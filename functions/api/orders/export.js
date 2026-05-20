// GET /api/orders/export.csv
// One row per order line — order_id + line_index uniquely identify each
// row. Pair with POST /api/orders/import to bulk-edit existing orders
// (edits only; no adds, no deletes; auto-backup before apply).

import { errResponse } from '../_xero.js';

const HEADERS = [
    'order_id', 'line_index', 'created_at', 'status', 'customer',
    'branch', 'sku', 'description', 'quantity', 'kg_per_unit',
    'unit_price', 'line_kg', 'xero_invoice', 'source', 'locked',
    'dispatched_by', 'dispatched_at',
];

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function lineKg(l) {
    let kgPer;
    if (l && l.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) {
        kgPer = Number(l.kgPerUnit);
    } else {
        const text = `${l?.description || ''} ${l?.sku || ''}`;
        const m = text.match(/\b(10|1)\s*kg\b/i);
        kgPer = m ? Number(m[1]) : 0;
    }
    return (Number(l?.quantity) || 0) * kgPer;
}

function row(order, line, lineIndex) {
    return [
        order.id,
        lineIndex,
        order.createdAt || '',
        order.status || '',
        order.customer?.name || '',
        order.shipTo?.branch || '',
        line?.sku || '',
        line?.description || '',
        line?.quantity ?? '',
        line?.kgPerUnit ?? '',
        line?.unitPrice ?? '',
        line ? lineKg(line).toFixed(2) : '',
        order.xeroInvoiceNumber || '',
        order.source || '',
        order.locked ? 'true' : '',
        order.dispatchedBy || '',
        order.dispatchedAt || '',
    ].map(csvEscape).join(',');
}

export async function onRequestGet({ env }) {
    try {
        const indexRaw = await env.ORDERS_KV.get('orders_index');
        const lines = [HEADERS.join(',')];

        if (indexRaw) {
            const ids = [...new Set(JSON.parse(indexRaw))];
            const orders = await Promise.all(
                ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))
            );
            for (const o of orders) {
                if (!o) continue;
                if (Array.isArray(o.lines) && o.lines.length) {
                    o.lines.forEach((l, i) => lines.push(row(o, l, i)));
                } else {
                    lines.push(row(o, null, 0));
                }
            }
        }

        return new Response(lines.join('\n') + '\n', {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="orders.csv"',
            },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
