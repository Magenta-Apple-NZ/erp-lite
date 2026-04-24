// GET   /api/stocktake/:id   — fetch full snapshot
// PATCH /api/stocktake/:id   — update items in snapshot
// DELETE /api/stocktake/:id  — remove snapshot

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

export async function onRequestPatch({ env, params, request }) {
    try {
        const snap = await env.ORDERS_KV.get('stocktake:' + params.id, { type: 'json' });
        if (!snap) return errResponse('Snapshot not found', 404);

        const { label, items } = await request.json();
        if (label !== undefined) snap.label = label;
        if (Array.isArray(items)) {
            snap.items = items.map(i => ({
                active:      Boolean(i.active),
                description: String(i.description || ''),
                accountCode: String(i.accountCode || ''),
                units:       Number(i.units) || 0,
                unitValue:   Number(i.unitValue) || 0,
                net:         Math.round((Number(i.units) || 0) * (Number(i.unitValue) || 0) * 100) / 100,
            }));
            snap.total = Math.round(snap.items.reduce((s, i) => s + i.net, 0) * 100) / 100;
        }
        snap.updatedAt = new Date().toISOString();

        await env.ORDERS_KV.put('stocktake:' + params.id, JSON.stringify(snap));

        // Keep summary list in sync
        const list = JSON.parse(await env.ORDERS_KV.get(LIST_KEY) || '[]');
        const idx = list.findIndex(s => s.id === params.id);
        if (idx >= 0) {
            list[idx] = { id: snap.id, label: snap.label, date: snap.date, total: snap.total, createdAt: snap.createdAt };
            await env.ORDERS_KV.put(LIST_KEY, JSON.stringify(list));
        }

        return jsonResponse(snap);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestDelete({ env, params }) {
    try {
        await env.ORDERS_KV.delete('stocktake:' + params.id);
        const list = JSON.parse(await env.ORDERS_KV.get(LIST_KEY) || '[]');
        await env.ORDERS_KV.put(LIST_KEY, JSON.stringify(list.filter(s => s.id !== params.id)));
        return jsonResponse({ deleted: params.id });
    } catch (e) {
        return errResponse(e.message);
    }
}
