// Settings → Integrations: one live health check per outside service the Hub
// talks to. GET /api/integrations runs them all in parallel (integrations.js);
// tests in tests/integrations.test.js stub fetch and env.
//
// Each check returns
//   { id, name, group, usedFor, status, summary, details:[{label, value, copy?}],
//     permissions?:[{scope, purpose, granted}], actions:[{label, href|tab, primary?}] }
// status: ok (working) · warn (working, needs a look) · error (broken) · off (not set up).
// Never returns a secret: only whether one is set, and non-secret names/addresses.

import { getValidToken, XERO_SCOPES } from './_xero.js';
import { serviceAccountInfo, getGdriveToken } from './_gdrive.js';
import { fetchGcalEvents } from './calendar/_gcal.js';
import { loadItemsMap } from './catalog/items.js';
import { loadFreightRates } from './_freight.js';
import { courierConfigured, isMockMode } from './_courier.js';
import { printNodeHeaders } from './print/_printnode.js';
import { nzYmd } from './_dates.js';

export const CLAUDE_MODEL = 'claude-sonnet-5';   // the model every extractor calls
export const CHECK_TIMEOUT_MS = 8000;
const FEED_STALE_HOURS = 48;
const STATUS_ORDER = ['error', 'warn', 'off', 'ok'];

// ── Pure helpers ──

// Claims of a JWT (no signature check — display only). null if not a JWT.
export function jwtClaims(token) {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    try {
        const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4)));
    } catch { return null; }
}

// The accounting permissions the Hub asks for, ticked against what the
// current Xero connection was granted (granted: null when unknown).
export function scopeReport(granted, wanted = XERO_SCOPES) {
    const have = granted == null ? null : new Set(Array.isArray(granted) ? granted : String(granted).split(/\s+/));
    const list = wanted.filter(s => s.scope.startsWith('accounting.'))
        .map(s => ({ scope: s.scope, purpose: s.purpose, granted: have ? have.has(s.scope) : null }));
    return { list, missing: list.filter(s => s.granted === false) };
}

