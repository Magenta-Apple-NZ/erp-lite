// Xero reads shared by the remittance match + apply endpoints.

import { xeroHeaders } from '../../_xero.js';
import { candidateNumbers } from '../_remittance.js';

export const SETTINGS_KEY = 'remittance_settings';
const ACCOUNTS_KEY = 'accounts_cache';
const ACCOUNTS_TTL = 3600;

export class XeroScopeError extends Error {
    constructor(msg) { super(msg); this.name = 'XeroScopeError'; }
}

export async function xeroGet(token, path) {
    const resp = await fetch('https://api.xero.com/api.xro/2.0/' + path, { headers: xeroHeaders(token) });
    if (resp.status === 401 || resp.status === 403) {
        throw new XeroScopeError('Xero permission missing for ' + path.split('?')[0] + ' — reconnect Xero');
    }
    if (!resp.ok) throw new Error('Xero API error (' + resp.status + '): ' + (await resp.text()).slice(0, 300));
    return resp.json();
}

// Sales invoices for every reference on the remittance (40 numbers per call).
export async function fetchInvoicesForRemit(token, remit) {
    const numbers = [...new Set((remit?.lines || [])
        .filter(l => l.kind === 'invoice')
        .flatMap(l => candidateNumbers(l.reference)))];
    const out = [];
    for (let i = 0; i < numbers.length; i += 40) {
        const chunk = numbers.slice(i, i + 40);
        const data = await xeroGet(token, 'Invoices?InvoiceNumbers=' + encodeURIComponent(chunk.join(',')));
        for (const inv of data.Invoices || []) if (inv.Type === 'ACCREC') out.push(inv);
    }
    return out;
}

export async function fetchOpenInvoicesForContact(token, contactId) {
    const data = await xeroGet(token, 'Invoices?ContactIDs=' + encodeURIComponent(contactId) +
        '&Statuses=AUTHORISED,SUBMITTED&where=' + encodeURIComponent('Type=="ACCREC"&&AmountDue>0') + '&page=1');
    return data.Invoices || [];
}

// Active chart of accounts, cached for an hour (needs accounting.settings.read).
export async function fetchAccounts(env, token, { bust = false } = {}) {
    if (!bust) {
        const cached = await env.XERO_KV.get(ACCOUNTS_KEY, { type: 'json' });
        if (Array.isArray(cached)) return cached;
    }
    const data = await xeroGet(token, 'Accounts?where=' + encodeURIComponent('Status=="ACTIVE"'));
    const accounts = (data.Accounts || []).map(a => ({
        AccountID: a.AccountID, Code: a.Code || '', Name: a.Name || '', Type: a.Type,
        Class: a.Class, BankAccountNumber: a.BankAccountNumber || '', TaxType: a.TaxType || '',
    }));
    await env.XERO_KV.put(ACCOUNTS_KEY, JSON.stringify(accounts), { expirationTtl: ACCOUNTS_TTL });
    return accounts;
}
