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
// Seeded from Enviroware's Commercial Invoice 101/2026 for Shipment 42
// (16 Jul 2026, LC 320126011494): the wording the bank accepted. They rarely
// change; each shipment's linked LC is checked against the identifiers.
// Only the parts that can change are shown in Document settings — the rest
// (labels, wording templates, sign-off, defaults) lives here.
export const SETTINGS_SEED = {
    seller: {
        name: 'Enviroware Ltd',
        strapline: 'PRIME TIE – the stretchy loop tie',
        addressLines: ['193 Mount Smart Road,', 'Onehunga, 1061', 'New Zealand'],
        phone: '+64-27-6312070',
        email: 'andrew@primetie.co.nz',
        gstNumber: '129-544-112',
    },
    // Enviroware's bank, printed on the proforma letterhead (as JPS has it on
    // their proforma for Shipment 43).
    bank: { name: 'ANZ Bank New Zealand Ltd', addressLines: ['23-29 Albert Street', 'Auckland, New Zealand'], swift: 'ANZBNZ22', accountNumber: '' },
    buyer: {
        name: 'JPS Enterprise',
        addressLines: ['Komolapur, Holding no:533 Birulia', 'Savar', 'Dhaka-1340,', 'Bangladesh'],
    },
    // The applicant's numbers: IRC, TIN, BIN and bank TIN / VAT reg no. as on
    // Commercial Invoice 101/2026; the SBAC Bank BIN as on the Shipment 43
    // draft packing list (a different number from the VAT reg no.).
    identifiers: {
        irc: '260326110775319', applicantTin: '358887309351', applicantBin: '001173726-0403',
        bankName: 'SBAC Bank', bankTin: '166085152182', bankBin: '000000203-0002', bankVatReg: '000060296-0202',
    },
    hsCode: '6002.90.00',
    goods: {
        subtitle: 'Knitted Nylon Stocking Material',
        proformaDescription: '{bales} bales of knitted nylon stocking material (Toeclip) a by-product from the manufacture of stockings',
        proformaLine: '{netKg} kg toeclip @ $USD{rate}/kg',
    },
    packingSpec: {
        draft: 'Standard Export Seaworthy',
        final: 'EXPORT STANDARD ROAD / SEA WORTHY CONDITION',
    },
    // Identifier rows on the packing list, lettered AA, BB, CC… as on the
    // Shipment 43 draft and the Shipment 42 final (they word them
    // differently). `field` picks the value; `suffix` follows it ({bankName} =
    // the applicant's bank); `span` prints label and value as one line.
    identifierRows: {
        draft: [
            { label: 'IRC NO', field: 'irc' },
            { label: 'TIN NO.', field: 'applicantTin' },
            { label: 'BIN NO.', field: 'applicantBin', suffix: '(APPLICANT)' },
            { label: 'BIN NO.', field: 'bankBin', suffix: '({bankName})' },
            { label: 'HS CODE NO.', field: 'hsCode' },
            { label: 'LC NO:', field: 'lcNumber' },
            { label: 'LC DATE OF ISSUE:', field: 'lcDate' },
        ],
        final: [
            { label: 'Applicant:', field: 'applicant', span: true },
            { label: 'IRC NO', field: 'irc' },
            { label: "APPLICANT'S TIN NO.", field: 'applicantTin' },
            { label: "APPLICANT'S BIN NO.", field: 'applicantBin' },
            { label: "APPLICANT'S BANK TIN NO.", field: 'bankTin' },
            { label: 'VAT REG NO.', field: 'bankVatReg' },
            { label: 'HS CODE NO.', field: 'hsCode' },
            { label: 'LC NO:', field: 'lcNumber' },
            { label: 'LC DATE OF ISSUE:', field: 'lcDate' },
        ],
    },
    // JPS Enterprise's own details, for our rewrite of their sales proforma
    // invoice (their template is full of typos). From their proforma for
    // Shipment 43, corrected. Letterhead name and address are buyer.* above.
    jps: {
        phone: '+880 1817 011668, +880 1726 624893',
        email: 'jpsenterprise@gmail.com',
        signatory: 'Sudipto Sarkar (Paul)',
        bank: { name: 'SBAC Bank PLC', addressLines: ['Galaxy Bhaban (1st Floor), Plot 29-30, Block 6, Mirpur-10', 'Dhaka, Bangladesh'], swift: 'SBACBDDH' },
        portOfLoading: 'ICD Kamlapur, Dhaka, via Chattogram, Bangladesh',
        destination: 'Tauranga, New Zealand',
        freightTerms: 'FOB',
        modeOfShipment: 'By sea',
        payment: '100% in advance by bank T/T before shipment',
        origin: 'Italy',
        goodsDescription: 'Sorted knitted nylon stocking material (toeclip), a by-product of the manufacture of stockings, and wastage after sorting',
    },
    terms: [
        'Country of Origin: Italy',
        'Port of Loading: Any port of Italy',
        'Place of Final Destination: ICD Kamlapur, Dhaka Via Chattogram Seaport, Bangladesh',
        'Freight Terms: CPT',
        'Container Size: 1x 40 FCL',
        'Mode of Shipment: By Sea',
        'Goods imported under temporary basis import. Goods must be re-exported.',
    ],
    signOff: {
        packingName: 'Andrew McLeod',
        packingTitle: 'DIRECTOR',
        company: 'Enviroware Ltd',
        proformaName: 'ANDREW FRASER MCLEOD',
        proformaTitle: 'DIRECTOR',
        proformaFor: 'For and on behalf of Enviroware Ltd',
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
        // 'nzd': EUR / USD documents go in as NZD at the day's rate (this Xero
        // has no multi-currency). 'foreign': in their own currency.
        currencyMode: 'nzd',
        accounts: { rawProduct: '', lcDeposit: '', handling: '', exportSale: '' },
        // New Zealand tax rate codes: ZERORATED = Zero Rated, NONE = No GST.
        taxTypes: { purchases: 'NONE', exportSale: 'ZERORATED' },
    },
};