// "15 Nov 2026" in New Zealand time.
export function fmtNzDate(iso) {
    const ymd = iso ? nzYmd(iso) : null;
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${y}`;
}

export function summarise(items) {
    const n = s => items.filter(i => i.status === s).length;
    const counts = { ok: n('ok'), warn: n('warn'), error: n('error'), off: n('off'), total: items.length };
    const parts = [];
    if (counts.error) parts.push(`${counts.error} not working`);
    if (counts.warn) parts.push(`${counts.warn} need${counts.warn === 1 ? 's' : ''} a look`);
    if (counts.off) parts.push(`${counts.off} not set up`);
    counts.headline = parts.length ? `${counts.ok} of ${counts.total} working · ${parts.join(' · ')}` : `All ${counts.total} working`;
    counts.worst = STATUS_ORDER.find(s => counts[s]) || 'ok';
    return counts;
}

export function withTimeout(promise, ms = CHECK_TIMEOUT_MS) {
    let t;
    return Promise.race([
        promise,
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`No answer within ${Math.round(ms / 1000)}s`)), ms); }),
    ]).finally(() => clearTimeout(t));
}

const set = v => (v ? 'Set' : 'Not set');

// ── Checks ──

async function checkXero(env) {
    const base = { id: 'xero', name: 'Xero', group: 'Accounting',
        usedFor: 'Invoices from orders, payment sync, AR alerts and the P&L widget; shipment bills and remittances' };
    const href = '/api/xero/auth?return=integrations';
    if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) {
        return { ...base, status: 'error', summary: 'XERO_CLIENT_ID / XERO_CLIENT_SECRET are not set in Cloudflare Pages', details: [], actions: [] };
    }
    const stored = await env.XERO_KV.get('tokens', { type: 'json' });
    if (!stored) {
        return { ...base, status: 'off', summary: 'Not connected', details: [], permissions: scopeReport(null).list,
            actions: [{ label: 'Connect Xero', href, primary: true }] };
    }
    let token;
    try { token = await getValidToken(env); }
    catch (e) {
        return { ...base, status: 'error', summary: e.message.replace(/ at \/api\/xero\/auth/, ''), details: [],
            permissions: scopeReport(null).list, actions: [{ label: 'Reconnect Xero', href, primary: true }] };
    }
    const claims = jwtClaims(token.accessToken);
    const report = scopeReport(claims ? (claims.scope ?? []) : null);

    const res = await fetch('https://api.xero.com/connections', { headers: { Authorization: 'Bearer ' + token.accessToken } });
    if (res.status === 401 || res.status === 403) {
        return { ...base, status: 'error', summary: 'Xero refused the saved connection — reconnect', details: [],
            permissions: report.list, actions: [{ label: 'Reconnect Xero', href, primary: true }] };
    }
    if (!res.ok) throw new Error(`Xero connections ${res.status}`);
    const conns = await res.json().catch(() => []);
    const conn = (Array.isArray(conns) ? conns : []).find(c => c.tenantId === token.tenantId) || conns[0] || null;
    const org = conn?.tenantName || 'Xero';

    const details = [{ label: 'Organisation', value: org }];
    const authorised = conn?.updatedDateUtc || conn?.createdDateUtc;
    // Xero prints e.g. "2026-11-15T01:02:03.1833130" (UTC, no zone, 7 decimals).
    if (authorised) details.push({ label: 'Authorised', value: fmtNzDate(String(authorised).replace(/\.\d+/, '').replace(/Z?$/, 'Z')) });
    if (report.missing.length) {
        return { ...base, status: 'warn',
            summary: `Connected to ${org}, but missing ${report.missing.length === 1 ? 'a permission' : report.missing.length + ' permissions'} — reconnect to allow ${report.missing.map(m => m.purpose.split(' (')[0].toLowerCase()).join(' and ')}`,
            details, permissions: report.list, actions: [{ label: 'Reconnect to allow', href, primary: true }] };
    }
    return { ...base, status: 'ok', summary: `Connected to ${org}`, details, permissions: report.list,
        actions: [{ label: 'Reconnect', href }] };
}

async function checkCalendar(env) {
    const base = { id: 'gcal', name: 'Google Calendar', group: 'Google', usedFor: 'The Calendar view, the dashboard and the notifications feed' };
    const href = '/api/calendar/auth?return=integrations';
    if (!env.GCAL_CLIENT_ID || !env.GCAL_CLIENT_SECRET) {
        return { ...base, status: 'off', summary: 'Not set up — GCAL_CLIENT_ID / GCAL_CLIENT_SECRET are not set', details: [], actions: [] };
    }
    if (!(await env.XERO_KV.get('gcal:tokens'))) {
        return { ...base, status: 'off', summary: 'Not connected', details: [], actions: [{ label: 'Connect Google Calendar', href, primary: true }] };
    }
    const now = Date.now();
    const r = await fetchGcalEvents(env, { timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86400000).toISOString() });
    if (!r.ok) {
        return { ...base, status: 'error', summary: 'Connected, but Google refused: ' + (r.error || r.status), details: [],
            actions: [{ label: 'Reconnect Google Calendar', href, primary: true }] };
    }
    return { ...base, status: 'ok', summary: `Connected · ${r.items.length} event${r.items.length === 1 ? '' : 's'} in the next 7 days`,
        details: [{ label: 'Calendar', value: 'Primary calendar, read-only' }], actions: [{ label: 'Reconnect', href }] };
}

async function checkDrive(env) {
    const base = { id: 'gdrive', name: 'Google Drive', group: 'Google', usedFor: "Filing LC documents into each shipment's Drive folder" };
    const info = serviceAccountInfo(env);
    if (!info.configured) return { ...base, status: 'off', summary: 'Not set up — add the service account key as GDRIVE_SA_KEY', details: [], actions: [] };
    const details = info.email ? [{ label: 'Service account', value: info.email, copy: true },
        { label: 'Folders', value: 'Share each shipment / LC folder with the service account (Content manager on a Shared Drive)' }] : [];
    if (info.error) return { ...base, status: 'error', summary: info.error, details, actions: [] };
    await getGdriveToken(env.GDRIVE_SA_KEY);
    return { ...base, status: 'ok', summary: 'Service account signs in', details, actions: [] };
}

async function checkSheets(env) {
    const base = { id: 'sheets', name: 'Catalogue sheets', group: 'Google', usedFor: 'Products (SKU, kg, type and size, prices) and freight rates, read live from the published Google Sheet' };
    const [items, freight] = await Promise.allSettled([loadItemsMap(env), loadFreightRates(env)]);
    const details = [
        { label: 'Products', value: items.status === 'fulfilled' ? `${items.value.size} SKUs` : 'Not readable: ' + items.reason?.message },
        { label: 'Freight rates', value: freight.status === 'fulfilled' ? `${freight.value.length} rows` : 'Not readable: ' + freight.reason?.message },
        { label: 'Source', value: env.CATALOG_ITEMS_CSV_URL || env.CATALOG_FREIGHT_CSV_URL ? 'Sheet URLs set in Cloudflare Pages' : 'Built-in published sheet' },
    ];
    const failed = [items, freight].filter(r => r.status === 'rejected').length;
    if (failed) return { ...base, status: 'error', summary: failed === 2 ? 'The sheet could not be read' : 'Part of the sheet could not be read', details, actions: [] };
    if (!items.value.size) return { ...base, status: 'warn', summary: 'The products sheet is empty', details, actions: [] };
    return { ...base, status: 'ok', summary: `Reading ${items.value.size} products and ${freight.value.length} freight rows`, details, actions: [] };
}

async function loadConfig(env, origin) {
    if (!env.ASSETS || !origin) return null;
    try {
        const r = await env.ASSETS.fetch(new URL('/config.json', origin));
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

async function checkPrintNode(env, { origin }) {
    const base = { id: 'printnode', name: 'PrintNode', group: 'Dispatch', usedFor: 'Printing packing slips, address sheets and courier labels at the depot' };
    const actions = [{ label: 'Printers', tab: 'printers' }];
    if (!env.PRINTNODE_API_KEY) return { ...base, status: 'off', summary: 'Not set up — add PRINTNODE_API_KEY', details: [], actions: [] };
    const res = await fetch('https://api.printnode.com/printers', { headers: printNodeHeaders(env.PRINTNODE_API_KEY) });
    if (res.status === 401 || res.status === 403) return { ...base, status: 'error', summary: 'PrintNode rejected the API key', details: [], actions };
    if (!res.ok) throw new Error(`PrintNode ${res.status}`);
    const printers = await res.json();
    const byId = new Map(printers.map(p => [Number(p.id), p]));
    const configured = (await loadConfig(env, origin))?.printers || [];
    const details = configured.map(c => {
        const p = byId.get(Number(c.id));
        return { label: c.label, value: p ? `${p.state || 'unknown'} · ${p.name}${p.computer?.name ? ' on ' + p.computer.name : ''}` : 'Not on the PrintNode account' };
    });
    const others = printers.filter(p => !configured.some(c => Number(c.id) === Number(p.id))).length;
    if (others) details.push({ label: 'Other printers', value: `${others} on the account, not used by the Hub` });
    const down = configured.filter(c => byId.get(Number(c.id))?.state !== 'online');
    const online = printers.filter(p => p.state === 'online').length;
    if (down.length) {
        return { ...base, status: 'warn', summary: `${down.map(c => c.label).join(' and ')} ${down.length === 1 ? 'is' : 'are'} not online`, details, actions };
    }
    if (!configured.length && printers.length && !online) {
        return { ...base, status: 'warn', summary: `None of the ${printers.length} printers is online`, details, actions };
    }
    return { ...base, status: 'ok', summary: configured.length ? `${configured.length === 1 ? 'The Hub printer is' : `All ${configured.length} Hub printers are`} online` : `${online} of ${printers.length} printers online`, details, actions };
}

function checkCourier(env) {
    const base = { id: 'courier', name: 'Post Haste (GoSweetSpot)', group: 'Dispatch', usedFor: 'Booking courier consignments and printing labels' };
    if (!courierConfigured(env)) {
        return { ...base, status: 'off', summary: 'Not set up — labels are mocked until GSS_ACCESS_KEY and GSS_SITE_ID are set', details: [], actions: [] };
    }
    const details = [{ label: 'Access key', value: 'Set' }, { label: 'Site ID', value: 'Set' }];
    if (isMockMode(env)) {
        return { ...base, status: 'warn', summary: 'Test mode — labels are mocked and nothing is booked (COURIER_TEST_MODE)', details, actions: [] };
    }
    return { ...base, status: 'ok', summary: 'Live — every label books a real, billable consignment', details, actions: [] };
}

async function checkAnthropic(env) {
    const base = { id: 'anthropic', name: 'Claude API', group: 'Claude', usedFor: 'Reading customer POs, LC documents, Pistoni and JPS documents, and remittances' };
    if (!env.ANTHROPIC_API_KEY) return { ...base, status: 'off', summary: 'Not set up — add ANTHROPIC_API_KEY', details: [], actions: [] };
    const res = await fetch('https://api.anthropic.com/v1/models/' + CLAUDE_MODEL, {
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    });
    const details = [{ label: 'Model', value: CLAUDE_MODEL }];
    if (res.status === 401 || res.status === 403) return { ...base, status: 'error', summary: 'Anthropic rejected the API key', details, actions: [] };
    if (res.status === 404) return { ...base, status: 'error', summary: `${CLAUDE_MODEL} is not available to this API key`, details, actions: [] };
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const m = await res.json().catch(() => ({}));
    return { ...base, status: 'ok', summary: `Key works · ${m.display_name || CLAUDE_MODEL} available`, details, actions: [] };
}

function checkMcp(env, { origin }) {
    const base = { id: 'mcp', name: 'Claude connector (MCP)', group: 'Claude', usedFor: 'Read-only orders, sales, stock, shipments and receivables in Claude' };
    const token = !!env.MCP_TOKEN, access = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
    const details = [
        { label: 'Server URL', value: (origin || 'https://hub.primetie.co.nz') + '/api/mcp', copy: true },
        { label: 'Claude Code token', value: set(token) },
        { label: 'claude.ai sign-in (Cloudflare Access)', value: set(access) },
    ];
    if (!token && !access) return { ...base, status: 'off', summary: 'Not set up — set MCP_TOKEN, or ACCESS_TEAM_DOMAIN and ACCESS_AUD', details, actions: [] };
    return { ...base, status: 'ok', summary: token && access ? 'Open to Claude Code and claude.ai' : token ? 'Open to Claude Code (token)' : 'Open to claude.ai (Cloudflare Access)', details, actions: [] };
}

function checkExtension(env, { origin }) {
    const base = { id: 'extension', name: 'Chrome extension', group: 'Feeds & webhooks', usedFor: 'Sending customer POs from the browser straight into Orders' };
    const details = [{ label: 'Endpoint', value: (origin || 'https://hub.primetie.co.nz') + '/api/orders/inbound', copy: true }];
    if (!env.HUB_WEBHOOK_KEY) return { ...base, status: 'off', summary: 'Not set up — add HUB_WEBHOOK_KEY', details, actions: [] };
    return { ...base, status: 'ok', summary: 'Key set — orders arrive as New', details, actions: [] };
}

async function checkFeeds(env, { now }) {
    const base = { id: 'feeds', name: 'New Tab Dashboard feeds', group: 'Feeds & webhooks', usedFor: 'Notifications and the pacing status feed on the New Tab Dashboard' };
    if (!env.NOTIFY_FEED_TOKEN) return { ...base, status: 'off', summary: 'Not set up — add NOTIFY_FEED_TOKEN', details: [], actions: [] };
    const feed = await env.ORDERS_KV.get('status_feed:pacing', { type: 'json' });
    const at = feed?.updated_at || null;
    const details = [
        { label: 'Notifications feed', value: 'On' },
        { label: 'Pacing feed', value: at ? `Updated ${fmtNzDate(at)}` : 'Nothing pushed yet' },
    ];
    const ageH = at ? (now - Date.parse(at)) / 3600000 : null;
    if (ageH != null && ageH > FEED_STALE_HOURS) {
        return { ...base, status: 'warn', summary: `The pacing feed hasn't been updated for ${Math.floor(ageH / 24)} days`, details, actions: [] };
    }
    return { ...base, status: 'ok', summary: 'Token set — feeds are being served', details, actions: [] };
}

