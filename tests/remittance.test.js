// Remittance reconciliation helpers — fixture is the PGG Wrightson
// remittance paid 29 Sep 2026 (14 invoices, one rebate, $72,193.25).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    toCents, candidateNumbers, checkTotals, buildRows, planApply,
    dominantContact, suggestBankAccount, remittanceKey,
} from '../functions/api/xero/_remittance.js';

const PGW = 'c-pgw';
const lines = [
    ['INV-1047', 22.99], ['INV-1044', 32.19], ['INV-1048', 139.02], ['INV-1049', 225.32],
    ['INV-1046', 344.83], ['INV-1045', 358.64], ['INV-0091', 860.15], ['INV-0095', 1244.23],
    ['INV-0101', 1267.23], ['INV-0107', 8222.50], ['INV-0094', 8222.50], ['INV-0089', 12477.50],
    ['INV-0098', 39675.00],
].map(([reference, amount]) => ({ kind: 'invoice', reference, amount }));
const remit = {
    payer: 'PGG Wrightson Limited', paymentDate: '2026-09-29', total: 72193.25,
    lines: [{ kind: 'deduction', reference: "Aug'26 Rebates RS", amount: 898.85 }, ...lines],
};
const xeroInv = (number, due, extra = {}) => ({
    InvoiceID: 'id-' + number, InvoiceNumber: number, Type: 'ACCREC', Status: 'AUTHORISED',
    AmountDue: due, Total: due, Contact: { ContactID: PGW, Name: 'PGG Wrightson Limited' }, ...extra,
});
const invoices = lines.map(l => xeroInv(l.reference, l.amount));

test('toCents handles strings, commas and floats', () => {
    assert.equal(toCents('$39,675.00'), 3967500);
    assert.equal(toCents(0.1 + 0.2), 30);
    assert.equal(toCents(null), 0);
});

test('candidateNumbers normalises references', () => {
    assert.deepEqual(candidateNumbers('INV-1047'), ['INV-1047']);
    assert.ok(candidateNumbers('1047').includes('INV-1047'));
    assert.ok(candidateNumbers('91').includes('INV-0091'));
    assert.deepEqual(candidateNumbers(''), []);
});

test('PGW remittance ties out', () => {
    const t = checkTotals(remit);
    assert.equal(t.invoiceCents, 7309210);
    assert.equal(t.deductionCents, 89885);
    assert.ok(t.ok);
});

test('all lines match as full payments', () => {
    const rows = buildRows(remit, invoices, PGW);
    assert.equal(rows.length, 13);
    assert.ok(rows.every(r => r.status === 'full'), JSON.stringify(rows.filter(r => r.status !== 'full')));
    assert.equal(dominantContact(invoices).id, PGW);
});

test('rebate credit note lands on the largest invoice; cash equals the bank line', () => {
    const rows = buildRows(remit, invoices, PGW);
    const plan = planApply(rows, [{ reference: "Aug'26 Rebates RS", amountCents: 89885 }]);
    assert.ok(plan.ok, plan.errors.join('; '));
    assert.equal(plan.creditNotes.length, 1);
    assert.deepEqual(plan.creditNotes[0].allocations, [{ invoiceId: 'id-INV-0098', invoiceNumber: 'INV-0098', cents: 89885 }]);
    assert.equal(plan.cashCents, 7219325);
    assert.equal(plan.payments.find(p => p.invoiceNumber === 'INV-0098').cents, 3967500 - 89885);
    assert.equal(plan.payments.length, 13);
});

test('partial, overpaid, paid, missing and foreign invoices are classified', () => {
    const r = { lines: [
        { kind: 'invoice', reference: 'INV-1', amount: 50 },
        { kind: 'invoice', reference: 'INV-2', amount: 150 },
        { kind: 'invoice', reference: 'INV-3', amount: 10 },
        { kind: 'invoice', reference: 'INV-4', amount: 10 },
        { kind: 'invoice', reference: 'INV-5', amount: 10 },
    ] };
    const inv = [
        xeroInv('INV-1', 100), xeroInv('INV-2', 100),
        xeroInv('INV-3', 0, { Status: 'PAID' }),
        xeroInv('INV-5', 10, { Contact: { ContactID: 'other', Name: 'Farmlands' } }),
    ];
    const rows = buildRows(r, inv, PGW);
    assert.deepEqual(rows.map(x => x.status), ['partial', 'overpaid', 'paid_already', 'not_found', 'wrong_contact']);
    assert.equal(rows[0].leftCents, 5000);
    const plan = planApply(rows, []);
    assert.equal(plan.ok, false);
    assert.equal(plan.errors.length, 4);
});

test('a deduction bigger than one invoice spreads across several', () => {
    const r = { lines: [{ kind: 'invoice', reference: 'INV-1', amount: 100 }, { kind: 'invoice', reference: 'INV-2', amount: 60 }] };
    const rows = buildRows(r, [xeroInv('INV-1', 100), xeroInv('INV-2', 60)], PGW);
    const plan = planApply(rows, [{ reference: 'Rebate', amountCents: 13000 }]);
    assert.ok(plan.ok);
    assert.deepEqual(plan.creditNotes[0].allocations.map(a => a.cents), [10000, 3000]);
    assert.deepEqual(plan.payments, [{ invoiceId: 'id-INV-2', invoiceNumber: 'INV-2', cents: 3000 }]);
    assert.equal(planApply(rows, [{ reference: 'Too big', amountCents: 20000 }]).ok, false);
});

test('bank account suggested from the printed number', () => {
    const accounts = [
        { AccountID: 'a1', Type: 'BANK', BankAccountNumber: '12-3456-7890123-00' },
        { AccountID: 'a2', Type: 'BANK', BankAccountNumber: '01-0288-0204028-00' },
        { AccountID: 'a3', Type: 'REVENUE' },
    ];
    assert.equal(suggestBankAccount('01-0288-0204028-000', accounts), 'a2');
    assert.equal(suggestBankAccount('', accounts), null);
    assert.equal(suggestBankAccount('', accounts.slice(1)), 'a2');
});

test('remittanceKey is stable', () => {
    assert.equal(remittanceKey(remit), 'remit:pgg-wrightson-limited:2026-09-29:7219325');
});
