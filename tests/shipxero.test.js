// Stage 1 money (functions/api/import/_shipxero.js): the JPS invoice split,
// the three Xero invoices and the cost breakdown they fill. Shipment 43.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseStandardNumber, jpsFromExtraction, jpsSplit, jpsChecks, xeroDocs, xeroPayload, xeroState, xeroDate, xeroUrl,
    xeroValidationMessage, costPlan, sanitiseJps,
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
        jps: jpsFromExtraction(JPS_EXTRACT), lc: {}, outputs: [], xero: {}, ...extra,
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
    assert.deepEqual(sale.lines.map(l => [l.Quantity, l.UnitAmount, l.AccountCode, l.TaxType]), [[18130, 1.18, '200', 'ZERORATEDOUTPUT']]);
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
    assert.ok(docs[1].issues.includes('Tick the invoice number and export rate first'));
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
