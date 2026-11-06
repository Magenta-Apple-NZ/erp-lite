// MCP endpoint: protocol, tools (read-only, enforced) and auth (functions/api/mcp/*).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, SUPPORTED_VERSIONS } from '../functions/api/mcp/_server.js';
import { readOnlyEnv } from '../functions/api/mcp/_tools.js';
import { authenticate, _resetCertsCache } from '../functions/api/mcp/_auth.js';
import { onRequestPost } from '../functions/api/mcp/index.js';

// ── Fixture ──────────────────────────────────────────────────────────────
function kv(entries = {}) {
    const store = new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return {
        store,
        get: async (k, o) => { const v = store.get(k) ?? null; return v != null && (o === 'json' || o?.type === 'json') ? JSON.parse(v) : v; },
        list: async () => ({ keys: [...store.keys()].map(name => ({ name })), list_complete: true }),
        getWithMetadata: async k => ({ value: store.get(k) ?? null, metadata: null }),
        put: async (k, v) => { store.set(k, v); },
        delete: async k => { store.delete(k); },
    };
}

const orders = [
    { id: 'PKS-0001', status: 'dispatched', createdAt: '2026-09-01T22:00:00Z', dispatchedAt: '2026-09-03T01:00:00Z', paidAt: '2026-10-01T00:00:00Z',
      customer: { name: 'Farmlands' }, shipTo: { branch: 'Farmlands - Ashburton' }, poNumber: 'PO-77', xeroInvoiceNumber: 'INV-100',
      lines: [{ sku: 'PT-B-10', description: 'Prime Tie 10kg', quantity: 3, unitPrice: 100 }],
      events: [{ ts: '2026-09-01T22:00:00Z', msg: 'Status set to New' }, { timestamp: '2026-09-03T01:00:00Z', user: 'Jake', action: 'Marked complete', changes: ['Status: Sent to Xero → Complete'] }] },
    { id: 'PKS-0002', status: 'new', createdAt: '2026-10-20T01:00:00Z',
      customer: { name: 'PGG Wrightson' }, shipTo: { branch: 'PGG - Gore' }, poNumber: 'G-5',
      lines: [{ sku: 'PT-B-1B', description: 'Prime Tie 1kg bag', quantity: 20, unitPrice: 12 }] },
];
const sales = [
    { id: 'a', year: 2026, month: 3, fy: 'FY26', customer: 'Farmlands', branch: 'Farmlands - Ashburton', bundlesKg: 100, looseKg: 0, ecoTiesKg: 0, oneKg: 0, tenKg: 100 },
    { id: 'b', year: 2026, month: 4, fy: 'FY27', customer: 'Farmlands', branch: 'Farmlands - Ashburton', bundlesKg: 50, looseKg: 10, ecoTiesKg: 0, oneKg: 20, tenKg: 40 },
    { id: 'c', year: 2026, month: 4, fy: 'FY27', customer: 'PGG Wrightson', branch: 'PGG - Gore', bundlesKg: 200, looseKg: 0, ecoTiesKg: 0, oneKg: 0, tenKg: 200 },
];
function makeEnv(extra = {}) {
    return {
        ORDERS_KV: kv({
            orders_index: orders.map(o => o.id),
            ...Object.fromEntries(orders.map(o => ['order:' + o.id, o])),
            sales_history: sales,
            'stock:items:index': ['prime-tie-bundled'],
            'stock:items:schema': 3,
            'stock:item:prime-tie-bundled': { id: 'prime-tie-bundled', name: 'Prime Tie Bundled', class: 'product', unit: 'kg', active: true, key: true, sortOrder: 10, salesKey: 'bundles', reorder: { mode: 'manual', manualPoint: 2000 } },
        }),
        XERO_KV: kv(),
        ...extra,
    };
}
const ctx = () => ({ env: makeEnv(), user: { name: 'Test' } });
const call = async (name, args = {}, c = ctx()) =>
    (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, c)).result;

