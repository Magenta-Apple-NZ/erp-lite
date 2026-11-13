// Stage 1 money: the JPS invoice, the three invoices that go through Xero,
// and how they fill the shipment's cost breakdown. Pure (no KV, no fetch);
// tests in tests/shipxero.test.js.
//
// The flow, per kg of net bale weight (Shipment 43: 18,130 kg):
//   Pistoni proforma (EUR)          → Xero bill from Pistoni     → Raw Product lines
//   our proforma to JPS (USD 1.18)  → Xero sales invoice to JPS  → LC Refund (the LC pays it)
//   JPS invoice (≈ USD 1.18 + 0.63) → Xero bill from JPS, split  → LC Deposit (= our proforma)
//                                                                 + Handling & Sorting (the rest)
// JPS's margin (Handling & Sorting) is the only real cost of the round trip;
// the deposit and the LC refund cancel out.

import { baleTotals, invoiceAmount, round2, cents, fmtKg, fmtMoney, fmtRate, normaliseColour } from './_exportdocs.js';

const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const toNum = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// ── Numbers on the JPS invoice: standard format (comma thousands, dot decimals)
export function parseStandardNumber(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/ /g, ' ').trim();
    s = s.replace(/^(USD|US\$|\$|BDT|Tk\.?|KG)\s*/i, '').replace(/\s*(USD|kg|kgs|kgs\.|kg\.)$/i, '').replace(/\s+/g, '');
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$/.test(s) && !/^\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? (neg ? -n : n) : null;
}

// ── JPS invoice ──────────────────────────────────────────────────────────
export function emptyJps() {
    return { number: '', date: '', dateRaw: null, currency: 'USD', lines: [], netKg: null, netKgRaw: null, total: null, totalRaw: null };
}

export function jpsFromExtraction(x) {
    const e = x || {};
    return {
        number: e.invoiceNumber != null ? String(e.invoiceNumber) : '',
        date: isYmd(e.invoiceDate) ? e.invoiceDate : '',
        dateRaw: e.invoiceDateRaw ?? null,
        currency: String(e.currency || 'USD').toUpperCase(),
        lines: (Array.isArray(e.lines) ? e.lines : []).map(l => ({
            description: String(l?.description || ''),
            kg: toNum(l?.kg), kgRaw: l?.kgRaw ?? null,
            unitPrice: toNum(l?.unitPrice), unitPriceRaw: l?.unitPriceRaw ?? null,
            amount: toNum(l?.amount), amountRaw: l?.amountRaw ?? null,
        })),
        netKg: toNum(e.netWeightKg), netKgRaw: e.netWeightRaw ?? null,
        total: toNum(e.total), totalRaw: e.totalRaw ?? null,
    };
}

const clean = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const rawOrNull = v => (v == null || v === '' ? null : String(v).slice(0, 60));
export function sanitiseJps(j) {
    if (!isObj(j)) return null;
    return {
        number: clean(j.number, 40), date: isYmd(j.date) ? j.date : '', dateRaw: rawOrNull(j.dateRaw),
        currency: clean(j.currency || 'USD', 3).toUpperCase(),
        lines: (Array.isArray(j.lines) ? j.lines : []).slice(0, 20).map(l => ({
            description: clean(l?.description), kg: toNum(l?.kg), kgRaw: rawOrNull(l?.kgRaw),
            unitPrice: toNum(l?.unitPrice), unitPriceRaw: rawOrNull(l?.unitPriceRaw),
            amount: toNum(l?.amount), amountRaw: rawOrNull(l?.amountRaw),
        })),
        netKg: toNum(j.netKg), netKgRaw: rawOrNull(j.netKgRaw),
        total: toNum(j.total), totalRaw: rawOrNull(j.totalRaw),
    };
}

