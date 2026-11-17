// Shipment export documents (functions/api/import/_exportdocs.js, _xlsx.js).
// Acceptance fixture: Shipment 43 (Pistoni packing list + PROFORMA 23).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseItalianNumber, invoiceAmount, longDate, ordinal, normaliseBales, baleTotals, splitBaleColumns,
    reviewFromPackingExtraction, reviewFromProformaExtraction, runChecks, blockingFailures,
    nextInvoiceNumber, exportInvoiceDefaults, deriveStatus, generationIssues, lcCrossChecks,
    renderPackingList, renderProforma, packingListWorkbookSpec, mergeSettings, missingSettings,
    hasUnconfirmedChanges, docFilename, SETTINGS_SEED, renderJpsContract, amountInWords,
} from '../functions/api/import/_exportdocs.js';
import { buildXlsx, crc32 } from '../functions/api/import/_xlsx.js';

// ── Shipment 43 fixture (from the brief) ─────────────────────────────────
const FIXTURE_43 = `1,442,white
2,495,coloured
3,494,coloured
4,495,coloured
5,551,coloured
6,500,coloured
7,508,coloured
8,504,coloured
9,467,white
10,527,coloured
11,385,coloured
12,370,coloured
13,432,coloured
14,443,coloured
15,404,coloured
16,370,coloured
17,400,coloured
18,376,coloured
19,339,coloured
20,291,coloured
21,429,coloured
22,371,coloured
23,331,coloured
24,348,coloured
25,383,coloured
26,394,coloured
27,202,coloured
28,327,coloured
29,406,coloured
30,379,coloured
31,334,white
32,352,white
33,415,white
34,395,white
35,326,white
36,292,white
37,363,white
38,359,white
39,397,white
40,288,white
41,474,coloured
42,480,coloured
43,466,coloured
44,369,coloured
45,457,white`.split('\n').map(l => { const [n, kg, colour] = l.split(','); return { n: Number(n), kg: Number(kg), colour }; });

// What the model is asked to return for the two Pistoni PDFs.
const PACKING_EXTRACT_43 = {
    shipmentNumber: 43, shipmentNumberRaw: '43',
    bales: FIXTURE_43.map(b => ({ ...b, kgRaw: String(b.kg) })),
    whiteTotalKg: 4887, whiteTotalRaw: '4.887',
    colouredTotalKg: 13243, colouredTotalRaw: '13.243',
    totalPackages: 45, totalPackagesRaw: '45',
};
const PROFORMA_EXTRACT_43 = {
    documentNumber: '23', documentDate: '2026-11-12', documentDateRaw: '12/11/2026', currency: 'EUR',
    lines: [
        { description: 'Toeclips white', colour: 'white', kg: 4887, kgRaw: '4.887', unitPrice: 1.5, unitPriceRaw: '1,50', amount: 7330.5, amountRaw: '7.330,50' },
        { description: 'Toeclips colored', colour: 'coloured', kg: 13243, kgRaw: '13.243', unitPrice: 0.75, unitPriceRaw: '0,75', amount: 9932.25, amountRaw: '9.932,25' },
    ],
    netWeightKg: 18130, netWeightRaw: '18.130',
    total: 17262.75, totalRaw: '17.262,75',
    destination: 'JPS Enterprise, Dhaka', deliveryTerms: 'Ex Works Castel Goffredo', hsCode: '6002.90.00',
};

function review43() {
    return { ...reviewFromPackingExtraction(PACKING_EXTRACT_43), supplierInvoice: reviewFromProformaExtraction(PROFORMA_EXTRACT_43) };
}
const SETTINGS_FILLED = mergeSettings({
    reviewedAt: '2026-11-13T00:00:00Z',
    seller: { phone: '+64 9 000 0000', gstNumber: '000-000-000' },
    bank: { name: 'Test Bank', addressLines: ['1 Test St', 'Auckland'], swift: 'TESTNZ22' },
    identifiers: { irc: 'IRC-1', applicantTin: 'TIN-1', applicantBin: 'BIN-1', bankBin: 'BBIN-1', bankTin: 'BTIN-1', bankVatReg: 'VAT-1' },
});
function record43(extra = {}) {
    const r = review43();
    return {
        review: r, confirmed: structuredClone(r),
        exportInvoice: { number: '102/2026', date: '2026-11-13', rate: 1.18, currency: 'USD', numberConfirmed: true, rateConfirmed: true },
        lc: {}, outputs: [], ...extra,
    };
}

// ── Number parsing ───────────────────────────────────────────────────────
test('Italian numbers: dot thousands, comma decimals, never a generic float parse', () => {
    assert.equal(parseItalianNumber('4.887'), 4887);
    assert.equal(parseItalianNumber('13.243'), 13243);
    assert.equal(parseItalianNumber('7.330,50'), 7330.5);
    assert.equal(parseItalianNumber('17.262,75'), 17262.75);
    assert.equal(parseItalianNumber('EUR 9.932,25'), 9932.25);
    assert.equal(parseItalianNumber('€ 1,50'), 1.5);
    assert.equal(parseItalianNumber('0,75'), 0.75);
    assert.equal(parseItalianNumber('18.130 kg'), 18130);
    assert.equal(parseItalianNumber('45'), 45);
    assert.equal(parseItalianNumber('1.234.567,8'), 1234567.8);
    assert.equal(parseItalianNumber('1.50'), null, 'a dot followed by two digits is not Italian formatting');
    assert.equal(parseItalianNumber('4,887.00'), null);
    assert.equal(parseItalianNumber(''), null);
    assert.equal(parseItalianNumber(null), null);
});

