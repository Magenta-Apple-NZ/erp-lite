// POST /api/orders/inbound — webhook for Chrome Extension and other trusted sources.
// Bypasses Cloudflare Access; authenticated by X-Hub-Key header instead.
// Set HUB_WEBHOOK_KEY as an env var in Cloudflare Pages settings.
// Also add an Access bypass policy for /api/orders/inbound in Zero Trust dashboard.

import { jsonResponse, errResponse } from '../_xero.js';

export async function onRequestPost({ env, request }) {
    // ── Auth: shared secret ──
    const key = request.headers.get('X-Hub-Key');
    if (!key || key !== env.HUB_WEBHOOK_KEY) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    try {
        const body = await request.json();

        // Accept either the Hub's native format or a Farmlands/extension payload.
        // Native format:  { customer, poNumber, shipTo, lines, packingNotes, source }
        // Extension format (Farmlands): { customerName, poNumber, shipTo, items, source }
        const customer = body.customer ?? {
            xeroContactId: body.xeroContactId || '',
            name: body.customerName || '',
        };

        if (!customer.name) return errResponse('customer name is required', 400);

        const rawLines = body.lines ?? body.items ?? [];
        if (!rawLines.length) return errResponse('at least one line item is required', 400);

        const lines = rawLines.map(l => ({
            sku:         l.sku || l.itemCode || '',
            description: l.description || l.name || '',
            quantity:    Number(l.quantity ?? l.qty ?? 1),
            unitPrice:   Number(l.unitPrice ?? l.price ?? 0),
            accountCode: l.accountCode || '200',
        })).filter(l => l.description);

        if (!lines.length) return errResponse('no valid line items', 400);

        const year = new Date().getFullYear();
        const counter = parseInt(await env.ORDERS_KV.get('order_counter') || '0') + 1;
        await env.ORDERS_KV.put('order_counter', String(counter));
        const id = `PKS-${year}-${String(counter).padStart(3, '0')}`;

        const order = {
            id,
            createdAt:        new Date().toISOString(),
            updatedAt:        new Date().toISOString(),
            status:           'new',
            source:           body.source || 'extension',
            customer,
            poNumber:         body.poNumber || '',
            shipTo:           body.shipTo || {},
            lines,
            packingNotes:     body.packingNotes || body.notes || '',
            xeroInvoiceId:    null,
            xeroInvoiceNumber: null,
        };

        await env.ORDERS_KV.put('order:' + id, JSON.stringify(order));

        const existing = JSON.parse(await env.ORDERS_KV.get('orders_index') || '[]');
        existing.unshift(id);
        await env.ORDERS_KV.put('orders_index', JSON.stringify(existing));

        return jsonResponse({ id, status: order.status, createdAt: order.createdAt }, 201);

    } catch (e) {
        return errResponse(e.message);
    }
}
