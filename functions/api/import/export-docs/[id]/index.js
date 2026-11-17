// /api/import/export-docs/:shipmentId — a shipment's export documents.
//   GET    → everything the Export documents tab shows (derived on read)
//   PATCH  { review?, jps?, exportInvoice?, lc? } → save, returns the same view
//   PATCH  { dismiss: checkId } / { restore: checkId } → dismiss a failing check
//          instead of correcting it (logged; holds while the check fails the same way)
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
        if (body.dismiss || body.restore) return await dismissal(env, params.id, body, whoami(request));
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

// The check is found in the view the user is looking at (review, JPS, LC) and
// its current detail is stored, so the dismissal covers exactly that problem.
async function dismissal(env, shipmentId, body, who) {
    const rec = await loadRecord(env, shipmentId);
    const id = String(body.dismiss || body.restore);
    if (body.restore) {
        const prev = rec.dismissed?.[id];
        if (!prev) return errResponse('That check is not dismissed', 404);
        delete rec.dismissed[id];
        await saveRecord(env, rec, who, `Restored the check "${prev.title}"`);
        return jsonResponse(await buildView(env, shipmentId));
    }
    const view = await buildView(env, shipmentId);
    const c = [...view.checks, ...(view.jpsChecks || []), ...(view.lcChecks || [])].find(x => x.id === id);
    if (!c) return errResponse('Unknown check', 404);
    if (c.ok !== false) return errResponse(`"${c.title}" isn't failing`, 409);
    if (!c.dismissible) return errResponse(`"${c.title}" can't be dismissed — the documents need it fixed`, 409);
    rec.dismissed = { ...(rec.dismissed || {}), [id]: { detail: c.detail, title: c.title, level: c.level, by: who, at: new Date().toISOString() } };
    await saveRecord(env, rec, who, `Dismissed "${c.title}": ${c.detail}`);
    return jsonResponse(await buildView(env, shipmentId));
}