test('invoice amount is net kg × rate to the cent', () => {
    assert.equal(invoiceAmount(18130, 1.18), 21393.40);
    assert.equal(invoiceAmount(18754, 1.18), 22129.72); // Shipment 42 reference
    assert.equal(invoiceAmount(1, 0.333), 0.33);
    assert.equal(invoiceAmount(0, 1.18), 0);
});

test('long dates and ordinals', () => {
    assert.equal(longDate('2026-11-13'), '13th November 2026');
    assert.equal(longDate('2026-06-01'), '1st June 2026');
    assert.equal(longDate('2026-06-22'), '22nd June 2026');
    assert.equal(longDate('2026-06-23'), '23rd June 2026');
    assert.equal(longDate('2026-06-11'), '11th June 2026');
    assert.equal(ordinal(112), '112th');
    assert.equal(longDate('13/11/2026'), '');
});

// ── Shipment 43 acceptance ───────────────────────────────────────────────
test('Shipment 43: extraction maps to exactly the fixture', () => {
    const r = reviewFromPackingExtraction(PACKING_EXTRACT_43);
    assert.deepEqual(r.bales, FIXTURE_43);
    assert.equal(r.shipmentNumber, 43);
    assert.equal(r.packing.packages, 45);
});

test('Shipment 43: totals', () => {
    const t = baleTotals(FIXTURE_43);
    assert.equal(t.count, 45);
    assert.equal(t.whiteCount, 13);
    assert.equal(t.colouredCount, 32);
    assert.equal(t.whiteKg, 4887);
    assert.equal(t.colouredKg, 13243);
    assert.equal(t.netKg, 18130);
    assert.equal(t.minKg, 202);
    assert.equal(t.maxKg, 551);
});

test('Shipment 43: every check passes', () => {
    const checks = runChecks(review43(), { shipmentNumber: 43, exportInvoice: { number: '102/2026', rate: 1.18, numberConfirmed: true, rateConfirmed: true } });
    for (const c of checks) assert.notEqual(c.ok, false, `${c.id}: ${c.detail}`);
    assert.equal(blockingFailures(checks).length, 0);
});

test('Shipment 43: packing list splits 23 left, 22 right', () => {
    const [l, r] = splitBaleColumns(FIXTURE_43);
    assert.equal(l.length, 23);
    assert.equal(r.length, 22);
    assert.equal(l[0].n, 1); assert.equal(l.at(-1).n, 23);
    assert.equal(r[0].n, 24); assert.equal(r.at(-1).n, 45);
    // Shipment 42 had 40 bales: 20 + 20
    const forty = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, kg: 400, colour: 'white' }));
    assert.deepEqual(splitBaleColumns(forty).map(c => c.length), [20, 20]);
});

test('Shipment 43: rendered draft packing list and proforma carry the expected values', () => {
    const rec = record43();
    const pl = renderPackingList({ record: rec, settings: SETTINGS_FILLED, stage: 'draft', shipmentNumber: 43 });
    assert.match(pl, /DRAFT PACKING LIST/);
    // One summary row, as on the Shipment 43 draft
    assert.match(pl, /<th>Shipment<\/th><th>No\. of Packages<\/th><th>Net Weight<\/th><th>Date<\/th><\/tr><\/thead>\s*<tbody><tr><td>43<\/td><td>45<\/td><td>18,130<\/td><td>13\/11\/2026<\/td>/);
    assert.doesNotMatch(pl, /Gross Weight/);
    assert.doesNotMatch(pl, /Applicant:/);
    // Two columns: bales 1–23 on the left, 24–45 on the right
    const cols = pl.match(/<table class="col">[\s\S]*?<\/table>/g);
    assert.equal(cols.length, 2);
    assert.match(cols[0], /<tbody><tr><td class="n">1<\/td><td class="kg">442<\/td><\/tr>/);
    assert.match(cols[0], /<td class="n">23<\/td><td class="kg">331<\/td>/);
    assert.match(cols[1], /<tbody><tr><td class="n">24<\/td><td class="kg">348<\/td><\/tr>/);
    assert.match(cols[1], /<td class="n">45<\/td><td class="kg">457<\/td><\/tr><tr><td class="n"><\/td>/);
    assert.match(pl, /Packing Specification: Standard Export Seaworthy/);

    const pf = renderProforma({ record: rec, settings: SETTINGS_FILLED, shipmentNumber: 43 });
    assert.match(pf, /102\/2026/);
    assert.match(pf, /13th November 2026/);
    assert.match(pf, /45 bales of knitted nylon stocking material \(Toeclip\)/);
    assert.match(pf, /18,130 kg toeclip @ \$USD1\.18\/kg/);
    assert.match(pf, /\$USD 21,393\.40/);
    assert.match(pf, /TOTAL @ <em>\$USD1\.18\/kg<\/em><\/td><td class="amt"><strong>\$USD 21,393\.40<\/strong>/);
    assert.match(pf, /HS Code 6002\.90\.00/);
    assert.match(pf, /Total net weight 18,130kg/);
    assert.match(pf, /Goods &amp; Services Tax \(GST\)<\/td><td class="amt">nil<\/td>/);
    assert.match(pf, /No: 102\/2026<\/span><span>Date: 13th November 2026/);
});

