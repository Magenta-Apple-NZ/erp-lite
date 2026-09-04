// GET /api/stock/items/:id/history?from=&to= — daily on-hand series plus the
// movements / receipts / counts that shaped it, for the trajectory chart.
// Defaults to the last 90 days ending today (NZ).

import { jsonResponse, errResponse } from '../../../_xero.js';
import { nzToday, addDays, isYmd } from '../../../_dates.js';
import { loadWorld } from '../../_store.js';
import { historyFor } from '../../_engine.js';

export async function onRequestGet({ env, params, request }) {
    try {
        const url = new URL(request.url);
        const to = isYmd(url.searchParams.get('to')) ? url.searchParams.get('to') : nzToday();
        const from = isYmd(url.searchParams.get('from')) ? url.searchParams.get('from') : addDays(to, -90);
        if (from > to) return errResponse('from must be ≤ to', 400);
        const world = await loadWorld(env);
        const item = world.items.find(i => i.id === params.id);
        if (!item) return errResponse('Item not found', 404);
        const epoch = world.settings.stockEpoch;
        if (to < epoch) return jsonResponse({ beforeEpoch: true, stockEpoch: epoch, from, to });
        return jsonResponse(historyFor(item, world, from < epoch ? epoch : from, to));
    } catch (e) {
        return errResponse(e.message);
    }
}
