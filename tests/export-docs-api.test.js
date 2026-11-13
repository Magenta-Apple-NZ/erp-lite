// Export documents API, end to end against an in-memory KV with the Claude
// call stubbed: upload → extract → review → confirm → settings → generate →
// frozen copy → xlsx. (functions/api/import/export-docs/*)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as recordApi from '../functions/api/import/export-docs/[id]/index.js';
import * as extractApi from '../functions/api/import/export-docs/[id]/extract.js';
import * as confirmApi from '../functions/api/import/export-docs/[id]/confirm.js';
import * as renderApi from '../functions/api/import/export-docs/[id]/render.js';
import * as xlsxApi from '../functions/api/import/export-docs/[id]/xlsx.js';
import * as fileApi from '../functions/api/import/export-docs/[id]/file.js';
import * as settingsApi from '../functions/api/import/export-docs/settings.js';
import { handleMessage } from '../functions/api/mcp/_server.js';

function kv(entries = {}) {
    const store = new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return {
        store,
        get: async (k, o) => { const v = store.get(k) ?? null; return v != null && (o === 'json' || o?.type === 'json') ? JSON.parse(v) : v; },
        put: async (k, v) => { store.set(k, v); },
        delete: async k => { store.delete(k); },
        list: async () => ({ keys: [...store.keys()].map(name => ({ name })), list_complete: true }),
    };
}

const SHIP = 'moqnsjz95bjp';
const BALES = [[1,442,'white'],[2,495,'coloured'],[3,494,'coloured'],[4,495,'coloured'],[5,551,'coloured'],[6,500,'coloured'],[7,508,'coloured'],[8,504,'coloured'],[9,467,'white'],[10,527,'coloured'],[11,385,'coloured'],[12,370,'coloured'],[13,432,'coloured'],[14,443,'coloured'],[15,404,'coloured'],[16,370,'coloured'],[17,400,'coloured'],[18,376,'coloured'],[19,339,'coloured'],[20,291,'coloured'],[21,429,'coloured'],[22,371,'coloured'],[23,331,'coloured'],[24,348,'coloured'],[25,383,'coloured'],[26,394,'coloured'],[27,202,'coloured'],[28,327,'coloured'],[29,406,'coloured'],[30,379,'coloured'],[31,334,'white'],[32,352,'white'],[33,415,'white'],[34,395,'white'],[35,326,'white'],[36,292,'white'],[37,363,'white'],[38,359,'white'],[39,397,'white'],[40,288,'white'],[41,474,'coloured'],[42,480,'coloured'],[43,466,'coloured'],[44,369,'coloured'],[45,457,'white']]
    .map(([n, kg, colour]) => ({ n, kg, kgRaw: String(kg), colour }));
const MODEL_OUT = {
    packingList: { shipmentNumber: 43, shipmentNumberRaw: '43', bales: BALES, whiteTotalKg: 4887, whiteTotalRaw: '4.887', colouredTotalKg: 13243, colouredTotalRaw: '13.243', totalPackages: 45, totalPackagesRaw: '45', notes: '' },
    proforma: {
        documentNumber: '23', documentDate: '2026-11-12', documentDateRaw: '12/11/2026', currency: 'EUR',
        lines: [
            { description: 'TOECLIPS BIANCHI', colour: 'white', kg: 4887, kgRaw: '4.887', unitPrice: 1.5, unitPriceRaw: '1,50', amount: 7330.5, amountRaw: '7.330,50' },
            { description: 'TOECLIPS COLORATI', colour: 'coloured', kg: 13243, kgRaw: '13.243', unitPrice: 0.75, unitPriceRaw: '0,75', amount: 9932.25, amountRaw: '9.932,25' },
        ],
        netWeightKg: 18130, netWeightRaw: '18.130', total: 17262.75, totalRaw: '17.262,75',
        destination: 'JPS ENTERPRISE - DHAKA', deliveryTerms: 'EX WORKS CASTEL GOFFREDO', hsCode: '6002.90.00', notes: '',
    },
};

