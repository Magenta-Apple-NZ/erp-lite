// Stage 1 money (functions/api/import/_shipxero.js): the JPS invoice split,
// the three Xero invoices and the cost breakdown they fill. Shipment 43.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseStandardNumber, jpsFromExtraction, jpsSplit, jpsChecks, xeroDocs, xeroPayload, xeroState, xeroDate, xeroUrl,
    xeroValidationMessage, costPlan, sanitiseJps, convertDocToNzd, reconcile,
} from '../functions/api/import/_shipxero.js';
import { mergeSettings, reviewFromPackingExtraction, reviewFromProformaExtraction, sanitiseSettings } from '../functions/api/import/_exportdocs.js';

const BALES = [442,495,494,495,551,500,508,504,467,527,385,370,432,443,404,370,400,376,339,291,429,371,331,348,383,394,202,327,406,379,334,352,415,395,326,292,363,359,397,288,474,480,466,369,457]
    .map((kg, i) => ({ n: i + 1, kg, colour: [1, 9, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 45].includes(i + 1) ? 'white' : 'coloured' }));

function confirmed43() {
    return {
        ...reviewFromPackingExtraction({ shipmentNumber: 43, bales: BALES, whiteTotalKg: 4887, colouredTotalKg: 13243, totalPackages: 45 }),
        supplierInvoice: reviewFromProformaExtraction({
            documentNumber: '23', documentDate: '2026-11-12', currency: 'EUR',
            lines: [
                { description: 'Toeclips white', colour: 'white', kg: 4887, unitPrice: 1.5, amount: 7330.5 },
                { description: 'Toeclips coloured', colour: 'coloured', kg: 13243, unitPrice: 0.75, amount: 9932.25 },
            ],
            netWeightKg: 18130, total: 17262.75,
        }),
    };
}
const JPS_EXTRACT = {
    invoiceNumber: 'JPS/2026/118', invoiceDate: '2026-11-20', invoiceDateRaw: '20.11.2026', currency: 'USD',
    lines: [{ description: 'Handling, sorting and LC charges — 18,130 kg', kg: 18130, kgRaw: '18,130', unitPrice: 1.81, unitPriceRaw: '1.81', amount: 32815.3, amountRaw: '32,815.30' }],
    netWeightKg: 18130, netWeightRaw: '18,130', total: 32815.3, totalRaw: '32,815.30',
};
const XERO_SETTINGS = mergeSettings({ xero: { accounts: { rawProduct: '630', lcDeposit: '820', handling: '631', exportSale: '200' } } });
function rec(extra = {}) {
    const c = confirmed43();
    return {
        confirmed: c, review: c,
        exportInvoice: { number: '102/2026', date: '2026-11-13', rate: 1.18, currency: 'USD', numberConfirmed: true, rateConfirmed: true },
        jps: jpsFromExtraction(JPS_EXTRACT), jpsConfirmed: { at: '2026-11-20T01:00:00Z', by: 'andrew@primetie.co.nz' }, lc: {}, outputs: [], xero: {}, ...extra,
    };
}

test('standard (English) number format on the JPS invoice', () => {
    assert.equal(parseStandardNumber('32,815.30'), 32815.3);
    assert.equal(parseStandardNumber('USD 1.81'), 1.81);
    assert.equal(parseStandardNumber('18,130 kg'), 18130);
    assert.equal(parseStandardNumber('(1,234.00)'), -1234);
    assert.equal(parseStandardNumber('32.815,30'), null, 'Italian formatting is not accepted here');
});

test('JPS invoice splits into the LC deposit (our proforma) and handling & sorting', () => {
    const s = jpsSplit(rec());
    assert.equal(s.netKg, 18130);
    assert.equal(s.depositAmount, 21393.4);     // = our proforma 102/2026
    assert.equal(s.handlingAmount, 11421.9);    // 18,130 × 0.63
    assert.equal(s.handlingRate, 0.63);
    assert.equal(s.total, 32815.3);
});

test('JPS checks pass for Shipment 43 and catch a short invoice', () => {
    const ok = jpsChecks(rec(), { settings: XERO_SETTINGS });
    for (const c of ok) assert.notEqual(c.ok, false, `${c.id}: ${c.detail}`);
    assert.match(ok.find(c => c.id === 'jps-margin').detail, /USD 0\.63\/kg \(usual 0\.63\/kg\)/);

    const short = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), total: 20000, totalRaw: null, lines: [] } });
    const c = jpsChecks(short, { settings: XERO_SETTINGS });
    assert.equal(c.find(x => x.id === 'jps-deposit').ok, false);

    const high = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), total: 35000, totalRaw: null, lines: [] } });
    const m = jpsChecks(high, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-margin');
    assert.equal(m.ok, false);
    assert.match(m.detail, /0\.7505/);

    const typo = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), totalRaw: '32,851.30' } });
    assert.equal(jpsChecks(typo, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-printed').ok, false);
});

