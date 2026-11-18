// Stage 1 money end to end: JPS invoice → three invoices created in Xero →
// payments read back → cost breakdown plan. Claude and Xero are stubbed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as recordApi from '../functions/api/import/export-docs/[id]/index.js';
import * as extractApi from '../functions/api/import/export-docs/[id]/extract.js';
import * as confirmApi from '../functions/api/import/export-docs/[id]/confirm.js';
import * as xeroApi from '../functions/api/import/export-docs/[id]/xero.js';
import * as settingsApi from '../functions/api/import/export-docs/settings.js';
import * as assetApi from '../functions/api/import/export-docs/settings/[asset].js';
import * as renderApi from '../functions/api/import/export-docs/[id]/render.js';

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
const KG = [442,495,494,495,551,500,508,504,467,527,385,370,432,443,404,370,400,376,339,291,429,371,331,348,383,394,202,327,406,379,334,352,415,395,326,292,363,359,397,288,474,480,466,369,457];
const WHITE = [1, 9, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 45];
const MODEL = {
    packingList: { shipmentNumber: 43, shipmentNumberRaw: '43', bales: KG.map((kg, i) => ({ n: i + 1, kg, kgRaw: String(kg), colour: WHITE.includes(i + 1) ? 'white' : 'coloured' })),
        whiteTotalKg: 4887, whiteTotalRaw: '4.887', colouredTotalKg: 13243, colouredTotalRaw: '13.243', totalPackages: 45, totalPackagesRaw: '45', notes: '' },
    proforma: { documentNumber: '23', documentDate: '2026-11-12', documentDateRaw: '12/11/2026', currency: 'EUR',
        lines: [
            { description: 'TOECLIPS BIANCHI', colour: 'white', kg: 4887, kgRaw: '4.887', unitPrice: 1.5, unitPriceRaw: '1,50', amount: 7330.5, amountRaw: '7.330,50' },
            { description: 'TOECLIPS COLORATI', colour: 'coloured', kg: 13243, kgRaw: '13.243', unitPrice: 0.75, unitPriceRaw: '0,75', amount: 9932.25, amountRaw: '9.932,25' },
        ],
        netWeightKg: 18130, netWeightRaw: '18.130', total: 17262.75, totalRaw: '17.262,75', destination: '', deliveryTerms: '', hsCode: '', notes: '' },
    jpsInvoice: { invoiceNumber: 'JPS-118', invoiceDate: '2026-11-20', invoiceDateRaw: '20/11/2026', currency: 'USD',
        lines: [{ description: 'LC deposit and handling — 18,130 kg', kg: 18130, kgRaw: '18,130', unitPrice: 1.81, unitPriceRaw: '1.81', amount: 32815.3, amountRaw: '32,815.30' }],
        netWeightKg: 18130, netWeightRaw: '18,130', total: 32815.3, totalRaw: '32,815.30',
        lastShipmentDate: '2027-06-15', expiryDate: '2027-06-30', containers: "1 x 40' FCL and 1 x 20' GP", notes: '' },
};

