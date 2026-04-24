// GET  /api/sales  — retrieve sales sheet config
// POST /api/sales  — save sheet URL

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'sales:config';

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get(KEY);
        return jsonResponse(raw ? JSON.parse(raw) : null);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const existing = JSON.parse(await env.ORDERS_KV.get(KEY) || '{}');
        if (body.sheetUrl !== undefined) existing.sheetUrl = body.sheetUrl || null;
        await env.ORDERS_KV.put(KEY, JSON.stringify(existing));
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