// The JPS invoice = LC deposit (exactly our proforma: net kg × export rate)
// + Handling & Sorting (everything else — JPS's margin).
export function jpsSplit(record) {
    const conf = record?.confirmed, j = record?.jps, ei = record?.exportInvoice || {};
    if (!conf || !j || !(Number(j.total) > 0)) return null;
    const netKg = baleTotals(conf.bales).netKg;
    const depositAmount = invoiceAmount(netKg, ei.rate);
    const handlingAmount = round2(Number(j.total) - depositAmount);
    return {
        netKg, currency: j.currency || ei.currency || 'USD', total: round2(j.total),
        depositRate: Number(ei.rate) || 0, depositAmount,
        handlingAmount, handlingRate: netKg ? r4(handlingAmount / netKg) : 0,
    };
}

function check(id, level, title, ok, detail) { return { id, level, title, ok, detail: detail || '' }; }

// ctx.typicalMargin: the previous shipment's Handling & Sorting rate, else settings.
export function jpsChecks(record, { settings = {}, typicalMargin = null } = {}) {
    const j = record?.jps;
    if (!j) return [];
    const ei = record.exportInvoice || {};
    const conf = record.confirmed;
    const out = [];
    out.push(check('jps-number', 'block', 'JPS invoice number and date', !!(j.number && isYmd(j.date)),
        j.number && isYmd(j.date) ? `${j.number}, ${j.date}` : 'Enter the invoice number and date'));
    out.push(check('jps-currency', 'block', 'Same currency as our proforma', j.currency === (ei.currency || 'USD'),
        `${j.currency || '—'} on the JPS invoice; ${ei.currency || 'USD'} on ours`));

    // Lines multiply out and add up to the total
    {
        const issues = [];
        if (!(Number(j.total) > 0)) issues.push('Total missing');
        (j.lines || []).forEach((l, i) => {
            if (l.kg != null && l.unitPrice != null && l.amount != null) {
                const calc = Math.round(Number(l.kg) * Math.round(Number(l.unitPrice) * 10000) / 100);
                if (calc !== cents(l.amount)) issues.push(`Line ${i + 1}: ${fmtKg(l.kg)} × ${fmtRate(l.unitPrice)} = ${fmtMoney(calc / 100)}, printed ${fmtMoney(l.amount)}`);
            }
        });
        const withAmt = (j.lines || []).filter(l => l.amount != null);
        if (withAmt.length && Number(j.total) > 0 && withAmt.reduce((s, l) => s + cents(l.amount), 0) !== cents(j.total)) {
            issues.push(`Lines sum to ${fmtMoney(withAmt.reduce((s, l) => s + cents(l.amount), 0) / 100)}, total printed ${fmtMoney(j.total)}`);
        }
        out.push(check('jps-lines', 'block', 'JPS invoice lines and total add up', !issues.length, issues.join('; ') || `${j.currency} ${fmtMoney(j.total)}`));
    }

    // Printed strings re-parse (standard number format)
    {
        const mism = [];
        const pairs = [['Total', j.totalRaw, j.total], ['Net weight', j.netKgRaw, j.netKg]];
        (j.lines || []).forEach((l, i) => pairs.push([`Line ${i + 1} kg`, l.kgRaw, l.kg], [`Line ${i + 1} unit price`, l.unitPriceRaw, l.unitPrice], [`Line ${i + 1} amount`, l.amountRaw, l.amount]));
        for (const [label, raw, val] of pairs) {
            if (raw == null || raw === '') continue;
            const p = parseStandardNumber(raw);
            if (p == null) mism.push(`${label}: printed "${raw}" isn't a number`);
            else if (val == null || Math.abs(p - Number(val)) > 0.0005) mism.push(`${label}: printed "${raw}", extracted ${val == null ? 'nothing' : fmtKg(val)}`);
        }
        out.push(check('jps-printed', 'block', 'Printed figures read correctly', !mism.length, mism.join('; ') || 'Every printed figure re-parses to the extracted number'));
    }

    if (!conf) {
        out.push(check('jps-deposit', 'block', 'Covers our proforma (the LC deposit)', false, 'Confirm the bales first'));
        return out;
    }
    const s = jpsSplit(record);
    const netKg = baleTotals(conf.bales).netKg;

    // Deposit: the JPS invoice must at least cover our proforma
    {
        const deposit = invoiceAmount(netKg, ei.rate);
        const ok = !!s && s.handlingAmount >= 0;
        out.push(check('jps-deposit', 'block', 'Covers our proforma (the LC deposit)', ok,
            s ? `LC deposit ${ei.currency || 'USD'} ${fmtMoney(deposit)} (${fmtKg(netKg)} kg × ${fmtRate(ei.rate)}, invoice ${ei.number || '—'}) + handling & sorting ${fmtMoney(s.handlingAmount)}`
              : 'JPS total missing'));
    }

    // Weight on the JPS invoice = our net weight
    {
        const stated = j.netKg ?? (j.lines || []).find(l => l.kg != null)?.kg ?? null;
        out.push(check('jps-kg', 'warn', 'JPS invoice weight matches the bales', stated == null ? null : Math.abs(Number(stated) - netKg) < 0.0005,
            stated == null ? 'No weight printed' : `JPS ${fmtKg(stated)} kg; bales ${fmtKg(netKg)} kg`));
    }

    // Margin in the usual range
    if (s) {
        const typical = typicalMargin ?? (Number(settings.jpsMarginPerKg) > 0 ? Number(settings.jpsMarginPerKg) : null);
        const ok = typical == null ? null : Math.abs(s.handlingRate - typical) <= 0.10;
        out.push(check('jps-margin', 'warn', 'Handling & sorting rate as usual', ok,
            `${s.currency} ${fmtRate(s.handlingRate)}/kg${typical != null ? ` (usual ${fmtRate(typical)}/kg)` : ''}`));
    }
    return out;
}