let env, realFetch, xeroCalls, xeroInvoices, xeroRefuse;
beforeEach(() => {
    env = {
        ANTHROPIC_API_KEY: 'k',
        ORDERS_KV: kv({ 'import:forecast': { shipments: [{ id: SHIP, seq: 43, schema: 3, whiteRawKg: 4430, colourRawKg: 11454,
            fixedLines: { rawWhite: { rate: 1.5, ccy: 'EUR' }, rawColour: { rate: 0.75, ccy: 'EUR' }, handlingA: { rate: 0.63, ccy: 'USD' }, handlingB: { rate: 1.18, ccy: 'USD' }, lcRefund: { rate: -1.18, ccy: 'USD' } },
            milestones: [] }] } }),
        XERO_KV: kv({ tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600e3, tenantId: 't1' } }),
    };
    xeroCalls = []; xeroInvoices = new Map(); xeroRefuse = null;
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
        if (u.startsWith('https://open.er-api.com/v6/latest/NZD')) return json({ result: 'success', rates: { NZD: 1, EUR: 0.53, USD: 0.6 } });
        if (u.startsWith('https://api.anthropic.com')) {
            const text = JSON.parse(init.body).messages[0].content[1].text;
            const kind = /JPS Enterprise \(Dhaka/.test(text) ? 'jpsInvoice' : /packing list/i.test(text) ? 'packingList' : 'proforma';
            return json({ model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(MODEL[kind]) }] });
        }
        if (u.startsWith('https://api.xero.com/api.xro/2.0/')) {
            const path = u.slice('https://api.xero.com/api.xro/2.0/'.length);
            const body = init.body ? JSON.parse(init.body) : null;
            xeroCalls.push({ method: init.method || 'GET', path, body, headers: init.headers });
            if (path.startsWith('Contacts?SearchTerm=')) {
                const term = decodeURIComponent(path.split('=')[1]);
                return json({ Contacts: /jps/i.test(term) ? [{ ContactID: 'c-jps', Name: 'JPS Enterprise', ContactStatus: 'ACTIVE' }] : [] });
            }
            if (path.startsWith('TaxRates')) return json({ TaxRates: [{ TaxType: 'ZERORATED', Name: 'Zero Rated' }, { TaxType: 'NONE', Name: 'No GST' }, { TaxType: 'OUTPUT2', Name: 'GST on Income' }, { TaxType: 'INPUT2', Name: 'GST on Expenses' }] });
            if (path === 'Contacts' && init.method === 'POST') return json({ Contacts: [{ ContactID: 'c-' + body.Contacts[0].Name.split(' ')[0].toLowerCase(), Name: body.Contacts[0].Name }] });
            if (path.startsWith('Invoices?') && init.method === 'POST') {
                if (xeroRefuse) return xeroRefuse.raw ? new Response(xeroRefuse.raw, { status: xeroRefuse.status }) : json(xeroRefuse.body, xeroRefuse.status);
                const inv = body.Invoices[0];
                if (!inv.LineItems.every(l => l.AccountCode)) return json({ Type: 'ValidationException', Elements: [{ ValidationErrors: [{ Message: 'Account code is required' }] }] }, 400);
                const total = Math.round(inv.LineItems.reduce((s, l) => s + Math.round(l.Quantity * l.UnitAmount * 100), 0)) / 100;
                const saved = { ...inv, InvoiceID: 'inv-' + (xeroInvoices.size + 1), Total: total, AmountPaid: 0, AmountDue: total, CurrencyRate: 0.5, Payments: [] };
                xeroInvoices.set(saved.InvoiceID, saved);
                return json({ Invoices: [saved] });
            }
            const m = path.match(/^Invoices\/([^?]+)/);
            if (m) return json({ Invoices: [xeroInvoices.get(decodeURIComponent(m[1]))] });
        }
        throw new Error('unexpected fetch ' + u);
    };
});
afterEach(() => { globalThis.fetch = realFetch; });