// ── Protocol ─────────────────────────────────────────────────────────────
test('initialize negotiates the protocol version', async () => {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx());
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.ok(r.result.capabilities.tools);
    const r2 = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, ctx());
    assert.equal(r2.result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('notifications get no reply; unknown methods error', async () => {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx()), null);
    assert.equal((await handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx())).error.code, -32601);
    assert.equal((await handleMessage({ id: 4, method: 'ping' }, ctx())).error.code, -32600);
});

test('tools/list: every tool is annotated read-only with a schema', async () => {
    const { tools } = (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx())).result;
    assert.ok(tools.length >= 8);
    for (const t of tools) {
        assert.equal(t.annotations.readOnlyHint, true, t.name);
        assert.equal(t.inputSchema.type, 'object', t.name);
    }
});

// ── Tools ────────────────────────────────────────────────────────────────
test('search_orders: text, status, paid and NZ-date filters', async () => {
    let r = (await call('search_orders', { query: 'ashburton' })).structuredContent;
    assert.deepEqual(r.orders.map(o => o.id), ['PKS-0001']);
    assert.equal(r.orders[0].totalExGst, 300);
    assert.equal(r.orders[0].status, 'Complete');
    r = (await call('search_orders', { paid: false })).structuredContent;
    assert.deepEqual(r.orders.map(o => o.id), ['PKS-0002']);
    // 2026-09-01T22:00Z is 2 Sep in NZ.
    r = (await call('search_orders', { from: '2026-09-02', to: '2026-09-02' })).structuredContent;
    assert.deepEqual(r.orders.map(o => o.id), ['PKS-0001']);
    r = (await call('search_orders', { query: 'PT-B-1B' })).structuredContent;
    assert.deepEqual(r.orders.map(o => o.id), ['PKS-0002']);
});

test('get_order: by short id and by PO, activity newest first across legacy shapes', async () => {
    const a = (await call('get_order', { id: '1' })).structuredContent;
    assert.equal(a.order.id, 'PKS-0001');
    assert.equal(a.activity[0].action, 'Marked complete');
    assert.equal(a.activity[1].action, 'Status set to New');
    const b = (await call('get_order', { po: 'g-5' })).structuredContent;
    assert.equal(b.order.id, 'PKS-0002');
    const miss = await call('get_order', { id: 'PKS-9999' });
    assert.equal(miss.isError, true);
});

test('sales_summary: by month, fy and customer, with filters', async () => {
    let r = (await call('sales_summary', { group_by: 'month' })).structuredContent;
    assert.deepEqual(r.groups.map(g => [g.month, g.kg]), [['2026-03', 100], ['2026-04', 260]]);
    r = (await call('sales_summary', { group_by: 'fy' })).structuredContent;
    assert.deepEqual(r.groups.map(g => [g.fy, g.kg]), [['FY26', 100], ['FY27', 260]]);
    r = (await call('sales_summary', { group_by: 'customer', from_month: '2026-04' })).structuredContent;
    assert.deepEqual(r.groups.map(g => [g.customer, g.kg]), [['PGG Wrightson', 200], ['Farmlands', 60]]);
    assert.equal(r.totalKg, 260);
    r = (await call('sales_summary', { group_by: 'branch', branch: 'gore' })).structuredContent;
    assert.equal(r.groups.length, 1);
});

test('stock_levels runs through the real handler', async () => {
    const r = await call('stock_levels', { as_of: '2026-11-06' });
    assert.notEqual(r.isError, true, r.content?.[0]?.text);
    assert.ok(r.structuredContent);
});

