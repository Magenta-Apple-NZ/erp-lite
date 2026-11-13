// Shipment export documents — the first stage of a shipment. Pistoni's
// packing list and proforma become Enviroware's packing list (Draft, then
// Final once the LC is issued) and proforma invoice to JPS Enterprise.
//
// Pure: no KV, no fetch. Number parsing, the review checks, defaults and the
// two document templates live here so tests can pin them down
// (tests/export-docs.test.js). KV access is in export-docs/_store.js, the
// Claude extraction in export-docs/_extract.js.
//
// Record (KV `shipdocs:<shipmentId>`, one per shipment in import:forecast):
//   files        { packingList, proforma }  latest supplier PDFs (key, filename, …)
//   extractions  { packingList, proforma }  raw model output, kept for diagnosis
//   review       working copy the review screen edits (never used to print)
//   confirmed    the review as the user confirmed it — the only source of output
//   exportInvoice{ number, date, rate, currency, numberConfirmed, rateConfirmed }
//   lc           { number, date, grossKg }  entered at the Final stage
//   outputs      [ generated documents, newest first ]
// Totals (net kg, package count, invoice amount) are always derived.

// ── Settings: constants that belong to the documents, not the code ──────
// Seeded from the brief (13 Nov 2026). Numbers we could not verify (phone,
// GST, bank, applicant identifiers) are left blank on purpose: documents
// can't be generated until someone fills them in from the Shipment 42
// reference and saves the settings once (reviewedAt).
export const SETTINGS_SEED = {
    reviewedAt: null,
    reviewedBy: null,
    seller: {
        name: 'Enviroware Ltd',
        strapline: 'PRIME TIE – the stretchy loop tie',
        addressLines: ['193 Mount Smart Road', 'Onehunga 1061', 'New Zealand'],
        phone: '',
        email: 'andrew@primetie.co.nz',
        gstNumber: '',
    },
    bank: { name: '', addressLines: [], swift: '', accountName: '', accountNumber: '' },
    buyer: {
        name: 'JPS Enterprise',
        addressLines: ['Komolapur, Holding no:533 Birulia', 'Savar, Dhaka-1340', 'Bangladesh'],
    },
    identifiers: { irc: '', applicantTin: '', applicantBin: '', bankName: 'SBAC Bank', bankBin: '', bankTin: '', bankVatReg: '' },
    hsCode: '6002.90.00',
    goods: {
        subtitle: 'Knitted Nylon Stocking Material',
        proformaDescription: '{bales} bales of knitted nylon stocking material (Toeclip), a by-product from the manufacture of stockings',
        proformaLine: '{netKg}kg toeclip @ $USD{rate}/kg',
    },
    packingSpec: {
        draft: 'Standard Export Seaworthy',
        final: 'EXPORT STANDARD ROAD / SEA WORTHY CONDITION',
    },
    // Identifier rows printed on the packing list. `field` picks the value;
    // the label is free text because Draft and Final word them differently.
    identifierRows: {
        draft: [
            { label: 'IRC no.', field: 'irc' },
            { label: 'TIN no.', field: 'applicantTin' },
            { label: 'BIN no.', field: 'applicantBin' },
            { label: 'BIN no. (SBAC Bank)', field: 'bankBin' },
            { label: 'HS code', field: 'hsCode' },
            { label: 'LC no.', field: 'lcNumber' },
            { label: 'LC date', field: 'lcDate' },
        ],
        final: [
            { label: 'IRC no.', field: 'irc' },
            { label: "Applicant's TIN", field: 'applicantTin' },
            { label: "Applicant's BIN", field: 'applicantBin' },
            { label: "Applicant's bank TIN", field: 'bankTin' },
            { label: 'VAT reg no.', field: 'bankVatReg' },
            { label: 'HS code', field: 'hsCode' },
            { label: 'LC no.', field: 'lcNumber' },
            { label: 'LC date of issue', field: 'lcDate' },
        ],
    },
    terms: [
        'Country of origin: Italy',
        'Port of loading: Any port of Italy',
        'Destination: ICD Kamlapur, Dhaka via Chattogram',
        'Freight terms: CPT',
        "Container: 1*40' FCL",
        'Shipment: By sea',
        'Temporary import: the goods must be re-exported',
    ],
    signOff: {
        packingName: 'Andrew McLeod',
        packingTitle: 'Director',
        company: 'Enviroware Ltd',
        proformaName: 'ANDREW FRASER MCLEOD',
        proformaTitle: 'Director',
    },
    currency: 'USD',
    defaultRate: 1.18,
    defaultRateSource: 'Shipment 42',
    lastInvoiceNumber: '101/2026',
    baleMinKg: 150,
    baleMaxKg: 650,
    // JPS's handling & sorting margin per kg over our export rate (≈ 0.63 on
    // recent shipments): the JPS invoice is checked against it.
    jpsMarginPerKg: 0.63,
    // Xero: the three stage-1 invoices (Pistoni bill, our proforma as a sales
    // invoice to JPS, JPS bill). Account codes are left for the accountant's
    // choice; nothing is created in Xero until they are set.
    xero: {
        supplierContact: 'Pistoni SRL',
        buyerContact: 'JPS Enterprise',
        status: 'DRAFT',
        accounts: { rawProduct: '', lcDeposit: '', handling: '', exportSale: '' },
        taxTypes: { purchases: 'NONE', exportSale: 'ZERORATEDOUTPUT' },
    },
};

export const IDENTIFIER_FIELDS = ['irc', 'applicantTin', 'applicantBin', 'bankBin', 'bankTin', 'bankVatReg', 'hsCode', 'lcNumber', 'lcDate'];

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Saved settings over the seed, one level of sections deep (arrays replace).
export function mergeSettings(saved) {
    const out = structuredClone(SETTINGS_SEED);
    if (!isObj(saved)) return out;
    for (const [k, v] of Object.entries(saved)) {
        if (isObj(v) && isObj(out[k])) {
            for (const [k2, v2] of Object.entries(v)) out[k][k2] = isObj(v2) && isObj(out[k][k2]) ? { ...out[k][k2], ...v2 } : v2;
        } else {
            out[k] = v;
        }
    }
    return out;
}

// Settings a document can't do without. Blank values print as blank lines
// on bank paperwork, which is a discrepancy, so they block generation.
export function missingSettings(settings, doc) {
    const s = settings || SETTINGS_SEED;
    const miss = [];
    const need = (v, label) => { if (!String(Array.isArray(v) ? v.join('') : (v ?? '')).trim()) miss.push(label); };
    need(s.seller?.name, 'Seller name');
    need(s.seller?.addressLines, 'Seller address');
    need(s.seller?.phone, 'Seller phone');
    need(s.seller?.email, 'Seller email');
    need(s.hsCode, 'HS code');
    if (doc === 'proforma') {
        need(s.seller?.gstNumber, 'GST no.');
        need(s.bank?.name, 'Bank name');
        need(s.bank?.addressLines, 'Bank address');
        need(s.bank?.swift, 'Bank SWIFT');
        need(s.buyer?.name, 'Buyer name');
        need(s.buyer?.addressLines, 'Buyer address');
        need(s.terms, 'Terms & conditions');
    } else {
        const labels = { irc: 'IRC no.', applicantTin: 'Applicant TIN', applicantBin: 'Applicant BIN', bankBin: 'Bank BIN', bankTin: 'Bank TIN', bankVatReg: 'Bank VAT reg no.' };
        const rows = [...(s.identifierRows?.draft || []), ...(s.identifierRows?.final || [])];
        for (const f of new Set(rows.map(r => r.field))) {
            if (labels[f]) need(s.identifiers?.[f], labels[f]);
        }
    }
    return miss;
}

