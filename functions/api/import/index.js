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

        // If only setting/clearing the sheet URL (no rows), merge with existing
        if (body.sheetUrl !== undefined && !body.rows) {
            const existing = JSON.parse(await env.ORDERS_KV.get(KEY) || '{}');
            existing.sheetUrl = body.sheetUrl || null;
            await env.ORDERS_KV.put(KEY, JSON.stringify(existing));
            return jsonResponse({ ok: true, sheetUrl: existing.sheetUrl });
        }

        if (!Array.isArray(body.rows) || !body.rows.length) {
            return errResponse('rows array is required', 400);
        }

        // Preserve existing sheetUrl if not provided
        const existing = JSON.parse(await env.ORDERS_KV.get(KEY) || '{}');
        const schedule = {
            sheetUrl:     body.sheetUrl ?? existing.sheetUrl ?? null,
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