test('the previous shipment\'s margin is the yardstick when there is one', () => {
    const m = jpsChecks(rec(), { settings: XERO_SETTINGS, typicalMargin: 0.72 }).find(x => x.id === 'jps-margin');
    assert.equal(m.ok, true);
    assert.match(m.detail, /usual 0\.72/);
});

test('three Xero documents with the right type, contact, currency and totals', () => {
    const docs = xeroDocs({ record: rec(), settings: XERO_SETTINGS, shipmentNumber: 43 });
    const [bill, sale, jps] = docs;
    assert.deepEqual(docs.map(d => [d.key, d.type, d.contactName, d.currency, d.total]), [
        ['supplierBill', 'ACCPAY', 'Pistoni SRL', 'EUR', 17262.75],
        ['salesInvoice', 'ACCREC', 'JPS Enterprise', 'USD', 21393.4],
        ['jpsBill', 'ACCPAY', 'JPS Enterprise', 'USD', 32815.3],
    ]);
    for (const d of docs) assert.deepEqual(d.issues, [], d.key);
    assert.deepEqual(bill.lines.map(l => [l.Quantity, l.UnitAmount, l.AccountCode, l.TaxType]), [[4887, 1.5, '630', 'NONE'], [13243, 0.75, '630', 'NONE']]);
    assert.deepEqual(sale.lines.map(l => [l.Quantity, l.UnitAmount, l.AccountCode, l.TaxType]), [[18130, 1.18, '200', 'ZERORATED']]);
    // JPS bill: deposit kg × rate, handling as one exact amount so the bill equals JPS's printed total
    assert.deepEqual(jps.lines.map(l => [l.Quantity, l.UnitAmount, l.AccountCode]), [[18130, 1.18, '820'], [1, 11421.9, '631']]);
    assert.equal(Math.round(18130 * 1.18 * 100) / 100 + 11421.9, 32815.3);
    assert.match(jps.lines[0].Description, /LC deposit — Shipment 43, 18,130 kg @ USD 1\.18\/kg \(our invoice 102\/2026\)/);

    const p = xeroPayload(sale, 'contact-1', 'DRAFT');
    assert.deepEqual([p.Type, p.Status, p.Contact.ContactID, p.Date, p.DueDate, p.InvoiceNumber, p.CurrencyCode, p.Reference],
        ['ACCREC', 'DRAFT', 'contact-1', '2026-11-13', '2026-11-13', '102/2026', 'USD', 'Shipment 43']);
    assert.equal(xeroPayload(bill, 'c', 'PAID').Status, 'DRAFT', 'only DRAFT / SUBMITTED / AUTHORISED can be created');
    assert.equal(xeroPayload(bill, 'c').Reference, undefined, 'bills carry the supplier number, no reference');
});

test('Xero documents wait for account codes, ticks and a JPS invoice', () => {
    const docs = xeroDocs({ record: rec({ jps: null, exportInvoice: { number: '102/2026', date: '2026-11-13', rate: 1.18, currency: 'USD' } }), settings: mergeSettings({}), shipmentNumber: 43 });
    assert.ok(docs[0].issues.includes('Set the raw product account in Document settings → Xero'));
    assert.ok(docs[1].issues.includes('Confirm our proforma invoice in step 2'));
    assert.ok(docs[2].issues.includes('Upload or enter the JPS invoice'));
});

test('payments read back from Xero in NZD (Amount ÷ CurrencyRate)', () => {
    const st = xeroState({
        InvoiceID: 'inv-1', InvoiceNumber: '23', Status: 'PAID', CurrencyCode: 'EUR', Total: 17262.75, AmountPaid: 17262.75, AmountDue: 0,
        CurrencyRate: 0.52, FullyPaidOnDate: '/Date(1763596800000+0000)/',
        Payments: [{ Date: '/Date(1763596800000+0000)/', Amount: 10000, CurrencyRate: 0.5 }, { Date: '/Date(1763683200000+0000)/', Amount: 7262.75 }],
    });
    assert.equal(st.status, 'PAID');
    assert.deepEqual(st.payments.map(p => p.nzd), [20000, 13966.83]);
    assert.equal(st.nzdPaid, 33966.83);
    assert.equal(st.paidOn, '2025-11-20');
    assert.equal(xeroDate('2026-11-13T00:00:00'), '2026-11-13');
    assert.equal(xeroUrl('ACCPAY', 'x'), 'https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=x');
    assert.equal(xeroValidationMessage({ Elements: [{ ValidationErrors: [{ Message: 'Account code 999 is not valid' }] }] }), 'Account code 999 is not valid');
});

