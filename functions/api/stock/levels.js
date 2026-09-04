// GET /api/stock/levels?asOf=YYYY-MM-DD — the one dashboard call (§6).
// Per active item: onHand, onOrder, avgDaily, daysCover, reorderPoint,
// status, covered, baselineDate. Returns { beforeEpoch: true } for dates
// before the stock epoch rather than zeros.

import { jsonResponse, errResponse } from '../_xero.js';
import { isYmd, nzToday } from '../_dates.js';
import { loadWorld } from './_store.js';
import { computeLevels, STATUS_ORDER } from './_engine.js';

export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const asOf = isYmd(url.searchParams.get('asOf')) ? url.searchParams.get('asOf') : nzToday();
        const world = await loadWorld(env);
        const levels = computeLevels(world, asOf);
        if (levels.beforeEpoch) return jsonResponse(levels);
        // Worst status first, then key products, then sort order.
        levels.items.sort((a, b) =>
            STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
            || (b.key ? 1 : 0) - (a.key ? 1 : 0)
            || a.sortOrder - b.sortOrder
            || a.name.localeCompare(b.name));
        return jsonResponse(levels);
    } catch (e) {
        return errResponse(e.message);
    }
}