// ── Numbers ──────────────────────────────────────────────────────────────
// Italian formatting: dot groups thousands, comma marks decimals.
//   "4.887" → 4887   "7.330,50" → 7330.5   "0,75" → 0.75   "18130" → 18130
// Anything that isn't valid Italian formatting returns null (e.g. "1.50",
// which would be a misplaced thousands dot) rather than being guessed at.
export function parseItalianNumber(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/ /g, ' ').trim();
    s = s.replace(/^(EUR|€|USD|\$|KG)\s*/i, '').replace(/\s*(EUR|€|kg|kgs|kgs\.|kg\.)$/i, '').replace(/\s+/g, '');
    let neg = false;
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    if (!/^\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) && !/^\d+(,\d+)?$/.test(s)) return null;
    const [intPart, dec] = s.split(',');
    const n = Number(intPart.replace(/\./g, '') + (dec ? '.' + dec : ''));
    return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const toNum = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);
export const cents = n => Math.round((Number(n) || 0) * 100 + (n >= 0 ? 1e-9 : -1e-9));
export const round2 = n => cents(n) / 100;
const kgEq = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.0005;

// Invoice amount = net kg × rate, rounded to the cent. Done on integers
// (rate to 4 dp) so 18,130 × 1.18 is exactly 21,393.40.
export function invoiceAmount(netKg, rate) {
    const kg = Number(netKg) || 0;
    const r4 = Math.round((Number(rate) || 0) * 10000);
    return Math.round(kg * r4 / 100) / 100;
}