test('supplier cost never reaches an output: no EUR, no Pistoni, no white/coloured split', () => {
    const rec = record43({ lc: { number: 'LC-1', date: '2026-12-01', grossKg: 18136 } });
    const outs = [
        renderPackingList({ record: rec, settings: SETTINGS_FILLED, stage: 'draft', shipmentNumber: 43 }),
        renderPackingList({ record: rec, settings: SETTINGS_FILLED, stage: 'final', shipmentNumber: 43 }),
        renderProforma({ record: rec, settings: SETTINGS_FILLED, shipmentNumber: 43 }),
    ];
    for (const doc of outs) {
        const html = doc.replace(/<style>[\s\S]*?<\/style>/, ''); // visible content only
        assert.doesNotMatch(html, /EUR|€|Pistoni|7,330|9,932|17,262|Castel Goffredo/i);
        assert.doesNotMatch(html, /\b4,887\b|\b13,243\b/);
        assert.doesNotMatch(html, /coloured|white/i);
    }
});

test('final packing list adds gross weight, applicant, LC number and date', () => {
    const rec = record43({ lc: { number: '320126011494', date: '2026-12-01', grossKg: 18136 } });
    const html = renderPackingList({ record: rec, settings: SETTINGS_FILLED, stage: 'final', shipmentNumber: 43 });
    assert.match(html, /<h1 class="title">Final Packing List<\/h1>/);
    assert.match(html, /<th>Gross Weight<\/th><th>Date<\/th>/);
    assert.match(html, /<td>18,130<\/td><td>18,136<\/td><td>13\/11\/2026<\/td>/);
    assert.match(html, /<td class="ltr">AA\.<\/td><td colspan="2">Applicant: JPS Enterprise, Komolapur, Holding no:533 Birulia, Savar, Dhaka-1340, Bangladesh<\/td>/);
    assert.match(html, /<td class="ltr">HH\.<\/td><th>LC NO:<\/th><td>320126011494/);
    assert.match(html, /<td class="ltr">II\.<\/td><th>LC DATE OF ISSUE:<\/th><td>01\/12\/2026/);
    assert.match(html, /Packing Specification: EXPORT STANDARD ROAD \/ SEA WORTHY CONDITION/);
});

// ── Checks that should fail ──────────────────────────────────────────────
test('misread bale weight is caught by the colour totals and net weight', () => {
    const r = review43();
    r.bales = r.bales.map(b => b.n === 27 ? { ...b, kg: 2020 } : b); // 202 misread
    const ids = blockingFailures(runChecks(r, { shipmentNumber: 43 })).map(c => c.id);
    assert.ok(ids.includes('colour-totals'));
    assert.ok(ids.includes('net-weight'));
    const range = runChecks(r, { shipmentNumber: 43 }).find(c => c.id === 'bale-range');
    assert.equal(range.ok, false);
    assert.match(range.detail, /bale 27: 2,020 kg/);
});

test('gaps, duplicates and package count are blocking', () => {
    const r = review43();
    r.bales = r.bales.filter(b => b.n !== 12).concat([{ n: 30, kg: 379, colour: 'coloured' }]);
    const c = runChecks(r, { shipmentNumber: 43 }).find(x => x.id === 'bale-sequence');
    assert.equal(c.ok, false);
    assert.match(c.detail, /Duplicate bale 30/);
    assert.match(c.detail, /Missing bale 12/);
});

test('the 4.887 trap: a total read as 4.887 kg fails the printed-number check', () => {
    const r = review43();
    r.packing.whiteTotalKg = 4.887;
    const fails = blockingFailures(runChecks(r, { shipmentNumber: 43 })).map(c => c.id);
    assert.ok(fails.includes('printed-numbers'));
    assert.ok(fails.includes('colour-totals'));
});

test('supplier line that does not multiply out is blocking', () => {
    const r = review43();
    r.supplierInvoice.lines[0].amount = 7330.05;
    r.supplierInvoice.lines[0].amountRaw = null; // typed by hand
    const c = runChecks(r, { shipmentNumber: 43 }).find(x => x.id === 'invoice-lines');
    assert.equal(c.ok, false);
    assert.match(c.detail, /Line 1: 4,887 × 1\.50 = 7,330\.50, printed 7,330\.05/);
});

test('wrong shipment number and unconfirmed rate are warnings, not blocks', () => {
    const r = review43();
    const checks = runChecks(r, { shipmentNumber: 44, exportInvoice: { number: '102/2026', rate: 1.18 } });
    assert.equal(checks.find(c => c.id === 'shipment-number').ok, false);
    assert.equal(checks.find(c => c.id === 'rate-confirmed').ok, false);
    assert.match(checks.find(c => c.id === 'rate-confirmed').detail, /not yet confirmed/);
    assert.equal(blockingFailures(checks).length, 0);
});

test('no supplier proforma yet blocks net weight and invoice checks', () => {
    const r = reviewFromPackingExtraction(PACKING_EXTRACT_43);
    const fails = blockingFailures(runChecks({ ...r, supplierInvoice: null }, { shipmentNumber: 43 })).map(c => c.id);
    assert.deepEqual(fails.sort(), ['invoice-lines', 'net-weight']);
});

// ── Defaults ─────────────────────────────────────────────────────────────
test('invoice number: previous + 1 in the year; counter continues into a new year', () => {
    assert.equal(nextInvoiceNumber(['101/2026'], '2026-11-13'), '102/2026');
    assert.equal(nextInvoiceNumber(['101/2026', '102/2026', 'junk'], '2026-12-01'), '103/2026');
    assert.equal(nextInvoiceNumber(['102/2026'], '2027-02-01'), '103/2027');
    assert.equal(nextInvoiceNumber([], '2026-11-13'), '1/2026');
});

