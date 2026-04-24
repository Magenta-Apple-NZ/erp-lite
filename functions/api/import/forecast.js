// GET  /api/import/forecast — retrieve Prime Ties stock forecast config
// POST /api/import/forecast — patch forecast config (startingKg, monthlyAvg, shipments)

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'import:forecast';

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get(KEY);
        return jsonResponse(raw ? JSON.parse(raw) : {});
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const existing = JSON.parse(await env.ORDERS_KV.get(KEY) || '{}');
        if (body.startingKg !== undefined) existing.startingKg = body.startingKg;
        if (body.monthlyAvg !== undefined) existing.monthlyAvg = body.monthlyAvg;
        if (body.shipments  !== undefined) existing.shipments  = body.shipments;
        await env.ORDERS_KV.put(KEY, JSON.stringify(existing));
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