export const IDENTIFIER_FIELDS = ['applicant', 'irc', 'applicantTin', 'applicantBin', 'bankBin', 'bankTin', 'bankVatReg', 'hsCode', 'lcNumber', 'lcDate'];

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Saved settings over the seed, two levels of sections deep (arrays
// replace). A blank saved value never hides a seeded one. The sections the
// settings window doesn't edit always come from the code.
const isBlank = v => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const CODE_OWNED = ['identifierRows', 'goods', 'signOff'];
// Until 17 Nov 2026 the seed had the VAT reg no. as the bank's BIN.
const OLD_BANK_BIN = '000060296-0202';
export function mergeSettings(saved) {
    const out = structuredClone(SETTINGS_SEED);
    if (!isObj(saved)) return out;
    saved = { ...saved };
    for (const k of CODE_OWNED) delete saved[k];
    // Until 18 Nov 2026 the seed had the UK code ZERORATEDOUTPUT, which a New
    // Zealand Xero refuses; its zero-rated code is ZERORATED.
    if (isObj(saved.xero) && isObj(saved.xero.taxTypes) && saved.xero.taxTypes.exportSale === 'ZERORATEDOUTPUT') {
        saved.xero = { ...saved.xero, taxTypes: { ...saved.xero.taxTypes, exportSale: 'ZERORATED' } };
    }
    if (isObj(saved.identifiers) && String(saved.identifiers.bankBin || '').trim() === OLD_BANK_BIN && !saved.identifiers.bankVatReg) {
        saved.identifiers = { ...saved.identifiers, bankBin: '', bankVatReg: OLD_BANK_BIN };
    }
    const into = (dst, src) => {
        for (const [k, v] of Object.entries(src)) {
            if (isObj(v) && isObj(dst[k])) into(dst[k], v);
            else if (!isBlank(v) || isBlank(dst[k])) dst[k] = v;
        }
    };
    into(out, saved);
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
    if (doc === 'jps') {
        need(s.seller?.gstNumber, 'GST no.');
        need(s.bank?.name, 'Bank name');
        need(s.bank?.swift, 'Bank SWIFT');
        need(s.buyer?.name, 'JPS name');
        need(s.buyer?.addressLines, 'JPS address');
        need(s.jps?.bank?.name, "JPS's bank");
        need(s.jps?.bank?.swift, "JPS's bank SWIFT");
        need(s.jps?.signatory, 'JPS signatory');
    } else if (doc === 'proforma') {
        need(s.seller?.gstNumber, 'GST no.');
        need(s.bank?.name, 'Bank name');
        need(s.bank?.swift, 'Bank SWIFT');
        need(s.buyer?.name, 'Buyer name');
        need(s.buyer?.addressLines, 'Buyer address');
        need(s.terms, 'Terms & conditions');
    } else {
        const labels = { irc: 'IRC no.', applicantTin: 'Applicant TIN', applicantBin: 'Applicant BIN', bankBin: 'Bank BIN', bankVatReg: 'Bank VAT reg no.', bankTin: 'Bank TIN' };
        const rows = [...(s.identifierRows?.draft || []), ...(s.identifierRows?.final || [])];
        for (const f of new Set(rows.map(r => r.field))) {
            if (labels[f]) need(s.identifiers?.[f], labels[f]);
        }
    }
    return miss;
}

// ── Numbers ──────────────────────────────────────────────────────────────
// Currency and unit decorations either side of a printed figure:
// "USD$1.82", "US$ 32,815.30", "€ 1,50", "1,50 €/kg", "18.130 kg".
export function stripDecorations(raw) {
    let s = String(raw).trim();
    for (let i = 0; i < 3; i++) {
        const before = s;
        s = s.replace(/^(?:USD|US|NZD|AUD|EUR|BDT|TK\.?|KGS?\.?)\s*/i, '').replace(/^[$€৳]\s*/, '')
             .replace(/\s*(?:\/\s*kgs?\.?|per\s+kgs?\.?|kgs?\.?|USD|NZD|EUR|BDT|€|\$)$/i, '').trim();
        if (s === before) break;
    }
    return s.replace(/\s+/g, '');
}

// Italian formatting: dot groups thousands, comma marks decimals.
//   "4.887" → 4887   "7.330,50" → 7330.5   "0,75" → 0.75   "18130" → 18130
// Anything that isn't valid Italian formatting returns null (e.g. "1.50",
// which would be a misplaced thousands dot) rather than being guessed at.
export function parseItalianNumber(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/ /g, ' ').trim();
    s = stripDecorations(s);
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
// "2026-11-17" → "17 Nov 2026": the one date format on screen (documents keep longDate).
export function shortDate(ymd) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1].slice(0, 3)} ${m[1]}` : '';
}

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
            whiteTotalKg: toNum(e.whiteTotalKg), whiteTotalRaw: e.whiteTotalRaw || null,
            colouredTotalKg: toNum(e.colouredTotalKg), colouredTotalRaw: e.colouredTotalRaw || null,
            packages: toNum(e.totalPackages), packagesRaw: e.totalPackagesRaw || null,
        },
    };
}

export function reviewFromProformaExtraction(x) {
    const e = x || {};
    return {
        number: e.documentNumber != null ? String(e.documentNumber) : '',
        date: isYmd(e.documentDate) ? e.documentDate : '',
        dateRaw: e.documentDateRaw || null,
        currency: String(e.currency || 'EUR').toUpperCase(),
        lines: (Array.isArray(e.lines) ? e.lines : []).map(l => ({
            description: String(l?.description || ''),
            colour: normaliseColour(l?.colour),
            kg: toNum(l?.kg), kgRaw: l?.kgRaw || null,
            unitPrice: toNum(l?.unitPrice), unitPriceRaw: l?.unitPriceRaw || null,
            amount: toNum(l?.amount), amountRaw: l?.amountRaw || null,
        })),
        netKg: toNum(e.netWeightKg), netKgRaw: e.netWeightRaw || null,
        total: toNum(e.total), totalRaw: e.totalRaw || null,
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
// dismissible: a failing check the user may dismiss instead of correcting
// (paperwork that disagrees with itself). Not for data the documents need.
export function check(id, level, title, ok, detail, { dismissible = true } = {}) {
    return { id, level, title, ok, detail: detail || '', dismissible: !!dismissible };
}

// record.dismissed = { [checkId]: { detail, title, by, at } }. A dismissal
// holds only while the check fails with exactly the same detail, so a
// different problem in the same check shows up again.
export function applyDismissals(checks, dismissed) {
    const d = dismissed || {};
    return (checks || []).map(c => {
        const x = d[c.id];
        return c.ok === false && c.dismissible && x && x.detail === c.detail
            ? { ...c, dismissed: { by: x.by || null, at: x.at || null } }
            : c;
    });
}

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
        let hard = !bales.length;
        if (nums.some(n => n == null)) { issues.push('A bale has no number'); hard = true; }
        const seen = new Set(), dupes = new Set();
        nums.forEach(n => { if (n != null) { if (seen.has(n)) dupes.add(n); seen.add(n); } });
        if (dupes.size) { issues.push(`Duplicate bale ${[...dupes].join(', ')}`); hard = true; }
        const max = Math.max(0, ...nums.filter(n => n != null));
        const missing = [];
        for (let i = 1; i <= max; i++) if (!seen.has(i)) missing.push(i);
        if (missing.length) issues.push(`Missing bale ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`);
        if (nums.some(n => n != null && n < 1)) { issues.push('Bale numbers must start at 1'); hard = true; }
        const noKg = bales.filter(b => !(Number(b.kg) > 0)).map(b => b.n);
        if (noKg.length) { issues.push(`No weight on bale ${noKg.join(', ')}`); hard = true; }
        const noColour = bales.filter(b => !b.colour).map(b => b.n);
        if (noColour.length) { issues.push(`No colour on bale ${noColour.join(', ')}`); hard = true; }
        if (p.packages == null) issues.push("Supplier's package count missing");
        else if (Number(p.packages) !== bales.length) issues.push(`${bales.length} bales but the supplier states ${p.packages} packages`);
        checks.push(check('bale-sequence', 'block', 'Bales numbered 1 to N, N = supplier package count', !issues.length,
            issues.length ? issues.join('; ') : `Bales 1–${bales.length}, matching ${p.packages} packages`, { dismissible: !hard }));
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
        checks.push(check('net-weight', 'block', 'Bales sum to the supplier proforma net weight', ok, detail, { dismissible: !!inv }));
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
            issues.length ? issues.join('; ') : `${(inv.lines || []).length} lines = ${inv.currency || ''} ${fmtMoney(inv.total)}`, { dismissible: !!inv }));
    }

    // 4a. Pistoni's document number (the Pistoni bill's number in Xero) isn't
    // one of our own registration numbers — Shipment 43's was read as
    // Enviroware's GST no. 129-544-112, printed in the customer block.
    if (inv) {
        const digits = v => String(v || '').replace(/\D/g, '');
        const idn = settings.identifiers || {};
        const ours = [["Enviroware's GST no.", settings.seller?.gstNumber], ['the IRC no.', idn.irc], ["JPS's TIN", idn.applicantTin],
            ["JPS's BIN", idn.applicantBin], ["the bank's TIN", idn.bankTin], ["the bank's BIN", idn.bankBin], ["the bank's VAT reg no.", idn.bankVatReg]]
            .filter(([, v]) => digits(v).length >= 6);
        const n = String(inv.number || '').trim();
        const clash = n && ours.find(([, v]) => digits(v) === digits(n));
        checks.push(check('supplier-number', 'warn', "Pistoni's document number", !!n && !clash,
            !n ? "Missing — it becomes the Pistoni bill's number in Xero"
                : clash ? `${n} is ${clash[0]}, not Pistoni's document number — correct the Document no. below`
                    : n));
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
            ei.rateConfirmed ? `USD ${fmtRate(ei.rate)}/kg` : `USD ${fmtRate(ei.rate)}/kg not yet confirmed`, { dismissible: false }));
        checks.push(check('number-confirmed', 'warn', 'Invoice number confirmed', !!ei.numberConfirmed,
            ei.numberConfirmed ? String(ei.number || '') : `${ei.number || '—'} not yet confirmed`, { dismissible: false }));
    }
    return applyDismissals(checks, ctx.dismissed);
}

