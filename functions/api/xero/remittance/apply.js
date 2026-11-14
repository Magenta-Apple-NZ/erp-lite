// POST /api/xero/remittance/apply  { remit, bankAccountId, rebateAccountCode }
//
// Writes the approved remittance to Xero:
//   1. one AR credit note per deduction (rebate), coded to rebateAccountCode,
//      GST-inclusive, dated the payment date;
//   2. each credit note allocated against the largest invoices on the remittance;
//   3. one batch payment into the bank account for the cash leg — it equals
//      the bank-feed line, so Xero offers it as a one-click match.
//
// Everything is re-derived from Xero here (the client's preview is not
// trusted) and the write is refused unless the plan ties out exactly. The
// remittance is logged in XERO_KV under remittanceKey() so it can't be
// applied twice; a part-way failure is logged with what was created.
// Needs accounting.invoices (credit notes) + accounting.payments.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../../_xero.js';
import { buildRows, checkTotals, dominantContact, planApply, remittanceKey, toCents, toDollars } from '../_remittance.js';
import { fetchInvoicesForRemit, fetchAccounts, XeroScopeError, SETTINGS_KEY } from './_shared.js';
import { nzToday } from '../../_dates.js';

async function xeroPut(token, path, body) {
    const resp = await fetch('https://api.xero.com/api.xro/2.0/' + path, {
        method: 'PUT', headers: xeroHeaders(token), body: JSON.stringify(body),
    });
    const text = await resp.text();
    let data = null; try { data = JSON.parse(text); } catch (_) {}
    if (resp.status === 401 || resp.status === 403) throw new XeroScopeError('Xero permission missing for ' + path.split('/')[0] + ' — reconnect Xero');
    if (!resp.ok) {
        const msgs = (data?.Elements || []).flatMap(el => (el.ValidationErrors || []).map(v => v.Message));
        throw new Error(`Xero rejected ${path.split('/')[0]} (${resp.status}): ` + (msgs.join('; ') || data?.Message || text.slice(0, 300)));
    }
    return data;
}

