// GET /api/stock/items/:id/ledger?asOf= — the audit trail behind an item's
// on hand: baseline count, every order that consumed it, shipments landed,
// manual receipts / adjustments / wastage, with a running balance.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { nzToday, isYmd } from '../../../_dates.js';
import { loadWorld } from '../../_store.js';
import { ledgerFor } from '../../_engine.js';

export async function onRequestGet({ env, params, request }) {
    try {
        const url = new URL(request.url);
        const asOf = isYmd(url.searchParams.get('asOf')) ? url.searchParams.get('asOf') : nzToday();
        const world = await loadWorld(env);
        const item = world.items.find(i => i.id === params.id);
        if (!item) return errResponse('Item not found', 404);
        return jsonResponse({ name: item.name, unitLabel: item.unitLabel || null, ...ledgerFor(item, world, asOf) });
    } catch (e) {
        return errResponse(e.message);
    }
}
