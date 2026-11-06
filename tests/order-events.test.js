// Order activity log: diff, normalisation, attribution (orders/_events.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOrder, normaliseEvent, appendEvent, appendOrderEvent } from '../functions/api/orders/_events.js';
import { userFromRequest } from '../functions/api/_users.js';

const req = headers => ({ headers: new Headers(headers) });
const jwtFor = email => ['x', btoa(JSON.stringify({ email })).replace(/=+$/, ''), 'y'].join('.');

const base = {
    id: 'PKS-0001', status: 'new', customer: { name: 'Farmlands' }, poNumber: 'PO1',
    shipTo: { branch: 'Farmlands - Ashburton', address: '1 Main St' }, fulfilmentMethod: 'courier',
    packingNotes: '', xeroInvoiceNumber: null, courier: null,
    lines: [
        { sku: 'PT-B-10', description: 'Prime Tie 10kg', quantity: 2, unitPrice: 100, accountCode: '200' },
        { sku: 'FR-1', description: 'Freight', quantity: 1, unitPrice: 15, accountCode: '200' },
    ],
};
const clone = o => structuredClone(o);

test('diffOrder: no change → empty', () => {
    assert.deepEqual(diffOrder(base, clone(base)), []);
});

test('diffOrder: printedAt / events are not data changes', () => {
    const b = clone(base); b.printedAt = '2026-10-13T00:00:00Z'; b.printedTo = 'Depot'; b.events = [{ action: 'x' }];
    assert.deepEqual(diffOrder(base, b), []);
});

test('diffOrder: header fields read from → to', () => {
    const b = clone(base);
    b.status = 'sent_to_xero'; b.poNumber = 'PO2'; b.shipTo.address = '2 Main St'; b.xeroInvoiceNumber = 'INV-9';
    assert.deepEqual(diffOrder(base, b), [
        'Status: New → Sent to Xero',
        'PO: PO1 → PO2',
        'Ship to: Farmlands - Ashburton, 1 Main St → Farmlands - Ashburton, 2 Main St',
        'Xero invoice: — → INV-9',
    ]);
});

test('diffOrder: line qty / price / add / remove', () => {
    const b = clone(base);
    b.lines[0].quantity = 3; b.lines[0].unitPrice = 95;
    b.lines.splice(1, 1);
    b.lines.push({ sku: 'PT-B-1B', description: 'Prime Tie 1kg', quantity: 10, unitPrice: 12 });
    assert.deepEqual(diffOrder(base, b), [
        'PT-B-10 qty: 2 → 3',
        'PT-B-10 price: $100.00 → $95.00',
        'Line added: PT-B-1B × 10 @ $12.00',
        'Line removed: FR-1 × 1 @ $15.00',
    ]);
});

test('diffOrder: duplicate SKUs pair in order', () => {
    const a = clone(base); a.lines = [{ sku: 'X', quantity: 1, unitPrice: 1 }, { sku: 'X', quantity: 2, unitPrice: 1 }];
    const b = clone(a); b.lines.pop();
    assert.deepEqual(diffOrder(a, b), ['Line removed: X × 2 @ $1.00']);
});

test('diffOrder: courier label set and cleared', () => {
    const b = clone(base); b.courier = { carrier: 'Post Haste', connote: 'ABC123' };
    assert.deepEqual(diffOrder(base, b), ['Courier label: — → Post Haste ABC123']);
    assert.deepEqual(diffOrder(b, base), ['Courier label: Post Haste ABC123 → —']);
});

test('normaliseEvent: legacy { ts, msg } and junk', () => {
    assert.deepEqual(normaliseEvent({ ts: '2026-01-01T00:00:00Z', msg: 'Status set to New' }),
        { timestamp: '2026-01-01T00:00:00Z', user: '', action: 'Status set to New', kind: 'change' });
    assert.equal(normaliseEvent({}), null);
    assert.equal(normaliseEvent(null), null);
    const e = normaliseEvent({ action: 'a', kind: 'evil', doc: 'nope', channel: 'printnode' });
    assert.equal(e.kind, 'change'); assert.equal(e.doc, undefined); assert.equal(e.channel, 'printnode');
});

test('userFromRequest: header, JWT, mapped name, none', () => {
    assert.deepEqual(userFromRequest(req({ 'CF-Access-Authenticated-User-Email': 'andrew.mcleod@x.nz' })),
        { email: 'andrew.mcleod@x.nz', name: 'Andrew Mcleod', role: 'admin' });
    assert.equal(userFromRequest(req({ 'Cf-Access-Jwt-Assertion': jwtFor('tetleyshed@gmail.com') })).name, 'Jake');
    assert.equal(userFromRequest(req({})).email, null);
    assert.equal(userFromRequest(undefined).name, 'Unknown');
});

test('appendEvent: server identity beats client-sent user; legacy events normalised', () => {
    const o = clone(base); o.events = [{ ts: '2026-01-01T00:00:00Z', msg: 'old' }];
    const ev = appendEvent(o, { action: 'Order edited', user: 'Spoofed', timestamp: '1999-01-01' },
        req({ 'CF-Access-Authenticated-User-Email': 'tetleyshed@gmail.com' }));
    assert.equal(ev.user, 'Jake');
    assert.equal(ev.email, 'tetleyshed@gmail.com');
    assert.notEqual(ev.timestamp, '1999-01-01');
    assert.equal(o.events.length, 2);
    assert.equal(o.events[0].action, 'old');
});

test('appendEvent: no identity keeps the system user', () => {
    const o = clone(base);
    const ev = appendEvent(o, { action: 'Payment received', user: 'Xero sync', kind: 'system' });
    assert.equal(ev.user, 'Xero sync'); assert.equal(ev.kind, 'system');
});

test('appendOrderEvent: re-reads the stored order so concurrent edits survive', async () => {
    const store = new Map([['order:PKS-0001', JSON.stringify(base)], ['sales_history', '[]']]);
    const env = { ORDERS_KV: {
        get: async (k, o) => { const v = store.get(k) ?? null; return v && o?.type === 'json' ? JSON.parse(v) : v; },
        put: async (k, v) => { store.set(k, v); },
    } };
    // An edit lands while (say) a print poll is running…
    store.set('order:PKS-0001', JSON.stringify({ ...base, poNumber: 'EDITED' }));
    await appendOrderEvent(env, 'PKS-0001', { action: 'Printed packing slip', kind: 'document', doc: 'slip', channel: 'printnode' });
    const saved = JSON.parse(store.get('order:PKS-0001'));
    assert.equal(saved.poNumber, 'EDITED');
    assert.equal(saved.events.at(-1).doc, 'slip');
});
