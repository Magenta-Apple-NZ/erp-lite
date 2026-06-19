// POST /api/xero/push  { orderId }
// Creates an AUTHORISED invoice in Xero from the order, stores the invoice
// ID back. "Authorised" is Xero's approved-and-ready-for-payment state — it
// shows in AR, counts toward the unpaid-invoices dashboard banner, and lines
// up with the Hub's operational flow (Entered → Sent to Xero → Printed →
// Complete). Use the Xero UI to void if a push happened in error.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../_xero.js';
import { syncSalesHistory } from '../sales-history/_writer.js';

// Customer-specific payment-term rules. Each entry is matched against the
// customer name case-insensitively as a substring. Day of 0 = due on the
// invoice date itself (cash sale). All other days = that day of the
// MONTH FOLLOWING the invoice date.
const PAYMENT_TERMS = [
    { match: /farmlands/i,       day: 26 },
    { match: /pgg\s*wrightson/i, day: 28 },
    { match: /horticentre/i,     day: 20 },
    { match: /cash/i,            day: 0  },
];
const DEFAULT_TERM_DAY = 20; // "Other" customers — 20th of following month

function dueDateFor(customerName, invoiceDateStr) {
    const name = String(customerName || '');
    const rule = PAYMENT_TERMS.find(r => r.match.test(name));
    const day = rule ? rule.day : DEFAULT_TERM_DAY;
    if (day === 0) return invoiceDateStr;
    // Pure string math so timezone never shifts the day. Pull year/month
    // out of YYYY-MM-DD, bump to next month, glue in the fixed day.
    const [yStr, mStr] = invoiceDateStr.split('-');
    let y = parseInt(yStr, 10);
    let m = parseInt(mStr, 10) + 1;
    if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function onRequestPost({ env, request }) {
    try {
        const { orderId } = await request.json();
        if (!orderId) return errResponse('orderId is required', 400);

        const order = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);
        if (order.xeroInvoiceId) {
            return errResponse('Invoice already created: ' + order.xeroInvoiceNumber, 409);
        }
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let contactId  = order.customer?.xeroContactId || '';
        let resolvedBy = null;

        // If the stored contactId isn't a real UUID (seeded placeholder like
        // "REPLACE_WITH_FARMLANDS_XERO_CONTACT_UUID", or empty), try to
        // resolve it by customer name from the cached Xero contacts list
        // before erroring out. Saves the user from manually re-picking the
        // customer on every legacy order.
        if (!UUID_RE.test(contactId) && order.customer?.name) {
            const cached = await env.XERO_KV.get('customers_cache', { type: 'json' });
            const list   = Array.isArray(cached) ? cached : [];
            const wanted = order.customer.name.trim().toLowerCase();
            const match  = list.find(c => (c.name || '').trim().toLowerCase() === wanted)
                || list.find(c => (c.name || '').trim().toLowerCase().includes(wanted))
                || list.find(c => wanted.includes((c.name || '').trim().toLowerCase()));
            if (match && UUID_RE.test(match.xeroContactId)) {
                contactId  = match.xeroContactId;
                resolvedBy = 'name-lookup';
            }
        }

        const token = await getValidToken(env);

        // Export orders with a new/unknown customer: create the Xero contact on the fly.
        // This eliminates the "Cash Sale + manual remap" workaround for overseas customers.
        if (!UUID_RE.test(contactId) && order.customer?.isExport && order.customer?.name) {
            const createResp = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
                method: 'POST',
                headers: xeroHeaders(token),
                body: JSON.stringify({ Contacts: [{ Name: order.customer.name }] }),
            });
            if (createResp.ok) {
                const cd = await createResp.json();
                const newContact = cd.Contacts?.[0];
                if (newContact?.ContactID && UUID_RE.test(newContact.ContactID)) {
                    contactId = newContact.ContactID;
                    order.customer = { ...order.customer, xeroContactId: contactId };
                    resolvedBy = 'export-create';
                }
            }
        }

        if (!UUID_RE.test(contactId)) {
            return errResponse(
                `Xero contact ID for "${order.customer?.name}" is missing or invalid` +
                (order.customer?.xeroContactId ? ` (got "${order.customer.xeroContactId}")` : '') +
                `. Edit the order and re-select the customer from the Xero search dropdown so a real contact ID is resolved.`,
                422
            );
        }

        // Persist the resolved contact id back onto the order so subsequent reads
        // (and re-pushes) see the corrected value.
        if (resolvedBy === 'name-lookup' || resolvedBy === 'export-create') {
            order.customer = { ...order.customer, xeroContactId: contactId };
        }

        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Derive Xero invoice number: PKS-1021 → INV-1021 (also handles legacy ORD- prefix)
        const invoiceNumber = order.id.replace(/^(?:PKS|ORD)-/, 'INV-');

        // AUTHORISED invoices require an explicit DueDate. Per-customer terms:
        //   Farmlands       → 26th of following month
        //   PGG Wrightson   → 28th of following month
        //   HortiCentre     → 20th of following month
        //   Cash / Export   → due on invoice date
        //   Anything else   → 20th of following month
        const isExport = !!order.customer?.isExport;
        const dueDate = isExport ? today : dueDateFor(order.customer?.name, today);

        const invoice = {
            Type: 'ACCREC',
            Status: 'AUTHORISED',
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
                if (isExport) item.TaxType = 'ZERORATEDOUTPUT';
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

        // Sync sales_history. /api/orders POST + inbound already do this
        // at creation time, so for already-existing orders this just
        // updates the invoice number in-place. The shared helper means
        // every write path uses the same logic.
        await syncSalesHistory(env, order);

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
