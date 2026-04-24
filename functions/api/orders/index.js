// GET  /api/orders       — list all orders, newest first
// POST /api/orders       — create a new order

import { jsonResponse, errResponse } from '../_xero.js';

export async function onRequestGet({ env }) {
    try {
        const indexRaw = await env.ORDERS_KV.get('orders_index');
        if (!indexRaw) return jsonResponse([]);

        const ids = JSON.parse(indexRaw);
        const orders = await Promise.all(
            ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))
        );
        return jsonResponse(orders.filter(Boolean));
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const { customer, poNumber, shipTo, lines, packingNotes } = body;

        if (!customer?.name) {
            return errResponse('customer.name is required', 400);
        }
        if (!Array.isArray(lines) || lines.length === 0) {
            return errResponse('at least one line item is required', 400);
        }
        for (const line of lines) {
            if (!line.description || line.quantity == null || line.unitPrice == null) {
                return errResponse('each line needs description, quantity, and unitPrice', 400);
            }
        }

        const counter = parseInt(await env.ORDERS_KV.get('order_counter') || '0') + 1;
        await env.ORDERS_KV.put('order_counter', String(counter));
        const id = `PKS-${String(counter).padStart(4, '0')}`;

        const order = {
            id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'new',
            customer,
            poNumber: poNumber || '',
            shipTo: shipTo || {},
            lines: lines.map(l => ({
                sku: l.sku || '',
                description: l.description,
                quantity: Number(l.quantity),
                unitPrice: Number(l.unitPrice),
                accountCode: l.accountCode || '200',
            })),
            packingNotes: packingNotes || '',
            xeroInvoiceId: null,
            xeroInvoiceNumber: null,
        };

        await env.ORDERS_KV.put('order:' + id, JSON.stringify(order));

        const existing = JSON.parse(await env.ORDERS_KV.get('orders_index') || '[]');
        existing.unshift(id);
        await env.ORDERS_KV.put('orders_index', JSON.stringify(existing));

        return jsonResponse(order, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}