export function fmtKg(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-NZ', { maximumFractionDigits: 3 });
}
export function fmtMoney(n) {
    return (Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtRate(n) {
    return (Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// ── Dates (business dates are Pacific/Auckland YYYY-MM-DD strings) ──────
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function ordinal(n) {
    const v = Number(n);
    const t = v % 100;
    if (t >= 11 && t <= 13) return v + 'th';
    return v + ({ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th');
}
// "2026-11-13" → "13th November 2026"
export function longDate(ymd) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    return `${ordinal(Number(m[3]))} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ── Bales ────────────────────────────────────────────────────────────────
export function normaliseColour(c) {
    const s = String(c || '').toLowerCase();
    if (/^(white|bianc)/.test(s)) return 'white';
    if (/^(colou?red|colou?r|colorat|color)/.test(s)) return 'coloured';
    return '';
}

// Clean bale rows: integer numbers, numeric kg, known colour; sorted by n.
// Rows with no number and no weight (spacers) are dropped.
export function normaliseBales(list) {
    return (Array.isArray(list) ? list : [])
        .map(b => ({ n: toNum(b?.n), kg: toNum(b?.kg), colour: normaliseColour(b?.colour) }))
        .filter(b => b.n != null || b.kg != null)
        .map(b => ({ n: b.n != null ? Math.round(b.n) : null, kg: b.kg, colour: b.colour }))
        .sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9));
}

export function baleTotals(bales) {
    const list = normaliseBales(bales);
    const t = { count: list.length, netKg: 0, whiteKg: 0, colouredKg: 0, whiteCount: 0, colouredCount: 0, minKg: null, maxKg: null };
    for (const b of list) {
        const kg = Number(b.kg) || 0;
        t.netKg += kg;
        if (b.colour === 'white') { t.whiteKg += kg; t.whiteCount++; }
        if (b.colour === 'coloured') { t.colouredKg += kg; t.colouredCount++; }
        if (b.kg != null) {
            t.minKg = t.minKg == null ? kg : Math.min(t.minKg, kg);
            t.maxKg = t.maxKg == null ? kg : Math.max(t.maxKg, kg);
        }
    }
    for (const k of ['netKg', 'whiteKg', 'colouredKg']) t[k] = Math.round(t[k] * 1000) / 1000;
    return t;
}

// Bales in number order, ceil(n/2) down the left column, the rest on the right.
export function splitBaleColumns(bales) {
    const list = normaliseBales(bales);
    const half = Math.ceil(list.length / 2);
    return [list.slice(0, half), list.slice(half)];
}

// ── Extraction → review shape ────────────────────────────────────────────
// The model returns plain numbers already converted from Italian formatting
// plus the raw printed strings; we keep both so the checks can compare them.
export function reviewFromPackingExtraction(x) {
    const e = x || {};
    return {
        shipmentNumber: toNum(e.shipmentNumber),
        bales: normaliseBales(e.bales),
        packing: {
            whiteTotalKg: toNum(e.whiteTotalKg), whiteTotalRaw: e.whiteTotalRaw ?? null,
            colouredTotalKg: toNum(e.colouredTotalKg), colouredTotalRaw: e.colouredTotalRaw ?? null,
            packages: toNum(e.totalPackages), packagesRaw: e.totalPackagesRaw ?? null,
        },
    };
}

export function reviewFromProformaExtraction(x) {
    const e = x || {};
    return {
        number: e.documentNumber != null ? String(e.documentNumber) : '',
        date: isYmd(e.documentDate) ? e.documentDate : '',
        dateRaw: e.documentDateRaw ?? null,
        currency: String(e.currency || 'EUR').toUpperCase(),
        lines: (Array.isArray(e.lines) ? e.lines : []).map(l => ({
            description: String(l?.description || ''),
            colour: normaliseColour(l?.colour),
            kg: toNum(l?.kg), kgRaw: l?.kgRaw ?? null,
            unitPrice: toNum(l?.unitPrice), unitPriceRaw: l?.unitPriceRaw ?? null,
            amount: toNum(l?.amount), amountRaw: l?.amountRaw ?? null,
        })),
        netKg: toNum(e.netWeightKg), netKgRaw: e.netWeightRaw ?? null,
        total: toNum(e.total), totalRaw: e.totalRaw ?? null,
        destination: e.destination || '',
        deliveryTerms: e.deliveryTerms || '',
        hsCode: e.hsCode || '',
    };
}

export function emptyReview() {
    return {
        shipmentNumber: null,
        bales: [],
        packing: { whiteTotalKg: null, whiteTotalRaw: null, colouredTotalKg: null, colouredTotalRaw: null, packages: null, packagesRaw: null },
        supplierInvoice: null,
    };
}

// ── Review checks ────────────────────────────────────────────────────────
// level 'block' stops confirm and generation; 'warn' is shown, not enforced.
// ok: true pass, false fail, null not applicable.
function check(id, level, title, ok, detail) { return { id, level, title, ok, detail: detail || '' }; }

// Printed strings the model read, re-parsed with the Italian rule; any that
// disagree with the number it returned are the classic 4.887 → 4.887 trap.
function rawMismatches(review) {
    const out = [];
    const p = review?.packing || {};
    const inv = review?.supplierInvoice || {};
    const pairs = [
        ['White total', p.whiteTotalRaw, p.whiteTotalKg],
        ['Coloured total', p.colouredTotalRaw, p.colouredTotalKg],
        ['Packages', p.packagesRaw, p.packages],
        ['Invoice net weight', inv.netKgRaw, inv.netKg],
        ['Invoice total', inv.totalRaw, inv.total],
    ];
    (inv.lines || []).forEach((l, i) => {
        pairs.push([`Line ${i + 1} kg`, l.kgRaw, l.kg], [`Line ${i + 1} unit price`, l.unitPriceRaw, l.unitPrice], [`Line ${i + 1} amount`, l.amountRaw, l.amount]);
    });
    for (const [label, raw, val] of pairs) {
        if (raw == null || raw === '') continue;
        const parsed = parseItalianNumber(raw);
        if (parsed == null) out.push(`${label}: printed "${raw}" isn't a valid Italian number`);
        else if (val == null || Math.abs(parsed - Number(val)) > 0.0005) out.push(`${label}: printed "${raw}" reads as ${fmtKg(parsed)}, extracted ${val == null ? 'nothing' : fmtKg(val)}`);
    }
    return out;
}

export function runChecks(review, ctx = {}) {
    const r = review || emptyReview();
    const settings = ctx.settings || SETTINGS_SEED;
    const bales = normaliseBales(r.bales);
    const t = baleTotals(bales);
    const p = r.packing || {};
    const inv = r.supplierInvoice;
    const checks = [];

    // 1. Bale numbers 1..N, no gaps or duplicates, N = supplier's package count
    {
        const issues = [];
        if (!bales.length) issues.push('No bales yet');
        const nums = bales.map(b => b.n);
        if (nums.some(n => n == null)) issues.push('A bale has no number');
        const seen = new Set(), dupes = new Set();
        nums.forEach(n => { if (n != null) { if (seen.has(n)) dupes.add(n); seen.add(n); } });
        if (dupes.size) issues.push(`Duplicate bale ${[...dupes].join(', ')}`);
        const max = Math.max(0, ...nums.filter(n => n != null));
        const missing = [];
        for (let i = 1; i <= max; i++) if (!seen.has(i)) missing.push(i);
        if (missing.length) issues.push(`Missing bale ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`);
        if (nums.some(n => n != null && n < 1)) issues.push('Bale numbers must start at 1');
        const noKg = bales.filter(b => !(Number(b.kg) > 0)).map(b => b.n);
        if (noKg.length) issues.push(`No weight on bale ${noKg.join(', ')}`);
        const noColour = bales.filter(b => !b.colour).map(b => b.n);
        if (noColour.length) issues.push(`No colour on bale ${noColour.join(', ')}`);
        if (p.packages == null) issues.push("Supplier's package count missing");
        else if (Number(p.packages) !== bales.length) issues.push(`${bales.length} bales but the supplier states ${p.packages} packages`);
        checks.push(check('bale-sequence', 'block', 'Bales numbered 1 to N, N = supplier package count', !issues.length,
            issues.length ? issues.join('; ') : `Bales 1–${bales.length}, matching ${p.packages} packages`));
    }

    // 2. White and coloured bale sums = supplier's stated totals
    {
        const issues = [];
        if (p.whiteTotalKg == null && p.colouredTotalKg == null) issues.push("Supplier's white and coloured totals missing");
        if (p.whiteTotalKg != null && !kgEq(t.whiteKg, p.whiteTotalKg)) issues.push(`White bales sum to ${fmtKg(t.whiteKg)} kg, supplier states ${fmtKg(p.whiteTotalKg)} kg`);
        if (p.colouredTotalKg != null && !kgEq(t.colouredKg, p.colouredTotalKg)) issues.push(`Coloured bales sum to ${fmtKg(t.colouredKg)} kg, supplier states ${fmtKg(p.colouredTotalKg)} kg`);
        if (p.whiteTotalKg == null && t.whiteKg > 0) issues.push("Supplier's white total missing");
        if (p.colouredTotalKg == null && t.colouredKg > 0) issues.push("Supplier's coloured total missing");
        checks.push(check('colour-totals', 'block', 'White and coloured sums match the supplier packing list', !issues.length,
            issues.length ? issues.join('; ') : `White ${fmtKg(t.whiteKg)} kg (${t.whiteCount} bales) · Coloured ${fmtKg(t.colouredKg)} kg (${t.colouredCount} bales)`));
    }

    // 3. All bales = net weight on the supplier proforma
    {
        let ok = false, detail;
        if (!inv) detail = 'Upload or enter the supplier proforma';
        else if (inv.netKg == null) detail = 'Net weight missing from the supplier proforma';
        else if (!kgEq(t.netKg, inv.netKg)) detail = `Bales sum to ${fmtKg(t.netKg)} kg, proforma states ${fmtKg(inv.netKg)} kg`;
        else { ok = true; detail = `${fmtKg(t.netKg)} kg on both`; }
        checks.push(check('net-weight', 'block', 'Bales sum to the supplier proforma net weight', ok, detail));
    }

    // 4. Each supplier line kg × unit price = amount; lines sum to the total
    {
        const issues = [];
        if (!inv) issues.push('Upload or enter the supplier proforma');
        else {
            const lines = inv.lines || [];
            if (!lines.length) issues.push('No invoice lines');
            lines.forEach((l, i) => {
                if (l.kg == null || l.unitPrice == null || l.amount == null) { issues.push(`Line ${i + 1} incomplete`); return; }
                const calc = Math.round(Number(l.kg) * Math.round(Number(l.unitPrice) * 10000) / 100);
                if (calc !== cents(l.amount)) issues.push(`Line ${i + 1}: ${fmtKg(l.kg)} × ${fmtRate(l.unitPrice)} = ${fmtMoney(calc / 100)}, printed ${fmtMoney(l.amount)}`);
            });
            if (inv.total == null) issues.push('Invoice total missing');
            else if (lines.length && lines.reduce((s, l) => s + cents(l.amount), 0) !== cents(inv.total)) {
                issues.push(`Lines sum to ${fmtMoney(lines.reduce((s, l) => s + cents(l.amount), 0) / 100)}, total printed ${fmtMoney(inv.total)}`);
            }
            const lineKg = lines.reduce((s, l) => s + (Number(l.kg) || 0), 0);
            if (lines.length && inv.netKg != null && !kgEq(lineKg, inv.netKg)) issues.push(`Line kg sum to ${fmtKg(lineKg)}, net weight printed ${fmtKg(inv.netKg)}`);
        }
        checks.push(check('invoice-lines', 'block', 'Supplier invoice lines and total add up', !issues.length,
            issues.length ? issues.join('; ') : `${(inv.lines || []).length} lines = ${inv.currency || ''} ${fmtMoney(inv.total)}`));
    }

    // 4b. Printed strings agree with the numbers (Italian locale rule)
    {
        const mism = rawMismatches(r);
        checks.push(check('printed-numbers', 'block', 'Printed totals read correctly (Italian number format)', !mism.length,
            mism.length ? mism.join('; ') : 'Every printed total re-parses to the extracted number'));
    }

    // 5. Packing list shipment number = the shipment being edited
    {
        const hub = ctx.shipmentNumber;
        let ok = null, detail = 'No shipment number read from the packing list';
        if (r.shipmentNumber != null && hub != null) {
            ok = Number(r.shipmentNumber) === Number(hub);
            detail = ok ? `Shipment ${hub}` : `Packing list says shipment ${r.shipmentNumber}; this is Shipment #${hub}`;
        }
        checks.push(check('shipment-number', 'warn', 'Packing list is for this shipment', ok, detail));
    }

    // 6. Bale weights outside the usual range (possible misread)
    {
        const lo = Number(settings.baleMinKg) || 150, hi = Number(settings.baleMaxKg) || 650;
        const odd = bales.filter(b => b.kg != null && (b.kg < lo || b.kg > hi));
        checks.push(check('bale-range', 'warn', `Bale weights within ${lo}–${hi} kg`, bales.length ? !odd.length : null,
            odd.length ? odd.map(b => `bale ${b.n}: ${fmtKg(b.kg)} kg`).join('; ') + ' — check for a misread'
                : (bales.length ? `${fmtKg(t.minKg)}–${fmtKg(t.maxKg)} kg` : '')));
    }

    // 7. Export invoice number and rate explicitly confirmed
    const ei = ctx.exportInvoice;
    if (ei) {
        checks.push(check('rate-confirmed', 'warn', 'Export rate confirmed', !!ei.rateConfirmed,
            ei.rateConfirmed ? `USD ${fmtRate(ei.rate)}/kg` : `USD ${fmtRate(ei.rate)}/kg not yet confirmed`));
        checks.push(check('number-confirmed', 'warn', 'Invoice number confirmed', !!ei.numberConfirmed,
            ei.numberConfirmed ? String(ei.number || '') : `${ei.number || '—'} not yet confirmed`));
    }
    return checks;
}

export const blockingFailures = checks => (checks || []).filter(c => c.level === 'block' && c.ok === false);

// ── Export invoice defaults ──────────────────────────────────────────────
export function parseInvoiceNumber(s) {
    const m = String(s || '').trim().match(/^(\d+)\s*\/\s*(\d{4})$/);
    return m ? { seq: Number(m[1]), year: Number(m[2]) } : null;
}

// Previous number + 1. The year suffix follows the document date; the
// counter carries on across years (101/2026 → 102/2026 → 103/2027).
export function nextInvoiceNumber(numbers, docYmd) {
    const parsed = (numbers || []).map(parseInvoiceNumber).filter(Boolean)
        .sort((a, b) => a.year - b.year || a.seq - b.seq);
    const year = isYmd(docYmd) ? Number(docYmd.slice(0, 4)) : (parsed.at(-1)?.year || new Date().getFullYear());
    const last = parsed.at(-1);
    return `${last ? last.seq + 1 : 1}/${year}`;
}

// others: [{ shipmentNumber, exportInvoice }] for every other shipment.
export function exportInvoiceDefaults({ others = [], shipmentNumber = null, settings, today }) {
    const s = settings || SETTINGS_SEED;
    const prior = others
        .filter(o => Number(o.exportInvoice?.rate) > 0 && (shipmentNumber == null || o.shipmentNumber == null || o.shipmentNumber < shipmentNumber))
        .sort((a, b) => (b.shipmentNumber ?? 0) - (a.shipmentNumber ?? 0))[0];
    const rate = prior ? Number(prior.exportInvoice.rate) : Number(s.defaultRate) || 0;
    const rateSource = prior ? `Shipment #${prior.shipmentNumber}` : (s.defaultRateSource || 'settings');
    const numbers = [s.lastInvoiceNumber, ...others.map(o => o.exportInvoice?.number)];
    return { number: nextInvoiceNumber(numbers, today), date: today, rate, rateSource, currency: s.currency || 'USD' };
}

// ── Stage and readiness ──────────────────────────────────────────────────
export function lcComplete(lc) {
    return !!(lc && String(lc.number || '').trim() && isYmd(lc.date) && Number(lc.grossKg) > 0);
}

export function deriveStatus(record) {
    const r = record || {};
    if ((r.outputs || []).some(o => o.doc === 'packing' && o.stage === 'final')) return 'final';
    if (r.confirmed && lcComplete(r.lc)) return 'lc_issued';
    if (r.confirmed) return 'draft';
    if (r.files?.packingList || r.files?.proforma || (r.review?.bales || []).length) return 'review';
    return 'not_started';
}
export const STATUS_LABELS = { not_started: 'Not started', review: 'In review', draft: 'Draft', lc_issued: 'LC issued', final: 'Final' };

const reviewKey = r => JSON.stringify({ n: r?.shipmentNumber ?? null, b: normaliseBales(r?.bales), p: r?.packing || null, i: r?.supplierInvoice || null });
export function hasUnconfirmedChanges(record) {
    if (!record?.review) return false;
    if (!record.confirmed) return (record.review.bales || []).length > 0;
    return reviewKey(record.review) !== reviewKey(record.confirmed);
}

// Why a document can't be generated yet ([] = ready).
// doc: 'packing' | 'proforma'; stage: 'draft' | 'final' (packing only).
export function generationIssues({ record, settings, doc, stage = 'draft', shipmentNumber = null, otherInvoiceNumbers = [] }) {
    const r = record || {};
    const out = [];
    if (!settings?.reviewedAt) out.push('Document settings have not been checked against the reference and saved yet');
    const miss = missingSettings(settings, doc);
    if (miss.length) out.push(`Settings incomplete: ${miss.join(', ')}`);
    if (!r.confirmed) { out.push('Confirm the bales first'); return out; }
    const fails = blockingFailures(runChecks(r.confirmed, { settings, shipmentNumber }));
    if (fails.length) out.push(`Confirmed data fails: ${fails.map(f => f.title).join('; ')}`);
    const ei = r.exportInvoice || {};
    if (!isYmd(ei.date)) out.push('Document date missing');
    if (doc === 'proforma') {
        if (!parseInvoiceNumber(ei.number)) out.push('Invoice number must look like 102/2026');
        if (!(Number(ei.rate) > 0)) out.push('Export rate missing');
        if (!ei.rateConfirmed) out.push('Tick to confirm the export rate');
        if (!ei.numberConfirmed) out.push('Tick to confirm the invoice number');
        const dup = otherInvoiceNumbers.find(o => String(o.number || '').replace(/\s/g, '') === String(ei.number || '').replace(/\s/g, ''));
        if (dup) out.push(`Invoice ${ei.number} is already used on Shipment #${dup.shipmentNumber}`);
    }
    if (doc === 'packing' && stage === 'final') {
        const lc = r.lc || {};
        if (!String(lc.number || '').trim()) out.push('LC number missing');
        if (!isYmd(lc.date)) out.push('LC date of issue missing');
        if (!(Number(lc.grossKg) > 0)) out.push('Gross weight missing');
        else if (Number(lc.grossKg) < baleTotals(r.confirmed.bales).netKg) out.push('Gross weight is less than the net weight');
    }
    return out;
}

// Compare our figures with the LC linked to this shipment (Letter of Credit
// tab). Warnings only: the LC is what the bank checks the documents against.
export function lcCrossChecks(record, lc, settings) {
    if (!lc || !record?.confirmed) return [];
    const out = [];
    const t = baleTotals(record.confirmed.bales);
    const ei = record.exportInvoice || {};
    const amount = invoiceAmount(t.netKg, ei.rate);
    const add = (title, ok, detail) => out.push(check('lc-' + out.length, 'warn', title, ok, detail));
    const norm = s => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (record.lc?.number && lc.lcNumber) add('LC number matches the linked LC', norm(record.lc.number) === norm(lc.lcNumber), `Entered ${record.lc.number}; LC record ${lc.lcNumber}`);
    if (record.lc?.date && lc.issuedDate) add('LC date matches the linked LC', record.lc.date === lc.issuedDate, `Entered ${record.lc.date}; LC record ${lc.issuedDate}`);
    if (lc.proformaRef) add('Proforma number matches the LC', norm(lc.proformaRef).includes(norm(String(ei.number || '').split('/')[0])) && !!ei.number, `LC cites ${lc.proformaRef}; invoice ${ei.number || '—'}`);
    if (lc.proformaDate && ei.date) add('Proforma date matches the LC', lc.proformaDate === ei.date, `LC cites ${lc.proformaDate}; invoice dated ${ei.date}`);
    if (Number(lc.amount) > 0 && ei.rate) add('Invoice amount within the LC amount', amount <= Number(lc.amount) + 0.005, `Invoice ${fmtMoney(amount)}; LC ${lc.currency || ''} ${fmtMoney(lc.amount)}`);
    const g = lc.goods || {};
    if (Number(g.quantity) > 0) add('Net weight matches the LC quantity', kgEq(g.quantity, t.netKg), `Bales ${fmtKg(t.netKg)} kg; LC ${fmtKg(g.quantity)} ${g.quantityUnit || ''}`);
    if (Number(g.packageCount) > 0) add('Bale count matches the LC', Number(g.packageCount) === t.count, `${t.count} bales; LC ${g.packageCount} ${g.packageType || ''}`);
    if (g.hsCode && settings?.hsCode) add('HS code matches the LC', norm(g.hsCode) === norm(settings.hsCode), `Settings ${settings.hsCode}; LC ${g.hsCode}`);
    return out;
}

// ── Document rendering ───────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = arr => (Array.isArray(arr) ? arr : String(arr || '').split('\n')).map(s => String(s).trim()).filter(Boolean);
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

export const DOC_TITLES = {
    'packing:draft': 'DRAFT PACKING LIST',
    'packing:final': 'Final Packing List',
    'proforma:draft': 'PROFORMA INVOICE',
};

export function docFilename({ doc, stage, shipmentNumber, date, ext = 'pdf' }) {
    const d = isYmd(date) ? date.slice(8, 10) + date.slice(5, 7) + date.slice(0, 4) : '';
    const base = doc === 'proforma' ? 'Proforma Invoice' : (stage === 'final' ? 'Final Packing List' : 'Packing List');
    return `${base} - #${shipmentNumber ?? ''} - ${d}.${ext}`;
}

function identifierValue(field, { settings, record }) {
    if (field === 'hsCode') return settings.hsCode || '';
    if (field === 'lcNumber') return record.lc?.number || '';
    if (field === 'lcDate') return record.lc?.date ? longDate(record.lc.date) : '';
    return settings.identifiers?.[field] || '';
}

// Shared page chrome: A4, single page, a screen-only toolbar with Print.
function page({ title, font, body, banner }) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
@page { size: A4; margin: 14mm 16mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #e5e7eb; color: #000; }
body { font-family: ${font}; font-size: 10.5pt; line-height: 1.3; }
.sheet { width: 210mm; min-height: 297mm; margin: 12px auto; background: #fff; padding: 14mm 16mm; box-shadow: 0 2px 12px rgba(0,0,0,.15); }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; justify-content: center; padding: 8px; background: #1e293b; color: #e2e8f0; font: 13px system-ui, sans-serif; }
.toolbar button { font: 600 13px system-ui, sans-serif; padding: 6px 14px; border-radius: 6px; border: 0; background: #2563eb; color: #fff; cursor: pointer; }
.toolbar .banner { color: #fbbf24; }
table { border-collapse: collapse; }
@media print {
  html, body { background: #fff; }
  .toolbar { display: none; }
  .sheet { margin: 0; padding: 0; width: auto; min-height: 0; box-shadow: none; }
}
${body.css}
</style></head>
<body>
<div class="toolbar"><span>${esc(title)}</span>${banner ? `<span class="banner">${esc(banner)}</span>` : ''}<button onclick="window.print()">Print / Save as PDF</button></div>
<div class="sheet">${body.html}</div>
</body></html>`;
}

// Enviroware packing list, Draft or Final. Arial, one A4 page.
export function renderPackingList({ record, settings, stage = 'draft', shipmentNumber = null, banner = '' }) {
    const s = settings || SETTINGS_SEED;
    const r = record || {};
    const conf = r.confirmed || emptyReview();
    const shipNo = shipmentNumber ?? conf.shipmentNumber ?? '';
    const t = baleTotals(conf.bales);
    const [left, right] = splitBaleColumns(conf.bales);
    const isFinal = stage === 'final';
    const ei = r.exportInvoice || {};
    const rows = Math.max(left.length, right.length);
    // One A4 page (269 mm printable): the bale rows share what the fixed
    // blocks leave — measured at ~131 mm on the Draft and ~147 mm on the
    // Final (gross weight, applicant line, extra identifier row). 45 bales
    // print at ~5 mm a row; the Draft fits ~68 bales, the Final ~62. Font
    // steps down with the row height.
    const budget = isFinal ? 112 : 124;
    const rowH = Math.max(3.4, Math.min(6, budget / (rows + 1)));
    const baleFont = rowH >= 4.6 ? 9.5 : rowH >= 4 ? 8.5 : 7.5;
    const baleRows = [];
    for (let i = 0; i < rows; i++) {
        const a = left[i], b = right[i];
        baleRows.push(`<tr><td class="n">${a ? a.n : ''}</td><td class="kg">${a ? fmtKg(a.kg) : ''}</td><td class="gap"></td><td class="n">${b ? b.n : ''}</td><td class="kg">${b ? fmtKg(b.kg) : ''}</td></tr>`);
    }
    const ids = (s.identifierRows?.[isFinal ? 'final' : 'draft'] || [])
        .map(row => `<tr><th>${esc(row.label)}</th><td>${esc(identifierValue(row.field, { settings: s, record: r }))}</td></tr>`).join('');
    const seller = s.seller || {};
    const applicant = [s.buyer?.name, ...lines(s.buyer?.addressLines)].filter(Boolean).join(', ');
    const title = DOC_TITLES[`packing:${isFinal ? 'final' : 'draft'}`];
    const html = `
<header class="lh">
  <div class="lh-name">${esc(seller.name)}</div>
  <div class="lh-strap">${esc(seller.strapline)}</div>
  <div class="lh-addr">${esc(lines(seller.addressLines).join(', '))}</div>
  <div class="lh-addr">${seller.phone ? 'Phone: ' + esc(seller.phone) : ''}${seller.phone && seller.email ? ' &nbsp;|&nbsp; ' : ''}${seller.email ? 'Email: ' + esc(seller.email) : ''}</div>
</header>
<h1 class="title">${esc(title)}</h1>
<table class="summary">
  <tr><th>Shipment</th><td>${esc(shipNo)}</td></tr>
  <tr><th>No. of Packages</th><td>${t.count}</td></tr>
  <tr><th>Net Weight</th><td>${fmtKg(t.netKg)} kg</td></tr>
  ${isFinal ? `<tr><th>Gross Weight</th><td>${r.lc?.grossKg ? fmtKg(r.lc.grossKg) + ' kg' : ''}</td></tr>` : ''}
  <tr><th>Date</th><td>${esc(longDate(ei.date))}</td></tr>
</table>
<h2 class="subtitle">${esc(s.goods?.subtitle)}</h2>
<table class="bales">
  <thead><tr><th>Bale #</th><th>Net Weight (kg)</th><th class="gap"></th><th>Bale #</th><th>Net Weight (kg)</th></tr></thead>
  <tbody>${baleRows.join('')}</tbody>
</table>
${isFinal && applicant ? `<p class="applicant"><strong>Applicant:</strong> ${esc(applicant)}</p>` : ''}
<table class="ids">${ids}</table>
<p class="spec"><strong>Packing:</strong> ${esc(s.packingSpec?.[isFinal ? 'final' : 'draft'])}</p>
<div class="sign">
  <div class="sign-line"></div>
  <div>${esc(s.signOff?.packingName)}</div>
  <div>${esc(s.signOff?.packingTitle)}</div>
  <div>${esc(s.signOff?.company || seller.name)}</div>
</div>`;
    const css = `
.lh { text-align: center; border-bottom: 1.5pt solid #000; padding-bottom: 2mm; margin-bottom: 3mm; line-height: 1.25; }
.lh-name { font-size: 16pt; font-weight: bold; }
.lh-strap { font-style: italic; font-size: 9pt; }
.lh-addr { font-size: 8.5pt; }
.title { text-align: center; font-size: 13pt; margin: 1mm 0 3mm; letter-spacing: .03em; }
.summary { margin: 0 auto 3mm; min-width: 95mm; }
.summary th, .summary td { border: 0.75pt solid #000; padding: 0.6mm 3mm; text-align: left; font-size: 10pt; line-height: 1.2; }
.summary th { width: 42mm; background: #f2f2f2; }
.subtitle { text-align: center; font-size: 11pt; margin: 0 0 2mm; }
.bales { margin: 0 auto 3mm; }
.bales th, .bales td { border: 0.75pt solid #000; padding: 0 4mm; font-size: ${baleFont}pt; line-height: 1; height: ${rowH.toFixed(2)}mm; white-space: nowrap; }
.bales th { background: #f2f2f2; }
.bales td.n { text-align: center; width: 16mm; }
.bales td.kg { text-align: right; width: 30mm; }
.bales .gap { border: 0; width: 10mm; background: none; padding: 0; }
.applicant { margin: 0 0 1.5mm; font-size: 9.5pt; }
.ids { margin: 0 0 2mm; }
.ids th, .ids td { padding: 0.25mm 3mm 0.25mm 0; text-align: left; font-size: 9pt; line-height: 1.2; vertical-align: top; }
.ids th { font-weight: bold; white-space: nowrap; }
.spec { margin: 0 0 3mm; font-size: 9.5pt; }
.sign { font-size: 9.5pt; line-height: 1.25; }
.sign-line { width: 55mm; border-bottom: 0.75pt solid #000; height: 9mm; margin-bottom: 1mm; }`;
    return page({ title: `${title} – Shipment #${shipNo}`, font: 'Arial, Helvetica, sans-serif', body: { html, css }, banner });
}

// Enviroware proforma invoice. Times New Roman, one A4 page. Never shows
// the supplier, its bank or EUR prices: only the export figures.
export function renderProforma({ record, settings, assets = {}, shipmentNumber = null, banner = '' }) {
    const s = settings || SETTINGS_SEED;
    const r = record || {};
    const conf = r.confirmed || emptyReview();
    const t = baleTotals(conf.bales);
    const ei = r.exportInvoice || {};
    const ccy = ei.currency || s.currency || 'USD';
    const amount = invoiceAmount(t.netKg, ei.rate);
    const vars = { bales: t.count, netKg: fmtKg(t.netKg), rate: fmtRate(ei.rate), currency: ccy, shipment: shipmentNumber ?? conf.shipmentNumber ?? '' };
    const seller = s.seller || {}, bank = s.bank || {}, buyer = s.buyer || {};
    const img = (a, cls) => a && a.data ? `<img class="${cls}" src="data:${esc(a.mediaType || 'image/png')};base64,${a.data}" alt="">` : '';
    const html = `
<header class="lh">
  <div class="lh-name">${esc(seller.name)}</div>
  <div class="lh-strap">${esc(seller.strapline)}</div>
  <div class="lh-cols">
    <div>
      ${lines(seller.addressLines).map(l => `<div>${esc(l)}</div>`).join('')}
      ${seller.phone ? `<div>Phone: ${esc(seller.phone)}</div>` : ''}
      ${seller.email ? `<div>Email: ${esc(seller.email)}</div>` : ''}
      ${seller.gstNumber ? `<div>GST No: ${esc(seller.gstNumber)}</div>` : ''}
    </div>
    <div class="bank">
      ${bank.name ? `<div><strong>${esc(bank.name)}</strong></div>` : ''}
      ${lines(bank.addressLines).map(l => `<div>${esc(l)}</div>`).join('')}
      ${bank.swift ? `<div>SWIFT: ${esc(bank.swift)}</div>` : ''}
      ${bank.accountName ? `<div>Account name: ${esc(bank.accountName)}</div>` : ''}
      ${bank.accountNumber ? `<div>Account no: ${esc(bank.accountNumber)}</div>` : ''}
    </div>
  </div>
</header>
<h1 class="title">PROFORMA INVOICE</h1>
<table class="meta">
  <tr><th>Invoice No:</th><td>${esc(ei.number)}</td></tr>
  <tr><th>Date:</th><td>${esc(longDate(ei.date))}</td></tr>
</table>
<div class="to"><strong>To:</strong>
  <div class="to-block"><div>${esc(buyer.name)}</div>${lines(buyer.addressLines).map(l => `<div>${esc(l)}</div>`).join('')}</div>
</div>
<div class="details">
  <div><strong>Shipment ${esc(vars.shipment)}</strong></div>
  <div>${esc(fill(s.goods?.proformaDescription, vars))}</div>
  <div>HS Code: ${esc(s.hsCode)}</div>
  <div>Total Net Weight: ${esc(vars.netKg)}kg</div>
</div>
<table class="lines">
  <thead><tr><th>Description</th><th class="amt">Amount (${esc(ccy)})</th></tr></thead>
  <tbody>
    <tr><td>${esc(fill(s.goods?.proformaLine, vars))}</td><td class="amt">${fmtMoney(amount)}</td></tr>
    <tr><td>GST</td><td class="amt">Nil</td></tr>
    <tr class="total"><td>Total</td><td class="amt">${esc(ccy)} ${fmtMoney(amount)}</td></tr>
  </tbody>
</table>
<div class="terms"><strong>Terms &amp; Conditions</strong>
  <ol>${lines(s.terms).map(l => `<li>${esc(l)}</li>`).join('')}</ol>
</div>
<div class="sign">
  <div class="sign-left">
    ${img(assets.signature, 'sig') || '<div class="sig-space"></div>'}
    <div class="sign-name">${esc(s.signOff?.proformaName)}</div>
    <div>${esc(s.signOff?.proformaTitle)}</div>
    <div>${esc(seller.name)}</div>
  </div>
  ${img(assets.seal, 'seal')}
</div>`;
    const css = `
.lh { border-bottom: 1.5pt solid #000; padding-bottom: 3mm; margin-bottom: 5mm; }
.lh-name { font-size: 20pt; font-weight: bold; text-align: center; }
.lh-strap { font-style: italic; text-align: center; margin-bottom: 3mm; }
.lh-cols { display: flex; justify-content: space-between; gap: 10mm; font-size: 10pt; }
.lh-cols .bank { text-align: right; }
.title { text-align: center; font-size: 16pt; letter-spacing: .06em; margin: 0 0 4mm; }
.meta { margin: 0 0 4mm auto; }
.meta th { text-align: right; padding: 0.5mm 3mm 0.5mm 0; }
.meta td { padding: 0.5mm 0; }
.to { margin-bottom: 4mm; }
.to-block { margin: 1mm 0 0 8mm; }
.details { margin-bottom: 4mm; }
.details div { margin-bottom: 0.8mm; }
.lines { width: 100%; margin-bottom: 5mm; }
.lines th, .lines td { border: 0.75pt solid #000; padding: 1.5mm 3mm; text-align: left; }
.lines th { background: #f2f2f2; }
.lines .amt { text-align: right; width: 48mm; white-space: nowrap; }
.lines tr.total td { font-weight: bold; }
.terms { margin-bottom: 6mm; font-size: 10.5pt; }
.terms ol { margin: 1.5mm 0 0; padding-left: 6mm; }
.terms li { margin-bottom: 0.6mm; }
.sign { display: flex; align-items: flex-end; justify-content: space-between; }
.sig { max-height: 22mm; max-width: 60mm; display: block; }
.sig-space { height: 18mm; }
.sign-name { font-weight: bold; margin-top: 1mm; }
.seal { max-height: 34mm; max-width: 40mm; }`;
    return page({ title: `Proforma Invoice ${ei.number || ''} – Shipment #${vars.shipment}`, font: '"Times New Roman", Times, serif', body: { html, css }, banner });
}

// ── Packing list workbook (.xlsx) ────────────────────────────────────────
// Same content as renderPackingList, as a sheet spec for _xlsx.js. Package
// count and net weight are formulas over the bale cells, like the
// reference workbook; a Final tab is added once the LC details are in.
export function packingListSheet({ record, settings, stage = 'draft', shipmentNumber = null }) {
    const s = settings || SETTINGS_SEED;
    const r = record || {};
    const conf = r.confirmed || emptyReview();
    const t = baleTotals(conf.bales);
    const [left, right] = splitBaleColumns(conf.bales);
    const isFinal = stage === 'final';
    const seller = s.seller || {};
    const rows = [];
    const merges = [];
    const full = (v, st) => { const i = rows.length + 1; rows.push([{ v, s: st }, { s: st }, { s: st }, { s: st }, { s: st }]); merges.push(`A${i}:E${i}`); };
    const blank = () => rows.push([]);
    const pair = (label, value, valueStyle = 'value') => {
        const i = rows.length + 1;
        rows.push([{ v: label, s: 'label' }, { s: 'label' }, { ...(typeof value === 'object' ? value : { v: value }), s: valueStyle }, { s: valueStyle }, { s: valueStyle }]);
        merges.push(`A${i}:B${i}`, `C${i}:E${i}`);
    };

    full(seller.name, 'name');
    full(seller.strapline, 'strap');
    full(lines(seller.addressLines).join(', '), 'center');
    full([seller.phone ? 'Phone: ' + seller.phone : '', seller.email ? 'Email: ' + seller.email : ''].filter(Boolean).join('  |  '), 'center');
    blank();
    full(DOC_TITLES[`packing:${isFinal ? 'final' : 'draft'}`], 'title');
    blank();

    // Summary box. Bale rows come later; their row numbers are known now.
    const summaryRows = isFinal ? 5 : 4;
    const firstBaleRow = rows.length + summaryRows + 1 /* blank */ + 1 /* subtitle */ + 1 /* blank */ + 1 /* header */ + 1;
    const rng = (col, list) => list.length ? `${col}${firstBaleRow}:${col}${firstBaleRow + list.length - 1}` : null;
    const ranges = [rng('B', left), rng('E', right)].filter(Boolean).join(',');
    pair('Shipment', shipmentNumber ?? conf.shipmentNumber ?? '', 'valueInt');
    pair('No. of Packages', { f: ranges ? `COUNT(${ranges})` : null, v: t.count }, 'valueInt');
    pair('Net Weight', { f: ranges ? `SUM(${ranges})` : null, v: t.netKg }, 'valueKg');
    if (isFinal) pair('Gross Weight', Number(r.lc?.grossKg) || '', 'valueKg');
    pair('Date', longDate(r.exportInvoice?.date));
    blank();
    full(s.goods?.subtitle, 'subtitle');
    blank();
    rows.push([{ v: 'Bale #', s: 'th' }, { v: 'Net Weight (kg)', s: 'th' }, null, { v: 'Bale #', s: 'th' }, { v: 'Net Weight (kg)', s: 'th' }]);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const a = left[i], b = right[i];
        rows.push([
            a ? { v: a.n, s: 'tdCenter' } : null, a ? { v: Number(a.kg), s: 'tdKg' } : null, null,
            b ? { v: b.n, s: 'tdCenter' } : null, b ? { v: Number(b.kg), s: 'tdKg' } : null,
        ]);
    }
    blank();
    if (isFinal) {
        const applicant = [s.buyer?.name, ...lines(s.buyer?.addressLines)].filter(Boolean).join(', ');
        if (applicant) full('Applicant: ' + applicant, 'default');
    }
    for (const row of (s.identifierRows?.[isFinal ? 'final' : 'draft'] || [])) {
        const i = rows.length + 1;
        rows.push([{ v: row.label, s: 'bold' }, null, { v: identifierValue(row.field, { settings: s, record: r }) }]);
        merges.push(`A${i}:B${i}`, `C${i}:E${i}`);
    }
    blank();
    full('Packing: ' + (s.packingSpec?.[isFinal ? 'final' : 'draft'] || ''), 'default');
    blank(); blank(); blank();
    rows.push(['______________________________']);
    rows.push([s.signOff?.packingName || '']);
    rows.push([s.signOff?.packingTitle || '']);
    rows.push([s.signOff?.company || seller.name || '']);
    return { name: isFinal ? 'Final' : 'Draft', cols: [12, 20, 4, 12, 20], rows, merges };
}

export function packingListWorkbookSpec({ record, settings, shipmentNumber = null }) {
    const sheets = [packingListSheet({ record, settings, stage: 'draft', shipmentNumber })];
    if (lcComplete(record?.lc)) sheets.push(packingListSheet({ record, settings, stage: 'final', shipmentNumber }));
    return { sheets };
}

// ── Request sanitising (PATCH / PUT bodies) ──────────────────────────────
const cleanStr = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const rawOrNull = v => (v == null || v === '' ? null : String(v).slice(0, 60));

export function sanitiseReview(r) {
    if (!isObj(r)) return emptyReview();
    const p = isObj(r.packing) ? r.packing : {};
    const inv = isObj(r.supplierInvoice) ? r.supplierInvoice : null;
    return {
        shipmentNumber: toNum(r.shipmentNumber),
        bales: normaliseBales(r.bales).slice(0, 500),
        packing: {
            whiteTotalKg: toNum(p.whiteTotalKg), whiteTotalRaw: rawOrNull(p.whiteTotalRaw),
            colouredTotalKg: toNum(p.colouredTotalKg), colouredTotalRaw: rawOrNull(p.colouredTotalRaw),
            packages: toNum(p.packages), packagesRaw: rawOrNull(p.packagesRaw),
        },
        supplierInvoice: inv ? {
            number: cleanStr(inv.number, 40), date: isYmd(inv.date) ? inv.date : '', dateRaw: rawOrNull(inv.dateRaw),
            currency: cleanStr(inv.currency || 'EUR', 3).toUpperCase(),
            lines: (Array.isArray(inv.lines) ? inv.lines : []).slice(0, 20).map(l => ({
                description: cleanStr(l?.description), colour: normaliseColour(l?.colour),
                kg: toNum(l?.kg), kgRaw: rawOrNull(l?.kgRaw),
                unitPrice: toNum(l?.unitPrice), unitPriceRaw: rawOrNull(l?.unitPriceRaw),
                amount: toNum(l?.amount), amountRaw: rawOrNull(l?.amountRaw),
            })),
            netKg: toNum(inv.netKg), netKgRaw: rawOrNull(inv.netKgRaw),
            total: toNum(inv.total), totalRaw: rawOrNull(inv.totalRaw),
            destination: cleanStr(inv.destination), deliveryTerms: cleanStr(inv.deliveryTerms), hsCode: cleanStr(inv.hsCode, 30),
        } : null,
    };
}

export function sanitiseExportInvoice(e, fallback = {}) {
    const x = isObj(e) ? e : {};
    return {
        number: cleanStr(x.number ?? fallback.number, 20),
        date: isYmd(x.date) ? x.date : (isYmd(fallback.date) ? fallback.date : ''),
        rate: toNum(x.rate ?? fallback.rate),
        currency: cleanStr(x.currency || fallback.currency || 'USD', 3).toUpperCase(),
        numberConfirmed: x.numberConfirmed === true,
        rateConfirmed: x.rateConfirmed === true,
    };
}

export function sanitiseLc(l) {
    const x = isObj(l) ? l : {};
    return { number: cleanStr(x.number, 40), date: isYmd(x.date) ? x.date : '', grossKg: toNum(x.grossKg) };
}

export function sanitiseSettings(input) {
    const x = isObj(input) ? input : {};
    const base = mergeSettings(x);
    const strs = (a, max = 20) => (Array.isArray(a) ? a : String(a || '').split('\n')).map(s => cleanStr(s, 300)).filter(Boolean).slice(0, max);
    const rows = a => (Array.isArray(a) ? a : []).filter(r => IDENTIFIER_FIELDS.includes(r?.field)).map(r => ({ label: cleanStr(r.label, 80), field: r.field })).slice(0, 20);
    const sec = (obj, keys) => Object.fromEntries(keys.map(k => [k, cleanStr(obj?.[k], 300)]));
    return {
        seller: { ...sec(base.seller, ['name', 'strapline', 'phone', 'email', 'gstNumber']), addressLines: strs(base.seller.addressLines, 6) },
        bank: { ...sec(base.bank, ['name', 'swift', 'accountName', 'accountNumber']), addressLines: strs(base.bank.addressLines, 6) },
        buyer: { name: cleanStr(base.buyer.name), addressLines: strs(base.buyer.addressLines, 6) },
        identifiers: sec(base.identifiers, ['irc', 'applicantTin', 'applicantBin', 'bankName', 'bankBin', 'bankTin', 'bankVatReg']),
        hsCode: cleanStr(base.hsCode, 30),
        goods: sec(base.goods, ['subtitle', 'proformaDescription', 'proformaLine']),
        packingSpec: sec(base.packingSpec, ['draft', 'final']),
        identifierRows: { draft: rows(base.identifierRows.draft), final: rows(base.identifierRows.final) },
        terms: strs(base.terms, 15),
        signOff: sec(base.signOff, ['packingName', 'packingTitle', 'company', 'proformaName', 'proformaTitle']),
        currency: cleanStr(base.currency || 'USD', 3).toUpperCase(),
        defaultRate: toNum(base.defaultRate),
        defaultRateSource: cleanStr(base.defaultRateSource, 60),
        lastInvoiceNumber: cleanStr(base.lastInvoiceNumber, 20),
        baleMinKg: toNum(base.baleMinKg) ?? 150,
        baleMaxKg: toNum(base.baleMaxKg) ?? 650,
        jpsMarginPerKg: toNum(base.jpsMarginPerKg),
        xero: {
            supplierContact: cleanStr(base.xero?.supplierContact, 120),
            buyerContact: cleanStr(base.xero?.buyerContact, 120),
            status: ['DRAFT', 'SUBMITTED', 'AUTHORISED'].includes(base.xero?.status) ? base.xero.status : 'DRAFT',
            accounts: sec(base.xero?.accounts, ['rawProduct', 'lcDeposit', 'handling', 'exportSale']),
            taxTypes: sec(base.xero?.taxTypes, ['purchases', 'exportSale']),
        },
    };
}