// ── Xero ─────────────────────────────────────────────────────────────────
export const XERO_DOCS = {
    supplierBill: { label: 'Pistoni bill', type: 'ACCPAY' },
    salesInvoice: { label: 'Our proforma to JPS', type: 'ACCREC' },
    jpsBill:      { label: 'JPS bill', type: 'ACCPAY' },
};
export const XERO_DONE = ['AUTHORISED', 'PAID', 'SUBMITTED', 'DRAFT'];

export function xeroUrl(type, invoiceId) {
    if (!invoiceId) return '';
    return (type === 'ACCREC' ? 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' : 'https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=') + encodeURIComponent(invoiceId);
}

// The three documents as they would be created in Xero, with the reasons
// any of them can't be created yet. `checksOk` are the blocking-check
// results the caller already has (bales confirmed data, JPS invoice).
export function xeroDocs({ record, settings, shipmentNumber, confirmedOk = true, jpsOk = true }) {
    const s = settings || {}, x = s.xero || {}, acc = x.accounts || {}, tax = x.taxTypes || {};
    const r = record || {}, conf = r.confirmed, ei = r.exportInvoice || {};
    const ship = `Shipment ${shipmentNumber ?? ''}`.trim();
    const t = conf ? baleTotals(conf.bales) : null;
    const docs = [];
    const common = key => {
        const pushed = r.xero?.[key] || null;
        return { key, ...XERO_DOCS[key], pushed, url: pushed ? xeroUrl(XERO_DOCS[key].type, pushed.invoiceId) : '' };
    };
    const live = pushed => pushed && !['VOIDED', 'DELETED'].includes(pushed.status);

    // Pistoni bill
    {
        const d = common('supplierBill');
        const inv = conf?.supplierInvoice;
        d.contactName = x.supplierContact || '';
        d.issues = [];
        if (!conf) d.issues.push('Confirm the bales first');
        else if (!inv) d.issues.push('No supplier proforma');
        else if (!confirmedOk) d.issues.push('Confirmed data fails a check');
        if (inv) {
            Object.assign(d, {
                currency: inv.currency || 'EUR', date: inv.date, number: inv.number, total: round2(inv.total),
                lines: (inv.lines || []).map(l => ({
                    Description: `${l.description || 'Toeclips'} — ${ship}`, Quantity: l.kg, UnitAmount: l.unitPrice,
                    AccountCode: acc.rawProduct || '', TaxType: tax.purchases || 'NONE',
                })),
            });
            if (!inv.number) d.issues.push('Supplier document number missing');
            if (!isYmd(inv.date)) d.issues.push('Supplier document date missing');
        }
        if (!acc.rawProduct) d.issues.push('Set the raw product account in Document settings → Xero');
        if (!d.contactName) d.issues.push('Set the Pistoni contact in Document settings → Xero');
        docs.push(d);
    }

    // Our proforma → sales invoice to JPS (paid by the LC)
    {
        const d = common('salesInvoice');
        d.contactName = x.buyerContact || '';
        d.issues = [];
        if (!conf) d.issues.push('Confirm the bales first');
        if (conf) {
            const total = invoiceAmount(t.netKg, ei.rate);
            Object.assign(d, {
                currency: ei.currency || 'USD', date: ei.date, number: ei.number, total, reference: ship,
                lines: [{
                    Description: `${fmtKg(t.netKg)}kg toeclip (knitted nylon stocking material), ${t.count} bales — ${ship}`,
                    Quantity: t.netKg, UnitAmount: Number(ei.rate) || 0,
                    AccountCode: acc.exportSale || '', TaxType: tax.exportSale || 'ZERORATEDOUTPUT',
                }],
            });
            if (!ei.numberConfirmed || !ei.rateConfirmed) d.issues.push('Tick the invoice number and export rate first');
        }
        if (!acc.exportSale) d.issues.push('Set the export sale account in Document settings → Xero');
        if (!d.contactName) d.issues.push('Set the JPS contact in Document settings → Xero');
        docs.push(d);
    }

    // JPS bill: deposit line (our proforma) + handling & sorting (the rest)
    {
        const d = common('jpsBill');
        d.contactName = x.buyerContact || '';
        d.issues = [];
        const sp = jpsSplit(r);
        if (!r.jps) d.issues.push('Upload or enter the JPS invoice');
        else if (!sp) d.issues.push('JPS invoice total missing');
        else if (!jpsOk) d.issues.push('JPS invoice fails a check');
        if (sp) {
            Object.assign(d, {
                currency: sp.currency, date: r.jps.date, number: r.jps.number, total: sp.total,
                lines: [
                    { Description: `LC deposit — ${ship}, ${fmtKg(sp.netKg)} kg @ ${sp.currency} ${fmtRate(sp.depositRate)}/kg (our invoice ${ei.number || ''})`, Quantity: sp.netKg, UnitAmount: sp.depositRate, AccountCode: acc.lcDeposit || '', TaxType: tax.purchases || 'NONE' },
                    { Description: `Handling & sorting — ${ship}, ${fmtKg(sp.netKg)} kg @ ${sp.currency} ${fmtRate(sp.handlingRate)}/kg`, Quantity: 1, UnitAmount: sp.handlingAmount, AccountCode: acc.handling || '', TaxType: tax.purchases || 'NONE' },
                ],
            });
        }
        if (!acc.lcDeposit) d.issues.push('Set the LC deposit account in Document settings → Xero');
        if (!acc.handling) d.issues.push('Set the handling & sorting account in Document settings → Xero');
        if (!d.contactName) d.issues.push('Set the JPS contact in Document settings → Xero');
        docs.push(d);
    }

    for (const d of docs) {
        if (live(d.pushed)) {
            d.inXero = true;
            d.changedSincePush = d.total != null && d.pushed.total != null && cents(d.total) !== cents(d.pushed.total);
        } else {
            d.inXero = false;
        }
    }
    return docs;
}

// Xero Invoice body for a doc from xeroDocs(). Due on the document date:
// all three are settled up front (prepayment, LC, deposit).
export function xeroPayload(doc, contactId, status = 'DRAFT') {
    const body = {
        Type: doc.type,
        Status: ['DRAFT', 'SUBMITTED', 'AUTHORISED'].includes(status) ? status : 'DRAFT',
        Contact: { ContactID: contactId },
        Date: doc.date,
        DueDate: doc.date,
        InvoiceNumber: String(doc.number || ''),
        CurrencyCode: doc.currency,
        LineAmountTypes: 'Exclusive',
        LineItems: doc.lines.map(l => ({ ...l })),
    };
    if (doc.type === 'ACCREC' && doc.reference) body.Reference = doc.reference;
    return body;
}

// "/Date(1543449600000+0000)/" or "2026-11-13T00:00:00" → "YYYY-MM-DD" (NZ date)
export function xeroDate(v) {
    const m = String(v || '').match(/\/Date\((\d+)/);
    if (m) return new Date(Number(m[1])).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
    const iso = String(v || '').match(/^\d{4}-\d{2}-\d{2}/);
    return iso ? iso[0] : null;
}

// What we keep from a Xero invoice. Payment Amount is in the invoice
// currency; CurrencyRate is foreign units per NZD (Xero: "e.g. 0.7500"),
// so NZD = Amount ÷ CurrencyRate.
export function xeroState(inv) {
    const rate = Number(inv?.CurrencyRate) || 1;
    const payments = (inv?.Payments || []).map(p => {
        const pr = Number(p.CurrencyRate) || rate;
        return { date: xeroDate(p.Date), amount: round2(p.Amount), nzd: round2(Number(p.Amount) / pr) };
    });
    return {
        invoiceId: inv?.InvoiceID || null,
        number: inv?.InvoiceNumber || '',
        status: inv?.Status || null,
        currency: inv?.CurrencyCode || null,
        total: inv?.Total != null ? round2(inv.Total) : null,
        amountPaid: inv?.AmountPaid != null ? round2(inv.AmountPaid) : 0,
        amountDue: inv?.AmountDue != null ? round2(inv.AmountDue) : null,
        paidOn: inv?.FullyPaidOnDate ? xeroDate(inv.FullyPaidOnDate) : null,
        payments,
        nzdPaid: round2(payments.reduce((s, p) => s + p.nzd, 0)),
    };
}

export function xeroValidationMessage(body) {
    const errs = (body?.Elements || []).flatMap(e => e.ValidationErrors || []).map(e => e.Message).filter(Boolean);
    return errs.length ? errs.join('; ') : (body?.Message || body?.Detail || '');
}

// ── Cost breakdown ───────────────────────────────────────────────────────
// What the documents say each V3 cost line should be, against what the
// shipment holds. Returns the changes to show and the patch the Imports
// view applies (it owns the shipment save).
const LINE_LABELS = { rawWhite: 'White Toeclips', rawColour: 'Coloured Toeclips', handlingA: 'Handling & Sorting', handlingB: 'LC Deposit', lcRefund: 'LC Refund' };

export function costPlan({ shipment, record }) {
    const out = { changes: [], patch: { fixedLines: {} } };
    if (!shipment || shipment.schema !== 3 || !record?.confirmed) return out;
    const lines = shipment.fixedLines || {};
    const conf = record.confirmed, ei = record.exportInvoice || {};
    const t = baleTotals(conf.bales);
    const same = (a, b) => (typeof b === 'number' ? a != null && Math.abs(Number(a) - b) < 1e-6 : String(a ?? '') === String(b ?? ''));
    const add = (change) => out.changes.push(change);
    const setLine = (key, field, to, show) => {
        const from = lines[key]?.[field];
        if (same(from, to)) return;
        out.patch.fixedLines[key] = { ...(out.patch.fixedLines[key] || {}), [field]: to };
        // A currency change rides along with that line's rate change (the
        // rate row already shows the new currency).
        if (field === 'ccy' && out.changes.some(c => c.key === key && c.field === 'rate')) return;
        add({ key, field, label: `${LINE_LABELS[key]} ${show.what}`, from: show.from(from), to: show.to(to), source: show.source });
    };
    const rateShow = (ccy, source) => ({ what: 'rate', from: v => v == null ? '—' : `${fmtRate(v)}/kg`, to: v => `${ccy} ${fmtRate(v)}/kg`, source });
    const ccyShow = source => ({ what: 'currency', from: v => v || '—', to: v => v, source });
    const nzdShow = source => ({ what: 'actual NZD', from: v => v == null ? '—' : `$${fmtMoney(v)}`, to: v => `$${fmtMoney(v)}`, source });
    const paidShow = source => ({ what: 'paid', from: v => (v ? 'yes' : 'no'), to: v => (v ? 'yes' : 'no'), source });

    // Weights
    if (!same(shipment.whiteRawKg, t.whiteKg) || !same(shipment.colourRawKg, t.colouredKg)) {
        out.patch.whiteRawKg = t.whiteKg;
        out.patch.colourRawKg = t.colouredKg;
        add({ key: 'weights', field: 'kg', label: 'Net Weight Breakdown', from: `white ${fmtKg(shipment.whiteRawKg)} / coloured ${fmtKg(shipment.colourRawKg)} kg`, to: `white ${fmtKg(t.whiteKg)} / coloured ${fmtKg(t.colouredKg)} kg`, source: 'confirmed bales' });
    }

    // Raw product rates from the supplier proforma lines (by colour)
    const inv = conf.supplierInvoice;
    if (inv) {
        for (const [key, colour] of [['rawWhite', 'white'], ['rawColour', 'coloured']]) {
            const ls = (inv.lines || []).filter(l => normaliseColour(l.colour) === colour && Number(l.kg) > 0 && l.amount != null);
            if (!ls.length) continue;
            const rate = r4(ls.reduce((s, l) => s + Number(l.amount), 0) / ls.reduce((s, l) => s + Number(l.kg), 0));
            const src = `Pistoni proforma ${inv.number || ''}`.trim();
            setLine(key, 'rate', rate, rateShow(inv.currency, src));
            setLine(key, 'ccy', inv.currency, ccyShow(src));
        }
    }

    // LC Deposit / LC Refund = our export rate
    if (Number(ei.rate) > 0) {
        const src = `our proforma ${ei.number || ''}`.trim();
        setLine('handlingB', 'rate', Number(ei.rate), rateShow(ei.currency, src));
        setLine('handlingB', 'ccy', ei.currency, ccyShow(src));
        setLine('lcRefund', 'rate', -Number(ei.rate), rateShow(ei.currency, src));
        setLine('lcRefund', 'ccy', ei.currency, ccyShow(src));
    }

    // Handling & Sorting = JPS invoice less the deposit
    const sp = jpsSplit(record);
    if (sp) {
        const src = `JPS invoice ${record.jps.number || ''}`.trim();
        setLine('handlingA', 'rate', sp.handlingRate, rateShow(sp.currency, src));
        setLine('handlingA', 'ccy', sp.currency, ccyShow(src));
    }

    // Actuals from Xero payments (NZD)
    const xs = record.xero || {};
    const paidState = st => st && st.nzdPaid > 0 ? st : null;
    const bill = paidState(xs.supplierBill);
    if (bill) {
        const to = round2(bill.nzdPaid);
        if (!same(shipment.sectionActuals?.raw, to)) {
            out.patch.sectionActuals = { raw: to };
            add({ key: 'rawActual', field: 'actual', label: 'Raw Product actual paid', from: shipment.sectionActuals?.raw == null ? '—' : `$${fmtMoney(shipment.sectionActuals.raw)}`, to: `$${fmtMoney(to)}`, source: 'Xero payments on the Pistoni bill' });
        }
        if (bill.status === 'PAID') { setLine('rawWhite', 'paid', true, paidShow('Xero')); setLine('rawColour', 'paid', true, paidShow('Xero')); }
    }
    const sale = paidState(xs.salesInvoice);
    if (sale) {
        setLine('lcRefund', 'actual', -round2(sale.nzdPaid), nzdShow('Xero payments on our proforma (the LC)'));
        if (sale.status === 'PAID') setLine('lcRefund', 'paid', true, paidShow('Xero'));
    }
    const jb = paidState(xs.jpsBill);
    if (jb && sp && sp.total > 0) {
        const depositNzd = round2(jb.nzdPaid * sp.depositAmount / sp.total);
        setLine('handlingB', 'actual', depositNzd, nzdShow('Xero payments on the JPS bill (deposit share)'));
        setLine('handlingA', 'actual', round2(jb.nzdPaid - depositNzd), nzdShow('Xero payments on the JPS bill (handling share)'));
        if (jb.status === 'PAID') { setLine('handlingB', 'paid', true, paidShow('Xero')); setLine('handlingA', 'paid', true, paidShow('Xero')); }
    }
    return out;
}
