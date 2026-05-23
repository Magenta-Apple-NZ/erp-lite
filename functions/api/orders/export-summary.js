// GET /api/orders/export-summary
//
// One row per Hub order with operational metadata + product-kg totals.
// No item breakdown (use /api/orders/export for the line-level CSV).
// Hub-only — historical sales rows live in /api/sales-history.
//
// Freight / fees / anything outside the three product buckets are
// excluded from the kg totals — same classifier the Xero push hook uses,
// so totals here match what each order contributes to sales_history.

import { errResponse } from '../_xero.js';

const HEADERS = [
    'order_id', 'created_at', 'dispatched_at', 'dispatched_by',
    'status', 'source', 'customer', 'branch',
    'po_number', 'xero_invoice', 'xero_sourced',
    'bundles_kg', 'loose_kg', 'ecoties_kg', 'total_kg',
    'line_count', 'subtotal_nzd',
];

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Same heuristic the Xero push hook uses (see sales-history/_writer.js).
// Kept inline to avoid an import cycle.
function classifyLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    if (sku.includes('ECOTIE') || /eco\s*ti/.test(desc)) return 'ecoTies';
    if (sku.includes('BUNDLE') || /bundle/.test(desc))   return 'bundles';
    if (sku.includes('LOOSE')  || /loose/.test(desc))    return 'loose';
    const kpu = Number(l?.kgPerUnit);
    if (kpu === 10) return 'bundles';
    if (kpu === 1)  return 'loose';
    return 'other';
}

function lineKg(l) {
    return (Number(l?.quantity) || 0) * (Number(l?.kgPerUnit) || 0);
}

function summarize(order) {
    const buckets = { bundles: 0, loose: 0, ecoTies: 0 };
    let lineCount = 0;
    let subtotal = 0;
    for (const l of (order.lines || [])) {
        const cat = classifyLine(l);
        if (cat !== 'other') buckets[cat] += lineKg(l);
        lineCount++;
        subtotal += (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
    }
    return { ...buckets, lineCount, subtotal };
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
            // Newest-first, then by id as tiebreak. Easier to scan in Sheets.
            orders.sort((a, b) => {
                if (!a || !b) return 0;
                return (b.createdAt || '').localeCompare(a.createdAt || '')
                    || (b.id || '').localeCompare(a.id || '');
            });
            for (const o of orders) {
                if (!o) continue;
                const s = summarize(o);
                const totalKg = s.bundles + s.loose + s.ecoTies;
                lines.push([
                    o.id,
                    o.createdAt || '',
                    o.dispatchedAt || '',
                    o.dispatchedBy || '',
                    o.status || '',
                    o.source || '',
                    o.customer?.name || '',
                    o.shipTo?.branch || '',
                    o.poNumber || '',
                    o.xeroInvoiceNumber || '',
                    o.xeroSourced ? 'true' : '',
                    Math.round(s.bundles),
                    Math.round(s.loose),
                    Math.round(s.ecoTies),
                    Math.round(totalKg),
                    s.lineCount,
                    s.subtotal.toFixed(2),
                ].map(csvEscape).join(','));
            }
        }

        return new Response(lines.join('\n') + '\n', {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="orders-summary.csv"',
            },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