let env, realFetch, calls;
beforeEach(() => {
    env = {
        ANTHROPIC_API_KEY: 'test-key',
        ORDERS_KV: kv({
            'import:forecast': { shipments: [
                { id: SHIP, seq: 43, schema: 3, startDate: '2026-11-13', whiteRawKg: 5000, colourRawKg: 10884, wastePct: 10, milestones: [] },
                { id: 'ship44', seq: 44, schema: 3, milestones: [] },
            ] },
            lc_index: ['lc-320126011494'],
            'lc:lc-320126011494': { id: 'lc-320126011494', lcNumber: '320126011494', issuedDate: '2026-12-01', linkedShipmentId: SHIP, proformaRef: '102/2026', proformaDate: '2026-11-13', amount: 21393.4, currency: 'USD', goods: { quantity: 18130, packageCount: 45, hsCode: '6002.90.00' } },
        }),
    };
    calls = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body, headers: init.headers });
        const isPacking = /packing list/i.test(body.messages[0].content[1].text);
        return new Response(JSON.stringify({
            model: 'claude-sonnet-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
            content: [{ type: 'text', text: JSON.stringify(MODEL_OUT[isPacking ? 'packingList' : 'proforma']) }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
});
afterEach(() => { globalThis.fetch = realFetch; });

const req = (method, path, body, headers = {}) => new Request('https://hub.test' + path, {
    method, headers: { 'Content-Type': 'application/json', 'cf-access-authenticated-user-email': 'andrew@primetie.co.nz', ...headers },
    ...(body !== undefined && { body: JSON.stringify(body) }),
});
const call = async (handler, method, path, body, params = { id: SHIP }) => {
    const res = await handler({ env, params, request: req(method, path, body) });
    const ct = res.headers.get('Content-Type') || '';
    return { status: res.status, res, body: ct.includes('json') ? await res.json() : null };
};
const PDF_B64 = Buffer.from('%PDF-1.4 fake').toString('base64');

async function uploadBoth() {
    const a = await call(extractApi.onRequestPost, 'POST', `/x`, { kind: 'packingList', filename: 'packing_list_october_2026.pdf', data: PDF_B64, mediaType: 'application/pdf' });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await call(extractApi.onRequestPost, 'POST', `/x`, { kind: 'proforma', filename: 'PROFORMA_23_ENVIROWARE.pdf', data: PDF_B64, mediaType: 'application/pdf' });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    return b.body;
}
async function fillSettings() {
    const got = await call(settingsApi.onRequestGet, 'GET', '/s');
    const s = got.body.settings;
    s.seller.phone = '+64 9 000 0000'; s.seller.gstNumber = '000-000-000';
    s.bank = { name: 'Test Bank', addressLines: ['1 Test St', 'Auckland'], swift: 'TESTNZ22', accountName: '', accountNumber: '' };
    Object.assign(s.identifiers, { irc: 'IRC-1', applicantTin: 'TIN-1', applicantBin: 'BIN-1', bankBin: 'BBIN-1', bankTin: 'BTIN-1', bankVatReg: 'VAT-1' });
    const put = await call(settingsApi.onRequestPut, 'PUT', '/s', { settings: s });
    assert.equal(put.status, 200);
    assert.ok(put.body.settings.reviewedAt);
    assert.equal(put.body.settings.reviewedBy, 'andrew@primetie.co.nz');
}

test('upload + extract: structured-output request, PDF stored, review filled, all checks pass', async () => {
    const view = await uploadBoth();
    assert.equal(calls.length, 2);
    const c = calls[0];
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.body.model, 'claude-sonnet-5');
    assert.equal(c.body.output_config.format.type, 'json_schema');
    assert.equal(c.body.messages[0].content[0].type, 'document');
    assert.equal(c.body.messages[0].content[0].source.data, PDF_B64);

    assert.equal(view.status, 'review');
    assert.equal(view.reviewTotals.count, 45);
    assert.equal(view.reviewTotals.netKg, 18130);
    for (const ck of view.checks) if (ck.level === 'block') assert.equal(ck.ok, true, ck.id + ': ' + ck.detail);
    assert.equal(view.checks.find(x => x.id === 'shipment-number').ok, true);
    assert.equal(view.record.files.packingList.filename, 'packing_list_october_2026.pdf');
    assert.ok(view.record.extractions.proforma.result.total === 17262.75, 'raw extraction kept');
    assert.equal(view.record.confirmed, null, 'nothing is confirmed by extraction');
    // defaults: 102/2026 at the Shipment 42 rate, unconfirmed
    assert.equal(view.record.exportInvoice.number, '102/2026');
    assert.equal(view.record.exportInvoice.rate, 1.18);
    assert.equal(view.record.exportInvoice.rateConfirmed, false);

    const f = await fileApi.onRequestGet({ env, params: { id: SHIP }, request: req('GET', `/f?key=${encodeURIComponent(view.record.files.packingList.key)}`) });
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('Content-Type'), 'application/pdf');
    assert.equal(Buffer.from(await f.arrayBuffer()).toString(), '%PDF-1.4 fake');
    const other = await fileApi.onRequestGet({ env, params: { id: 'ship44' }, request: req('GET', `/f?key=${encodeURIComponent(view.record.files.packingList.key)}`) });
    assert.equal(other.status, 404, "one shipment can't read another's files");
});

