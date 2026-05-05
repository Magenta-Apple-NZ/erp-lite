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
        if (!order.customer?.xeroContactId) {
            return errResponse(
                `No Xero contact ID for "${order.customer?.name}". ` +
                `Edit the order and select the customer from the Xero search dropdown so the contact ID is resolved.`,
                422
            );
        }

        const token = await getValidToken(env);

        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 86400_000).toISOString().split('T')[0];

        // Derive Xero invoice number: PKS-1021 → INV-1021 (also handles legacy ORD- prefix)
        const invoiceNumber = order.id.replace(/^(?:PKS|ORD)-/, 'INV-');

        const invoice = {
            Type: 'ACCREC',
            Status: 'DRAFT',
            Date: today,
            DueDate: dueDate,
            InvoiceNumber: invoiceNumber,
            Reference: order.poNumber || '',
            Contact: { ContactID: order.customer.xeroContactId },
            LineItems: order.lines.map(l => {
                const item = {
                    Description: l.description,
                    Quantity: l.quantity,
                    UnitAmount: l.unitPrice,
                };
                if (l.sku) {
                    item.ItemCode = l.sku;
                } else if (l.accountCode) {
                    item.AccountCode = l.accountCode;
                }
                return item;
            }),
        };

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

        // Ship-to + packing notes go into the invoice's History & Notes
        // (audit trail in Xero UI; not on the printed invoice).
        const noteParts = [];
        if (order.shipTo?.branch) noteParts.push(`Ship to: ${order.shipTo.branch}`);
        if (order.shipTo?.address) noteParts.push(order.shipTo.address);
        if (order.packingNotes) noteParts.push(order.packingNotes);
        if (noteParts.length) {
            await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${created.InvoiceID}/History`, {
                method: 'PUT',
                headers: xeroHeaders(token),
                body: JSON.stringify({ HistoryRecords: [{ Details: noteParts.join('\n') }] }),
            }).catch(() => {});
        }

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