test('export rate defaults to the previous shipment, else the Shipment 42 seed', () => {
    const d1 = exportInvoiceDefaults({ others: [], shipmentNumber: 43, settings: SETTINGS_SEED, today: '2026-11-13' });
    assert.deepEqual([d1.number, d1.rate, d1.rateSource, d1.date], ['102/2026', 1.18, 'Shipment 42', '2026-11-13']);
    const others = [{ shipmentNumber: 43, exportInvoice: { number: '102/2026', rate: 1.21 } }, { shipmentNumber: 45, exportInvoice: { number: '104/2027', rate: 1.5 } }];
    const d2 = exportInvoiceDefaults({ others, shipmentNumber: 44, settings: SETTINGS_SEED, today: '2027-03-01' });
    assert.equal(d2.rate, 1.21);
    assert.equal(d2.rateSource, 'Shipment #43');
    assert.equal(d2.number, '105/2027');
});

// ── Stage and generation gates ───────────────────────────────────────────
test('status: review → draft → LC issued → final', () => {
    assert.equal(deriveStatus({}), 'not_started');
    assert.equal(deriveStatus({ review: review43() }), 'review');
    assert.equal(deriveStatus(record43()), 'draft');
    assert.equal(deriveStatus(record43({ lc: { number: 'X', date: '2026-12-01', grossKg: 18136 } })), 'lc_issued');
    assert.equal(deriveStatus(record43({ lc: { number: 'X', date: '2026-12-01', grossKg: 18136 }, outputs: [{ doc: 'packing', stage: 'final' }] })), 'final');
});

test('generation waits for missing settings and the rate and number ticks', () => {
    const rec = record43();
    // Straight from the seed (commercial invoice + JPS's proforma for the bank): everything is ready.
    assert.deepEqual(generationIssues({ record: rec, settings: mergeSettings({}), doc: 'packing', stage: 'draft', shipmentNumber: 43 }), []);
    assert.deepEqual(generationIssues({ record: rec, settings: mergeSettings({}), doc: 'proforma', shipmentNumber: 43 }), []);
    assert.deepEqual(generationIssues({ record: rec, settings: mergeSettings({ bank: { name: '', swift: '' } }), doc: 'proforma', shipmentNumber: 43 }), [], 'blank saved values keep the seed');
    assert.deepEqual(generationIssues({ record: rec, settings: SETTINGS_FILLED, doc: 'proforma', shipmentNumber: 43 }), []);
    assert.deepEqual(generationIssues({ record: rec, settings: SETTINGS_FILLED, doc: 'packing', stage: 'draft', shipmentNumber: 43 }), []);

    const unticked = record43({ exportInvoice: { ...rec.exportInvoice, rateConfirmed: false } });
    assert.ok(generationIssues({ record: unticked, settings: SETTINGS_FILLED, doc: 'proforma', shipmentNumber: 43 }).includes('Confirm our proforma invoice in section 3'));

    const dup = generationIssues({ record: rec, settings: SETTINGS_FILLED, doc: 'proforma', shipmentNumber: 43, otherInvoiceNumbers: [{ shipmentNumber: 44, number: '102/2026' }] });
    assert.ok(dup.some(i => /already used on Shipment #44/.test(i)));

    const final = generationIssues({ record: rec, settings: SETTINGS_FILLED, doc: 'packing', stage: 'final', shipmentNumber: 43 });
    assert.deepEqual(final, ['LC number missing', 'LC date of issue missing', 'Gross weight missing']);
    const lowGross = generationIssues({ record: record43({ lc: { number: 'X', date: '2026-12-01', grossKg: 18000 } }), settings: SETTINGS_FILLED, doc: 'packing', stage: 'final', shipmentNumber: 43 });
    assert.deepEqual(lowGross, ['Gross weight is less than the net weight']);

    assert.deepEqual(generationIssues({ record: { review: review43() }, settings: SETTINGS_FILLED, doc: 'packing' }), ['Confirm the bales first']);
});

test('Shipment 42 (40 bales): gross over net is accepted for the final', () => {
    const bales = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, kg: i < 34 ? 469 : 468, colour: i % 2 ? 'white' : 'coloured' }));
    const t = baleTotals(bales);
    assert.equal(t.netKg, 34 * 469 + 6 * 468); // 18,754
    assert.equal(t.netKg, 18754);
    const conf = { shipmentNumber: 42, bales, packing: { packages: 40, whiteTotalKg: t.whiteKg, colouredTotalKg: t.colouredKg }, supplierInvoice: { currency: 'EUR', lines: [{ kg: 18754, unitPrice: 1, amount: 18754 }], netKg: 18754, total: 18754 } };
    const rec = { confirmed: conf, review: conf, exportInvoice: { number: '101/2026', date: '2026-06-06', rate: 1.18, rateConfirmed: true, numberConfirmed: true }, lc: { number: 'LC42', date: '2026-06-20', grossKg: 18760 } };
    assert.deepEqual(generationIssues({ record: rec, settings: SETTINGS_FILLED, doc: 'packing', stage: 'final', shipmentNumber: 42 }), []);
    const pf = renderProforma({ record: rec, settings: SETTINGS_FILLED, shipmentNumber: 42 });
    assert.match(pf, /USD 22,129\.72/);
    assert.match(pf, /101\/2026/);
    const pl = renderPackingList({ record: rec, settings: SETTINGS_FILLED, stage: 'final', shipmentNumber: 42 });
    assert.match(pl, /<td>42<\/td><td>40<\/td><td>18,754<\/td><td>18,760<\/td><td>06\/06\/2026<\/td>/);
});