test('extraction failure keeps the upload and reports the error', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 });
    const r = await call(extractApi.onRequestPost, 'POST', '/x', { kind: 'packingList', filename: 'p.pdf', data: PDF_B64 });
    assert.equal(r.status, 502);
    assert.match(r.body.extractError, /Anthropic 529: overloaded/);
    assert.equal(r.body.record.files.packingList.filename, 'p.pdf');
    assert.match(r.body.record.extractions.packingList.error, /overloaded/);
});

test('confirm is refused while a blocking check fails, then accepted', async () => {
    const view = await uploadBoth();
    const bad = structuredClone(view.record.review);
    bad.bales[26].kg = 2020;
    await call(recordApi.onRequestPatch, 'PATCH', '/r', { review: bad });
    const refused = await call(confirmApi.onRequestPost, 'POST', '/c');
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /White and coloured sums/);

    await call(recordApi.onRequestPatch, 'PATCH', '/r', { review: view.record.review });
    const ok = await call(confirmApi.onRequestPost, 'POST', '/c');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.weights, { whiteRawKg: 4887, colourRawKg: 13243 });
    assert.equal(ok.body.status, 'draft');
    assert.equal(ok.body.unconfirmedChanges, false);
    assert.equal(ok.body.amount, 21393.4);
    assert.match(ok.body.record.log[0].action, /Confirmed 45 bales, 18,130 kg net \(white 4,887 \/ coloured 13,243\)/);
    assert.equal(ok.body.record.log[0].by, 'andrew@primetie.co.nz');
});

