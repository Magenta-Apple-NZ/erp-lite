// POST /api/xero/push  { orderId }
// Creates a DRAFT invoice in Xero from the order, stores the invoice ID back.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../_xero.js';

export async function onRequestPost({ env, request }) {
    try {
        const { orderId } = await request.json();
        if (!orderId) return errResponse('orderId is required', 400);

        const order = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);
        if (order.xeroInvoiceId) {
            return errResponse('Invoice already created: ' + order.xeroInvoiceNumber, 409);
        }

        const token = await getValidToken(env);

        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 86400_000).toISOString().split('T')[0];

        const invoice = {
            Type: 'ACCREC',
            Status: 'DRAFT',
            Date: today,
            DueDate: dueDate,
            Reference: order.id,
            Contact: { ContactID: order.customer.xeroContactId },
            LineItems: order.lines.map(l => ({
                Description: l.description,
                Quantity: l.quantity,
                UnitAmount: l.unitPrice,
                AccountCode: l.accountCode || '200',
            })),
        };

        if (order.shipTo?.branch || order.shipTo?.address) {
            const deliveryNote = [order.shipTo.branch, order.shipTo.address]
                .filter(Boolean).join(' — ');
            invoice.DeliveryAddress = deliveryNote;
        }

        const resp = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
            method: 'POST',
            headers: xeroHeaders(token),
            body: JSON.stringify({ Invoices: [invoice] }),
        });

        if (!resp.ok) {
            const body = await resp.text();
            return errResponse('Xero API error: ' + body, resp.status);
        }

        const data = await resp.json();
        const created = data.Invoices?.[0];
        if (!created) return errResponse('Unexpected Xero response', 502);

        // Write invoice details back to the order
        order.xeroInvoiceId = created.InvoiceID;
        order.xeroInvoiceNumber = created.InvoiceNumber;
        order.updatedAt = new Date().toISOString();
        await env.ORDERS_KV.put('order:' + orderId, JSON.stringify(order));

        return jsonResponse({
            invoiceId: created.InvoiceID,
            invoiceNumber: created.InvoiceNumber,
            order,
        });

    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message, 401);
        return errResponse(e.message);
    }
}
