// GET  /api/catalog/items        — returns items array
// POST /api/catalog/items        — replaces entire items catalog

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'catalog:items';

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
        const { items } = await request.json();
        if (!Array.isArray(items)) return errResponse('items must be an array', 400);
        await env.ORDERS_KV.put(KEY, JSON.stringify(items));
        return jsonResponse({ count: items.length });
    } catch (e) {
        return errResponse(e.message);
    }
}
