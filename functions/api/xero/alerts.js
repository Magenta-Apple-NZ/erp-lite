// GET /api/xero/alerts — counts + totals of AR invoices that need attention.
// Returns { unpaidCount, unpaidTotal, overdueCount, overdueTotal, asOf }.
// Cached in XERO_KV for 5 minutes — every dashboard load hits this endpoint,
// and we don't want to burn the 60-calls/min/org rate limit.
//
// "Unpaid" = AUTHORISED with AmountDue > 0.
// "Overdue" = unpaid AND DueDate < today.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../_xero.js';

const CACHE_KEY = 'alerts_cache';
const CACHE_TTL = 300; // 5 minutes

export async function onRequestGet({ env, request }) {
    try {
        const url  = new URL(request.url);
        const bust = url.searchParams.get('bust') === '1';

        if (!bust) {
            const cached = await env.XERO_KV.get(CACHE_KEY, { type: 'json' });
            if (cached) return jsonResponse(cached);
        }

        const token = await getValidToken(env);

        // Pull AR invoices in either AUTHORISED or SUBMITTED status — both
        // can carry AmountDue. DRAFT invoices haven't been issued so we skip
        // them. Xero caps pages at 100; if Prime Tie ever exceeds that this
        // will need paging, but two-user volumes are well under it.
        const apiUrl = 'https://api.xero.com/api.xro/2.0/Invoices' +
            '?Statuses=AUTHORISED,SUBMITTED' +
            '&where=' + encodeURIComponent('Type=="ACCREC"&&AmountDue>0') +
            '&page=1';
        const resp = await fetch(apiUrl, { headers: xeroHeaders(token) });

        if (!resp.ok) {
            const body = await resp.text();
            return errResponse('Xero API error: ' + body, resp.status);
        }

        const data = await resp.json();
        const invoices = data.Invoices || [];

        const today = new Date().toISOString().slice(0, 10);
        let unpaidCount = 0, unpaidTotal = 0;
        let overdueCount = 0, overdueTotal = 0;

        for (const inv of invoices) {
            const due = Number(inv.AmountDue) || 0;
            if (due <= 0) continue;
            unpaidCount++;
            unpaidTotal += due;

            // Xero serialises dates as /Date(1234567890000+0000)/ for some
            // fields; DueDateString is the friendly YYYY-MM-DDT... form.
            const dueDate = (inv.DueDateString || '').slice(0, 10);
            if (dueDate && dueDate < today) {
                overdueCount++;
                overdueTotal += due;
            }
        }

        const payload = {
            unpaidCount,
            unpaidTotal:  Math.round(unpaidTotal * 100) / 100,
            overdueCount,
            overdueTotal: Math.round(overdueTotal * 100) / 100,
            asOf: new Date().toISOString(),
        };

        await env.XERO_KV.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: CACHE_TTL });
        return jsonResponse(payload);

    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message, 401);
        return errResponse(e.message);
    }
}
