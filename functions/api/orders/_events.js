// Order activity log — one shape, attributed server-side, with a field-level
// diff of what each write changed.
//
// Event: { timestamp, user, email, action, detail?, kind, changes?, doc?,
//          channel?, printer?, jobId? }
//   kind     'change'   — the order's data moved (changes[] says how)
//            'document' — a slip / address sheet / courier label was printed,
//                         downloaded or opened (doc + channel say which/how)
//            'system'   — written by an integration (Xero sync, webhook)
//   timestamp is the server's clock; user/email come from Cloudflare Access
//   (see _users.js), falling back to what the client sent only when the
//   request carried no identity (local dev).
//
// Legacy events — { ts, msg } and the client-shaped { timestamp, user, action,
// detail } — are normalised on the next write, so old orders read the same.

import { userFromRequest } from '../_users.js';
import { syncSalesHistory } from '../sales-history/_writer.js';

const STATUS_LABELS = { new: 'New', reviewed: 'Reviewed', sent_to_xero: 'Sent to Xero', dispatched: 'Complete', paid: 'Paid' };
const KINDS    = new Set(['change', 'document', 'system']);
const DOCS     = new Set(['slip', 'address', 'label']);
const CHANNELS = new Set(['printnode', 'browser', 'download', 'view']);
export const DOC_LABELS = { slip: 'Packing Slip', address: 'Address Sheet', label: 'Courier Label' };

const MAX_EVENTS = 500; // per order — far beyond any real order's life

const str = (v, n = 300) => String(v ?? '').slice(0, n);

export function normaliseEvent(e) {
    if (!e || typeof e !== 'object') return null;
    const ev = {
        timestamp: str(e.timestamp || e.ts || '', 40),
        user:      str(e.user || '', 80),
        action:    str(e.action || e.msg || '', 200),
        kind:      KINDS.has(e.kind) ? e.kind : 'change',
    };
    if (!ev.action) return null;
    if (e.email)   ev.email   = str(e.email, 120);
    if (e.detail)  ev.detail  = str(e.detail, 500);
    if (Array.isArray(e.changes) && e.changes.length) ev.changes = e.changes.map(c => str(c, 300)).slice(0, 60);
    if (DOCS.has(e.doc))         ev.doc = e.doc;
    if (CHANNELS.has(e.channel)) ev.channel = e.channel;
    if (e.printer) ev.printer = str(e.printer, 80);
    if (e.jobId != null && e.jobId !== '') ev.jobId = str(e.jobId, 40);
    return ev;
}

// Stamp an event with the server clock and the Access identity, then append
// it (normalising any legacy events on the way through).
export function appendEvent(order, event, request) {
    const ev = normaliseEvent(event);
    if (!ev) return null;
    const who = userFromRequest(request);
    ev.timestamp = new Date().toISOString();
    if (who.email) { ev.user = who.name; ev.email = who.email; }
    else if (!ev.user) ev.user = who.name;
    order.events = (Array.isArray(order.events) ? order.events : []).map(normaliseEvent).filter(Boolean);
    order.events.push(ev);
    if (order.events.length > MAX_EVENTS) order.events = order.events.slice(-MAX_EVENTS);
    return ev;
}

// Append an event to a stored order without touching anything else. Re-reads
// the order immediately before writing so a long-running caller (the 25s
// PrintNode poll) doesn't overwrite edits made meanwhile.
export async function appendOrderEvent(env, orderId, event, request) {
    const order = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
    if (!order) return null;
    const ev = appendEvent(order, event, request);
    if (!ev) return null;
    await env.ORDERS_KV.put('order:' + orderId, JSON.stringify(order));
    await syncSalesHistory(env, order); // no-op: events aren't material, but every order write syncs
    return ev;
}

