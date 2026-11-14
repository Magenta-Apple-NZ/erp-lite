// Pure helpers for remittance reconciliation (no I/O) — shared by
// functions/api/xero/remittance/{extract,match,apply}.js and tested in
// tests/remittance.test.js.
//
// Everything money is handled in integer cents to avoid float drift; the
// endpoints convert back to dollars only at the Xero boundary.

export const toCents = v => {
    if (v == null || v === '') return 0;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const toDollars = c => Math.round(c) / 100;

// A remittance reference → the Xero invoice numbers it could be.
// "INV-1047" → ["INV-1047"]; "1047" / "INV1047" → ["INV-1047"]; "91" → ["INV-91","INV-0091"].
export function candidateNumbers(ref) {
    const raw = String(ref || '').trim().toUpperCase();
    if (!raw) return [];
    const out = new Set([raw]);
    const digits = (raw.match(/(\d+)\s*$/) || [])[1];
    if (digits) {
        out.add('INV-' + digits);
        if (digits.length < 4) out.add('INV-' + digits.padStart(4, '0'));
    }
    return [...out];
}

// Stable id for a remittance — guards against applying the same one twice.
export function remittanceKey(remit) {
    const payer = String(remit?.payer || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `remit:${payer || 'unknown'}:${remit?.paymentDate || 'nodate'}:${toCents(remit?.total)}`;
}

// Do the lines tie out to the stated total?  invoices − deductions = total.
export function checkTotals(remit) {
    const lines = Array.isArray(remit?.lines) ? remit.lines : [];
    const inv = lines.filter(l => l.kind === 'invoice').reduce((s, l) => s + toCents(l.amount), 0);
    const ded = lines.filter(l => l.kind !== 'invoice').reduce((s, l) => s + toCents(l.amount), 0);
    const stated = toCents(remit?.total);
    return { invoiceCents: inv, deductionCents: ded, netCents: inv - ded, statedCents: stated, ok: inv - ded === stated };
}

// Build the review rows. `invoices` is the Xero invoice list returned for the
// candidate numbers (ACCREC only). Each row:
//   { ref, date, amountCents, invoice|null, dueCents, status, leftCents, note }
// status: full | partial | overpaid | paid_already | voided | not_found | wrong_contact
export function buildRows(remit, invoices, contactId = null) {
    const byNumber = new Map();
    for (const inv of invoices || []) {
        if (inv && inv.InvoiceNumber && inv.Type !== 'ACCPAY') byNumber.set(String(inv.InvoiceNumber).toUpperCase(), inv);
    }
    const lines = (remit?.lines || []).filter(l => l.kind === 'invoice');
    return lines.map(l => {
        const amountCents = toCents(l.amount);
        const inv = candidateNumbers(l.reference).map(n => byNumber.get(n)).find(Boolean) || null;
        const row = { ref: l.reference || '', date: l.date || null, amountCents, invoice: null, dueCents: 0, totalCents: 0, status: 'not_found', leftCents: 0, note: '' };
        if (!inv) { row.note = 'No Xero sales invoice with this number'; return row; }
        row.invoice = { id: inv.InvoiceID, number: inv.InvoiceNumber, contactId: inv.Contact?.ContactID || null, contactName: inv.Contact?.Name || '', status: inv.Status, reference: inv.Reference || '' };
        row.dueCents = toCents(inv.AmountDue);
        row.totalCents = toCents(inv.Total);
        if (inv.Status === 'VOIDED' || inv.Status === 'DELETED') { row.status = 'voided'; row.note = 'Invoice is ' + inv.Status.toLowerCase(); return row; }
        if (contactId && row.invoice.contactId && row.invoice.contactId !== contactId) { row.status = 'wrong_contact'; row.note = 'Invoice belongs to ' + row.invoice.contactName; return row; }
        if (inv.Status === 'PAID' || row.dueCents <= 0) { row.status = 'paid_already'; row.note = 'Already fully paid in Xero'; return row; }
        if (amountCents > row.dueCents) { row.status = 'overpaid'; row.note = 'Remittance pays more than is owing'; return row; }
        row.leftCents = row.dueCents - amountCents;
        row.status = row.leftCents === 0 ? 'full' : 'partial';
        if (row.status === 'partial') row.note = 'Leaves ' + (row.leftCents / 100).toFixed(2) + ' owing';
        return row;
    });
}

// The contact the remittance is from = the contact on most matched invoices.
export function dominantContact(invoices) {
    const counts = new Map();
    for (const inv of invoices || []) {
        const id = inv?.Contact?.ContactID;
        if (!id) continue;
        const c = counts.get(id) || { id, name: inv.Contact.Name || '', n: 0 };
        c.n++; counts.set(id, c);
    }
    return [...counts.values()].sort((a, b) => b.n - a.n)[0] || null;
}

export const PAYABLE = new Set(['full', 'partial']);

// Plan the Xero writes. Each deduction becomes one credit note, allocated
// against the largest invoices on the remittance (so the cash leg is a clean
// "invoice minus rebate"); the rest of each invoice is paid in one batch.
//   rows: buildRows() output (only full/partial rows are used)
//   deductions: [{ reference, amountCents }]
// Returns { ok, errors, creditNotes:[{ reference, amountCents, allocations:[{invoiceId, invoiceNumber, cents}] }],
//           payments:[{ invoiceId, invoiceNumber, cents }], cashCents }
export function planApply(rows, deductions) {
    const errors = [];
    const blocking = (rows || []).filter(r => !PAYABLE.has(r.status));
    for (const r of blocking) errors.push(`${r.ref || '(no ref)'}: ${r.note || r.status}`);
    const payable = (rows || []).filter(r => PAYABLE.has(r.status));
    if (!payable.length) errors.push('No payable invoices on this remittance');

    // Remaining capacity per invoice for allocations, largest first.
    const cap = payable.map(r => ({ invoiceId: r.invoice.id, invoiceNumber: r.invoice.number, left: r.amountCents }))
        .sort((a, b) => b.left - a.left);

    const creditNotes = [];
    for (const d of deductions || []) {
        let need = Math.round(d.amountCents || 0);
        if (need <= 0) continue;
        const allocations = [];
        for (const c of cap) {
            if (need <= 0) break;
            const take = Math.min(need, c.left);
            if (take <= 0) continue;
            allocations.push({ invoiceId: c.invoiceId, invoiceNumber: c.invoiceNumber, cents: take });
            c.left -= take; need -= take;
        }
        if (need > 0) errors.push(`Deduction ${d.reference || ''} is larger than the invoices it can offset`);
        creditNotes.push({ reference: d.reference || 'Deduction', amountCents: Math.round(d.amountCents), allocations });
    }

    const capById = new Map(cap.map(c => [c.invoiceId, c.left]));
    const payments = payable
        .map(r => ({ invoiceId: r.invoice.id, invoiceNumber: r.invoice.number, cents: capById.get(r.invoice.id) }))
        .filter(p => p.cents > 0);
    const cashCents = payments.reduce((s, p) => s + p.cents, 0);
    return { ok: errors.length === 0, errors, creditNotes, payments, cashCents };
}

// Match the bank account number printed on the remittance to a Xero BANK account.
export function suggestBankAccount(printed, accounts) {
    const digits = s => String(s || '').replace(/\D/g, '').replace(/^0+/, '');
    const want = digits(printed);
    const banks = (accounts || []).filter(a => a.Type === 'BANK');
    if (want) {
        const hit = banks.find(a => digits(a.BankAccountNumber) && (digits(a.BankAccountNumber) === want ||
            digits(a.BankAccountNumber).startsWith(want) || want.startsWith(digits(a.BankAccountNumber))));
        if (hit) return hit.AccountID;
    }
    return banks.length === 1 ? banks[0].AccountID : null;
}
