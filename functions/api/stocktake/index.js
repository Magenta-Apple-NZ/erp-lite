// GET /api/stocktake — list legacy stocktake snapshots (read-only archive;
// superseded by /api/stock/counts — see Stock-Rebuild.md §3.6)

import { jsonResponse, errResponse } from '../_xero.js';

const LIST_KEY = 'stocktake:list';

export async function onRequestGet({ env }) {
    try {
        const list = JSON.parse(await env.ORDERS_KV.get(LIST_KEY) || '[]');
        return jsonResponse(list);
    } catch (e) {
        return errResponse(e.message);
    }
}
