// /api/feeds/status/<token> — Status feed for the New Tab Dashboard
// ("Status feeds" in the dashboard's NOTIFICATIONS.md).
//
// POST: a scheduled Claude routine pushes the computed statuses (CalibrateOS
//       pacing per client). The body is stored verbatim in KV, stamped with
//       updated_at. The Hub itself computes nothing here.
// GET:  the dashboard polls it. If the stored feed is older than
//       STALE_AFTER_H, a warn chip is prepended so a silently-failing
//       refresh is visible on the dashboard instead of showing stale greens.
//
// Auth: the token in the path must equal NOTIFY_FEED_TOKEN — the same
// credential class as the notifications feed. Like that path, this one needs
// its own Zero Trust bypass policy (the dashboard and the routine fetch
// without an Access session).

import { jsonResponse } from '../../_xero.js';

const KV_KEY = 'status_feed:pacing';
const STALE_AFTER_H = 48;
const EMPTY_FEED = {
    version: 1,
    source: { id: 'calibrate-pacing', name: 'Pacing', icon: '📊' },
    statuses: [],
};

function authorized(env, params) {
    return Boolean(env.NOTIFY_FEED_TOKEN) && params.token === env.NOTIFY_FEED_TOKEN;
}

export async function onRequestPost({ env, request, params }) {
    if (!authorized(env, params)) return jsonResponse({ error: 'Unauthorized' }, 401);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    if (body?.version !== 1 || typeof body?.source?.id !== 'string' || !body.source.id || !Array.isArray(body?.statuses)) {
        return jsonResponse({ error: 'Expected { version: 1, source: { id }, statuses: [] }' }, 400);
    }

    const record = { ...body, updated_at: new Date().toISOString() };
    await env.ORDERS_KV.put(KV_KEY, JSON.stringify(record));
    return jsonResponse({ ok: true, statuses: body.statuses.length, updated_at: record.updated_at });
}

export async function onRequestGet({ env, params }) {
    if (!authorized(env, params)) return jsonResponse({ error: 'Unauthorized' }, 401);

    const raw = await env.ORDERS_KV.get(KV_KEY);
    let feed = null;
    if (raw) {
        try { feed = JSON.parse(raw); } catch { feed = null; }
    }
    if (!feed) feed = EMPTY_FEED;

    const ageHours = (Date.now() - new Date(feed.updated_at || 0).getTime()) / 3600000;
    if (feed.updated_at && ageHours > STALE_AFTER_H) {
        feed = {
            ...feed,
            statuses: [
                {
                    id: 'feed-stale',
                    label: 'Pacing stale',
                    state: 'warn',
                    detail: `Last updated ${Math.round(ageHours)}h ago — the scheduled refresh may have failed`,
                },
                ...feed.statuses,
            ],
        };
    }

    return new Response(JSON.stringify(feed), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}
