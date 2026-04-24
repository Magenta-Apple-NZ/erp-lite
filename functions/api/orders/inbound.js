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

        // Accept multiple payload shapes:
        //   Native Hub:    { customer, poNumber, shipTo (obj), lines, packingNotes, source }
        //   Extension:     { customerName, poNumber, shipTo (obj), items, source }
        //   Make/DocuPipe: { po, ship_to (array), line_items, invoice_no, ... }

        // ── Customer ──
        const customer = body.customer ?? {
            xeroContactId: body.xeroContactId || '',
            name: body.customerName || body.customer_name || '',
        };
        // Derive from ship_to[0] (branch/customer name) when not explicitly provided
        if (!customer.name && Array.isArray(body.ship_to) && body.ship_to[0]) {
            customer.name = body.ship_to[0];
        }
        if (!customer.name) return errResponse('customer name is required (add customerName or ship_to[0])', 400);

        // ── shipTo: accept object or address-lines array ──
        let shipTo = body.shipTo || body.ship_to || {};
        if (Array.isArray(shipTo)) {
            shipTo = {
                branch:  shipTo[0] || '',
                address: shipTo.slice(1).filter(Boolean).join(', '),
            };
        }

        // ── Line items: accept lines / items / line_items; object or array ──
        let rawLines = body.lines ?? body.items ?? body.line_items ?? [];
        if (!Array.isArray(rawLines)) rawLines = [rawLines];
        if (!rawLines.length) return errResponse('at least one line item is required', 400);

        const lines = rawLines.map(l => ({
            sku:         l.sku || l.itemCode || l.ItemCode || l.item_code || '',
            description: l.description || l.Description || l.name || l.item_description || '',
            quantity:    Number(l.quantity ?? l.Quantity ?? l.qty ?? 1),
            unitPrice:   Number(l.unitPrice ?? l.UnitAmount ?? l.unit_price ?? l.price ?? 0),
            accountCode: (l.accountCode || l.AccountCode || l.account_code || '200').split(' ')[0],
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
            source:           body.source || 'inbound',
            customer,
            poNumber:         body.poNumber || body.po || body.invoice_no || '',
            shipTo,
            lines,
            packingNotes:     body.packingNotes || body.packing_notes || body.notes || '',
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