test('generation: blocked until settings are saved and rate/number ticked; then frozen copies + xlsx', async () => {
    await uploadBoth();
    await call(confirmApi.onRequestPost, 'POST', '/c');

    const early = await call(renderApi.onRequestPost, 'POST', '/g', { docs: [{ doc: 'packing', stage: 'draft' }, { doc: 'proforma' }] });
    assert.equal(early.status, 422);
    assert.match(early.body.error, /settings have not been checked/);
    assert.match(early.body.error, /Tick to confirm the export rate/);

    await fillSettings();
    const v = (await call(recordApi.onRequestGet, 'GET', '/r')).body;
    await call(recordApi.onRequestPatch, 'PATCH', '/r', { exportInvoice: { ...v.record.exportInvoice, rateConfirmed: true, numberConfirmed: true } });

    const gen = await call(renderApi.onRequestPost, 'POST', '/g', { docs: [{ doc: 'packing', stage: 'draft' }, { doc: 'proforma' }] });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.equal(gen.body.generated.length, 2);
    const pf = gen.body.generated.find(g => g.doc === 'proforma');
    assert.equal(pf.invoiceNumber, '102/2026');
    assert.equal(pf.amount, 21393.4);
    assert.match(pf.filename, /^Proforma Invoice - #43 - \d{8}\.pdf$/);
    assert.equal(gen.body.record.outputs.length, 2);

    const snap = await renderApi.onRequestGet({ env, params: { id: SHIP }, request: req('GET', `/r?out=${encodeURIComponent(pf.key)}`) });
    const html = await snap.text();
    assert.match(html, /USD 21,393\.40/);
    assert.doesNotMatch(html, /Preview/);

    // Later edits don't change an issued copy
    const after = (await call(recordApi.onRequestGet, 'GET', '/r')).body;
    await call(recordApi.onRequestPatch, 'PATCH', '/r', { exportInvoice: { ...after.record.exportInvoice, rate: 1.25, rateConfirmed: false } });
    const again = await (await renderApi.onRequestGet({ env, params: { id: SHIP }, request: req('GET', `/r?out=${encodeURIComponent(pf.key)}`) })).text();
    assert.match(again, /USD 21,393\.40/);

    const live = await renderApi.onRequestGet({ env, params: { id: SHIP }, request: req('GET', '/r?doc=proforma') });
    assert.match(await live.text(), /Preview only — not ready to issue: Tick to confirm the export rate/);

    const x = await xlsxApi.onRequestGet({ env, params: { id: SHIP }, request: req('GET', '/x') });
    assert.equal(x.status, 200);
    assert.match(x.headers.get('Content-Disposition'), /Packing List - #43 - \d{8}\.xlsx/);
    const bytes = new Uint8Array(await x.arrayBuffer());
    assert.equal(bytes[0], 0x50);
});

test('final packing list: LC details checked against the linked LC; status final after generating', async () => {
    await uploadBoth();
    await call(confirmApi.onRequestPost, 'POST', '/c');
    await fillSettings();
    let v = (await call(recordApi.onRequestGet, 'GET', '/r')).body;
    assert.equal(v.linkedLc.lcNumber, '320126011494');
    assert.deepEqual(v.generation.packingFinal, ['LC number missing', 'LC date of issue missing', 'Gross weight missing']);

    v = (await call(recordApi.onRequestPatch, 'PATCH', '/r', { lc: { number: '320126011494', date: '2026-12-01', grossKg: 18136 }, exportInvoice: { ...v.record.exportInvoice, numberConfirmed: true, rateConfirmed: true } })).body;
    assert.equal(v.status, 'lc_issued');
    assert.deepEqual(v.generation.packingFinal, []);
    assert.ok(v.lcChecks.every(c => c.ok), JSON.stringify(v.lcChecks));
    assert.match(v.record.log[0].action, /LC details: 320126011494, 1st December 2026, gross 18,136 kg/);

    const gen = await call(renderApi.onRequestPost, 'POST', '/g', { docs: [{ doc: 'packing', stage: 'final' }] });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.equal(gen.body.status, 'final');
    const x = await xlsxApi.onRequestGet({ env, params: { id: SHIP }, request: req('GET', `/x?out=${encodeURIComponent(gen.body.generated[0].key)}`) });
    assert.match(x.headers.get('Content-Disposition'), /Final Packing List - #43/);
    assert.match(Buffer.from(await x.arrayBuffer()).toString('latin1'), /sheet name="Final"/);
});

test('invoice number already used on another shipment blocks the proforma', async () => {
    env.ORDERS_KV.store.set('shipdocs:ship44', JSON.stringify({ shipmentId: 'ship44', exportInvoice: { number: '102/2026', rate: 1.2 } }));
    env.ORDERS_KV.store.set('shipdocs:index', JSON.stringify(['ship44']));
    await uploadBoth();
    const v = (await call(recordApi.onRequestGet, 'GET', '/r')).body;
    // the default steps past the number #44 holds
    assert.equal(v.record.exportInvoice.number, '103/2026');
    v.record.exportInvoice.number = '102/2026';
    const p = (await call(recordApi.onRequestPatch, 'PATCH', '/r', { exportInvoice: { ...v.record.exportInvoice, numberConfirmed: true, rateConfirmed: true } })).body;
    await call(confirmApi.onRequestPost, 'POST', '/c');
    const v2 = (await call(recordApi.onRequestGet, 'GET', '/r')).body;
    assert.ok(v2.generation.proforma.some(i => /already used on Shipment #44/.test(i)), JSON.stringify(v2.generation.proforma));
    assert.ok(p);
});

test('unknown shipment is a 404', async () => {
    const r = await call(recordApi.onRequestGet, 'GET', '/r', undefined, { id: 'nope' });
    assert.equal(r.status, 404);
});

test('MCP shipment_export_docs: read-only view of bales, export invoice and document links', async () => {
    await uploadBoth();
    await call(confirmApi.onRequestPost, 'POST', '/c');
    await fillSettings();
    const v = (await call(recordApi.onRequestGet, 'GET', '/r')).body;
    await call(recordApi.onRequestPatch, 'PATCH', '/r', { exportInvoice: { ...v.record.exportInvoice, rateConfirmed: true, numberConfirmed: true } });
    await call(renderApi.onRequestPost, 'POST', '/g', { docs: [{ doc: 'packing', stage: 'draft' }, { doc: 'proforma' }] });

    const before = new Map(env.ORDERS_KV.store);
    const rpc = async args => (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shipment_export_docs', arguments: args } }, { env, user: 't' })).result;
    const one = await rpc({ shipment: 43 });
    assert.equal(one.isError, undefined, one.content?.[0]?.text);
    const d = one.structuredContent;
    assert.equal(d.status, 'Draft');
    assert.equal(d.bales.length, 45);
    assert.deepEqual(d.bales[26], { n: 27, kg: 202, colour: 'coloured' });
    assert.equal(d.totals.netKg, 18130);
    assert.equal(d.exportInvoice.number, '102/2026');
    assert.equal(d.exportInvoice.amount, 21393.4);
    assert.equal(d.documents.length, 2);
    assert.match(d.documents.find(x => x.name === 'Draft packing list').xlsx, /^\/api\/import\/export-docs\/moqnsjz95bjp\/xlsx\?out=/);
    assert.equal(d.supplierFiles.length, 2);

    const all = (await rpc({})).structuredContent;
    assert.deepEqual(all.shipments, [{ shipment: 43, status: 'Draft', bales: 45, netKg: 18130, exportInvoice: '102/2026', amount: 21393.4, lcNumber: null, documents: 2 }]);
    assert.match((await rpc({ shipment: 99 })).content[0].text, /Shipment #99 not found/);
    assert.deepEqual([...env.ORDERS_KV.store.keys()].sort(), [...before.keys()].sort(), 'MCP wrote nothing');
});
