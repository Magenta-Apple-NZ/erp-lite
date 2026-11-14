// Settings → Integrations: every outside service checked live, with Xero's
// granted permissions compared to what the Hub asks for. fetch and KV stubbed.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { checkAll, jwtClaims, scopeReport, summarise, fmtNzDate, CHECKS } from '../functions/api/_integrations.js';
import { XERO_SCOPES, validateOAuthState, saveOAuthState } from '../functions/api/_xero.js';
import * as xeroAuth from '../functions/api/xero/auth.js';
import * as xeroCallback from '../functions/api/xero/callback.js';

function kv(entries = {}) {
    const store = new Map(Object.entries(entries).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    return {
        store,
        get: async (k, o) => { const v = store.get(k) ?? null; return v != null && (o === 'json' || o?.type === 'json') ? JSON.parse(v) : v; },
        put: async (k, v) => { store.set(k, v); },
        delete: async k => { store.delete(k); },
    };
}
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = claims => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.sig`;
const ALL_SCOPES = XERO_SCOPES.map(s => s.scope);
const OLD_SCOPES = ['openid', 'accounting.invoices', 'accounting.contacts', 'accounting.reports.profitandloss.read', 'offline_access'];

const ITEMS_CSV = 'id,name,kg\nPT-10,Prime Tie 10kg,10\nPT-1,Prime Tie 1kg,1\n';
const FREIGHT_CSV = 'year,region,courier_per_box,freight_per_box,min_pallet,full_pallet,zone_courier,zone_freight\n2026,Auckland,5,6,50,90,A,A\n';

// A throwaway service-account key, so the Drive check really signs a JWT.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_KEY = JSON.stringify({ client_email: 'hub-lc@primetie-hub.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });

let env, realFetch, calls, routes;
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });

function fullEnv(scopes = ALL_SCOPES) {
    return {
        XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 'secret',
        GCAL_CLIENT_ID: 'g', GCAL_CLIENT_SECRET: 'gs',
        PRINTNODE_API_KEY: 'pn', GSS_ACCESS_KEY: 'gss', GSS_SITE_ID: '123', GDRIVE_SA_KEY: SA_KEY,
        ANTHROPIC_API_KEY: 'sk-ant-secret', MCP_TOKEN: 'mcp-secret', HUB_WEBHOOK_KEY: 'hook-secret', NOTIFY_FEED_TOKEN: 'feed-secret',
        ACCESS_TEAM_DOMAIN: 'primetie.cloudflareaccess.com', ACCESS_AUD: 'aud',
        XERO_KV: kv({
            tokens: { accessToken: jwt({ scope: scopes }), refreshToken: 'rt', expiresAt: Date.now() + 3600e3, tenantId: 't1' },
            'gcal:tokens': { access_token: 'ga', refresh_token: 'gr', expires_in: 3600, stored_at: Date.now() },
        }),
        ORDERS_KV: kv({ 'status_feed:pacing': { updated_at: new Date().toISOString(), statuses: [] } }),
        ASSETS: { fetch: async () => json({ printers: [{ id: 1, label: 'Warehouse', documents: ['slip'] }] }) },
    };
}

beforeEach(() => {
    calls = [];
    routes = {
        'https://api.xero.com/connections': () => json([{ tenantId: 't1', tenantName: 'Enviroware Ltd', updatedDateUtc: '2026-11-14T22:30:00.1833130' }]),
        'https://www.googleapis.com/calendar': () => json({ items: [{ id: 'e1' }, { id: 'e2' }] }),
        'https://docs.google.com/spreadsheets': (u) => new Response(/gid=0&/.test(u) ? ITEMS_CSV : FREIGHT_CSV),
        'https://api.printnode.com/printers': () => json([{ id: 1, name: 'Zebra', state: 'online', computer: { name: 'DEPOT-PC' } }, { id: 2, name: 'Old', state: 'offline' }]),
        'https://api.anthropic.com/v1/models/': () => json({ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }),
        'https://oauth2.googleapis.com/token': (u, init) => json(/jwt-bearer&assertion=[\w-]+\.[\w-]+\.[\w-]+$/.test(init.body) ? { access_token: 'drive' } : { error: 'invalid_grant' }),
    };
    realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        calls.push({ url: u, headers: init.headers || {} });
        const key = Object.keys(routes).find(k => u.startsWith(k));
        if (!key) throw new Error('unexpected fetch ' + u);
        return routes[key](u, init);
    };
});
afterEach(() => { globalThis.fetch = realFetch; });

const byId = r => Object.fromEntries(r.integrations.map(i => [i.id, i]));

test('everything set up and answering: all working, no secret in the response', async () => {
    env = fullEnv();
    const r = await checkAll(env, { origin: 'https://hub.primetie.co.nz' });
    const i = byId(r);
    assert.equal(r.integrations.length, CHECKS.length);
    assert.deepEqual(r.integrations.filter(x => x.status !== 'ok').map(x => [x.id, x.summary]), []);
    assert.equal(r.summary.headline, `All ${CHECKS.length} working`);
    assert.equal(i.xero.summary, 'Connected to Enviroware Ltd');
    assert.deepEqual(i.xero.details.find(d => d.label === 'Authorised'), { label: 'Authorised', value: '15 Nov 2026' });
    assert.ok(i.xero.permissions.every(p => p.granted === true));
    assert.match(i.gcal.summary, /2 events in the next 7 days/);
    assert.match(i.sheets.summary, /2 products and 1 freight rows/);
    assert.equal(i.printnode.summary, 'The Hub printer is online');
    assert.match(i.anthropic.summary, /Claude Sonnet 5 available/);
    assert.deepEqual(i.gdrive.details[0], { label: 'Service account', value: 'hub-lc@primetie-hub.iam.gserviceaccount.com', copy: true });
    assert.ok(!JSON.stringify(i.gdrive).includes('PRIVATE KEY'));
    assert.equal(i.mcp.details[0].value, 'https://hub.primetie.co.nz/api/mcp');
    const text = JSON.stringify(r);
    for (const secret of ['sk-ant-secret', 'mcp-secret', 'hook-secret', 'feed-secret', 'gss', 'secret"']) assert.ok(!text.includes(secret), secret + ' leaked');
    const anth = calls.find(c => c.url.startsWith('https://api.anthropic.com'));
    assert.equal(anth.url, 'https://api.anthropic.com/v1/models/claude-sonnet-5');
});

test('Xero connected before the remittance permissions: needs a look, reconnect returns to Integrations', async () => {
    env = fullEnv(OLD_SCOPES);
    const x = byId(await checkAll(env)).xero;
    assert.equal(x.status, 'warn');
    assert.match(x.summary, /missing 2 permissions — reconnect to allow batch payments and chart of accounts/);
    assert.deepEqual(x.permissions.filter(p => !p.granted).map(p => p.scope), ['accounting.payments', 'accounting.settings.read']);
    assert.deepEqual(x.actions, [{ label: 'Reconnect to allow', href: '/api/xero/auth?return=integrations', primary: true }]);
});

test('nothing set up: every card says so, with Connect where OAuth applies', async () => {
    env = { XERO_CLIENT_ID: 'cid', XERO_CLIENT_SECRET: 's', GCAL_CLIENT_ID: 'g', GCAL_CLIENT_SECRET: 'gs', XERO_KV: kv(), ORDERS_KV: kv() };
    const r = await checkAll(env);
    const i = byId(r);
    assert.equal(i.xero.status, 'off');
    assert.equal(i.xero.actions[0].href, '/api/xero/auth?return=integrations');
    assert.equal(i.gcal.actions[0].href, '/api/calendar/auth?return=integrations');
    for (const id of ['gdrive', 'printnode', 'courier', 'anthropic', 'mcp', 'extension', 'feeds']) assert.equal(i[id].status, 'off', id);
    assert.equal(i.sheets.status, 'ok', 'the catalogue sheet needs no key');
    assert.equal(r.summary.headline, '1 of 10 working · 9 not set up');
});

test('failures: rejected keys, an offline printer, test-mode courier, stale feed, a hung check', async () => {
    env = fullEnv();
    env.COURIER_TEST_MODE = 'true';
    env.ORDERS_KV = kv({ 'status_feed:pacing': { updated_at: new Date(Date.now() - 5 * 86400e3).toISOString() } });
    routes['https://api.anthropic.com/v1/models/'] = () => json({ error: { message: 'invalid x-api-key' } }, 401);
    routes['https://api.printnode.com/printers'] = () => json([{ id: 1, name: 'Zebra', state: 'disconnected' }]);
    routes['https://www.googleapis.com/calendar'] = () => new Promise(() => {});  // never answers
    const r = await checkAll(env, { origin: 'https://hub.primetie.co.nz', timeoutMs: 50 });
    const i = byId(r);
    assert.deepEqual([i.anthropic.status, i.anthropic.summary], ['error', 'Anthropic rejected the API key']);
    assert.deepEqual([i.printnode.status, i.printnode.summary], ['warn', 'Warehouse is not online']);
    assert.equal(i.courier.status, 'warn');
    assert.match(i.feeds.summary, /hasn't been updated for 5 days/);
    assert.deepEqual([i.gcal.status, i.gcal.name, i.gcal.summary], ['error', 'Google Calendar', 'No answer within 0s']);
    assert.equal(r.summary.worst, 'error');
});

test('Xero session expired: not working, reconnect', async () => {
    env = fullEnv();
    await env.XERO_KV.put('tokens', JSON.stringify({ accessToken: 'x', refreshToken: 'dead', expiresAt: 0, tenantId: 't1' }));
    routes['https://identity.xero.com/connect/token'] = () => new Response('{"error":"invalid_grant"}', { status: 400 });
    const x = byId(await checkAll(env)).xero;
    assert.equal(x.status, 'error');
    assert.equal(x.summary, 'Xero session expired — reconnect Xero');
    assert.equal(x.actions[0].label, 'Reconnect Xero');
});

test('pure helpers', () => {
    assert.deepEqual(jwtClaims(jwt({ scope: ['a'] })), { scope: ['a'] });
    assert.equal(jwtClaims('not-a-jwt'), null);
    const unknown = scopeReport(null);
    assert.ok(unknown.list.every(p => p.granted === null) && !unknown.missing.length);
    assert.ok(!unknown.list.some(p => p.scope === 'openid' || p.scope === 'offline_access'), 'sign-in scopes are not listed');
    assert.equal(scopeReport('accounting.invoices accounting.contacts').missing.length, 3);
    assert.equal(fmtNzDate('2026-11-14T11:30:00Z'), '15 Nov 2026');
    assert.equal(summarise([{ status: 'ok' }, { status: 'warn' }]).headline, '1 of 2 working · 1 needs a look');
});

test('OAuth round trip from Integrations lands back on Integrations', async () => {
    env = { XERO_CLIENT_ID: 'cid', XERO_KV: kv() };
    const res = await xeroAuth.onRequestGet({ env, request: new Request('https://hub.primetie.co.nz/api/xero/auth?return=integrations') });
    const state = new URL(res.headers.get('Location')).searchParams.get('state');
    assert.equal(await env.XERO_KV.get('oauth_state:' + state), 'integrations');
    assert.equal(new URL(res.headers.get('Location')).searchParams.get('scope'), ALL_SCOPES.join(' '));

    const denied = await xeroCallback.onRequestGet({ env, request: new Request(`https://hub.primetie.co.nz/api/xero/callback?error=invalid_scope&state=${state}`) });
    assert.match(await denied.text(), /url=\/#admin\/integrations\?xero_error=invalid_scope/);

    // Started from Orders (no ?return): unchanged behaviour.
    await saveOAuthState(env, 's2');
    assert.equal(await validateOAuthState(env, 's2'), '1');
    assert.equal(await validateOAuthState(env, 's2'), null, 'state is single-use');
});
