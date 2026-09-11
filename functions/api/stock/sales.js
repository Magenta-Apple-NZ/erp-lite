// GET /api/stock/sales?month=YYYY-MM — every order in an NZ month with the
// kg the stock engine attributes to it: total product kg and the Bundled /
// Loose / eco split. Orders with no product kg (Hessian, freight-only) are
// listed with zeros so it's obvious what does and doesn't move stock.
// Classified with the same writer the sales rows come from.

import { jsonResponse, errResponse } from '../_xero.js';
import { nzToday, nzYmd } from '../_dates.js';
import { rowFromOrder } from '../sales-history/_writer.js';
import { loadItemsMap } from '../catalog/items.js';
import { loadWorld } from './_store.js';
import { stockAnchor } from './_engine.js';

export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : nzToday().slice(0, 7);
        const ids = JSON.parse(await env.ORDERS_KV.get('orders_index') || '[]');
        const [orders, itemsMap] = await Promise.all([
            Promise.all([...new Set(ids)].map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))),
            loadItemsMap(env).catch(() => null),
        ]);
        let anchor = null;
        try { anchor = stockAnchor(await loadWorld(env), nzToday()); } catch { /* optional */ }
        const rows = [];
        for (const o of orders) {
            if (!o || !o.createdAt) continue;
            const date = nzYmd(o.createdAt);
            if (date.slice(0, 7) !== month) continue;
            const r = rowFromOrder(o, itemsMap);
            const b = r ? r.bundlesKg : 0, l = r ? r.looseKg : 0, e = r ? r.ecoTiesKg : 0;
            const other = (o.lines || []).filter(x => !/^FR-/i.test(String(x.sku || ''))).map(x => `${x.quantity} × ${x.description || x.sku}`);
            rows.push({
                id: o.id, date, status: o.status || '', customer: o.customer?.name || '', branch: o.shipTo?.branch || '',
                invoice: o.xeroInvoiceNumber || '',
                totalKg: Math.round((b + l + e) * 100) / 100, bundlesKg: b, looseKg: l, ecoTiesKg: e,
                counted: !!r, lines: other,
                // Before the count date: already inside the opening count, so it never comes off stock again.
                inCount: !!(anchor && date < anchor.date),
            });
        }
        rows.sort((a, b) => b.date.localeCompare(a.date) || String(b.id).localeCompare(String(a.id)));
        const sum = k => Math.round(rows.reduce((s, r) => s + (r[k] || 0), 0) * 100) / 100;
        const after = rows.filter(r => !r.inCount);
        const sumA = k => Math.round(after.reduce((x, r) => x + (r[k] || 0), 0) * 100) / 100;
        return jsonResponse({ month, countDate: anchor ? anchor.date : null, countLabel: anchor ? anchor.label : null, rows,
            totals: { orders: rows.length, totalKg: sum('totalKg'), bundlesKg: sum('bundlesKg'), looseKg: sum('looseKg'), ecoTiesKg: sum('ecoTiesKg') },
            afterCount: { orders: after.length, totalKg: sumA('totalKg'), bundlesKg: sumA('bundlesKg'), looseKg: sumA('looseKg'), ecoTiesKg: sumA('ecoTiesKg') } });
    } catch (e) {
        return errResponse(e.message);
    }
}
