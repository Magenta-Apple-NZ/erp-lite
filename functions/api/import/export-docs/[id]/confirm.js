// POST /api/import/export-docs/:shipmentId/confirm
// Makes the reviewed bales and supplier figures the shipment's confirmed
// data — refused while any blocking check fails. Returns the view plus the
// white / coloured kg so the Imports view can update the shipment's Net
// Weight Breakdown through its normal save.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { buildView, loadRecord, saveRecord, loadSettings, loadShipments, whoami, viewError } from '../_store.js';
import { shipNumber } from '../../../stock/_engine.js';
import { runChecks, blockingFailures, baleTotals, fmtKg } from '../../_exportdocs.js';

export async function onRequestPost({ env, params, request }) {
    try {
        const ship = (await loadShipments(env)).find(s => s.id === params.id);
        if (!ship) return errResponse('Shipment not found', 404);
        const [rec, settings] = await Promise.all([loadRecord(env, params.id), loadSettings(env)]);
        if (!rec.review || !(rec.review.bales || []).length) return errResponse('Nothing to confirm yet', 400);
        const checks = runChecks(rec.review, { settings, shipmentNumber: shipNumber(ship) });
        const fails = blockingFailures(checks);
        if (fails.length) return jsonResponse({ error: 'Checks failing: ' + fails.map(f => f.title).join('; '), checks }, 422);

        const who = whoami(request);
        const before = await buildView(env, params.id);
        rec.confirmed = { ...structuredClone(rec.review), confirmedAt: new Date().toISOString(), confirmedBy: who };
        if (!rec.exportInvoice) rec.exportInvoice = before.record.exportInvoice;
        const t = baleTotals(rec.confirmed.bales);
        await saveRecord(env, rec, who, `Confirmed ${t.count} bales, ${fmtKg(t.netKg)} kg net (white ${fmtKg(t.whiteKg)} / coloured ${fmtKg(t.colouredKg)})`);
        return jsonResponse({ ...(await buildView(env, params.id)), weights: { whiteRawKg: t.whiteKg, colourRawKg: t.colouredKg } });
    } catch (e) {
        return viewError(e);
    }
}
