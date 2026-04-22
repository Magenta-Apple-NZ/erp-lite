// GET   /api/orders/:id   — fetch a single order
// PATCH /api/orders/:id   — update status, fields, or append an event

import { jsonResponse, errResponse } from '../_xero.js';

const VALID_STATUSES = ['new', 'reviewed', 'sent_to_xero', 'dispatched'];

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

        // Full order field updates (edit order)
        if (updates.customer !== undefined) order.customer = updates.customer;
        if (updates.poNumber !== undefined) order.poNumber = updates.poNumber;
        if (updates.shipTo !== undefined) order.shipTo = updates.shipTo;
        if (updates.lines !== undefined) order.lines = updates.lines;
        if (updates.packingNotes !== undefined) order.packingNotes = updates.packingNotes;
        if (updates.xeroInvoiceId !== undefined) order.xeroInvoiceId = updates.xeroInvoiceId;
        if (updates.xeroInvoiceNumber !== undefined) order.xeroInvoiceNumber = updates.xeroInvoiceNumber;

        // Append event to activity log
        if (updates.event) {
            if (!order.events) order.events = [];
            order.events.push(updates.event);
        }

        order.updatedAt = new Date().toISOString();
        await env.ORDERS_KV.put('order:' + params.id, JSON.stringify(order));
        return jsonResponse(order);
    } catch (e) {
        return errResponse(e.message);
    }
}
