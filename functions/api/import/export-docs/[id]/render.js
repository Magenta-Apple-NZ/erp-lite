// The Enviroware documents as print-ready HTML (print / save as PDF from
// the browser; no PDF library on Workers).
//   GET  ?doc=packing&stage=draft|final | ?doc=proforma | ?doc=jps   live preview
//        (jps = our signed rewrite of JPS's sales proforma invoice)
//   GET  ?out=<key>[&download=1]                          a generated copy, with a
//        Download PDF button (html2pdf in the browser, as the packing slips do);
//        &download=1 starts the download as soon as the page loads
//   POST { docs: [{ doc, stage }] }                       generate: re-check,
//        freeze the HTML and its data in KV, log it on the shipment
// Nothing is emailed or written to Drive; sharing stays manual.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { K, buildView, loadRecord, saveRecord, loadSettings, loadAssets, getJson, putJson, whoami, viewError } from '../_store.js';
import { renderPackingList, renderProforma, renderJpsContract, docFilename, baleTotals, invoiceAmount, cents } from '../../_exportdocs.js';

const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
const DOCS = { 'packing:draft': 'packingDraft', 'packing:final': 'packingFinal', 'proforma:draft': 'proforma', 'jps:contract': 'jpsContract' };
const NAMES = { 'packing:draft': 'Draft packing list', 'packing:final': 'Final packing list', 'proforma:draft': 'Our proforma invoice', 'jps:contract': "JPS's proforma invoice — signed copy" };
const docOf = d => (d === 'proforma' || d === 'jps' ? d : 'packing');
const docKey = (doc, stage) => doc === 'jps' ? 'jps:contract' : `${doc}:${doc === 'proforma' ? 'draft' : (stage === 'final' ? 'final' : 'draft')}`;

function render(dk, { record, settings, assets, shipmentNumber, banner }) {
    if (dk === 'jps:contract') return renderJpsContract({ record, settings, assets, shipmentNumber, banner });
    if (dk === 'proforma:draft') return renderProforma({ record, settings, assets, shipmentNumber, banner });
    return renderPackingList({ record, settings, assets, stage: dk.endsWith('final') ? 'final' : 'draft', shipmentNumber, banner });
}

// The Download PDF button for a generated copy: the page renders itself to an
// A4 PDF named like the files Andrew keeps (docFilename). Added when served,
// so copies generated before it existed get it too.
export function withDownload(page, filename, auto) {
    const name = JSON.stringify(filename || 'document.pdf').replace(/</g, '\\u003c');
    const tail = `<style>.pdf-capture .sheet { margin: 0 !important; box-shadow: none !important; min-height: 0 !important; height: 296mm; overflow: hidden; }</style>
<script src="https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js"></script>
<script>
(() => {
  const name = ${name};
  const bar = document.querySelector('.toolbar');
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = 'Download PDF'; btn.id = 'download-pdf';
  if (bar) bar.insertBefore(btn, bar.querySelector('button'));
  async function download() {
    if (typeof html2pdf === 'undefined') { alert('The PDF tool did not load — check the connection and try again'); return; }
    btn.disabled = true; btn.textContent = 'Preparing PDF…';
    document.body.classList.add('pdf-capture');
    try {
      await html2pdf().set({
        margin: 0, filename: name, image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }, pagebreak: { mode: 'avoid-all' },
      }).from(document.querySelector('.sheet')).save();
    } finally {
      document.body.classList.remove('pdf-capture'); btn.disabled = false; btn.textContent = 'Download PDF';
    }
  }
  btn.addEventListener('click', download);
  ${auto ? "window.addEventListener('load', () => setTimeout(download, 300));" : ''}
})();
</script>`;
    return page.includes('</body>') ? page.replace('</body>', tail + '\n</body>') : page + tail;
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
            const [snap, rec] = await Promise.all([getJson(env, K.out(out), null), loadRecord(env, params.id)]);
            if (!snap) return html(messagePage('Not found'), 404);
            const meta = (rec.outputs || []).find(o => o.key === out);
            return html(withDownload(snap.html, meta?.filename, url.searchParams.get('download') === '1'));
        }
        const dk = docKey(docOf(url.searchParams.get('doc')), url.searchParams.get('stage'));
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
        const wanted = [...new Set((Array.isArray(body.docs) ? body.docs : []).map(d => docKey(docOf(d?.doc), d?.stage)))];
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
            const data = { shipmentNumber: view.shipment.number, confirmed: rec.confirmed, exportInvoice: rec.exportInvoice, lc: rec.lc || {}, jps: rec.jps || null, settings };
            const page = render(dk, { record: data, settings, assets, shipmentNumber: view.shipment.number, banner: '' });
            await putJson(env, K.out(key), { html: page, data });
            const meta = {
                key, doc, stage, at, by: who, name: NAMES[dk],
                filename: docFilename({ doc, stage, shipmentNumber: view.shipment.number, date: doc === 'jps' ? rec.jps.date : rec.exportInvoice.date }),
                date: doc === 'jps' ? rec.jps.date : rec.exportInvoice.date, packages: t.count, netKg: t.netKg,
                ...(doc === 'jps' && { invoiceNumber: rec.jps.number, currency: rec.jps.currency, amount: (rec.jps.lines || []).reduce((a, l) => a + cents(l.amount), 0) / 100 || rec.jps.total, terms: { ...(rec.jps.contract || {}) } }),
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
