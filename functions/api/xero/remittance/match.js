// POST /api/xero/remittance/match  { remit }   (remit from ./extract)
//
// Read-only. Looks up every invoice on the remittance in Xero and returns the
// review the user approves before anything is written:
//   { contact, rows, deductions, totals, plan, otherOpen, accounts, suggestedBankAccountId,
//     settings, alreadyApplied, needsReauth }
// Amounts are integer cents.

import { getValidToken, jsonResponse, errResponse, XeroAuthError } from '../../_xero.js';
import {
    buildRows, checkTotals, dominantContact, planApply, suggestBankAccount, remittanceKey, toCents,
} from '../_remittance.js';
import {
    fetchInvoicesForRemit, fetchOpenInvoicesForContact, fetchAccounts, XeroScopeError, SETTINGS_KEY,
} from './_shared.js';

export async function onRequestPost({ env, request }) {
    try {
        const { remit } = await request.json();
        if (!remit || !Array.isArray(remit.lines)) return errResponse('remit is required', 400);

        const token = await getValidToken(env);
        const invoices = await fetchInvoicesForRemit(token, remit);
        const contact = dominantContact(invoices);
        const rows = buildRows(remit, invoices, contact?.id || null);

        const deductions = remit.lines.filter(l => l.kind === 'deduction')
            .map(l => ({ reference: l.reference, details: l.details || null, amountCents: toCents(l.amount) }));
        const creditNoteLines = remit.lines.filter(l => l.kind === 'credit_note');

        const plan = planApply(rows, deductions);
        for (const cn of creditNoteLines) {
            plan.ok = false;
            plan.errors.push(`${cn.reference}: an existing credit note — allocate it in Xero, the Hub only creates new ones`);
        }
        const totals = checkTotals(remit);
        if (!totals.ok) {
            plan.ok = false;
            plan.errors.push('Remittance lines do not add up to the total paid — re-check the PDF read');
        } else if (plan.ok && plan.cashCents !== totals.statedCents) {
            plan.ok = false;
            plan.errors.push('Planned cash does not equal the total paid');
        }

        let otherOpen = [];
        if (contact) {
            const onRemit = new Set(rows.filter(r => r.invoice).map(r => r.invoice.id));
            otherOpen = (await fetchOpenInvoicesForContact(token, contact.id))
                .filter(inv => !onRemit.has(inv.InvoiceID))
                .map(inv => ({
                    id: inv.InvoiceID, number: inv.InvoiceNumber, reference: inv.Reference || '',
                    date: (inv.DateString || '').slice(0, 10), dueDate: (inv.DueDateString || '').slice(0, 10),
                    dueCents: toCents(inv.AmountDue),
                }));
        }

        // Chart of accounts needs accounting.settings.read — tokens granted
        // before the remittance feature lack it, so degrade to a reconnect prompt.
        let accounts = [], needsReauth = false;
        try { accounts = await fetchAccounts(env, token); }
        catch (e) { if (e instanceof XeroScopeError) needsReauth = true; else throw e; }

        const settings = (await env.XERO_KV.get(SETTINGS_KEY, { type: 'json' })) || {};
        const applied = await env.XERO_KV.get(remittanceKey(remit), { type: 'json' });

        return jsonResponse({
            contact, rows, deductions, totals, plan, otherOpen,
            accounts: accounts.filter(a => a.Type === 'BANK' || ['REVENUE', 'EXPENSE'].includes(a.Class)),
            // Printed account number first, then the last account used, then the only bank account.
            suggestedBankAccountId: (remit.bankAccount && suggestBankAccount(remit.bankAccount, accounts))
                || (accounts.some(a => a.AccountID === settings.bankAccountId) ? settings.bankAccountId : null)
                || suggestBankAccount('', accounts),
            settings,
            alreadyApplied: applied || null,
            needsReauth,
        });
    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message, 401);
        if (e instanceof XeroScopeError) return jsonResponse({ error: e.message, needsReauth: true }, 403);
        return errResponse(e.message);
    }
}