test('unconfirmed edits are noticed', () => {
    const rec = record43();
    assert.equal(hasUnconfirmedChanges(rec), false);
    rec.review.bales[0].kg = 443;
    assert.equal(hasUnconfirmedChanges(rec), true);
});

test('LC cross-checks compare against the linked LC record', () => {
    const rec = record43({ lc: { number: '320126011494', date: '2026-12-01', grossKg: 18136 } });
    const lc = { lcNumber: '320126011494', issuedDate: '2026-12-02', proformaRef: '102/2026', proformaDate: '2026-11-13', amount: 21393.4, currency: 'USD', goods: { quantity: 18130, packageCount: 45, hsCode: '6002.90.00' } };
    const res = lcCrossChecks(rec, lc, SETTINGS_FILLED);
    const byTitle = Object.fromEntries(res.map(c => [c.title, c.ok]));
    assert.equal(byTitle['LC number matches the linked LC'], true);
    assert.equal(byTitle['LC date matches the linked LC'], false);
    assert.equal(byTitle['Proforma number matches the LC'], true);
    assert.equal(byTitle['Invoice amount within the LC amount'], true);
    assert.equal(byTitle['Net weight matches the LC quantity'], true);
    assert.equal(byTitle['Bale count matches the LC'], true);
    assert.equal(byTitle['HS code matches the LC'], true);
});

test('settings merge keeps the seed and reports blanks', () => {
    const s = mergeSettings({ seller: { phone: '123' }, terms: ['Only one'] });
    assert.equal(s.seller.name, 'Enviroware Ltd');
    assert.equal(s.seller.phone, '123');
    assert.deepEqual(s.terms, ['Only one']);
    assert.deepEqual(missingSettings(s, 'packing'), [], 'the identifiers come seeded');
    assert.deepEqual(missingSettings(s, 'proforma'), [], 'the bank comes seeded too');
    // A blank saved value never hides a seeded one
    const blanked = mergeSettings({ seller: { phone: '' }, identifiers: { irc: '  ' }, buyer: { addressLines: [] } });
    assert.equal(blanked.seller.phone, '+64-27-6312070');
    assert.equal(blanked.identifiers.irc, '260326110775319');
    assert.equal(blanked.buyer.addressLines.length, 4);
    assert.equal(missingSettings(SETTINGS_FILLED, 'packing').length, 0);
    assert.equal(missingSettings(SETTINGS_FILLED, 'proforma').length, 0);
});

test('filenames follow the Drive convention', () => {
    assert.equal(docFilename({ doc: 'packing', stage: 'draft', shipmentNumber: 43, date: '2026-11-13' }), 'Packing List - #43 - 13112026.pdf');
    assert.equal(docFilename({ doc: 'proforma', shipmentNumber: 43, date: '2026-11-13' }), 'Proforma Invoice - #43 - 13112026.pdf');
    assert.equal(docFilename({ doc: 'packing', stage: 'final', shipmentNumber: 43, date: '2026-11-13', ext: 'xlsx' }), 'Final Packing List - #43 - 13112026.xlsx');
});

// ── xlsx ─────────────────────────────────────────────────────────────────
test('crc32 matches the standard check value', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('packing list workbook: Draft tab with formulas over the bale cells; Final once LC is in', () => {
    const spec = packingListWorkbookSpec({ record: record43(), settings: SETTINGS_FILLED, shipmentNumber: 43 });
    assert.deepEqual(spec.sheets.map(s => s.name), ['Draft']);
    const rows = spec.sheets[0].rows;
    const find = label => rows.find(r => r?.[0]?.v === label);
    assert.equal(find('No. of Packages')[2].f, 'COUNT(B16:B38,E16:E37)');
    assert.equal(find('No. of Packages')[2].v, 45);
    assert.equal(find('Net Weight')[2].f, 'SUM(B16:B38,E16:E37)');
    assert.equal(find('Net Weight')[2].v, 18130);
    assert.equal(rows[15][0].v, 1);  // row 16 = bale 1
    assert.equal(rows[15][1].v, 442);
    assert.equal(rows[15][3].v, 24);
    assert.equal(rows[37][0].v, 23); // row 38 = bale 23
    assert.equal(rows[36][4].v, 457); // row 37 col E = bale 45

    const withLc = packingListWorkbookSpec({ record: record43({ lc: { number: 'X', date: '2026-12-01', grossKg: 18136 } }), settings: SETTINGS_FILLED, shipmentNumber: 43 });
    assert.deepEqual(withLc.sheets.map(s => s.name), ['Draft', 'Final']);
    const fin = withLc.sheets[1].rows;
    const net = fin.find(r => r?.[0]?.v === 'Net Weight')[2];
    assert.equal(net.f, 'SUM(B17:B39,E17:E38)'); // one more summary row (Gross Weight)
    assert.equal(fin[16][1].v, 442);

    const bytes = buildXlsx(withLc);
    assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b); // PK
    const text = new TextDecoder().decode(bytes);
    assert.match(text, /<f>SUM\(B16:B38,E16:E37\)<\/f><v>18130<\/v>/);
    assert.match(text, /<sheet name="Final" sheetId="2"/);
    assert.match(text, /DRAFT PACKING LIST/);
    assert.doesNotMatch(text, /EUR|Pistoni/);
});

