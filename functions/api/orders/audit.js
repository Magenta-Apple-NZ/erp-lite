// GET /api/orders/audit
//
// Read-only reconciliation. Lists every order:* key in KV, cross-references
// orders_index and sales_history, and flags gaps — especially legacy orders
// (ORD-* / non-PKS ids) that were dispatched before the Xero integration and
// never got a sales_history row. Nothing is written.

import { jsonResponse, errResponse } from '../_xero.js';
import { rowFromOrder } from '../sales-history/_writer.js';
import { loadItemsMap } from '../catalog/items.js';

// The size a line's SKU implies (from the catalogue kg-per-unit, else the
// -10 / -1B suffix), vs the size its description implies ("10kg" / "1kg").
// When they disagree the line is mis-keyed — sales-history kg is computed from
// the SKU, so a 1kg SKU on a 10kg line records 10× too little.
function skuSize(l, itemsMap) {
    const cat = itemsMap && l?.sku ? itemsMap.get(String(l.sku).toUpperCase()) : null;
    if (cat && cat.kgPerUnit != null && !isNaN(Number(cat.kgPerUnit))) {
        const k = Number(cat.kgPerUnit);
        if (k === 10 || k === 1) return k;
    }
    const s = String(l?.sku || '').toUpperCase();
    if (/-10$/.test(s)) return 10;
    if (/-1B?$/.test(s)) return 1;
    return null;
}
function descSize(l) {
    const m = String(l?.description || l?.name || '').match(/\b(10|1)\s*kg\b/i);
    return m ? Number(m[1]) : null;
}
function isFreightLine(l) {
    const sku = String(l?.sku || '').toUpperCase();
    return /^FR-\d|COURIER|FREIGHT|CARTAGE|LABEL/.test(sku) || /courier|freight|cartage|\blabel/i.test(String(l?.description || ''));
}

export async function onRequestGet({ env }) {
    try {
        // 1) Every order key in KV (paginated).
        let cursor, keys = [];
        do {
            const res = await env.ORDERS_KV.list({ prefix: 'order:', cursor });
            keys.push(...res.keys.map(k => k.name));
            cursor = res.list_complete ? null : res.cursor;
        } while (cursor);

        const index = new Set(JSON.parse(await env.ORDERS_KV.get('orders_index') || '[]'));
        const salesRaw = await env.ORDERS_KV.get('sales_history');
        const salesById = new Map((salesRaw ? JSON.parse(salesRaw) : []).map(r => [r.id, r]));
        const itemsMap = await loadItemsMap(env).catch(() => null);

        const orders = await Promise.all(keys.map(k => env.ORDERS_KV.get(k, { type: 'json' })));

        const totals = { total: 0, dispatched: 0, missingSales: 0, orphanIndex: 0, noInvoice: 0, unclassified: 0, sizeMismatch: 0, problems: 0 };
        const problems = [];

        for (const o of orders) {
            if (!o || !o.id) continue;
            if (String(o.id).startsWith('HST-')) continue; // legacy seed placeholders
            totals.total++;

            const inIndex      = index.has(o.id);
            const hasSales     = salesById.has(o.id);
            const isDispatched = o.status === 'dispatched' || !!o.dispatchedAt;
            const hasInvoice   = !!o.xeroInvoiceId;
            const legacy       = !/^PKS-/i.test(o.id);            // ORD-* and anything non-PKS
            const wouldRow     = rowFromOrder(o, itemsMap);        // null → lines don't classify

            if (isDispatched) totals.dispatched++;

            // SKU vs description size mismatch — the mis-keyed-line bug that
            // makes sales-history kg 10× too low (e.g. 1kg SKU on a 10kg line).
            const mismatches = [];
            for (const l of (o.lines || [])) {
                if (isFreightLine(l)) continue;
                const ss = skuSize(l, itemsMap), ds = descSize(l);
                if (ss != null && ds != null && ss !== ds) {
                    mismatches.push(`${l.sku || '?'} says ${ss}kg but "${String(l.description || '').slice(0, 40)}"`);
                }
            }

            const issues = [];
            if (!hasSales)        { issues.push('no-sales-row');       totals.missingSales++; }
            if (!inIndex)         { issues.push('not-in-index');       totals.orphanIndex++; }
            if (!hasInvoice)      { issues.push('no-xero-invoice');    totals.noInvoice++; }
            if (wouldRow == null) { issues.push('unclassified-lines'); totals.unclassified++; }
            if (mismatches.length){ issues.push('sku-size-mismatch');  totals.sizeMismatch++; }

            if (!issues.length) continue;
            totals.problems++;
            problems.push({
                id: o.id, legacy, status: o.status || '',
                dispatched: isDispatched, dispatchedAt: o.dispatchedAt || '',
                createdAt: o.createdAt || '',
                customer: (o.customer && o.customer.name) || '',
                branch: (o.shipTo && o.shipTo.branch) || '',
                poNumber: o.poNumber || '',
                invoice: o.xeroInvoiceNumber || '',
                inIndex, hasSales, hasInvoice,
                // kg the row would carry if backfilled (helps spot mis-keyed lines).
                kg: wouldRow ? (Number(wouldRow.bundlesKg) || 0) + (Number(wouldRow.looseKg) || 0) + (Number(wouldRow.ecoTiesKg) || 0) : 0,
                mismatches,
                issues,
            });
        }

        // Most important first: dispatched AND missing a sales row (the pre-Xero
        // strays), then by created date.
        const weight = p => (p.dispatched && !p.hasSales ? 0 : 1);
        problems.sort((a, b) => weight(a) - weight(b) || (a.createdAt || '').localeCompare(b.createdAt || ''));

        return jsonResponse({ totals, problems });
    } catch (e) {
        return errResponse(e.message);
    }
}
