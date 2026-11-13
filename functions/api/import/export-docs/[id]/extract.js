// POST /api/import/export-docs/:shipmentId/extract
// Body: { kind: 'packingList' | 'proforma', filename, data: <base64 PDF> }
// Stores the supplier PDF first (so an extraction failure never loses it),
// reads it with Claude, keeps the raw result on the record for diagnosis and
// loads it into the review copy. Nothing is confirmed here.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { K, KINDS, buildView, loadRecord, saveRecord, loadShipments, whoami, viewError } from '../_store.js';
import { extractSupplierDoc } from '../_extract.js';
import { emptyReview, reviewFromPackingExtraction, reviewFromProformaExtraction, fmtKg, fmtMoney } from '../../_exportdocs.js';
import { jpsFromExtraction } from '../../_shipxero.js';

const LABEL = { packingList: 'supplier packing list', proforma: 'supplier proforma', jpsInvoice: 'JPS invoice' };
const MAX_B64 = 20 * 1024 * 1024;

export async function onRequestPost({ env, params, request }) {
    try {
        if (!(await loadShipments(env)).some(s => s.id === params.id)) return errResponse('Shipment not found', 404);
        const body = await request.json();
        const kind = body.kind;
        if (!KINDS.includes(kind)) return errResponse('kind must be packingList, proforma or jpsInvoice', 400);
        const data = String(body.data || '').replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
        if (!data) return errResponse('No file data', 400);
        if (data.length > MAX_B64) return errResponse('File too large (max ~15 MB)', 413);
        if (body.mediaType && body.mediaType !== 'application/pdf') return errResponse('Upload the supplier PDF', 400);
        const filename = String(body.filename || `${kind}.pdf`).replace(/[\r\n"]/g, '').slice(0, 120);
        const who = whoami(request);
        const now = new Date().toISOString();

        const key = `${params.id}:${kind}:${Date.now().toString(36)}`;
        await env.ORDERS_KV.put(K.file(key), data);
        let rec = await loadRecord(env, params.id);
        const meta = { key, kind, filename, size: Math.round(data.length * 3 / 4), uploadedAt: now, by: who };
        rec.files = { ...(rec.files || {}), [kind]: meta };
        rec.fileHistory = [meta, ...(rec.fileHistory || [])].slice(0, 50);
        await saveRecord(env, rec, who, `Uploaded the ${LABEL[kind]}: ${filename}`);

        let ext;
        try {
            ext = await extractSupplierDoc(env, { kind, data });
        } catch (e) {
            rec = await loadRecord(env, params.id);
            rec.extractions = { ...(rec.extractions || {}), [kind]: { at: new Date().toISOString(), by: who, fileKey: key, error: e.message } };
            await saveRecord(env, rec, who, `Could not read the ${LABEL[kind]}: ${e.message}`);
            return jsonResponse({ ...(await buildView(env, params.id)), extractError: e.message }, 502);
        }

        rec = await loadRecord(env, params.id);
        rec.extractions = {
            ...(rec.extractions || {}),
            [kind]: { at: new Date().toISOString(), by: who, fileKey: key, model: ext.model, stopReason: ext.stopReason, usage: ext.usage, result: ext.fields },
        };
        let summary;
        if (kind === 'jpsInvoice') {
            rec.jps = jpsFromExtraction(ext.fields);
            summary = `invoice ${rec.jps.number || '?'}, ${rec.jps.currency} ${fmtMoney(rec.jps.total)}`;
            await saveRecord(env, rec, who, `Read the ${LABEL[kind]} (${summary})`);
            return jsonResponse(await buildView(env, params.id));
        }
        const review = rec.review ? { ...rec.review } : emptyReview();
        if (kind === 'packingList') {
            const r = reviewFromPackingExtraction(ext.fields);
            Object.assign(review, { shipmentNumber: r.shipmentNumber, bales: r.bales, packing: r.packing });
            summary = `${r.bales.length} bales`;
        } else {
            review.supplierInvoice = reviewFromProformaExtraction(ext.fields);
            summary = `document ${review.supplierInvoice.number || '?'}, net ${fmtKg(review.supplierInvoice.netKg)} kg`;
        }
        rec.review = review;
        await saveRecord(env, rec, who, `Read the ${LABEL[kind]} (${summary})`);
        return jsonResponse(await buildView(env, params.id));
    } catch (e) {
        return viewError(e);
    }
}