const req = (method, body) => new Request('https://hub.test/x', { method, headers: { 'Content-Type': 'application/json', 'cf-access-authenticated-user-email': 'andrew@primetie.co.nz' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
const call = async (h, method, body) => { const r = await h({ env, params: { id: SHIP }, request: req(method, body) }); return { status: r.status, body: await r.json() }; };
const B64 = Buffer.from('%PDF fake').toString('base64');

// currencyMode 'foreign' = invoices in EUR / USD (needs multi-currency in Xero);
// 'nzd' (the default) = converted at the day's rate.
async function stageOne({ accounts = true, currencyMode = 'foreign' } = {}) {
    for (const kind of ['packingList', 'proforma']) assert.equal((await call(extractApi.onRequestPost, 'POST', { kind, filename: kind + '.pdf', data: B64 })).status, 200);
    assert.equal((await call(confirmApi.onRequestPost, 'POST', {})).status, 200);
    const s = (await call(settingsApi.onRequestGet, 'GET')).body.settings;
    if (accounts) s.xero.accounts = { rawProduct: '630', lcDeposit: '820', handling: '631', exportSale: '200' };
    s.xero.currencyMode = currencyMode;
    await call(settingsApi.onRequestPut, 'PUT', { settings: s });
    const v = (await call(recordApi.onRequestGet, 'GET')).body;
    await call(recordApi.onRequestPatch, 'PATCH', { exportInvoice: { ...v.record.exportInvoice, numberConfirmed: true, rateConfirmed: true } });
    const j = await call(extractApi.onRequestPost, 'POST', { kind: 'jpsInvoice', filename: 'JPS-118.pdf', data: B64 });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    const c = await call(recordApi.onRequestPatch, 'PATCH', { jpsConfirm: true });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return c.body;
}

test('JPS invoice is read, split and checked', async () => {
    const v = await stageOne();
    assert.equal(v.record.jps.number, 'JPS-118');
    assert.deepEqual([v.jpsSplit.depositAmount, v.jpsSplit.handlingAmount, v.jpsSplit.handlingRate], [21393.4, 11421.9, 0.63]);
    for (const c of v.jpsChecks) assert.notEqual(c.ok, false, `${c.id}: ${c.detail}`);
    assert.ok(v.record.log.some(l => /Read the JPS invoice \(invoice JPS-118, USD 32,815\.30\)/.test(l.action)));
    assert.equal(v.record.log[0].action, "Confirmed JPS's proforma invoice JPS-118 (USD 32,815.30)");
    assert.ok(v.record.jpsConfirmed.at);
    // Cost plan: weights from the bales; rates already right
    assert.deepEqual(v.costPlan.changes.map(c => c.label), ['Net Weight Breakdown']);
});

test('three invoices created in Xero as drafts with the right lines; no duplicates', async () => {
    await stageOne();
    for (const doc of ['supplierBill', 'salesInvoice', 'jpsBill']) {
        const r = await call(xeroApi.onRequestPost, 'POST', { doc });
        assert.equal(r.status, 200, doc + ': ' + JSON.stringify(r.body));
    }
    const posts = xeroCalls.filter(c => c.method === 'POST' && c.path.startsWith('Invoices'));
    assert.equal(posts.length, 3);
    assert.ok(posts.every(p => p.path === 'Invoices?unitdp=4'));
    const [bill, sale, jps] = posts.map(p => p.body.Invoices[0]);
    assert.deepEqual([bill.Type, bill.Status, bill.Contact.ContactID, bill.CurrencyCode, bill.InvoiceNumber, bill.Date], ['ACCPAY', 'DRAFT', 'c-pistoni', 'EUR', '23', '2026-11-12']);
    assert.deepEqual([sale.Type, sale.Contact.ContactID, sale.CurrencyCode, sale.InvoiceNumber, sale.LineItems[0].TaxType], ['ACCREC', 'c-jps', 'USD', '102/2026', 'ZERORATED']);
    assert.deepEqual(jps.LineItems.map(l => [l.Quantity, l.UnitAmount, l.AccountCode]), [[18130, 1.18, '820'], [1, 11421.9, '631']]);
    assert.ok(xeroCalls.some(c => c.path === 'Contacts' && c.method === 'POST' && c.body.Contacts[0].Name === 'Pistoni SRL'), 'missing supplier contact is created');
    assert.ok(!xeroCalls.some(c => c.path === 'Contacts' && c.method === 'POST' && /JPS/.test(c.body.Contacts[0].Name)), 'existing JPS contact is reused');
    assert.equal(posts[0].headers['Xero-tenant-id'], 't1');

    const again = await call(xeroApi.onRequestPost, 'POST', { doc: 'jpsBill' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already in Xero/);

    const v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.deepEqual(v.xero.docs.map(d => [d.key, d.inXero, d.pushed.status]), [['supplierBill', true, 'DRAFT'], ['salesInvoice', true, 'DRAFT'], ['jpsBill', true, 'DRAFT']]);
    assert.match(v.xero.docs[2].url, /AccountsPayable\/View\.aspx\?InvoiceID=inv-3/);
    assert.match(v.record.log.find(l => /Created the JPS bill/.test(l.action)).action, /USD 32,815\.30/);
});

test('payments read back from Xero fill the cost plan in NZD', async () => {
    await stageOne();
    for (const doc of ['supplierBill', 'salesInvoice', 'jpsBill']) await call(xeroApi.onRequestPost, 'POST', { doc });
    // Pay everything in Xero (rate 0.5 → NZD = amount × 2)
    for (const inv of xeroInvoices.values()) Object.assign(inv, { Status: 'PAID', AmountPaid: inv.Total, AmountDue: 0, FullyPaidOnDate: '2026-11-25T00:00:00', Payments: [{ Date: '2026-11-25T00:00:00', Amount: inv.Total, CurrencyRate: 0.5 }] });
    const v = (await call(xeroApi.onRequestPost, 'POST', { refresh: true })).body;
    assert.deepEqual(v.xero.docs.map(d => d.pushed.nzdPaid), [34525.5, 42786.8, 65630.6]);
    const patch = v.costPlan.patch;
    assert.deepEqual(patch.sectionActuals, { raw: 34525.5 });
    assert.equal(patch.fixedLines.lcRefund.actual, -42786.8);
    assert.equal(patch.fixedLines.handlingB.actual, 42786.8);  // the deposit share equals what the LC paid back
    assert.equal(patch.fixedLines.handlingA.actual, 22843.8);  // NZD cost of JPS's margin
    assert.equal(patch.fixedLines.handlingA.paid, true);
    assert.match(v.record.log[0].action, /Pistoni bill now paid in Xero \(NZD 34,525\.50 paid\)/);
});

test('nothing reaches Xero until the account codes are set', async () => {
    await stageOne({ accounts: false });
    const r = await call(xeroApi.onRequestPost, 'POST', { doc: 'supplierBill' });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /Set the raw product account/);
    assert.equal(xeroCalls.length, 0);
});

test('signed JPS proforma: terms read from their PDF, generated once your signature is uploaded', async () => {
    await stageOne();
    let v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.deepEqual(v.record.jps.contract, { lastShipmentDate: '2027-06-15', expiryDate: '2027-06-30', containers: "1 x 40' FCL and 1 x 20' GP" });
    assert.equal(v.hasSignature, false);
    assert.deepEqual(v.generation.jpsContract, ['Upload your signature in Document settings → Enviroware']);
    assert.equal((await call(renderApi.onRequestPost, 'POST', { docs: [{ doc: 'jps' }] })).status, 422);

    for (const [asset, data] of [['signature', 'U0lH'], ['seal', 'U0VBTA==']]) {
        const r = await assetApi.onRequestPost({ env, params: { asset }, request: req('POST', { mediaType: 'image/png', data }) });
        assert.equal(r.status, 200);
    }
    v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.equal(v.hasSignature, true);
    assert.deepEqual(v.generation.jpsContract, []);

    const gen = await call(renderApi.onRequestPost, 'POST', { docs: [{ doc: 'jps' }] });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    const m = gen.body.generated[0];
    assert.deepEqual([m.name, m.filename, m.invoiceNumber, m.currency, m.amount],
        ["JPS's proforma invoice — signed copy", 'JPS Proforma Invoice - #43 - 20112026 - Signed.pdf', 'JPS-118', 'USD', 32815.3]);
    assert.match(gen.body.record.log[0].action, /^Generated JPS's proforma invoice — signed copy JPS-118/);
    const page = await (await renderApi.onRequestGet({ env, params: { id: SHIP }, request: new Request('https://hub.test/x?out=' + encodeURIComponent(m.key)) })).text();
    assert.match(page, /SALES PROFORMA INVOICE/);
    assert.match(page, /data:image\/png;base64,U0lH/);
    assert.match(page, /Thirty-Two Thousand Eight Hundred and Fifteen and Thirty Cents Only/);
    assert.match(page, /Last date of shipment:<\/th><td>15th June 2027/, "the terms read from JPS's PDF are printed");
    assert.match(page, /Container size:<\/th><td>1 x 40' FCL and 1 x 20' GP/);
    assert.deepEqual(m.terms, { lastShipmentDate: '2027-06-15', expiryDate: '2027-06-30', containers: "1 x 40' FCL and 1 x 20' GP" }, 'the copy remembers the terms it printed');

    const preview = await (await renderApi.onRequestGet({ env, params: { id: SHIP }, request: new Request('https://hub.test/x?doc=jps') })).text();
    assert.match(preview, /Preview — use Generate/);
});

test('a refused invoice is logged with what Xero said and what was sent; the next success clears it', async () => {
    await stageOne();
    xeroRefuse = { status: 400, body: { ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{
        ValidationErrors: [{ Message: 'Organisation is not subscribed to currency USD' }],
        LineItems: [{ ValidationErrors: [{ Message: "Account code '820' is not a valid code for this document." }] }, {}],
    }] } };
    const r = await call(xeroApi.onRequestPost, 'POST', { doc: 'jpsBill' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "Xero 400: Organisation is not subscribed to currency USD; Line 1: Account code '820' is not a valid code for this document.");
    const e = r.body.xeroError;
    assert.deepEqual([e.step, e.xeroStatus, e.request, e.by], ['create', 400, 'POST Invoices', 'andrew@primetie.co.nz']);
    assert.deepEqual(e.details, ['Organisation is not subscribed to currency USD', "Line 1: Account code '820' is not a valid code for this document."]);
    assert.deepEqual([e.sent.type, e.sent.contact, e.sent.currency, e.sent.total], ['ACCPAY', 'JPS Enterprise', 'USD', 32815.3]);
    assert.deepEqual(e.sent.lines.map(l => [l.accountCode, l.taxType]), [['820', 'NONE'], ['631', 'NONE']]);
    assert.match(e.response, /not subscribed to currency USD/);

    const v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.equal(v.xero.errors.jpsBill.message, r.body.error);
    assert.equal(v.record.log[0].action, `JPS bill not created in Xero (creating the invoice): ${r.body.error}`);
    assert.equal(v.record.log[0].by, 'andrew@primetie.co.nz');

    xeroRefuse = { status: 503, raw: '<html>Service Unavailable</html>' };
    const down = await call(xeroApi.onRequestPost, 'POST', { doc: 'jpsBill' });
    assert.equal(down.status, 502);
    assert.match(down.body.error, /^Xero 503: <html>Service Unavailable/);
    assert.equal(down.body.xeroError.response, '<html>Service Unavailable</html>');

    xeroRefuse = null;
    const ok = await call(xeroApi.onRequestPost, 'POST', { doc: 'jpsBill' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.xero.errors.jpsBill, undefined, 'a success clears the last error');
});

test('a lapsed Xero connection is logged as a sign-in failure with where to reconnect', async () => {
    await stageOne();
    await env.XERO_KV.put('tokens', JSON.stringify({ accessToken: 'old', refreshToken: 'dead', expiresAt: 0, tenantId: 't1' }));
    const realStub = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).startsWith('https://identity.xero.com')
        ? new Response('{"error":"invalid_grant"}', { status: 400 }) : realStub(url, init);
    const r = await call(xeroApi.onRequestPost, 'POST', { doc: 'supplierBill' });
    globalThis.fetch = realStub;
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Xero session expired — reconnect Xero in Settings → Integrations');
    assert.equal(r.body.xeroError.step, 'auth');
    const v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.match(v.record.log[0].action, /^Pistoni bill not created in Xero \(signing in to Xero\): Xero session expired/);

    const rf = await call(xeroApi.onRequestPost, 'POST', { refresh: true });
    assert.equal(rf.status, 200, 'nothing in Xero yet, so nothing to refresh');
});

test('NZD mode (no multi-currency in Xero): EUR and USD documents go in as NZD at the day\'s rate', async () => {
    await stageOne({ currencyMode: 'nzd' });
    await env.ORDERS_KV.put('fx:nzd:latest', JSON.stringify({ rates: { EUR: 0.5, USD: 0.6 }, at: '2026-11-16T20:00:00Z' }));
    let v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.equal(v.xero.currencyMode, 'nzd');
    assert.deepEqual(v.xero.docs.map(d => d.nzdEstimate?.total), [34525.5, 35655.67, 54692.17], 'estimates at the last known rate');

    for (const doc of ['supplierBill', 'salesInvoice', 'jpsBill']) {
        const r = await call(xeroApi.onRequestPost, 'POST', { doc });
        assert.equal(r.status, 200, doc + ': ' + JSON.stringify(r.body));
    }
    const [bill, sale, jps] = xeroCalls.filter(c => c.method === 'POST' && c.path.startsWith('Invoices')).map(p => p.body.Invoices[0]);
    // Today's rate from the forex feed (EUR 0.53, USD 0.6), not the cached one
    assert.deepEqual([bill.CurrencyCode, sale.CurrencyCode, jps.CurrencyCode], ['NZD', 'NZD', 'NZD']);
    assert.deepEqual(bill.LineItems.map(l => [l.Quantity, l.UnitAmount, l.AccountCode]), [[1, 13831.13, '630'], [1, 18740.09, '630']]);
    assert.match(bill.LineItems[0].Description, /— EUR 7,330\.50 @ 1 NZD = 0\.5300 EUR on \d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(sale.LineItems.map(l => [l.Quantity, l.UnitAmount]), [[1, 35655.67]]);          // USD 21,393.40 / 0.6
    assert.deepEqual(jps.LineItems.map(l => [l.Quantity, l.UnitAmount, l.AccountCode]), [[1, 35655.67, '820'], [1, 19036.5, '631']]);  // 21,393.40 + 11,421.90 USD

    v = (await call(recordApi.onRequestGet, 'GET')).body;
    const pushed = Object.fromEntries(v.xero.docs.map(d => [d.key, d]));
    assert.deepEqual(pushed.supplierBill.pushed.fx, { currency: 'EUR', rate: 0.53, rateDate: pushed.supplierBill.pushed.fx.rateDate, foreignTotal: 17262.75 });
    assert.equal(pushed.supplierBill.pushed.currency, 'NZD');
    assert.ok(v.xero.docs.every(d => d.inXero && !d.changedSincePush), 'NZD totals are not mistaken for a change');
    assert.match(v.record.log.find(l => /Created the Pistoni bill/.test(l.action)).action, /NZD 32,571\.22 \(EUR 17,262\.75 @ 1 NZD = 0\.5300 EUR\)$/);
});

test('NZD mode with no exchange rate at all: logged, nothing sent to Xero', async () => {
    await stageOne({ currencyMode: 'nzd' });
    const realStub = globalThis.fetch;
    globalThis.fetch = async (url, init) => String(url).startsWith('https://open.er-api.com') ? new Response('down', { status: 503 }) : realStub(url, init);
    const r = await call(xeroApi.onRequestPost, 'POST', { doc: 'supplierBill' });
    globalThis.fetch = realStub;
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'No EUR → NZD exchange rate available');
    assert.equal(r.body.xeroError.step, 'rate');
    assert.ok(!xeroCalls.some(c => c.path.startsWith('Invoices')), 'nothing reached Xero');
});

test("JPS's proforma invoice: confirm locks it, unlock clears it, a new PDF needs confirming again", async () => {
    const v = await stageOne();
    assert.equal(v.xero.docs.find(d => d.key === 'jpsBill').issues.length, 0);
    const edit = await call(recordApi.onRequestPatch, 'PATCH', { jps: { ...v.record.jps, total: 1 } });
    assert.equal(edit.status, 409, 'locked while confirmed');
    const un = await call(recordApi.onRequestPatch, 'PATCH', { jpsConfirm: false });
    assert.equal(un.body.record.jpsConfirmed, null);
    assert.deepEqual(un.body.xero.docs.find(d => d.key === 'jpsBill').issues, ["Confirm JPS's proforma invoice in step 3"]);
    assert.match(un.body.record.log[0].action, /Unlocked JPS's proforma invoice/);
    await call(recordApi.onRequestPatch, 'PATCH', { jpsConfirm: true });
    const again = await call(extractApi.onRequestPost, 'POST', { kind: 'jpsInvoice', filename: 'JPS-118b.pdf', data: B64 });
    assert.equal(again.body.record.jpsConfirmed, null);
});

test('reconciliation: the three proformas side by side, differences worked out', async () => {
    const v = await stageOne();
    const rc = v.reconciliation;
    assert.deepEqual(rc.docs.map(d => [d.key, d.kg, d.currency, d.amount]), [
        ['packing', 18130, null, null], ['supplier', 18130, 'EUR', 17262.75], ['ours', 18130, 'USD', 21393.4], ['jps', 18130, 'USD', 32815.3]]);
    assert.deepEqual(rc.diffs.map(d => [d.id, d.status]), [['kg', 'ok'], ['margin', 'ok'], ['dates', 'ok']]);
    assert.equal(rc.diffs[1].text, "JPS's is USD 11,421.90 more than ours = USD 0.63/kg handling & sorting (usual 0.63/kg)");
});

test('error messages can be dismissed once read; the activity log keeps them', async () => {
    await stageOne();
    xeroRefuse = { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: 'Organisation is not subscribed to currency EUR' }] }] } };
    await call(xeroApi.onRequestPost, 'POST', { doc: 'supplierBill' });
    xeroRefuse = null;
    let v = (await call(recordApi.onRequestGet, 'GET')).body;
    assert.ok(v.xero.errors.supplierBill);
    v = (await call(recordApi.onRequestPatch, 'PATCH', { dismissXeroError: 'supplierBill' })).body;
    assert.equal(v.xero.errors.supplierBill, undefined);
    assert.equal(v.record.log[0].action, 'Dismissed the Xero error on Pistoni bill');
    assert.ok(v.record.log.some(l => /not subscribed to currency EUR/.test(l.action)), 'the failure stays in the log');
});

