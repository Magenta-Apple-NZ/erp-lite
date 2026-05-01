// POST /api/print  { orderId, document, pdfBase64, printerId }
// Forwards a base64-encoded PDF to PrintNode, then polls the job state until
// it reaches a terminal state ('done', 'error', 'cancelled', 'expired') or
// the polling window closes. Returns the verbatim PrintNode message on
// failure so the client can surface it to the operator.
//
// document  : 'slip' | 'address' (free-form, used for the job title + event log)
// printerId : PrintNode printer id — picked client-side from the config.json
//             registry. Falls back to env.PRINTNODE_PRINTER_ID for back-compat.

import { printNodeHeaders, jsonResponse, errResponse } from './_printnode.js';

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB — well above any realistic slip

// Polling parameters. Cloudflare Pages Functions allow ~30s of wall-clock
// time per request; we cap polling at 25s to leave headroom for the upload
// round-trip. 2s intervals strike a balance between responsiveness and
// sub-request volume.
const POLL_MAX_MS  = 25000;
const POLL_EVERY_MS = 2000;

const TERMINAL_STATES = new Set(['done', 'error', 'cancelled', 'expired']);

async function pollJobState(jobId, apiKey) {
    const headers = printNodeHeaders(apiKey);
    const start = Date.now();
    let lastState = null;

    while (Date.now() - start < POLL_MAX_MS) {
        await new Promise(r => setTimeout(r, POLL_EVERY_MS));
        try {
            const resp = await fetch(`https://api.printnode.com/printjobs/${jobId}/states`, { headers });
            if (!resp.ok) continue;
            const data = await resp.json();

            // PrintNode returns [[stateObj, stateObj, ...]] — outer array is
            // one entry per job in the set, inner is the state history.
            const history = Array.isArray(data) && Array.isArray(data[0])
                ? data[0]
                : (Array.isArray(data) ? data : []);
            if (!history.length) continue;

            // Look for any terminal state in the history; otherwise track latest.
            const terminal = history.find(s => TERMINAL_STATES.has(s.state));
            lastState = terminal || history[history.length - 1];
            if (terminal) return terminal;
        } catch {
            // Network blip — keep polling until window closes.
        }
    }
    return lastState; // may be null if PrintNode never responded
}

export async function onRequestPost({ env, request }) {
    try {
        if (!env.PRINTNODE_API_KEY) {
            return errResponse('PRINTNODE_API_KEY not configured', 500);
        }

        const { orderId, document, pdfBase64, printerId } = await request.json();
        if (!orderId)    return errResponse('orderId is required', 400);
        if (!pdfBase64)  return errResponse('pdfBase64 is required', 400);

        // Sanity-check size (base64 is ~4/3 the raw byte count)
        if (pdfBase64.length * 0.75 > MAX_PDF_BYTES) {
            return errResponse('PDF exceeds maximum size', 413);
        }

        // Cheap content guard: a real PDF starts with "%PDF-", which base64-
        // encodes to "JVBERi". Catches blank/corrupt html2pdf output before
        // we waste a print job on it.
        if (!pdfBase64.startsWith('JVBERi')) {
            return errResponse('PDF appears empty or corrupt — not sent to printer', 422);
        }

        const targetPrinter = printerId || env.PRINTNODE_PRINTER_ID;
        if (!targetPrinter) {
            return errResponse('No printer configured. Set PRINTNODE_PRINTER_ID or pass printerId.', 400);
        }

        const order = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);

        const docLabel = document === 'address' ? 'Address Sheet' : 'Packing Slip';
        const ref      = order.xeroInvoiceNumber || order.id;
        const title    = `${docLabel} — ${ref}`;

        const resp = await fetch('https://api.printnode.com/printjobs', {
            method: 'POST',
            headers: printNodeHeaders(env.PRINTNODE_API_KEY),
            body: JSON.stringify({
                printerId: Number(targetPrinter),
                title,
                contentType: 'pdf_base64',
                content: pdfBase64,
                source: 'Business Hub',
            }),
        });

        if (!resp.ok) {
            const body = await resp.text();
            return errResponse('PrintNode error: ' + body, resp.status);
        }

        const jobIdRaw = await resp.json();
        const jobId = typeof jobIdRaw === 'number'
            ? jobIdRaw
            : (jobIdRaw?.id || jobIdRaw?.jobId);

        // Block on terminal state so the operator sees the truth, not just
        // "PrintNode received the PDF". The 'done' branch is the only one
        // that means paper actually came out.
        const final = await pollJobState(jobId, env.PRINTNODE_API_KEY);
        const state = final?.state || 'pending';
        const confirmed = TERMINAL_STATES.has(state);

        return jsonResponse({
            jobId,
            title,
            printerId: Number(targetPrinter),
            state,
            message: final?.message || null,
            confirmed,                    // reached a terminal state within the polling window
            success:   state === 'done',  // the only state that means "printed"
        });

    } catch (e) {
        return errResponse(e.message);
    }
}
