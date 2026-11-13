// GET /api/import/export-docs/:shipmentId/xlsx[?out=<key>]
// The packing list as .xlsx (Draft tab; Final tab once the LC details are
// in), from the confirmed data or from a generated copy's frozen data.

import { errResponse } from '../../../_xero.js';
import { K, buildView, loadSettings, getJson, viewError } from '../_store.js';
import { packingListWorkbookSpec, docFilename, lcComplete } from '../../_exportdocs.js';
import { buildXlsx } from '../../_xlsx.js';

export async function onRequestGet({ env, params, request }) {
    try {
        const out = new URL(request.url).searchParams.get('out');
        let record, settings, shipmentNumber;
        if (out) {
            if (!out.startsWith(params.id + ':')) return errResponse('Not found', 404);
            const snap = await getJson(env, K.out(out), null);
            if (!snap?.data) return errResponse('Not found', 404);
            ({ settings, shipmentNumber } = snap.data);
            record = snap.data;
        } else {
            const view = await buildView(env, params.id);
            if (!view.record.confirmed) return errResponse('Confirm the bales first', 409);
            record = view.record;
            settings = await loadSettings(env);
            shipmentNumber = view.shipment.number;
        }
        const bytes = buildXlsx(packingListWorkbookSpec({ record, settings, shipmentNumber }));
        const filename = docFilename({ doc: 'packing', stage: lcComplete(record.lc) ? 'final' : 'draft', shipmentNumber, date: record.exportInvoice?.date, ext: 'xlsx' });
        return new Response(bytes, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Cache-Control': 'private, no-store',
            },
        });
    } catch (e) {
        return viewError(e);
    }
}
