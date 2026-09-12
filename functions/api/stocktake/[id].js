// GET /api/stocktake/:id — one legacy stocktake snapshot (read-only archive)

import { jsonResponse, errResponse } from '../_xero.js';

const LIST_KEY = 'stocktake:list';

export async function onRequestGet({ env, params }) {
    try {
        const snap = await env.ORDERS_KV.get('stocktake:' + params.id, { type: 'json' });
        if (!snap) return errResponse('Snapshot not found', 404);
        return jsonResponse(snap);
    } catch (e) {
        return errResponse(e.message);
    }
}