// ── Seeded from Commercial Invoice 101/2026 (Shipment 42) ────────────────
test('settings are seeded from Commercial Invoice 101/2026', () => {
    const s = mergeSettings({});
    assert.equal(s.seller.phone, '+64-27-6312070');
    assert.equal(s.seller.gstNumber, '129-544-112');
    assert.deepEqual(s.buyer.addressLines, ['Komolapur, Holding no:533 Birulia', 'Savar', 'Dhaka-1340,', 'Bangladesh']);
    assert.deepEqual(s.identifiers, { irc: '260326110775319', applicantTin: '358887309351', applicantBin: '001173726-0403', bankName: 'SBAC Bank', bankTin: '166085152182', bankBin: '000000203-0002', bankVatReg: '000060296-0202' });
    assert.deepEqual([s.bank.name, s.bank.swift], ['ANZ Bank New Zealand Ltd', 'ANZBNZ22']);
});

test('settings saved with the old merged bank number are split; layout sections always come from the code', () => {
    const s = mergeSettings({
        identifiers: { irc: '260326110775319', bankName: 'SBAC Bank', bankBin: '000060296-0202' },
        identifierRows: { draft: [{ label: 'IRC no.', field: 'irc' }], final: [] },
        signOff: { packingTitle: 'Director' },
    });
    assert.equal(s.identifiers.bankBin, '000000203-0002');
    assert.equal(s.identifiers.bankVatReg, '000060296-0202');
    assert.equal(s.identifierRows.draft.length, 7);
    assert.equal(s.signOff.packingTitle, 'DIRECTOR');
    // A bank BIN someone typed in on purpose is kept
    assert.equal(mergeSettings({ identifiers: { bankBin: '000000999-0001' } }).identifiers.bankBin, '000000999-0001');
});

test('documents print the seeded numbers, lettered as on the Shipment 43 draft', () => {
    const s = mergeSettings({});
    const rec = record43({ lc: { number: '320126011494', date: '2026-12-01', grossKg: 18136 } });
    const draft = renderPackingList({ record: rec, settings: s, stage: 'draft', shipmentNumber: 43 });
    assert.match(draft, /<div>193 Mount Smart Road<\/div><div>Onehunga, 1061\. NEW ZEALAND<\/div>/);
    assert.match(draft, /<div>Phone \+64-27-6312070<\/div><div>andrew@primetie\.co\.nz<\/div>/);
    const ids = [...draft.matchAll(/<td class="ltr">([A-Z]{2}\.)<\/td><th>([^<]*)<\/th><td>([^<]*)<\/td>/g)].map(m => m.slice(1).join(' ').trim());
    assert.deepEqual(ids, [
        'AA. IRC NO 260326110775319',
        'BB. TIN NO. 358887309351',
        'CC. BIN NO. 001173726-0403 (APPLICANT)',
        'DD. BIN NO. 000000203-0002 (SBAC Bank)',
        'EE. HS CODE NO. 6002.90.00',
        'FF. LC NO: 320126011494',
        'GG. LC DATE OF ISSUE: 01/12/2026',
    ]);
    assert.match(draft, /Andrew McLeod<\/div>\s*<div><strong>DIRECTOR<\/strong><\/div>\s*<div>Enviroware Ltd/);
    const signed = renderPackingList({ record: rec, settings: s, stage: 'draft', shipmentNumber: 43, assets: { signature: { mediaType: 'image/png', data: 'U0lH' }, seal: { mediaType: 'image/png', data: 'U0VBTA==' } } });
    assert.match(signed, /<img class="sig-img" src="data:image\/png;base64,U0lH"/);
    assert.match(signed, /<img class="seal-img" src="data:image\/png;base64,U0VBTA=="/);
    const final = renderPackingList({ record: rec, settings: s, stage: 'final', shipmentNumber: 43 });
    assert.match(final, /<th>VAT REG NO\.<\/th><td>000060296-0202/);
    assert.match(final, /<th>APPLICANT'S BANK TIN NO\.<\/th><td>166085152182<\/td>/);
    assert.match(final, /<td colspan="2">Applicant: JPS Enterprise, Komolapur, Holding no:533 Birulia, Savar, Dhaka-1340, Bangladesh</);
    const pf = renderProforma({ record: rec, settings: s, shipmentNumber: 43 });
    assert.match(pf, /<strong>PRIME TIE<\/strong> – <em>the stretchy loop tie<\/em>/);
    assert.match(pf, /GST No\.: 129-544-112/);
    assert.match(pf, /<span class="lbl">Phone<\/span>\+64-27-6312070/);
    assert.match(pf, /JPS Enterprise<br>Komolapur, Holding no:533 Birulia<br>Savar<br>Dhaka-1340,<br>Bangladesh/);
    assert.match(pf, /ANDREW FRASER MCLEOD<\/div>\s*<div><strong>DIRECTOR<\/strong><\/div>\s*<div>For and on behalf of Enviroware Ltd/);
    assert.match(pf, /Bank: ANZ Bank New Zealand Ltd<\/div><div>23-29 Albert Street<\/div><div>Auckland, New Zealand<\/div><div>SWIFT: ANZBNZ22/);
});

test('the applicant numbers are checked against the linked LC\'s conditions', () => {
    const s = mergeSettings({});
    const rec = record43();
    const lc = { lcNumber: '320126011494', f47aConditions: [
        { num: '02', text: 'ALL DOCUMENTS MUST SHOW IMPORTER NAME, ADDRESS, BIN NO.001173726-0403, TIN NO.358887309351, IRC NO.260326110775319 AND APPLICANT BANK TIN NO.166085152182, BIN NO.000000203-0002 AND VAT REG NO.000060296-0202' },
    ] };
    const ok = lcCrossChecks(rec, lc, s).find(c => c.title === 'Applicant numbers match the LC');
    assert.equal(ok.ok, true, ok.detail);
    const changed = { ...lc, f47aConditions: [{ num: '02', text: 'BIN NO.001173726-0403, TIN NO.358887309351, IRC NO.260326110779999, BANK TIN NO.166085152182, BIN NO.000000203-0002, VAT REG NO.000060296-0202' }] };
    const bad = lcCrossChecks(rec, changed, s).find(c => c.title === 'Applicant numbers match the LC');
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /IRC 260326110775319 not found in LC 320126011494/);
    assert.equal(lcCrossChecks(rec, { lcNumber: 'X' }, s).find(c => c.title === 'Applicant numbers match the LC'), undefined, 'no LC text, no check');
});

