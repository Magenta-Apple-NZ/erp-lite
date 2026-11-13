// /api/import/export-docs/:shipmentId — a shipment's export documents.
//   GET    → everything the Export documents tab shows (derived on read)
//   PATCH  { review?, jps?, exportInvoice?, lc? } → save, returns the same view
// `review` is the unconfirmed working copy (autosaved as the user edits);
// only POST …/confirm makes it the data documents are printed from.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { buildView, loadRecord, saveRecord, loadShipments, whoami, viewError } from '../_store.js';
import { sanitiseReview, sanitiseExportInvoice, sanitiseLc, fmtRate, longDate, fmtKg } from '../../_exportdocs.js';
import { sanitiseJps } from '../../_shipxero.js';

export async function onRequestGet({ env, params }) {
    try {
        return jsonResponse(await buildView(env, params.id));
    } catch (e) {
        return viewError(e);
    }
}

export async function onRequestPatch({ env, params, request }) {
    try {
        if (!(await loadShipments(env)).some(s => s.id === params.id)) return errResponse('Shipment not found', 404);
        const body = await request.json();
        const rec = await loadRecord(env, params.id);
        const actions = [];
        if (body.review !== undefined) rec.review = sanitiseReview(body.review);
        if (body.jps !== undefined) rec.jps = sanitiseJps(body.jps);
        if (body.exportInvoice !== undefined) {
            const prev = rec.exportInvoice || {};
            const next = sanitiseExportInvoice(body.exportInvoice, prev);
            if (next.rateConfirmed && !(prev.rateConfirmed && prev.rate === next.rate)) actions.push(`Confirmed export rate ${next.currency} ${fmtRate(next.rate)}/kg`);
            if (next.numberConfirmed && !(prev.numberConfirmed && prev.number === next.number)) actions.push(`Confirmed invoice number ${next.number}`);
            if (prev.date && next.date !== prev.date) actions.push(`Document date ${longDate(next.date)}`);
            rec.exportInvoice = next;
        }
        if (body.lc !== undefined) {
            const prev = rec.lc || {};
            const next = sanitiseLc(body.lc);
            if (next.number !== (prev.number || '') || next.date !== (prev.date || '') || next.grossKg !== (prev.grossKg ?? null)) {
                actions.push(`LC details: ${next.number || '—'}, ${next.date ? longDate(next.date) : '—'}, gross ${next.grossKg ? fmtKg(next.grossKg) + ' kg' : '—'}`);
            }
            rec.lc = next;
        }
        await saveRecord(env, rec, whoami(request), actions.join('; ') || null);
        return jsonResponse(await buildView(env, params.id));
    } catch (e) {
        return viewError(e);
    }
}