test('read-only is enforced: ORDERS_KV writes throw, XERO_KV stays writable', async () => {
    const env = readOnlyEnv(makeEnv());
    await assert.rejects(() => env.ORDERS_KV.put('x', '1'), /Read-only/);
    await assert.rejects(() => env.ORDERS_KV.delete('order:PKS-0001'), /Read-only/);
    await env.XERO_KV.put('token', 'ok');
    // A tool whose read path tries to write (an unseeded stock store) fails
    // with an error result rather than writing.
    const fresh = makeEnv(); fresh.ORDERS_KV.store.delete('stock:items:index');
    const r = await call('stock_levels', {}, { env: fresh, user: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /Read-only/);
    assert.equal(fresh.ORDERS_KV.store.has('stock:items:index'), false);
});

// ── Auth ─────────────────────────────────────────────────────────────────
const req = headers => new Request('https://hub.example/api/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });

test('auth: nothing configured → 503; token right / wrong', async () => {
    assert.equal((await authenticate(req({}), {})).status, 503);
    const env = { MCP_TOKEN: 's3cret' };
    assert.equal((await authenticate(req({ Authorization: 'Bearer s3cret' }), env)).ok, true);
    assert.equal((await authenticate(req({ Authorization: 'Bearer nope' }), env)).status, 401);
    assert.equal((await authenticate(req({}), env)).status, 401);
});

test('auth: unverified identity headers are never trusted', async () => {
    const forged = ['x', btoa(JSON.stringify({ email: 'andrew@x.nz' })), 'y'].join('.');
    const r = await authenticate(req({ 'CF-Access-Authenticated-User-Email': 'andrew@x.nz', 'Cf-Access-Jwt-Assertion': forged }), { MCP_TOKEN: 't' });
    assert.equal(r.ok, false);
});

test('auth: Access JWT verified by signature, audience, issuer and expiry', async () => {
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
    const env = { ACCESS_TEAM_DOMAIN: 'primetie.cloudflareaccess.com', ACCESS_AUD: 'aud-123' };
    const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
    const sign = async (claims, kid = 'k1') => {
        const h = b64u({ alg: 'RS256', kid }), p = b64u(claims);
        const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`));
        return `${h}.${p}.${Buffer.from(s).toString('base64url')}`;
    };
    const now = Math.floor(Date.now() / 1000);
    const good = { aud: ['aud-123'], iss: 'https://primetie.cloudflareaccess.com', exp: now + 600, email: 'tetleyshed@gmail.com' };

    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        assert.equal(String(url), 'https://primetie.cloudflareaccess.com/cdn-cgi/access/certs');
        return new Response(JSON.stringify({ keys: [jwk] }));
    };
    _resetCertsCache();
    try {
        const ok = await authenticate(req({ 'Cf-Access-Jwt-Assertion': await sign(good) }), env);
        assert.equal(ok.ok, true);
        assert.equal(ok.user.name, 'Jake');
        for (const [bad, why] of [
            [{ ...good, aud: ['other'] }, /audience/],
            [{ ...good, exp: now - 3600 }, /expired/],
            [{ ...good, iss: 'https://evil.cloudflareaccess.com' }, /issuer/],
        ]) {
            const r = await authenticate(req({ 'Cf-Access-Jwt-Assertion': await sign(bad) }), env);
            assert.equal(r.ok, false); assert.match(r.error, why);
        }
        const tampered = (await sign(good)).replace(/\.[^.]+\./, '.' + b64u({ ...good, email: 'andrew@x.nz' }) + '.');
        assert.match((await authenticate(req({ 'Cf-Access-Jwt-Assertion': tampered }), env)).error, /signature/);
        assert.match((await authenticate(req({ 'Cf-Access-Jwt-Assertion': await sign(good, 'k9') }), env)).error, /signing key/);
    } finally {
        globalThis.fetch = realFetch;
        _resetCertsCache();
    }
});

// ── HTTP ─────────────────────────────────────────────────────────────────
test('POST /api/mcp: 401 without auth, JSON reply, 202 for notifications, batches', async () => {
    const env = makeEnv({ MCP_TOKEN: 't' });
    const post = (body, auth = 'Bearer t') => onRequestPost({ env, request: new Request('https://hub.example/api/mcp', {
        method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

    const denied = await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, '');
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('WWW-Authenticate'), /Bearer/);

    const ok = await post({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { jsonrpc: '2.0', id: 7, result: {} });

    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const batch = await (await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json();
    assert.deepEqual(batch.map(r => r.id), [1, 2]);
});