export async function onRequestPost({ env, request }) {
    const log = { status: 'in_progress', startedAt: new Date().toISOString(), startedOn: nzToday(), creditNotes: [], batchPaymentId: null };
    let key = null, logged = false;
    try {
        const { remit, bankAccountId, rebateAccountCode, force } = await request.json();
        if (!remit || !Array.isArray(remit.lines)) return errResponse('remit is required', 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(remit.paymentDate || '')) return errResponse('Payment date missing', 400);
        if (!bankAccountId) return errResponse('Choose the bank account the payment landed in', 400);

        key = remittanceKey(remit);
        const prior = await env.XERO_KV.get(key, { type: 'json' });
        // A failed attempt that created nothing can simply be retried; one that
        // created something needs `force` (after tidying up in Xero).
        const blocked = prior && (prior.status !== 'failed' || ((prior.creditNotes || []).length && !force));
        if (blocked) {
            const what = prior.status === 'applied' ? 'already applied' : prior.status === 'failed' ? 'part-applied before an error' : 'already in progress';
            return jsonResponse({ error: `This remittance was ${what} (${prior.startedOn || String(prior.startedAt).slice(0, 10)})`, prior }, 409);
        }

        const token = await getValidToken(env);
        const totals = checkTotals(remit);
        if (!totals.ok) return errResponse('Remittance lines do not add up to the total paid', 422);

        const invoices = await fetchInvoicesForRemit(token, remit);
        const contact = dominantContact(invoices);
        if (!contact) return errResponse('None of the remittance invoices were found in Xero', 422);
        const rows = buildRows(remit, invoices, contact.id);
        const deductions = remit.lines.filter(l => l.kind === 'deduction')
            .map(l => ({ reference: l.reference, details: l.details || null, amountCents: toCents(l.amount) }));
        if (remit.lines.some(l => l.kind === 'credit_note')) return errResponse('Remittance applies an existing credit note — do this one in Xero', 422);

        const plan = planApply(rows, deductions);
        if (!plan.ok) return jsonResponse({ error: 'Not ready to apply: ' + plan.errors.join('; '), plan }, 422);
        if (plan.cashCents !== totals.statedCents) return errResponse('Planned cash does not equal the total paid', 422);

        const accounts = await fetchAccounts(env, token);
        if (!accounts.some(a => a.AccountID === bankAccountId && a.Type === 'BANK')) return errResponse('Unknown bank account', 400);
        if (plan.creditNotes.length) {
            if (!rebateAccountCode) return errResponse('Choose the account to code rebates to', 400);
            if (!accounts.some(a => a.Code === rebateAccountCode)) return errResponse('Unknown rebate account code ' + rebateAccountCode, 400);
        }

        await env.XERO_KV.put(key, JSON.stringify({ ...log, payer: remit.payer, totalCents: totals.statedCents }));
        logged = true;
        await env.XERO_KV.put(SETTINGS_KEY, JSON.stringify({ bankAccountId, rebateAccountCode: rebateAccountCode || null }));

        const payer = remit.payer || contact.name;
        const date = remit.paymentDate;

        // 1 + 2. Credit notes, then allocations.
        if (plan.creditNotes.length) {
            const created = await xeroPut(token, 'CreditNotes', {
                CreditNotes: plan.creditNotes.map(cn => ({
                    Type: 'ACCRECCREDIT',
                    Status: 'AUTHORISED',
                    Contact: { ContactID: contact.id },
                    Date: date,
                    Reference: cn.reference.slice(0, 255),
                    LineAmountTypes: 'Inclusive',
                    LineItems: [{
                        Description: `${cn.reference} — deducted on ${payer} remittance ${date}`,
                        Quantity: 1,
                        UnitAmount: toDollars(cn.amountCents),
                        AccountCode: rebateAccountCode,
                    }],
                })),
            });
            const notes = created?.CreditNotes || [];
            for (let i = 0; i < plan.creditNotes.length; i++) {
                const cn = notes[i];
                if (!cn?.CreditNoteID) throw new Error('Xero did not return credit note ' + (i + 1));
                log.creditNotes.push({ id: cn.CreditNoteID, number: cn.CreditNoteNumber, reference: plan.creditNotes[i].reference, amountCents: plan.creditNotes[i].amountCents, allocated: false });
            }
            await env.XERO_KV.put(key, JSON.stringify({ ...log, payer, totalCents: totals.statedCents }));
            for (let i = 0; i < plan.creditNotes.length; i++) {
                await xeroPut(token, `CreditNotes/${log.creditNotes[i].id}/Allocations`, {
                    Allocations: plan.creditNotes[i].allocations.map(a => ({
                        Invoice: { InvoiceID: a.invoiceId }, Amount: toDollars(a.cents), Date: date,
                    })),
                });
                log.creditNotes[i].allocated = true;
                log.creditNotes[i].allocations = plan.creditNotes[i].allocations;
            }
        }

        // 3. The cash leg.
        let batch = null;
        if (plan.payments.length) {
            const res = await xeroPut(token, 'BatchPayments', {
                BatchPayments: [{
                    Account: { AccountID: bankAccountId },
                    Date: date,
                    Reference: `${payer} remittance`.slice(0, 255),
                    Payments: plan.payments.map(p => ({ Invoice: { InvoiceID: p.invoiceId }, Amount: toDollars(p.cents) })),
                }],
            });
            batch = res?.BatchPayments?.[0] || null;
            log.batchPaymentId = batch?.BatchPaymentID || null;
        }

        log.status = 'applied';
        log.appliedAt = new Date().toISOString();
        log.appliedOn = nzToday();
        log.payments = plan.payments;
        log.cashCents = plan.cashCents;
        await env.XERO_KV.put(key, JSON.stringify({ ...log, payer, totalCents: totals.statedCents }));

        // Let the order payment sync + AR alerts see the change straight away.
        await env.XERO_KV.delete('payments_reconcile').catch(() => {});
        await env.XERO_KV.delete('alerts_cache').catch(() => {});

        return jsonResponse({ ok: true, ...log, contact });
    } catch (e) {
        // Leave the log behind (blocks a blind retry) with the error and what was created.
        if (key && logged && log.status === 'in_progress') {
            log.status = 'failed';
            log.error = e.message;
            await env.XERO_KV.put(key, JSON.stringify(log)).catch(() => {});
        }
        const partial = log.creditNotes.length ? { created: log } : {};
        if (e instanceof XeroAuthError) return jsonResponse({ error: e.message, ...partial }, 401);
        if (e instanceof XeroScopeError) return jsonResponse({ error: e.message, needsReauth: true, ...partial }, 403);
        return jsonResponse({ error: e.message, ...partial }, 500);
    }
}