// In page order. The id / name / group here label the card when a check throws or hangs.
export const CHECKS = [
    { id: 'xero',      name: 'Xero',                     group: 'Accounting',       run: checkXero },
    { id: 'gcal',      name: 'Google Calendar',          group: 'Google',           run: checkCalendar },
    { id: 'gdrive',    name: 'Google Drive',             group: 'Google',           run: checkDrive },
    { id: 'sheets',    name: 'Catalogue sheets',         group: 'Google',           run: checkSheets },
    { id: 'printnode', name: 'PrintNode',                group: 'Dispatch',         run: checkPrintNode },
    { id: 'courier',   name: 'Post Haste (GoSweetSpot)', group: 'Dispatch',         run: checkCourier },
    { id: 'anthropic', name: 'Claude API',               group: 'Claude',           run: checkAnthropic },
    { id: 'mcp',       name: 'Claude connector (MCP)',   group: 'Claude',           run: checkMcp },
    { id: 'extension', name: 'Chrome extension',         group: 'Feeds & webhooks', run: checkExtension },
    { id: 'feeds',     name: 'New Tab Dashboard feeds',  group: 'Feeds & webhooks', run: checkFeeds },
];

// Every check in parallel; one that throws or hangs becomes an error card.
export async function checkAll(env, { origin = null, now = Date.now(), timeoutMs = CHECK_TIMEOUT_MS } = {}) {
    const integrations = await Promise.all(CHECKS.map(async c => {
        try { return await withTimeout(Promise.resolve().then(() => c.run(env, { origin, now })), timeoutMs); }
        catch (e) {
            return { id: c.id, name: c.name, group: c.group, usedFor: '', status: 'error', summary: e.message || String(e), details: [], actions: [] };
        }
    }));
    return { checkedAt: new Date(now).toISOString(), summary: summarise(integrations), integrations };
}
