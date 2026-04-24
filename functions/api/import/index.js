// GET  /api/import  — retrieve stored import schedule
// POST /api/import  — save a new import schedule

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'import:schedule';

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
        if (!Array.isArray(body.rows) || !body.rows.length) {
            return errResponse('rows array is required', 400);
        }
        const schedule = {
            preparedDate: body.preparedDate || new Date().toISOString().slice(0, 10),
            savedAt:      new Date().toISOString(),
            rows:         body.rows,
            accountCodes: body.accountCodes || [39, 40, 41, 42, 43],
        };
        await env.ORDERS_KV.put(KEY, JSON.stringify(schedule));
        return jsonResponse({ ok: true, count: body.rows.length });
    } catch (e) {
        return errResponse(e.message);
    }
}
