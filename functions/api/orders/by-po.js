// GET /api/orders/by-po?po=FPON12863934
//
// Returns the Hub order matching a retailer PO number, plus the Xero
// invoice reference and dispatch totals the Prime Ties extension needs
// to drive Farmlands' month-end Ship + Invoice screens.
//
// Designed for the extension to call once per PO it's about to act on;
// scans orders_index linearly (two-user volumes are small). If we ever
// add ~1000+ orders we'd want a po→id reverse index in KV.
//
// Match rules (in order):
//   1. exact poNumber match (case-insensitive)
//   2. exact match after stripping non-alphanumerics — handles "FPON 12345"
//      vs "FPON12345" / "FPON-12345" inconsistencies on the retailer side.
//
// Response shape on hit:
//   {
//     id, poNumber, status,
//     customer: { name, xeroContactId },
//     shipTo: { branch },
//     lines: [{ sku, description, quantity, unitPrice }],
//     totals: { net, gst, gross },
//     xeroInvoiceId, xeroInvoiceNumber,
//     dispatchedAt, dispatchedBy,
//     printedAt, printedTo,
//   }
// On miss: 404 { error: 'No Hub order found for PO ...' }

import { jsonResponse, errResponse } from '../_xero.js';

const GST_RATE = 0.15;

function normalisePo(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function orderTotals(order) {
    const net = (order.lines || []).reduce(
        (sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0),
        0
    );
    const gst = net * GST_RATE;
    const gross = net + gst;
    const r2 = n => Math.round(n * 100) / 100;
    return { net: r2(net), gst: r2(gst), gross: r2(gross) };
}

export async function onRequestGet({ env, request }) {
    try {
        const url   = new URL(request.url);
        const poRaw = url.searchParams.get('po');
        if (!poRaw) return errResponse('po query param is required', 400);
        const wanted = normalisePo(poRaw);
        if (!wanted) return errResponse('po query param is empty', 400);

        const indexRaw = await env.ORDERS_KV.get('orders_index');
        if (!indexRaw) return errResponse('No Hub orders yet', 404);

        const ids = [...new Set(JSON.parse(indexRaw))];
        const orders = await Promise.all(
            ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))
        );

        // Newest first so a duplicate PO returns the most recent order
        // (shouldn't happen, but safer than picking an arbitrary one).
        const sorted = orders.filter(Boolean).sort((a, b) =>
            (b.createdAt || '').localeCompare(a.createdAt || '')
        );

        const hit = sorted.find(o => normalisePo(o.poNumber) === wanted);
        if (!hit) {
            return errResponse(`No Hub order found for PO ${poRaw}`, 404);
        }

        return jsonResponse({
            id:                hit.id,
            poNumber:          hit.poNumber || null,
            status:            hit.status || 'new',
            customer: {
                name:          hit.customer?.name || '',
                xeroContactId: hit.customer?.xeroContactId || null,
            },
            shipTo: {
                branch:        hit.shipTo?.branch || '',
                address:       hit.shipTo?.address || '',
            },
            lines: (hit.lines || []).map(l => ({
                sku:         l.sku || '',
                description: l.description || '',
                quantity:    Number(l.quantity) || 0,
                unitPrice:   Number(l.unitPrice) || 0,
            })),
            totals:            orderTotals(hit),
            xeroInvoiceId:     hit.xeroInvoiceId || null,
            xeroInvoiceNumber: hit.xeroInvoiceNumber || null,
            dispatchedAt:      hit.dispatchedAt || null,
            dispatchedBy:      hit.dispatchedBy || null,
            printedAt:         hit.printedAt || null,
            printedTo:         hit.printedTo || null,
            createdAt:         hit.createdAt || null,
            updatedAt:         hit.updatedAt || null,
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
