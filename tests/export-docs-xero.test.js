// Stage 1 money end to end: JPS invoice → three invoices created in Xero →
// payments read back → cost breakdown plan. Claude and Xero are stubbed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as recordApi from '../functions/api/import/export-docs/[id]/index.js';
import * as extractApi from '../functions/api/import/export-docs/[id]/extract.js';
import * as confirmApi from '../functions/api/import/export-docs/[id]/confirm.js';
import * as xeroApi from '../functions/api/import/export-docs/[id]/xero.js';
import * as settingsApi from '../functions/api/import/export-docs/settings.js';

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
        netWeightKg: 18130, netWeightRaw: '18,130', total: 32815.3, totalRaw: '32,815.30', notes: '' },
};

let env, realFetch, xeroCalls, xeroInvoices;
beforeEach(() => {
    env = {
        ANTHROPIC_API_KEY: 'k',
        ORDERS_KV: kv({ 'import:forecast': { shipments: [{ id: SHIP, seq: 43, schema: 3, whiteRawKg: 4430, colourRawKg: 11454,
            fixedLines: { rawWhite: { rate: 1.5, ccy: 'EUR' }, rawColour: { rate: 0.75, ccy: 'EUR' }, handlingA: { rate: 0.63, ccy: 'USD' }, handlingB: { rate: 1.18, ccy: 'USD' }, lcRefund: { rate: -1.18, ccy: 'USD' } },
            milestones: [] }] } }),
        XERO_KV: kv({ tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600e3, tenantId: 't1' } }),
    };
    xeroCalls = []; xeroInvoices = new Map();
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
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
            if (path === 'Contacts' && init.method === 'POST') return json({ Contacts: [{ ContactID: 'c-' + body.Contacts[0].Name.split(' ')[0].toLowerCase(), Name: body.Contacts[0].Name }] });
            if (path.startsWith('Invoices?') && init.method === 'POST') {
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

async function stageOne({ accounts = true } = {}) {
    for (const kind of ['packingList', 'proforma']) assert.equal((await call(extractApi.onRequestPost, 'POST', { kind, filename: kind + '.pdf', data: B64 })).status, 200);
    assert.equal((await call(confirmApi.onRequestPost, 'POST', {})).status, 200);
    const s = (await call(settingsApi.onRequestGet, 'GET')).body.settings;
    if (accounts) s.xero.accounts = { rawProduct: '630', lcDeposit: '820', handling: '631', exportSale: '200' };
    await call(settingsApi.onRequestPut, 'PUT', { settings: s });
    const v = (await call(recordApi.onRequestGet, 'GET')).body;
    await call(recordApi.onRequestPatch, 'PATCH', { exportInvoice: { ...v.record.exportInvoice, numberConfirmed: true, rateConfirmed: true } });
    const j = await call(extractApi.onRequestPost, 'POST', { kind: 'jpsInvoice', filename: 'JPS-118.pdf', data: B64 });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    return j.body;
}

test('JPS invoice is read, split and checked', async () => {
    const v = await stageOne();
    assert.equal(v.record.jps.number, 'JPS-118');
    assert.deepEqual([v.jpsSplit.depositAmount, v.jpsSplit.handlingAmount, v.jpsSplit.handlingRate], [21393.4, 11421.9, 0.63]);
    for (const c of v.jpsChecks) assert.notEqual(c.ok, false, `${c.id}: ${c.detail}`);
    assert.match(v.record.log[0].action, /Read the JPS invoice \(invoice JPS-118, USD 32,815\.30\)/);
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
    assert.deepEqual([sale.Type, sale.Contact.ContactID, sale.CurrencyCode, sale.InvoiceNumber, sale.LineItems[0].TaxType], ['ACCREC', 'c-jps', 'USD', '102/2026', 'ZERORATEDOUTPUT']);
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
