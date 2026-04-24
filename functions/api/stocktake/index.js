// GET  /api/stocktake     — list all snapshots (summary only)
// POST /api/stocktake     — save a new snapshot

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

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const { label, date, items } = body;

        if (!Array.isArray(items) || items.length === 0) {
            return errResponse('items array is required', 400);
        }

        const id = 'stocktake-' + (date || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
        const total = items.reduce((s, i) => s + (Number(i.units) * Number(i.unitValue)), 0);

        const snapshot = {
            id,
            label: label || date || new Date().toISOString().slice(0, 10),
            date: date || new Date().toISOString().slice(0, 10),
            items: items.map(i => ({
                active:      Boolean(i.active),
                description: String(i.description || ''),
                accountCode: String(i.accountCode || ''),
                units:       Number(i.units) || 0,
                unitValue:   Number(i.unitValue) || 0,
                net:         Math.round((Number(i.units) || 0) * (Number(i.unitValue) || 0) * 100) / 100,
            })),
            total: Math.round(total * 100) / 100,
            createdAt: new Date().toISOString(),
        };

        await env.ORDERS_KV.put('stocktake:' + id, JSON.stringify(snapshot));

        // Update summary list
        const list = JSON.parse(await env.ORDERS_KV.get(LIST_KEY) || '[]');
        const existing = list.findIndex(s => s.id === id);
        const summary = { id, label: snapshot.label, date: snapshot.date, total: snapshot.total, createdAt: snapshot.createdAt };
        if (existing >= 0) list[existing] = summary;
        else list.unshift(summary);
        list.sort((a, b) => b.date.localeCompare(a.date));
        await env.ORDERS_KV.put(LIST_KEY, JSON.stringify(list));

        return jsonResponse(snapshot, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}