test("a tax code this Xero doesn't have stops before anything is sent, with the real ones listed", async () => {
    await stageOne();
    const st = (await call(settingsApi.onRequestGet, 'GET')).body.settings;
    st.xero.taxTypes.exportSale = 'ZERORATEDOUTPUT_X';
    await call(settingsApi.onRequestPut, 'PUT', { settings: st });
    const r = await call(xeroApi.onRequestPost, 'POST', { doc: 'salesInvoice' });
    assert.equal(r.status, 422);
    assert.equal(r.body.xeroError.summary, 'Xero has no tax rate ZERORATEDOUTPUT_X — choose one in Document settings → Xero');
    assert.match(r.body.xeroError.message, /Its rates: Zero Rated \(ZERORATED\), No GST \(NONE\)/);
    assert.equal(r.body.xeroError.step, 'tax');
    assert.ok(!xeroCalls.some(c => c.method === 'POST' && c.path.startsWith('Invoices')), 'nothing was sent to Xero');
});

test('a Xero refusal reads as one plain sentence; the full reply stays in the details', async () => {
    await stageOne();
    xeroRefuse = { status: 400, body: { Elements: [{ ValidationErrors: [{ Message: 'The TaxType code ZERORATEDOUTPUT does not exist or cannot be used for this type of transaction.' }] }] } };
    const r = await call(xeroApi.onRequestPost, 'POST', { doc: 'salesInvoice' });
    xeroRefuse = null;
    assert.equal(r.body.xeroError.summary, "Xero doesn't accept the tax rate ZERORATEDOUTPUT — choose another in Document settings → Xero");
    assert.match(r.body.xeroError.message, /^Xero 400: The TaxType code ZERORATEDOUTPUT/);
});
