// GET  /api/catalog/stores       — returns stores array
// POST /api/catalog/stores       — replaces entire stores catalog

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'catalog:stores';

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get(KEY);
        return jsonResponse(raw ? JSON.parse(raw) : []);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const { stores } = await request.json();
        if (!Array.isArray(stores)) return errResponse('stores must be an array', 400);
        await env.ORDERS_KV.put(KEY, JSON.stringify(stores));
        return jsonResponse({ count: stores.length });
    } catch (e) {
        return errResponse(e.message);
    }
}
