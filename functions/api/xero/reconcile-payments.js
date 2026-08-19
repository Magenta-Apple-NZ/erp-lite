// POST /api/xero/reconcile-payments  (?bust=1 to skip the throttle)
//
// Reconciles Hub orders against Xero payment status. For every order that has
// a linked Xero invoice but isn't marked paid yet, we check the invoice in
// Xero; if it's fully PAID we stamp `paidAt` on the order (from Xero's
// FullyPaidOnDate). Fulfilment status is left untouched — payment is an
// independent flag, so an order can be awaiting dispatch AND paid.
//
// Self-throttled to one Xero round-trip per 5 min (cached summary in
// XERO_KV) so the automatic on-load call doesn't burn the rate limit.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../_xero.js';

const CACHE_KEY = 'payments_reconcile';
const CACHE_TTL = 300; // seconds
const BATCH = 50;      // invoice IDs per Xero request

// Xero serialises some dates as /Date(1699999999999+0000)/. Return YYYY-MM-DD,
// falling back to today when absent/unparseable.
function xeroDateToIso(v) {
    const m = String(v || '').match(/\/Date\((\d+)/);
    if (m) {
        const d = new Date(Number(m[1]));
        if (!isNaN(d)) return d.toISOString().slice(0, 10);
    }
    const iso = String(v || '').match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
    return new Date().toISOString().slice(0, 10);
}

export async function onRequestPost({ env, request }) {
    try {
        const bust = new URL(request.url).searchParams.get('bust') === '1';

        if (!bust) {
            const cached = await env.XERO_KV.get(CACHE_KEY, { type: 'json' });
            if (cached && cached.at && (Date.now() - Date.parse(cached.at)) < CACHE_TTL * 1000) {
                return jsonResponse({ ...cached.summary, cached: true });
            }
        }

        // Load Hub orders.
        const indexRaw = await env.ORDERS_KV.get('orders_index');
        const ids = indexRaw ? [...new Set(JSON.parse(indexRaw))] : [];
        const orders = (await Promise.all(
            ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))
        )).filter(Boolean);

        // Candidates: linked to a Xero invoice, not already marked paid.
        const candidates = orders.filter(o => o.xeroInvoiceId && !o.paidAt);

        const summary = { checked: candidates.length, marked: 0, voided: 0, markedOrders: [], asOf: new Date().toISOString() };

        if (candidates.length) {
            const token = await getValidToken(env);
            // Map invoiceId → invoice, fetched in batches.
            const invById = new Map();
            for (let i = 0; i < candidates.length; i += BATCH) {
                const batchIds = candidates.slice(i, i + BATCH).map(o => o.xeroInvoiceId);
                const url = 'https://api.xero.com/api.xro/2.0/Invoices?IDs=' +
                    encodeURIComponent(batchIds.join(','));
                const resp = await fetch(url, { headers: xeroHeaders(token) });
                if (!resp.ok) {
                    const body = await resp.text();
                    return errResponse('Xero API error: ' + body, resp.status);
                }
                const data = await resp.json();
                for (const inv of (data.Invoices || [])) {
                    if (inv.InvoiceID) invById.set(inv.InvoiceID, inv);
                }
            }

            for (const order of candidates) {
                const inv = invById.get(order.xeroInvoiceId);
                if (!inv) continue;
                if (inv.Status === 'VOIDED' || inv.Status === 'DELETED') { summary.voided++; continue; }
                const paid = inv.Status === 'PAID' || (Number(inv.AmountDue) === 0 && Number(inv.AmountPaid) > 0);
                if (!paid) continue;

                order.paidAt = xeroDateToIso(inv.FullyPaidOnDate);
                if (!order.events) order.events = [];
                order.events.push({
                    timestamp: new Date().toISOString(),
                    user: 'Xero sync',
                    action: 'Payment received',
                    detail: (order.xeroInvoiceNumber || '') +
                        (inv.AmountPaid != null ? ` · $${Number(inv.AmountPaid).toLocaleString('en-NZ')}` : ''),
                });
                order.updatedAt = new Date().toISOString();
                await env.ORDERS_KV.put('order:' + order.id, JSON.stringify(order));

                summary.marked++;
                summary.markedOrders.push({ id: order.id, invoice: order.xeroInvoiceNumber, paidAt: order.paidAt });
            }
        }

        await env.XERO_KV.put(CACHE_KEY, JSON.stringify({ at: summary.asOf, summary }), { expirationTtl: CACHE_TTL + 60 });

        return jsonResponse(summary);
    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message, 401);
        return errResponse(e.message);
    }
}