export const blockingFailures = checks => (checks || []).filter(c => c.level === 'block' && c.ok === false && !c.dismissed);

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
// The contract terms on JPS's sales proforma — last date of shipment, expiry
// date, containers — are the Letter of Credit's (44C, 31D, the container in
// 45A), from the LC linked to the shipment. Until one is linked, what was read
// from JPS's PDF stands in. from: 'lc' | 'pdf' | null per field.
export function jpsContractTerms(record, lc) {
    const pdf = record?.jps?.contract || {};
    const has = v => !!String(v || '').trim();
    const pick = (lcVal, pdfVal, ok) => (ok(lcVal) ? { value: lcVal, from: 'lc' } : ok(pdfVal) ? { value: pdfVal, from: 'pdf' } : { value: '', from: null });
    const ship = pick(lc?.latestShipDate, pdf.lastShipmentDate, isYmd);
    const exp = pick(lc?.expiryDate, pdf.expiryDate, isYmd);
    const cont = pick(lc?.goods?.container, pdf.containers, has);
    return {
        lastShipmentDate: ship.value, expiryDate: exp.value, containers: String(cont.value || '').trim(),
        from: { lastShipmentDate: ship.from, expiryDate: exp.from, containers: cont.from },
        lcNumber: lc?.lcNumber || null,
    };
}

