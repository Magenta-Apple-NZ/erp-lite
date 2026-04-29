// POST /api/print  { orderId, document, pdfBase64, printerId }
// Forwards a base64-encoded PDF to PrintNode and logs the job on the order.
//
// document  : 'slip' | 'address' (free-form, used for the job title + event log)
// printerId : PrintNode printer id — picked client-side from the config.json
//             registry. Falls back to env.PRINTNODE_PRINTER_ID for back-compat.

import { printNodeHeaders, jsonResponse, errResponse } from './_printnode.js';

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB — well above any realistic slip

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

        const jobId = await resp.json(); // PrintNode returns the integer job id
        return jsonResponse({ jobId, title, printerId: Number(targetPrinter) });

    } catch (e) {
        return errResponse(e.message);
    }
}