test('cost plan joins the documents to the cost breakdown lines', () => {
    const shipment = {
        schema: 3, whiteRawKg: 4430, colourRawKg: 11454,
        fixedLines: {
            rawWhite: { rate: 1.5, ccy: 'EUR' }, rawColour: { rate: 0.75, ccy: 'EUR' },
            handlingA: { rate: 0.63, ccy: 'USD' }, handlingB: { rate: 1.18, ccy: 'USD' }, lcRefund: { rate: -1.18, ccy: 'USD' },
        },
    };
    const r = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), total: 33000, totalRaw: null, lines: [] } });
    const plan = costPlan({ shipment, record: r });
    assert.deepEqual(plan.patch.whiteRawKg, 4887);
    assert.deepEqual(plan.patch.colourRawKg, 13243);
    // rates already match except handling, which follows the JPS invoice
    assert.deepEqual(plan.patch.fixedLines, { handlingA: { rate: 0.6402 } });
    assert.deepEqual(plan.changes.map(c => c.label), ['Net Weight Breakdown', 'Handling & Sorting rate']);

    // Payments in Xero land as actual NZD, split on the JPS bill by deposit / handling
    const paid = rec({
        xero: {
            supplierBill: { status: 'PAID', nzdPaid: 30500 },
            salesInvoice: { status: 'AUTHORISED', nzdPaid: 0 },
            jpsBill: { status: 'PAID', nzdPaid: 56000 },
        },
    });
    const p2 = costPlan({ shipment: { ...shipment, whiteRawKg: 4887, colourRawKg: 13243 }, record: paid });
    assert.deepEqual(p2.patch.sectionActuals, { raw: 30500 });
    assert.equal(p2.patch.fixedLines.rawWhite.paid, true);
    assert.equal(p2.patch.fixedLines.handlingB.actual, Math.round(56000 * 21393.4 / 32815.3 * 100) / 100);
    assert.equal(Math.round((p2.patch.fixedLines.handlingA.actual + p2.patch.fixedLines.handlingB.actual) * 100) / 100, 56000);
    assert.equal(p2.patch.fixedLines.lcRefund, undefined, 'unpaid sales invoice leaves LC Refund alone');

    const lc = costPlan({ shipment: { ...shipment, whiteRawKg: 4887, colourRawKg: 13243 }, record: rec({ xero: { salesInvoice: { status: 'PAID', nzdPaid: 36500 } } }) });
    assert.deepEqual(lc.patch.fixedLines.lcRefund, { actual: -36500, paid: true });

    assert.deepEqual(costPlan({ shipment: { ...shipment, schema: undefined }, record: r }).changes, [], 'V2 shipments are left alone');
});

test('JPS and Xero settings are sanitised', () => {
    const s = sanitiseSettings({ jpsMarginPerKg: '0.65', xero: { status: 'PAID', accounts: { handling: ' 631 ' } } });
    assert.equal(s.jpsMarginPerKg, 0.65);
    assert.equal(s.xero.status, 'DRAFT');
    assert.equal(s.xero.accounts.handling, '631');
    assert.equal(sanitiseJps({ number: 'X', total: '100', lines: [{ kg: '5', amount: 'abc' }] }).lines[0].amount, null);
});

test('a line whose rate and currency both change shows as one row', () => {
    const plan = costPlan({ shipment: { schema: 3, whiteRawKg: 4887, colourRawKg: 13243, fixedLines: {} }, record: rec() });
    assert.deepEqual(plan.changes.map(c => c.label), ['White Toeclips rate', 'Coloured Toeclips rate', 'LC Deposit rate', 'LC Refund rate', 'Handling & Sorting rate']);
    assert.equal(plan.changes[0].to, 'EUR 1.50/kg');
    assert.deepEqual(plan.patch.fixedLines.rawWhite, { rate: 1.5, ccy: 'EUR' }, 'the currency is still written');
    assert.deepEqual(plan.patch.fixedLines.lcRefund, { rate: -1.18, ccy: 'USD' });
});

test('JPS figures printed with currency marks read as numbers ("USD$1.82")', () => {
    for (const [raw, n] of [['USD$1.82', 1.82], ['US$32,996.60', 32996.6], ['US$ 32,996.60', 32996.6], ['1.82/kg', 1.82], ['1.82 USD/kg', 1.82], ['18,130 kg', 18130]]) {
        assert.equal(parseStandardNumber(raw), n, raw);
    }
    assert.equal(parseStandardNumber('1.8x'), null);
    const r = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), lines: [{ description: 'Toeclip', kg: 18130, kgRaw: '18,130', unitPrice: 1.81, unitPriceRaw: 'USD$1.81', amount: 32815.3, amountRaw: 'US$32,815.30' }] } });
    assert.equal(jpsChecks(r, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-printed').ok, true);
});

