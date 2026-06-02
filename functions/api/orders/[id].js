// GET   /api/orders/:id   — fetch a single order
// PATCH /api/orders/:id   — update status, fields, or append an event

import { jsonResponse, errResponse } from '../_xero.js';
import { syncSalesHistory, removeRow } from '../sales-history/_writer.js';

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

export async function onRequestDelete({ env, params }) {
    try {
        const order = await env.ORDERS_KV.get('order:' + params.id, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);

        await env.ORDERS_KV.delete('order:' + params.id);

        const index = JSON.parse(await env.ORDERS_KV.get('orders_index') || '[]');
        // Filter out the deleted id AND dedupe any pre-existing duplicates.
        const updated = [...new Set(index.filter(id => id !== params.id))];
        await env.ORDERS_KV.put('orders_index', JSON.stringify(updated));

        // Drop the corresponding sales_history row so the reporting view
        // doesn't keep a sale that no longer has an underlying order.
        await removeRow(env, params.id);

        return jsonResponse({ deleted: params.id });
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
            // Stamp the moment of dispatch + who did it so the Dispatch Log can
            // attribute work. Only stamp on the first transition into 'dispatched'.
            if (updates.status === 'dispatched' && order.status !== 'dispatched') {
                order.dispatchedAt = new Date().toISOString();
                order.dispatchedBy = updates.dispatchedBy || 'Jake';
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
        if (updates.xeroSourced !== undefined) order.xeroSourced = updates.xeroSourced === true;
        if (updates.paidAt !== undefined) order.paidAt = updates.paidAt;
        // Slip print receipt (set by the order-detail view after auto-print
        // to the depot succeeds). Lets the UI show "🖨 Printed at <where>".
        if (updates.printedAt !== undefined) order.printedAt = updates.printedAt;
        if (updates.printedTo !== undefined) order.printedTo = updates.printedTo;
        // Payslip label (set by the Dispatch Log "Assign to Payslip" action).
        // Free-form string — typically "May 2026" or similar. Used to group
        // dispatched orders into payslip tallies in the log.
        if (updates.payslipLabel !== undefined) {
            order.payslipLabel = String(updates.payslipLabel || '').trim() || null;
        }

        // Append event to activity log
        if (updates.event) {
            if (!order.events) order.events = [];
            order.events.push(updates.event);
        }

        order.updatedAt = new Date().toISOString();
        await env.ORDERS_KV.put('order:' + params.id, JSON.stringify(order));

        // Any field that affects sales reporting (customer/branch/lines/
        // invoice/date) might have changed — re-derive and upsert. No-op
        // if nothing material moved.
        await syncSalesHistory(env, order);

        return jsonResponse(order);
    } catch (e) {
        return errResponse(e.message);
    }
}