// ── Diff ─────────────────────────────────────────────────────────────────
const show = v => {
    const s = (v == null || v === '') ? '—' : String(v).replace(/\s+/g, ' ').trim();
    return s.length > 80 ? s.slice(0, 77) + '…' : (s || '—');
};
const money = n => (n == null || n === '' || isNaN(Number(n))) ? '—' : '$' + Number(n).toFixed(2);
const fromTo = (label, a, b) => `${label}: ${show(a)} → ${show(b)}`;
const shipText = s => {
    s = s || {};
    return [s.branch, s.address || s.street, s.suburb, s.city, s.postcode, s.phone].map(x => String(x || '').trim()).filter(Boolean).join(', ');
};
const lineKey  = l => String(l?.sku || '').trim().toUpperCase() || String(l?.description || '').trim().toLowerCase();
const lineName = l => String(l?.sku || '').trim() || show(l?.description);

function diffLines(before = [], after = []) {
    const out = [];
    // Bucket by key so duplicate SKUs pair up in order rather than collapsing.
    const bucket = lines => {
        const m = new Map();
        for (const l of lines || []) { const k = lineKey(l); if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
        return m;
    };
    const A = bucket(before), B = bucket(after);
    for (const [k, bs] of B) {
        const as = A.get(k) || [];
        bs.forEach((b, i) => {
            const a = as[i];
            if (!a) { out.push(`Line added: ${lineName(b)} × ${show(b.quantity)} @ ${money(b.unitPrice)}`); return; }
            const name = lineName(b);
            if (Number(a.quantity) !== Number(b.quantity)) out.push(`${name} qty: ${show(a.quantity)} → ${show(b.quantity)}`);
            if (Number(a.unitPrice) !== Number(b.unitPrice)) out.push(`${name} price: ${money(a.unitPrice)} → ${money(b.unitPrice)}`);
            if (String(a.description || '') !== String(b.description || '')) out.push(fromTo(`${name} description`, a.description, b.description));
            if (String(a.accountCode || '') !== String(b.accountCode || '')) out.push(fromTo(`${name} account`, a.accountCode, b.accountCode));
        });
        for (const a of as.slice(bs.length)) out.push(`Line removed: ${lineName(a)} × ${show(a.quantity)} @ ${money(a.unitPrice)}`);
    }
    for (const [k, as] of A) {
        if (B.has(k)) continue;
        for (const a of as) out.push(`Line removed: ${lineName(a)} × ${show(a.quantity)} @ ${money(a.unitPrice)}`);
    }
    return out;
}

// Human-readable list of what moved between two versions of an order. Print
// receipts (printedAt/To) and the event log itself are not data changes.
export function diffOrder(before, after) {
    const a = before || {}, b = after || {};
    const out = [];
    const cmp = (label, x, y, fmt = v => v) => {
        if (show(fmt(x)) !== show(fmt(y))) out.push(fromTo(label, fmt(x), fmt(y)));
    };
    cmp('Status', a.status, b.status, s => STATUS_LABELS[s] || s);
    cmp('Customer', a.customer?.name, b.customer?.name);
    cmp('PO', a.poNumber, b.poNumber);
    cmp('Ship to', shipText(a.shipTo), shipText(b.shipTo));
    cmp('Fulfilment', a.fulfilmentMethod, b.fulfilmentMethod);
    cmp('Packing notes', a.packingNotes, b.packingNotes);
    out.push(...diffLines(a.lines, b.lines));
    cmp('Xero invoice', a.xeroInvoiceNumber || a.xeroInvoiceId, b.xeroInvoiceNumber || b.xeroInvoiceId);
    if (!!a.xeroSourced !== !!b.xeroSourced) out.push(`Created in Xero: ${a.xeroSourced ? 'yes' : 'no'} → ${b.xeroSourced ? 'yes' : 'no'}`);
    cmp('Paid', a.paidAt, b.paidAt);
    cmp('Dispatched by', a.dispatchedBy, b.dispatchedBy);
    const conn = c => c ? `${c.carrier || 'Courier'} ${c.connote || ''}${c.mock ? ' (TEST)' : ''}`.trim() : '';
    cmp('Courier label', conn(a.courier), conn(b.courier));
    cmp('Payslip', a.payslipLabel, b.payslipLabel);
    cmp('Pay month', a.payslipMonth, b.payslipMonth);
    return out;
}