test('JPS checks can be dismissed, except the number, currency and deposit', () => {
    const typo = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), totalRaw: '32,851.30' } });
    const c = jpsChecks(typo, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-printed');
    assert.equal(c.ok, false);
    const dismissed = { 'jps-printed': { detail: c.detail, by: 'andrew@primetie.co.nz', at: '2026-11-17T01:00:00Z' } };
    const after = jpsChecks({ ...typo, dismissed }, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-printed');
    assert.equal(after.dismissed.by, 'andrew@primetie.co.nz');

    const noNumber = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), number: '' } });
    const n = jpsChecks(noNumber, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-number');
    assert.equal(n.dismissible, false);
    const short = rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), total: 20000, totalRaw: null, lines: [] } });
    assert.equal(jpsChecks(short, { settings: XERO_SETTINGS }).find(x => x.id === 'jps-deposit').dismissible, false);
});

test('converting a document to NZD: one line each, to the cent, original amount and rate kept', () => {
    const d = { currency: 'EUR', total: 17262.75, lines: [{ Description: 'White toeclips — Shipment 43', Quantity: 4887, UnitAmount: 1.5, AccountCode: '630' }, { Description: 'Coloured', Quantity: 13243, UnitAmount: 0.75 }] };
    const { doc, fx } = convertDocToNzd(d, 0.53, '2026-11-17');
    assert.equal(doc.currency, 'NZD');
    assert.deepEqual(doc.lines.map(l => [l.Quantity, l.UnitAmount, l.AccountCode]), [[1, 13831.13, '630'], [1, 18740.09, undefined]]);
    assert.equal(doc.lines[0].Description, 'White toeclips — Shipment 43 — EUR 7,330.50 @ 1 NZD = 0.5300 EUR on 2026-11-17');
    assert.equal(doc.total, 32571.22);
    assert.deepEqual(fx, { currency: 'EUR', rate: 0.53, rateDate: '2026-11-17', foreignTotal: 17262.75 });
    assert.deepEqual(convertDocToNzd({ currency: 'NZD', lines: [] }, 1).fx, null);
    assert.throws(() => convertDocToNzd(d, undefined), /No EUR → NZD exchange rate available/);
});

test('reconciliation flags JPS dated before ours, a weight that differs, an unusual margin, and waits honestly', () => {
    // Shipment 43 as it came: JPS's dated 10 Nov at USD 1.82/kg, ours dated 17 Nov
    const r43 = rec({
        exportInvoice: { number: '102/2026', date: '2026-11-17', rate: 1.18, currency: 'USD', numberConfirmed: true, rateConfirmed: true },
        jps: { ...jpsFromExtraction(JPS_EXTRACT), number: 'JPSE-102/2026', date: '2026-11-10', total: 32996.6, lines: [{ kg: 18130, unitPrice: 1.82, amount: 32996.6 }] },
    });
    const rc = reconcile(r43, { typicalMargin: 0.63, fxRates: { EUR: 0.5, USD: 0.6 } });
    const by = Object.fromEntries(rc.diffs.map(d => [d.id, d]));
    assert.equal(by.kg.status, 'ok');
    assert.equal(by.margin.status, 'ok');
    assert.equal(by.margin.text, "JPS's is USD 11,603.20 more than ours = USD 0.64/kg handling & sorting (usual 0.63/kg)");
    assert.equal(by.dates.status, 'warn');
    assert.match(by.dates.text, /JPS's proforma invoice \(10 Nov 2026\) is dated before our proforma invoice \(17 Nov 2026\)/);
    assert.deepEqual(rc.docs.map(d => d.nzd), [null, 34525.5, 35655.67, 54994.33]);
    assert.equal(rc.docs.find(d => d.key === 'jps').rate, 1.82);

    const short = reconcile(rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), netKg: 18000, lines: [] } }), { typicalMargin: 0.63 });
    assert.equal(short.diffs[0].status, 'warn');
    assert.match(short.diffs[0].text, /JPS's proforma invoice 18,000 kg is 130 kg less than the packing list \(18,130 kg\)/);

    const high = reconcile(rec({ jps: { ...jpsFromExtraction(JPS_EXTRACT), total: 40000, lines: [] } }), { typicalMargin: 0.63 });
    assert.equal(high.diffs[1].status, 'warn');

    const none = reconcile(rec({ jps: null }), { typicalMargin: 0.63 });
    assert.deepEqual(none.diffs.map(d => d.status), ['ok', 'wait', 'ok']);
    assert.equal(none.diffs[1].text, "Waiting for JPS's proforma invoice");
    assert.match(none.diffs[0].text, /\(JPS's not in yet\)$/);
});
