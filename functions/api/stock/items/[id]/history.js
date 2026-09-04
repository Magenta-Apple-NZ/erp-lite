// GET /api/stock/items/:id/history?from=&to=&project=12 — daily on-hand
// series (actuals) plus the movements / receipts / counts that shaped it,
// and, with ?project=N, a month-end projection N months ahead on the shared
// seasonal forecast (Average / Good / Great). Defaults: from the stock epoch
// (or 365 days back, whichever is later) to today (NZ).

import { jsonResponse, errResponse } from '../../../_xero.js';
import { nzToday, addDays, isYmd } from '../../../_dates.js';
import { loadWorld, getJson } from '../../_store.js';
import { historyFor, projectionFor } from '../../_engine.js';

export async function onRequestGet({ env, params, request }) {
    try {
        const url = new URL(request.url);
        const to = isYmd(url.searchParams.get('to')) ? url.searchParams.get('to') : nzToday();
        const project = Math.max(0, Math.min(24, parseInt(url.searchParams.get('project') || '0', 10) || 0));
        const world = await loadWorld(env);
        const item = world.items.find(i => i.id === params.id);
        if (!item) return errResponse('Item not found', 404);
        const epoch = world.settings.stockEpoch;
        const yearBack = addDays(to, -365);
        const from = isYmd(url.searchParams.get('from')) ? url.searchParams.get('from') : (yearBack > epoch ? yearBack : epoch);
        if (from > to) return errResponse('from must be ≤ to', 400);
        if (to < epoch) return jsonResponse({ beforeEpoch: true, stockEpoch: epoch, from, to });
        const out = historyFor(item, world, from < epoch ? epoch : from, to);
        if (project) {
            const cfg = await getJson(env, 'import:forecast', null);
            out.projection = projectionFor(item, world, { monthlyAvg: cfg && Array.isArray(cfg.monthlyAvg) ? cfg.monthlyAvg : null, today: to, months: project });
        }
        return jsonResponse(out);
    } catch (e) {
        return errResponse(e.message);
    }
}
