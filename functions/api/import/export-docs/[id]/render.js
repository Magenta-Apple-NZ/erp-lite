// The Enviroware documents as print-ready HTML (print / save as PDF from
// the browser; no PDF library on Workers).
//   GET  ?doc=packing&stage=draft|final | ?doc=proforma   live preview
//   GET  ?out=<key>                                       a generated copy
//   POST { docs: [{ doc, stage }] }                       generate: re-check,
//        freeze the HTML and its data in KV, log it on the shipment
// Nothing is emailed or written to Drive; sharing stays manual.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { K, buildView, loadRecord, saveRecord, loadSettings, loadAssets, getJson, putJson, whoami, viewError } from '../_store.js';
import { renderPackingList, renderProforma, docFilename, baleTotals, invoiceAmount } from '../../_exportdocs.js';

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
const DOCS = { 'packing:draft': 'packingDraft', 'packing:final': 'packingFinal', 'proforma:draft': 'proforma' };
const NAMES = { 'packing:draft': 'Draft packing list', 'packing:final': 'Final packing list', 'proforma:draft': 'Proforma invoice' };
const docKey = (doc, stage) => `${doc}:${doc === 'proforma' ? 'draft' : (stage === 'final' ? 'final' : 'draft')}`;

function render(dk, { record, settings, assets, shipmentNumber, banner }) {
    if (dk === 'proforma:draft') return renderProforma({ record, settings, assets, shipmentNumber, banner });
    return renderPackingList({ record, settings, stage: dk.endsWith('final') ? 'final' : 'draft', shipmentNumber, banner });
}

function messagePage(msg) {
    return `<!doctype html><meta charset="utf-8"><title>Export documents</title><body style="font:15px system-ui,sans-serif;padding:3rem;color:#334155"><p>${String(msg).replace(/</g, '&lt;')}</p></body>`;
}

export async function onRequestGet({ env, params, request }) {
    try {
        const url = new URL(request.url);
        const out = url.searchParams.get('out');
        if (out) {
            if (!out.startsWith(params.id + ':')) return html(messagePage('Not found'), 404);
            const snap = await getJson(env, K.out(out), null);
            return snap ? html(snap.html) : html(messagePage('Not found'), 404);
        }
        const dk = docKey(url.searchParams.get('doc') === 'proforma' ? 'proforma' : 'packing', url.searchParams.get('stage'));
        const view = await buildView(env, params.id);
        if (!view.record.confirmed) return html(messagePage('Confirm the bales on the Export documents tab first.'), 409);
        const [settings, assets] = await Promise.all([loadSettings(env), loadAssets(env)]);
        const issues = view.generation[DOCS[dk]];
        const banner = issues.length ? `Preview only — not ready to issue: ${issues[0]}` : 'Preview — use Generate on the shipment to issue and keep a copy';
        return html(render(dk, { record: view.record, settings, assets, shipmentNumber: view.shipment.number, banner }));
    } catch (e) {
        return viewError(e);
    }
}

export async function onRequestPost({ env, params, request }) {
    try {
        const body = await request.json();
        const wanted = [...new Set((Array.isArray(body.docs) ? body.docs : []).map(d => docKey(d?.doc === 'proforma' ? 'proforma' : 'packing', d?.stage)))];
        if (!wanted.length) return errResponse('docs required', 400);
        const view = await buildView(env, params.id);
        const issues = Object.fromEntries(wanted.map(dk => [dk, view.generation[DOCS[dk]]]).filter(([, v]) => v.length));
        if (Object.keys(issues).length) {
            return jsonResponse({ error: Object.entries(issues).map(([dk, v]) => `${NAMES[dk]}: ${v.join('; ')}`).join(' · '), issues }, 422);
        }
        const [settings, assets] = await Promise.all([loadSettings(env), loadAssets(env)]);
        const who = whoami(request);
        const rec = await loadRecord(env, params.id);
        rec.exportInvoice = view.record.exportInvoice;
        const t = baleTotals(rec.confirmed.bales);
        const metas = [];
        for (const dk of wanted) {
            const [doc, stage] = dk.split(':');
            const at = new Date().toISOString();
            const key = `${params.id}:${doc}-${stage}:${Date.now().toString(36)}${metas.length}`;
            const data = { shipmentNumber: view.shipment.number, confirmed: rec.confirmed, exportInvoice: rec.exportInvoice, lc: rec.lc || {}, settings };
            const page = render(dk, { record: data, settings, assets, shipmentNumber: view.shipment.number, banner: '' });
            await putJson(env, K.out(key), { html: page, data });
            const meta = {
                key, doc, stage, at, by: who, name: NAMES[dk],
                filename: docFilename({ doc, stage, shipmentNumber: view.shipment.number, date: rec.exportInvoice.date }),
                date: rec.exportInvoice.date, packages: t.count, netKg: t.netKg,
                ...(doc === 'proforma' && { invoiceNumber: rec.exportInvoice.number, rate: rec.exportInvoice.rate, currency: rec.exportInvoice.currency, amount: invoiceAmount(t.netKg, rec.exportInvoice.rate) }),
                ...(stage === 'final' && doc === 'packing' && { lcNumber: rec.lc?.number, lcDate: rec.lc?.date, grossKg: rec.lc?.grossKg }),
            };
            metas.push(meta);
        }
        rec.outputs = [...metas, ...(rec.outputs || [])];
        await saveRecord(env, rec, who, 'Generated ' + metas.map(m => m.name + (m.invoiceNumber ? ' ' + m.invoiceNumber : '')).join(' + '));
        return jsonResponse({ ...(await buildView(env, params.id)), generated: metas });
    } catch (e) {
        return viewError(e);
    }
}