// ── Dismissing a check instead of correcting it ─────────────────────────
test('a dismissed check stops blocking until it fails in a different way', () => {
    const r = review43();
    r.packing.whiteTotalKg = 4.887;   // printed-numbers and colour-totals fail
    const pn = runChecks(r, { shipmentNumber: 43 }).find(c => c.id === 'printed-numbers');
    assert.equal(pn.dismissible, true);
    const dismissed = { 'printed-numbers': { detail: pn.detail, title: pn.title, by: 'andrew@primetie.co.nz', at: '2026-11-17T01:00:00Z' } };
    const after = runChecks(r, { shipmentNumber: 43, dismissed });
    assert.deepEqual(after.find(c => c.id === 'printed-numbers').dismissed, { by: 'andrew@primetie.co.nz', at: '2026-11-17T01:00:00Z' });
    assert.deepEqual(blockingFailures(after).map(c => c.id), ['colour-totals']);

    r.packing.colouredTotalKg = 13.243;  // a second misread in the same check
    assert.ok(blockingFailures(runChecks(r, { shipmentNumber: 43, dismissed })).some(c => c.id === 'printed-numbers'));
});

test('what the documents need cannot be dismissed', () => {
    const ticks = runChecks(review43(), { shipmentNumber: 43, exportInvoice: { number: '102/2026', rate: 1.18 } });
    assert.equal(ticks.find(c => c.id === 'rate-confirmed').dismissible, false);
    assert.equal(ticks.find(c => c.id === 'number-confirmed').dismissible, false);

    const gap = review43();
    gap.bales = gap.bales.filter(b => b.n !== 12);
    assert.equal(runChecks(gap, { shipmentNumber: 43 }).find(c => c.id === 'bale-sequence').dismissible, true, 'a gap in Pistoni\'s numbering can be dismissed');

    const noColour = review43();
    noColour.bales[0] = { ...noColour.bales[0], colour: '' };
    const seq = runChecks(noColour, { shipmentNumber: 43 }).find(c => c.id === 'bale-sequence');
    assert.equal(seq.dismissible, false, 'a bale with no colour cannot');
    const forced = runChecks(noColour, { shipmentNumber: 43, dismissed: { 'bale-sequence': { detail: seq.detail } } });
    assert.ok(blockingFailures(forced).some(c => c.id === 'bale-sequence'));

    const noInvoice = runChecks({ ...review43(), supplierInvoice: null }, { shipmentNumber: 43 });
    assert.equal(noInvoice.find(c => c.id === 'net-weight').dismissible, false);
});

test('Italian figures with currency and unit marks still parse', () => {
    for (const [raw, n] of [['€ 1,50', 1.5], ['1,50 €/kg', 1.5], ['EUR 7.330,50', 7330.5], ['18.130 kg', 18130]]) assert.equal(parseItalianNumber(raw), n, raw);
    assert.equal(parseItalianNumber('1.50'), null, 'a misplaced thousands dot is still refused');
});

// ── Our signed rewrite of JPS's sales proforma invoice ──────────────────
const JPS_43 = {
    number: 'JPSE-102/2026', date: '2026-11-10', currency: 'USD', total: 32996.6,
    lines: [{ description: 'Sorted Knitted Nylon Stocking Material (Toeclip) a by-product from the manufacture of stockings, and Wastage (after sorting)', kg: 18130, unitPrice: 1.82, amount: 32996.6 }],
    contract: { lastShipmentDate: '2027-06-15', expiryDate: '2027-06-30', containers: "1 x 40' FCL and 1 x 20' GP" },
};

