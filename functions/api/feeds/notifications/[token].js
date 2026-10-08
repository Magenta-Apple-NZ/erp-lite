// GET /api/feeds/notifications/<token> — Notification Feed Spec v1 for the
// New Tab Dashboard. Same items as the Hub's Notifications view (see
// feeds/_notifications.js), served as JSON the dashboard polls.
//
// Auth: the token in the path must equal NOTIFY_FEED_TOKEN (Pages env var).
// Treat the full URL as a credential. The dashboard fetches without an
// Access session, so this path needs its own Zero Trust policy, the same
// way /api/orders/inbound does.

import { jsonResponse } from '../../_xero.js';
import { nzToday, addDays, nzMidnightIso } from '../../_dates.js';
import { loadGcalEvents } from '../../calendar/_gcal.js';
import { NZ_TAX } from '../../calendar/_nz-dates.js';
import { buildFeed, DEFAULT_SETTINGS } from '../_notifications.js';

async function loadOrders(env) {
    const indexRaw = await env.ORDERS_KV.get('orders_index');
    if (!indexRaw) return [];
    const ids = [...new Set(JSON.parse(indexRaw))];
    const orders = await Promise.all(ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' })));
    return orders.filter(Boolean);
}

async function loadShipments(env) {
    const raw = await env.ORDERS_KV.get('import:forecast');
    if (!raw) return [];
    try { return JSON.parse(raw).shipments || []; } catch { return []; }
}

// config.json → notifications, read through the static-asset binding so the
// feed honours the same keywords / lookahead the Hub UI uses.
async function loadSettings(env, request) {
    try {
        if (!env.ASSETS) return DEFAULT_SETTINGS;
        const r = await env.ASSETS.fetch(new URL('/config.json', request.url));
        if (!r.ok) return DEFAULT_SETTINGS;
        const cfg = await r.json();
        return { ...DEFAULT_SETTINGS, ...(cfg.notifications || {}) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export async function onRequestGet({ env, request, params }) {
    const expected = env.NOTIFY_FEED_TOKEN;
    if (!expected || !params.token || params.token !== expected) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const today = nzToday();
    const settings = await loadSettings(env, request);
    const back  = Number(settings.lookbackDays)  || 30;
    const ahead = Number(settings.lookaheadDays) || 7;

    const [ordersRes, shipsRes, gcalRes] = await Promise.allSettled([
        loadOrders(env),
        loadShipments(env),
        loadGcalEvents(env, {
            timeMin: nzMidnightIso(addDays(today, -back)),
            timeMax: nzMidnightIso(addDays(today, ahead + 1)),
        }),
    ]);

    const feed = buildFeed({
        orders:     ordersRes.status === 'fulfilled' ? ordersRes.value : [],
        shipments:  shipsRes.status  === 'fulfilled' ? shipsRes.value  : [],
        gcalEvents: gcalRes.status   === 'fulfilled' ? gcalRes.value   : null,
        taxDates:   NZ_TAX,
        settings,
        today,
        baseUrl:    new URL(request.url).origin,
    });

    return new Response(JSON.stringify(feed), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}
