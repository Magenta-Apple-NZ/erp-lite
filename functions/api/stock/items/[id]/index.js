// GET   /api/stock/items/:id — one item
// PATCH /api/stock/items/:id — edit. id/class never change; unit is locked
//                              once the item appears on a committed count.
//                              Soft-delete via active:false (no DELETE).

import { jsonResponse, errResponse } from '../../../_xero.js';
import { loadItem, saveItem, loadCommittedCounts } from '../../_store.js';
import { validateItemFields, UNITS } from '../index.js';

export async function onRequestGet({ env, params }) {
    try {
        const item = await loadItem(env, params.id);
        if (!item) return errResponse('Item not found', 404);
        return jsonResponse(item);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPatch({ env, params, request }) {
    try {
        const item = await loadItem(env, params.id);
        if (!item) return errResponse('Item not found', 404);
        const body = await request.json();
        if (body.id !== undefined && body.id !== item.id) return errResponse('id cannot change', 400);
        if (body.class !== undefined && body.class !== item.class) return errResponse('class cannot change', 400);

        const v = validateItemFields(body, { partial: true });
        if (v.error) return errResponse(v.error, 400);

        if (body.unit !== undefined && body.unit !== item.unit) {
            if (!UNITS.includes(body.unit)) return errResponse('unit must be kg or each', 400);
            const counts = await loadCommittedCounts(env);
            const counted = counts.some(c => (c.lines || []).some(l => l.itemId === item.id && l.counted !== false && l.countedQty != null));
            if (counted) return errResponse('unit is locked once the item has been counted', 409);
            v.fields.unit = body.unit;
        }

        const next = { ...item, ...v.fields, updatedAt: new Date().toISOString() };
        await saveItem(env, next);
        return jsonResponse(next);
    } catch (e) {
        return errResponse(e.message);
    }
}