// doc 'jps' (our signed rewrite of JPS's sales proforma) also takes the
// titles of JPS checks still blocking, whether a signature is uploaded and
// the contract terms (jpsContractTerms, from the linked LC).
export function generationIssues({ record, settings, doc, stage = 'draft', shipmentNumber = null, otherInvoiceNumbers = [], jpsFailures = [], hasSignature = false, jpsTerms = null }) {
    const r = record || {};
    const out = [];
    const miss = missingSettings(settings, doc);
    if (miss.length) out.push(`Settings incomplete: ${miss.join(', ')}`);
    if (!r.confirmed) { out.push('Confirm the bales first'); return out; }
    const fails = blockingFailures(runChecks(r.confirmed, { settings, shipmentNumber, dismissed: r.dismissed }));
    if (fails.length) out.push(`Confirmed data fails: ${fails.map(f => f.title).join('; ')}`);
    const ei = r.exportInvoice || {};
    if (!isYmd(ei.date)) out.push('Document date missing');
    if (doc === 'proforma') {
        if (!parseInvoiceNumber(ei.number)) out.push('Invoice number must look like 102/2026');
        if (!(Number(ei.rate) > 0)) out.push('Export rate missing');
        if (!ei.rateConfirmed || !ei.numberConfirmed) out.push('Confirm our proforma invoice in section 3');
        const dup = otherInvoiceNumbers.find(o => String(o.number || '').replace(/\s/g, '') === String(ei.number || '').replace(/\s/g, ''));
        if (dup) out.push(`Invoice ${ei.number} is already used on Shipment #${dup.shipmentNumber}`);
    }
    if (doc === 'jps') {
        const j = r.jps;
        if (!j) { out.push('Upload or enter the JPS invoice first'); return out; }
        if (!String(j.number || '').trim()) out.push('JPS invoice number missing');
        if (!isYmd(j.date)) out.push('JPS invoice date missing');
        if (!(j.lines || []).some(l => Number(l.kg) > 0 && Number(l.unitPrice) > 0 && Number(l.amount) > 0)) out.push('JPS invoice lines need kg, unit price and amount');
        if (jpsFailures.length) out.push(`JPS invoice fails: ${jpsFailures.join('; ')}`);
        else if (!r.jpsConfirmed) out.push("Confirm JPS's proforma invoice in section 5");
        const c = jpsTerms || jpsContractTerms(r, null);
        if (!isYmd(c.lastShipmentDate)) out.push("Last date of shipment missing — it comes from the LC (Letter of Credit tab)");
        if (!isYmd(c.expiryDate)) out.push("Expiry date missing — it comes from the LC (Letter of Credit tab)");
        if (!hasSignature) out.push('Upload your signature in Document settings → Enviroware');
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
    const slug = t => 'lc-' + String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const add = (title, ok, detail) => out.push(check(slug(title), 'warn', title, ok, detail));
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
    // The LC (field 47A) quotes the applicant's numbers; every one printed on
    // our documents must be among them.
    const lcText = [lc.rawText, ...(lc.f47aConditions || []).map(c => c.text)].filter(Boolean).join(' ');
    const idn = settings?.identifiers || {};
    if (lcText.trim()) {
        const digits = v => String(v || '').replace(/\D/g, '');
        const runs = (lcText.match(/\d[\d\s.\-/:]*\d/g) || []).map(digits);
        const ids = [['IRC', idn.irc], ['applicant TIN', idn.applicantTin], ['applicant BIN', idn.applicantBin], ['bank TIN', idn.bankTin], ['bank BIN', idn.bankBin], ['bank VAT reg no.', idn.bankVatReg]]
            .filter(([, v]) => digits(v).length >= 6);
        const missing = ids.filter(([, v]) => !runs.some(r => r.includes(digits(v))));
        if (ids.length) add('Applicant numbers match the LC', !missing.length, missing.length
            ? `${missing.map(([l, v]) => `${l} ${v}`).join(', ')} not found in LC ${lc.lcNumber || ''} — check Document settings → JPS Enterprise`
            : `IRC, TIN, BIN and bank numbers all appear in LC ${lc.lcNumber || ''}`);
    }
    return applyDismissals(out, record.dismissed);
}

// ── Document rendering ───────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = arr => (Array.isArray(arr) ? arr : String(arr || '').split('\n')).map(s => String(s).trim()).filter(Boolean);
// "193 Mount Smart Road," + "Onehunga, 1061" → "193 Mount Smart Road, Onehunga, 1061"
const joinLine = arr => lines(arr).map(l => l.replace(/,\s*$/, '')).join(', ');
// "PRIME TIE – the stretchy loop tie" → bold brand, italic tagline
const straplineHtml = t => {
    const m = String(t || '').match(/^(.*?)\s+[–-]\s+(.*)$/);
    return m ? `<strong>${esc(m[1])}</strong> – <em>${esc(m[2])}</em>` : esc(t);
};
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

export const DOC_TITLES = {
    'packing:draft': 'DRAFT PACKING LIST',
    'packing:final': 'Final Packing List',
    'proforma:draft': 'PROFORMA INVOICE',
    'jps:contract': 'SALES PROFORMA INVOICE',
};

export function docFilename({ doc, stage, shipmentNumber, date, ext = 'pdf' }) {
    const d = isYmd(date) ? date.slice(8, 10) + date.slice(5, 7) + date.slice(0, 4) : '';
    if (doc === 'jps') return `JPS Proforma Invoice - #${shipmentNumber ?? ''} - ${d} - Signed.${ext}`;
    const base = doc === 'proforma' ? 'Proforma Invoice' : (stage === 'final' ? 'Final Packing List' : 'Packing List');
    return `${base} - #${shipmentNumber ?? ''} - ${d}.${ext}`;
}

const dmy = ymd => (isYmd(ymd) ? `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)}` : '');

function identifierValue(field, { settings, record }) {
    if (field === 'hsCode') return settings.hsCode || '';
    if (field === 'lcNumber') return record.lc?.number || '';
    if (field === 'lcDate') return record.lc?.date ? dmy(record.lc.date) : '';
    if (field === 'applicant') return joinLine([settings.buyer?.name, ...lines(settings.buyer?.addressLines)]);
    return settings.identifiers?.[field] || '';
}

// The lettered identifier block: [{ letter: 'AA.', label, value }].
export function identifierLines({ settings, record, stage = 'draft' }) {
    const s = settings || SETTINGS_SEED;
    return (s.identifierRows?.[stage === 'final' ? 'final' : 'draft'] || []).map((row, i) => {
        const v = identifierValue(row.field, { settings: s, record: record || {} });
        const suffix = row.suffix ? fill(row.suffix, { bankName: s.identifiers?.bankName || '' }).replace(/\(\s*\)/, '').trim() : '';
        const letter = String.fromCharCode(65 + (i % 26));
        return { letter: letter + letter + '.', label: row.label, value: v && suffix ? `${v} ${suffix}` : v, span: !!row.span };
    });
}


// Right-hand letterhead lines: "193 Mount Smart Road" / "Onehunga, 1061. NEW ZEALAND".
function addressBlock(addressLines) {
    const ls = lines(addressLines).map(l => l.replace(/,\s*$/, ''));
    if (ls.length < 2) return ls;
    const rest = ls.slice(1);
    rest[rest.length - 1] = rest[rest.length - 1].toUpperCase();
    return [ls[0], rest.join('. ')];
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

// Enviroware packing list, Draft or Final, laid out like the Shipment 43
// draft: name and strapline left, address right; one summary row; the bales
// in two light columns; the lettered identifier block (AA. IRC NO …); packing
// specification; signature and seal. Arial, one A4 page.
export function renderPackingList({ record, settings, assets = {}, stage = 'draft', shipmentNumber = null, banner = '' }) {
    const s = settings || SETTINGS_SEED;
    const r = record || {};
    const conf = r.confirmed || emptyReview();
    const shipNo = shipmentNumber ?? conf.shipmentNumber ?? '';
    const t = baleTotals(conf.bales);
    const [left, right] = splitBaleColumns(conf.bales);
    const isFinal = stage === 'final';
    const ei = r.exportInvoice || {};
    const rows = Math.max(left.length, right.length);
    // One A4 page (269 mm printable). The bale rows share what the fixed
    // blocks leave (measured in Chrome: ~150 mm Draft, ~160 mm Final with the
    // applicant line and an extra identifier row). 45 bales print at ~4.4 mm a
    // row as on the Shipment 43 draft; ~60 bales still fit. Font steps down
    // with the row height.
    const budget = isFinal ? 100 : 114;
    const rowH = Math.max(3.2, Math.min(4.4, budget / (rows + 1)));
    const baleFont = rowH >= 4 ? 8 : rowH >= 3.6 ? 7.5 : 7;
    const col = list => {
        const body = [];
        for (let i = 0; i < rows; i++) {
            const b = list[i];
            body.push(`<tr><td class="n">${b ? b.n : ''}</td><td class="kg">${b ? fmtKg(b.kg) : ''}</td></tr>`);
        }
        return `<table class="col"><thead><tr><th class="n">Bale #</th><th class="kg">Net Weight</th></tr></thead><tbody>${body.join('')}</tbody></table>`;
    };
    const ids = identifierLines({ settings: s, record: r, stage })
        .map(x => x.span
            ? `<tr><td class="ltr">${esc(x.letter)}</td><td colspan="2">${esc(x.label)} ${esc(x.value)}</td></tr>`
            : `<tr><td class="ltr">${esc(x.letter)}</td><th>${esc(x.label)}</th><td>${esc(x.value)}</td></tr>`).join('');
    const seller = s.seller || {};
    const title = DOC_TITLES[`packing:${isFinal ? 'final' : 'draft'}`];
    const img = (a, cls) => a && a.data ? `<img class="${cls}" src="data:${esc(a.mediaType || 'image/png')};base64,${a.data}" alt="">` : '';
    const sign = s.signOff || {};
    const html = `
<header class="lh">
  <div class="lh-l"><div class="lh-name">${esc(seller.name)}</div><div class="lh-strap">${esc(seller.strapline)}</div></div>
  <div class="lh-r">${addressBlock(seller.addressLines).map(l => `<div>${esc(l)}</div>`).join('')}
    ${seller.phone ? `<div>Phone ${esc(seller.phone)}</div>` : ''}${seller.email ? `<div>${esc(seller.email)}</div>` : ''}</div>
</header>
<h1 class="title">${esc(title)}</h1>
<table class="summary">
  <thead><tr><th>Shipment</th><th>No. of Packages</th><th>Net Weight</th>${isFinal ? '<th>Gross Weight</th>' : ''}<th>Date</th></tr></thead>
  <tbody><tr><td>${esc(shipNo)}</td><td>${t.count}</td><td>${fmtKg(t.netKg)}</td>${isFinal ? `<td>${r.lc?.grossKg ? fmtKg(r.lc.grossKg) : ''}</td>` : ''}<td>${esc(dmy(ei.date))}</td></tr></tbody>
</table>
<h2 class="subtitle">${esc(s.goods?.subtitle)}</h2>
<div class="bales">${col(left)}${col(right)}</div>
<table class="ids">${ids}</table>
<p class="spec${isFinal ? ' spec--final' : ''}">Packing Specification: ${esc(s.packingSpec?.[isFinal ? 'final' : 'draft'])}</p>
<div class="sign">
  <div class="sign-row"><div class="sig">${img(assets.signature, 'sig-img') || '<div class="sig-line"></div>'}</div>${img(assets.seal, 'seal-img')}</div>
  <div>${esc(sign.packingName)}</div>
  <div><strong>${esc(sign.packingTitle)}</strong></div>
  <div>${esc(sign.company || seller.name)}</div>
</div>`;
    const css = `
.sheet { padding-left: 20mm; padding-right: 20mm; }
.lh { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 9mm; }
.lh-name { font-size: 16pt; font-weight: bold; line-height: 1.15; }
.lh-strap { font-size: 8.5pt; }
.lh-r { text-align: right; font-size: 8pt; line-height: 1.45; }
.title { text-align: center; font-size: 12pt; margin: 0 0 3.5mm; }
.summary { margin: 0 auto 8mm; }
.summary th, .summary td { border: 0.75pt solid #000; padding: 0.3mm 2.5mm; text-align: center; font-size: 9pt; line-height: 1.25; }
.summary th { font-weight: bold; }
.subtitle { text-align: center; font-size: 9.5pt; margin: 0 0 4mm; }
.bales { display: flex; justify-content: space-between; width: 128mm; margin: 0 auto 7mm; }
.col th, .col td { padding: 0 1.5mm; font-size: ${baleFont}pt; line-height: 1; height: ${rowH.toFixed(2)}mm; white-space: nowrap; }
.col th { font-size: 7pt; font-weight: bold; }
.col .n { text-align: right; width: 12mm; }
.col .kg { text-align: right; width: 22mm; }
.ids { margin: 0 0 6mm 14mm; width: calc(100% - 14mm); }
.ids th, .ids td { padding: 0.15mm 0; text-align: left; font-size: 8pt; line-height: 1.3; vertical-align: top; font-weight: normal; }
.ids .ltr { width: 8mm; font-size: 7pt; }
.ids th { width: 50mm; }
.spec { text-align: center; margin: 0 0 5mm; font-size: 8.5pt; }
.spec--final { font-weight: bold; }
.sign { font-size: 8.5pt; line-height: 1.4; }
.sign-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 2mm; }
.sig { width: 60mm; }
.sig-img { max-height: 22mm; max-width: 60mm; display: block; }
.sig-line { width: 55mm; border-bottom: 0.75pt solid #000; height: 14mm; }
.seal-img { max-height: 27mm; max-width: 30mm; }`;
    return page({ title: `${title} – Shipment #${shipNo}`, font: 'Arial, Helvetica, sans-serif', body: { html, css }, banner });
}

// Enviroware proforma invoice, laid out like Commercial Invoice 101/2026:
// name and strapline left, contact block right, the JPS / Shipment box,
// $USD lines, terms, signature and seal. Times New Roman, one A4 page. Never
// shows the supplier, its bank or EUR prices: only the export figures.
export function renderProforma({ record, settings, assets = {}, shipmentNumber = null, banner = '' }) {
    const s = settings || SETTINGS_SEED;
    const r = record || {};
    const conf = r.confirmed || emptyReview();
    const t = baleTotals(conf.bales);
    const ei = r.exportInvoice || {};
    const ccy = ei.currency || s.currency || 'USD';
    const amount = invoiceAmount(t.netKg, ei.rate);
    const vars = { bales: t.count, netKg: fmtKg(t.netKg), rate: fmtRate(ei.rate), currency: ccy, shipment: shipmentNumber ?? conf.shipmentNumber ?? '' };
    const seller = s.seller || {}, bank = s.bank || {}, buyer = s.buyer || {}, so = s.signOff || {};
    const money = n => `$${esc(ccy)} ${fmtMoney(n)}`;
    const img = (a, cls) => a && a.data ? `<img class="${cls}" src="data:${esc(a.mediaType || 'image/png')};base64,${a.data}" alt="">` : '';
    const html = `
<header class="lh">
  <div class="lh-left">
    <div class="lh-name">${esc(seller.name)}</div>
    <div class="lh-strap">${straplineHtml(seller.strapline)}</div>
    ${bank.name ? `<div class="lh-bank"><div>Bank: ${esc(bank.name)}</div>${lines(bank.addressLines).map(l => `<div>${esc(l)}</div>`).join('')}${bank.swift ? `<div>SWIFT: ${esc(bank.swift)}</div>` : ''}${bank.accountNumber ? `<div>Account no: ${esc(bank.accountNumber)}</div>` : ''}</div>` : ''}
  </div>
  <div class="lh-right">
    ${lines(seller.addressLines).map(l => `<div>${esc(l)}</div>`).join('')}
    ${seller.phone ? `<div><span class="lbl">Phone</span>${esc(seller.phone)}</div>` : ''}
    ${seller.email ? `<div><span class="lbl">Email</span>${esc(seller.email)}</div>` : ''}
    ${seller.gstNumber ? `<div>GST No.: ${esc(seller.gstNumber)}</div>` : ''}
  </div>
</header>
<div class="title">Proforma Invoice</div>
<div class="meta"><span>No: ${esc(ei.number)}</span><span>Date: ${esc(longDate(ei.date))}</span></div>
<table class="inv">
  <colgroup><col style="width:36%"><col style="width:40%"><col style="width:24%"></colgroup>
  <tr class="box">
    <td class="to">${esc(buyer.name)}${lines(buyer.addressLines).map(l => `<br>${esc(l)}`).join('')}</td>
    <td colspan="2" class="desc"><strong>Shipment ${esc(vars.shipment)}:</strong><br><em>${esc(fill(s.goods?.proformaDescription, vars))}<br>HS Code ${esc(s.hsCode)}<br>Total net weight ${esc(vars.netKg)}kg</em></td>
  </tr>
  <tr><td colspan="2" class="r"><em>${esc(fill(s.goods?.proformaLine, vars))}</em></td><td class="amt">${money(amount)}</td></tr>
  <tr><td colspan="2" class="r">Goods &amp; Services Tax (GST)</td><td class="amt">nil</td></tr>
  <tr class="total"><td colspan="2" class="r">TOTAL @ <em>$${esc(ccy)}${esc(vars.rate)}/kg</em></td><td class="amt"><strong>${money(amount)}</strong></td></tr>
</table>
<div class="terms"><strong>Terms &amp; Conditions</strong>
  <ol>${lines(s.terms).map(l => `<li>${esc(l)}</li>`).join('')}</ol>
</div>
<div class="sign">
  <div class="sign-left">
    ${img(assets.signature, 'sig') || '<div class="sig-space"></div>'}
    <div>${esc(so.proformaName)}</div>
    <div><strong>${esc(so.proformaTitle)}</strong></div>
    <div>${esc(so.proformaFor || seller.name)}</div>
  </div>
  ${img(assets.seal, 'seal')}
</div>`;
    const css = `
.lh { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; margin-bottom: 9mm; }
.lh-name { font-size: 22pt; font-weight: bold; line-height: 1.1; }
.lh-strap { font-size: 11pt; margin-top: 1mm; }
.lh-bank { font-size: 9pt; margin-top: 3mm; line-height: 1.3; }
.lh-right { text-align: right; font-size: 9pt; line-height: 1.3; }
.lh-right .lbl { display: inline-block; margin-right: 3mm; }
.title { text-align: center; font-weight: bold; font-size: 12pt; }
.meta { display: flex; justify-content: center; gap: 45mm; margin: 0.5mm 0 3mm; font-size: 10.5pt; }
.inv { width: 100%; margin-bottom: 7mm; font-size: 10pt; }
.inv td { border: 0.75pt solid #000; padding: 1.8mm 2.5mm; vertical-align: top; }
.inv tr.box td { height: 26mm; }
.inv td.r { text-align: right; }
.inv td.amt { text-align: right; white-space: nowrap; }
.terms { margin-bottom: 7mm; font-size: 9.5pt; }
.terms > strong { font-size: 11.5pt; }
.terms ol { margin: 1.5mm 0 0; padding-left: 6mm; }
.terms li { margin-bottom: 0.4mm; }
.sign { display: flex; align-items: flex-end; justify-content: space-between; font-size: 11pt; }
.sig { max-height: 22mm; max-width: 60mm; display: block; margin-bottom: 4mm; }
.sig-space { height: 22mm; }
.seal { max-height: 34mm; max-width: 40mm; }`;
    return page({ title: `Proforma Invoice ${ei.number || ''} – Shipment #${vars.shipment}`, font: '"Times New Roman", Times, serif', body: { html, css }, banner });
}

// ── Packing list workbook (.xlsx) ────────────────────────────────────────
// Same content as renderPackingList, as a sheet spec for _xlsx.js. Package
// count and net weight are formulas over the bale cells, like the
// reference workbook; a Final tab is added once the LC details are in.
// ── Amount in words ──────────────────────────────────────────────────────
// 32996.6 → "Thirty-Two Thousand Nine Hundred and Ninety-Six and Sixty Cents"
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const under100 = n => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
export function numberToWords(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (!n) return 'Zero';
    const scales = ['', 'Thousand', 'Million', 'Billion'];
    const chunks = [];
    for (let i = 0; n > 0 && i < scales.length; i++, n = Math.floor(n / 1000)) chunks.push(n % 1000);
    const parts = [];
    for (let i = chunks.length - 1; i >= 0; i--) {
        const c = chunks[i];
        if (!c) continue;
        const h = Math.floor(c / 100), r = c % 100;
        let w = h ? ONES[h] + ' Hundred' : '';
        if (r) w += (h ? ' and ' : (i === 0 && parts.length ? 'and ' : '')) + under100(r);
        parts.push(w + (scales[i] ? ' ' + scales[i] : ''));
    }
    return parts.join(' ');
}
export function amountInWords(amount, currency = 'USD') {
    const c = cents(amount);
    const whole = Math.floor(c / 100), frac = c % 100;
    const name = { USD: 'US Dollars', NZD: 'New Zealand Dollars', EUR: 'Euros' }[currency] || currency;
    return `${name} ${numberToWords(whole)}${frac ? ` and ${numberToWords(frac)} Cent${frac === 1 ? '' : 's'}` : ''} Only`;
}

// Our rewrite of JPS Enterprise's sales proforma invoice (their template has
// the wrong street number, "Buyerer's", "SWFIT", "Tauraqnga"…): JPS
// letterhead, Enviroware as buyer with its bank, the goods line(s) from the
// JPS invoice as captured on the shipment, the amount in words, the terms
// once each, and Enviroware's signature and seal. JPS's side is left for
// Paul to sign. Times New Roman, one A4 page.
export function renderJpsContract({ record, settings, assets = {}, shipmentNumber = null, banner = '' }) {
    const s = settings || SETTINGS_SEED;
    const r = record || {};
    const j = r.jps || {};
    const jp = s.jps || {};
    const c = j.contract || {};
    const seller = s.seller || {}, bank = s.bank || {}, sign = s.signOff || {};
    const cur = j.currency || 'USD';
    const sym = cur === 'USD' ? 'US$' : cur;
    const ls = (j.lines || []).filter(l => l.kg != null || l.amount != null);
    const single = ls.length === 1;
    const totalKg = ls.reduce((a, l) => a + (Number(l.kg) || 0), 0);
    const total = ls.length ? ls.reduce((a, l) => a + cents(l.amount), 0) / 100 : (Number(j.total) || 0);
    const img = (a, cls) => a && a.data ? `<img class="${cls}" src="data:${esc(a.mediaType || 'image/png')};base64,${a.data}" alt="">` : '';
    const bankLine = b => [b?.name, ...lines(b?.addressLines)].filter(Boolean).map(x => x.replace(/,\s*$/, '')).join(', ') + (b?.swift ? `. SWIFT: ${b.swift}` : '');
    const terms = [
        ['Payment', jp.payment],
        ['Country of origin', jp.origin],
        ["Exporter's bank", bankLine(jp.bank)],
        ['Port of loading', jp.portOfLoading],
        ['Destination', jp.destination],
        ['Freight terms', jp.freightTerms],
        ['Mode of shipment', jp.modeOfShipment],
        ['Last date of shipment', isYmd(c.lastShipmentDate) ? longDate(c.lastShipmentDate) : ''],
        ['Expiry date', isYmd(c.expiryDate) ? longDate(c.expiryDate) : ''],
        ['Container size', c.containers],
    ].filter(([, v]) => String(v || '').trim());
    const title = DOC_TITLES['jps:contract'];
    const html = `
<header class="lh">
  <div class="lh-name">${esc(s.buyer?.name)}</div>
  <div>${esc(joinLine(s.buyer?.addressLines))}</div>
  <div>${jp.phone ? 'Phone: ' + esc(jp.phone) : ''}${jp.phone && jp.email ? ' &nbsp;·&nbsp; ' : ''}${jp.email ? 'Email: ' + esc(jp.email) : ''}</div>
</header>
<div class="doc-hd">
  <h1>${esc(title)}</h1>
  <div class="doc-no">No. <strong>${esc(j.number)}</strong> &nbsp;·&nbsp; Date: <strong>${esc(longDate(j.date))}</strong></div>
</div>
<p class="contract">This sales contract is made between the exporter and the buyer.</p>
<div class="buyer">
  <div class="k">Buyer</div>
  <div><strong>${esc(seller.name)}</strong></div>
  <div>${esc(joinLine(seller.addressLines))}</div>
  <div>${[seller.phone && 'Phone: ' + esc(seller.phone), seller.email && 'Email: ' + esc(seller.email), seller.gstNumber && 'GST No.: ' + esc(seller.gstNumber)].filter(Boolean).join(' &nbsp;·&nbsp; ')}</div>
  <div>Buyer's bank: ${esc(bankLine(bank))}</div>
</div>
<table class="goods">
  <thead><tr><th>Description of goods</th><th class="r">Weight (kg)</th><th class="r">Unit price (${esc(sym)})</th><th class="r">Value (${esc(sym)})</th></tr></thead>
  <tbody>${ls.map(l => `<tr>
    <td>${esc(single ? jp.goodsDescription || l.description : l.description)}${single || ls.indexOf(l) === ls.length - 1 ? `<div class="hs">HS code: ${esc(s.hsCode)}</div>` : ''}</td>
    <td class="r">${l.kg != null ? fmtKg(l.kg) : ''}</td><td class="r">${l.unitPrice != null ? fmtRate(l.unitPrice) : ''}</td><td class="r">${l.amount != null ? fmtMoney(l.amount) : ''}</td></tr>`).join('')}</tbody>
  <tfoot><tr><th>Total</th><th class="r">${totalKg ? fmtKg(totalKg) : ''}</th><th></th><th class="r">${esc(sym)} ${fmtMoney(total)}</th></tr></tfoot>
</table>
<p class="words"><strong>Amount in words:</strong> ${esc(amountInWords(total, cur))}.</p>
<h2>Terms and conditions</h2>
<table class="terms">${terms.map(([k, v]) => `<tr><th>${esc(k)}:</th><td>${esc(v)}</td></tr>`).join('')}</table>
<div class="sigs">
  <div class="sig-col">
    <div class="sig-space"></div>
    <div class="sig-rule"></div>
    <div><strong>${esc(jp.signatory)}</strong></div>
    <div>For and on behalf of ${esc(s.buyer?.name)}</div>
    <div class="k">Exporter</div>
  </div>
  <div class="sig-col sig-col--us">
    <div class="sig-space">${img(assets.signature, 'sig-img')}${img(assets.seal, 'seal-img')}</div>
    <div class="sig-rule"></div>
    <div><strong>${esc(sign.proformaName)}</strong></div>
    <div>${esc(sign.proformaFor || 'For and on behalf of ' + (seller.name || ''))}</div>
    <div class="k">Buyer</div>
  </div>
</div>`;
    const css = `
.lh { text-align: center; line-height: 1.35; font-size: 10.5pt; border-bottom: 1.25pt solid #000; padding-bottom: 3mm; margin-bottom: 4mm; }
.lh-name { font-size: 24pt; font-weight: bold; line-height: 1.15; }
.doc-hd { display: flex; justify-content: space-between; align-items: baseline; gap: 6mm; }
.doc-hd h1 { font-size: 13pt; margin: 0; letter-spacing: .02em; }
.doc-no { font-size: 10.5pt; }
.contract { margin: 1mm 0 4mm; font-style: italic; }
.k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #333; }
.buyer { line-height: 1.4; margin-bottom: 5mm; }
.goods { width: 100%; margin-bottom: 3mm; }
.goods th, .goods td { border: 0.75pt solid #000; padding: 1.5mm 2.5mm; vertical-align: top; text-align: left; }
.goods thead th { background: #f2f2f2; }
.goods .r { text-align: right; white-space: nowrap; }
.goods td:first-child { width: 52%; }
.goods tbody td { height: 24mm; }
.hs { margin-top: 2mm; }
.words { margin: 0 0 5mm; }
h2 { font-size: 11pt; margin: 0 0 1.5mm; }
.terms { margin-bottom: 8mm; }
.terms th, .terms td { text-align: left; vertical-align: top; padding: 0.4mm 0; line-height: 1.35; }
.terms th { font-weight: normal; white-space: nowrap; padding-right: 4mm; }
.sigs { display: flex; justify-content: space-between; gap: 12mm; }
.sig-col { width: 46%; line-height: 1.4; }
.sig-space { height: 26mm; display: flex; align-items: flex-end; gap: 4mm; }
.sig-img { max-height: 20mm; max-width: 50mm; }
.seal-img { max-height: 25mm; max-width: 28mm; margin-left: auto; }
.sig-rule { border-top: 0.75pt solid #000; margin: 1mm 0 1.5mm; }`;
    return page({ title: `${title} ${j.number || ''} – Shipment #${shipmentNumber ?? ''}`, font: '"Times New Roman", Times, serif', body: { html, css }, banner });
}

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
    full(joinLine(seller.addressLines), 'center');
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
    pair('Date', dmy(r.exportInvoice?.date));
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
    for (const x of identifierLines({ settings: s, record: r, stage })) {
        const i = rows.length + 1;
        if (x.span) { rows.push([{ v: `${x.letter} ${x.label} ${x.value}` }]); merges.push(`A${i}:E${i}`); continue; }
        rows.push([{ v: `${x.letter} ${x.label}`, s: 'bold' }, null, { v: x.value }]);
        merges.push(`A${i}:B${i}`, `C${i}:E${i}`);
    }
    blank();
    full('Packing Specification: ' + (s.packingSpec?.[isFinal ? 'final' : 'draft'] || ''), 'default');
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
    const sec = (obj, keys) => Object.fromEntries(keys.map(k => [k, cleanStr(obj?.[k], 300)]));
    return {
        seller: { ...sec(base.seller, ['name', 'strapline', 'phone', 'email', 'gstNumber']), addressLines: strs(base.seller.addressLines, 6) },
        bank: { ...sec(base.bank, ['name', 'swift', 'accountNumber']), addressLines: strs(base.bank.addressLines, 6) },
        buyer: { name: cleanStr(base.buyer.name), addressLines: strs(base.buyer.addressLines, 6) },
        identifiers: sec(base.identifiers, ['irc', 'applicantTin', 'applicantBin', 'bankName', 'bankBin', 'bankVatReg', 'bankTin']),
        hsCode: cleanStr(base.hsCode, 30),
        packingSpec: sec(base.packingSpec, ['draft', 'final']),
        terms: strs(base.terms, 15),
        jps: {
            ...sec(base.jps, ['phone', 'email', 'signatory', 'portOfLoading', 'destination', 'freightTerms']),
            bank: { ...sec(base.jps?.bank, ['name', 'swift']), addressLines: strs(base.jps?.bank?.addressLines, 4) },
        },
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
            currencyMode: base.xero?.currencyMode === 'foreign' ? 'foreign' : 'nzd',
            accounts: sec(base.xero?.accounts, ['rawProduct', 'lcDeposit', 'handling', 'exportSale']),
            taxTypes: sec(base.xero?.taxTypes, ['purchases', 'exportSale']),
        },
    };
}
