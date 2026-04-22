// GET   /api/orders/:id   — fetch a single order
// PATCH /api/orders/:id   — update status or fields

import { jsonResponse, errResponse } from '../_xero.js';

const VALID_STATUSES = ['confirmed', 'ready', 'packing', 'packed', 'dispatched'];

export async function onRequestGet({ env, params }) {
    try {
        const order = await env.ORDERS_KV.get('order:' + params.id, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);
        return jsonResponse(order);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPatch({ env, params, request }) {
    try {
        const order = await env.ORDERS_KV.get('order:' + params.id, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);

        const updates = await request.json();

        if (updates.status !== undefined) {
            if (!VALID_STATUSES.includes(updates.status)) {
                return errResponse('Invalid status: ' + updates.status, 400);
            }
            order.status = updates.status;
        }
        if (updates.packingNotes !== undefined) order.packingNotes = updates.packingNotes;
        if (updates.shipTo !== undefined) order.shipTo = updates.shipTo;
        if (updates.xeroInvoiceId !== undefined) order.xeroInvoiceId = updates.xeroInvoiceId;
        if (updates.xeroInvoiceNumber !== undefined) order.xeroInvoiceNumber = updates.xeroInvoiceNumber;

        order.updatedAt = new Date().toISOString();
        await env.ORDERS_KV.put('order:' + params.id, JSON.stringify(order));
        return jsonResponse(order);
    } catch (e) {
        return errResponse(e.message);
    }
}