test('signed JPS proforma: their document without the errors, amount in words, terms once, our signature and seal', () => {
    const rec = record43({ jps: JPS_43 });
    const html = renderJpsContract({ record: rec, settings: mergeSettings({}), shipmentNumber: 43,
        assets: { signature: { mediaType: 'image/png', data: 'U0lH' }, seal: { mediaType: 'image/png', data: 'U0VBTA==' } } });
    const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
    assert.match(text, /SALES PROFORMA INVOICE/);
    assert.match(text, /No\. <strong>JPSE-102\/2026<\/strong> &nbsp;·&nbsp; Date: <strong>10th November 2026<\/strong>/);
    assert.match(text, /<div class="lh-name">JPS Enterprise<\/div>/);
    assert.match(text, /Phone: \+880 1817 011668, \+880 1726 624893/);
    assert.match(text, /<div>193 Mount Smart Road, Onehunga, 1061, New Zealand<\/div>/);
    assert.match(text, /GST No\.: 129-544-112/);
    assert.match(text, /Buyer's bank: ANZ Bank New Zealand Ltd, 23-29 Albert Street, Auckland, New Zealand\. SWIFT: ANZBNZ22/);
    assert.match(text, /Sorted knitted nylon stocking material \(toeclip\), a by-product of the manufacture of stockings, and wastage after sorting<div class="hs">HS code: 6002\.90\.00/);
    assert.match(text, /<td class="r">18,130<\/td><td class="r">1\.82<\/td><td class="r">32,996\.60<\/td>/);
    assert.match(text, /US\$ 32,996\.60/);
    assert.match(text, /US Dollars Thirty-Two Thousand Nine Hundred and Ninety-Six and Sixty Cents Only\./);
    assert.match(text, /Exporter's bank:<\/th><td>SBAC Bank PLC, Galaxy Bhaban \(1st Floor\), Plot 29-30, Block 6, Mirpur-10, Dhaka, Bangladesh\. SWIFT: SBACBDDH/);
    assert.match(text, /Port of loading:<\/th><td>ICD Kamlapur, Dhaka, via Chattogram, Bangladesh/);
    assert.match(text, /Destination:<\/th><td>Tauranga, New Zealand/);
    assert.match(text, /Last date of shipment:<\/th><td>15th June 2027/);
    assert.match(text, /Expiry date:<\/th><td>30th June 2027/);
    assert.match(text, /Container size:<\/th><td>1 x 40' FCL and 1 x 20' GP/);
    assert.equal(text.match(/Payment:/g).length, 1, 'the payment term once, not twice');
    assert.doesNotMatch(text, /Buyerer|SWFIT|Tauraqnga|Chattragarm|139 Mount|Proform |Dt :/);
    assert.match(text, /<strong>Sudipto Sarkar \(Paul\)<\/strong><\/div>\s*<div>For and on behalf of JPS Enterprise/);
    assert.match(text, /<img class="sig-img" src="data:image\/png;base64,U0lH" alt=""><img class="seal-img"/);
    assert.match(text, /<strong>ANDREW FRASER MCLEOD<\/strong><\/div>\s*<div>For and on behalf of Enviroware Ltd/);
    assert.doesNotMatch(text, /Pistoni|EUR|€|7,330|17,262/);
    assert.equal(docFilename({ doc: 'jps', shipmentNumber: 43, date: '2026-11-10' }), 'JPS Proforma Invoice - #43 - 10112026 - Signed.pdf');
});

test('signed JPS proforma waits for the JPS invoice, its terms, its checks and your signature', () => {
    const s = mergeSettings({});
    const issues = rec => generationIssues({ record: rec, settings: s, doc: 'jps', shipmentNumber: 43, hasSignature: true });
    assert.deepEqual(issues(record43()), ['Upload or enter the JPS invoice first']);
    assert.deepEqual(issues(record43({ jps: JPS_43 })), ["Confirm JPS's proforma invoice in section 5"]);
    assert.deepEqual(issues(record43({ jps: JPS_43, jpsConfirmed: { at: '2026-11-17T01:00:00Z', by: 'andrew@primetie.co.nz' } })), []);
    const ok = { jpsConfirmed: { at: '2026-11-17T01:00:00Z', by: 'andrew@primetie.co.nz' } };
    assert.deepEqual(issues(record43({ ...ok, jps: { ...JPS_43, contract: {} } })), ['Last date of shipment missing', 'Expiry date missing']);
    assert.deepEqual(issues(record43({ ...ok, jps: { ...JPS_43, number: '', lines: [] } })), ['JPS invoice number missing', 'JPS invoice lines need kg, unit price and amount']);
    assert.deepEqual(generationIssues({ record: record43({ ...ok, jps: JPS_43 }), settings: s, doc: 'jps', hasSignature: false }), ['Upload your signature in Document settings → Enviroware']);
    assert.deepEqual(generationIssues({ record: record43({ ...ok, jps: JPS_43 }), settings: s, doc: 'jps', hasSignature: true, jpsFailures: ['Printed figures read correctly'] }), ['JPS invoice fails: Printed figures read correctly']);
    assert.deepEqual(generationIssues({ record: record43({ ...ok, jps: JPS_43 }), settings: mergeSettings({ jps: { signatory: ' ' } }), doc: 'jps', hasSignature: true }), [], 'blank saved values keep the seed');
});

test('amounts in words', () => {
    assert.equal(amountInWords(32996.6), 'US Dollars Thirty-Two Thousand Nine Hundred and Ninety-Six and Sixty Cents Only');
    assert.equal(amountInWords(21393.4), 'US Dollars Twenty-One Thousand Three Hundred and Ninety-Three and Forty Cents Only');
    assert.equal(amountInWords(32050), 'US Dollars Thirty-Two Thousand and Fifty Only');
    assert.equal(amountInWords(1000.01), 'US Dollars One Thousand and One Cent Only');
});

test("Pistoni's document number read as our GST number is flagged", () => {
    const r = review43();
    assert.equal(runChecks(r, { shipmentNumber: 43 }).find(c => c.id === 'supplier-number').ok, true);
    r.supplierInvoice.number = '129544112';
    const c = runChecks(r, { shipmentNumber: 43, settings: mergeSettings({}) }).find(x => x.id === 'supplier-number');
    assert.deepEqual([c.ok, c.level], [false, 'warn']);
    assert.equal(c.detail, "129544112 is Enviroware's GST no., not Pistoni's document number — correct the Document no. below");
    r.supplierInvoice.number = '';
    assert.match(runChecks(r, { shipmentNumber: 43 }).find(x => x.id === 'supplier-number').detail, /^Missing/);
});
