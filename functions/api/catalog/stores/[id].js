// PATCH  /api/catalog/stores/:id  — update editable fields on one store
// DELETE /api/catalog/stores/:id  — soft-delete (archived: true). The row
//                                   stays in KV so historical references
//                                   (sales rows, orders) can still resolve.

import { jsonResponse, errResponse } from '../../_xero.js';

const EDITABLE_FIELDS = ['customerCode', 'customer', 'branch', 'city', 'address', 'postcode', 'phone'];

async function loadStores(env) {
    const raw = await env.ORDERS_KV.get('stores');
    return raw ? JSON.parse(raw) : [];
}

async function saveStores(env, stores) {
    await env.ORDERS_KV.put('stores', JSON.stringify(stores));
}

export async function onRequestPatch({ env, params, request }) {
    try {
        const stores = await loadStores(env);
        const idx = stores.findIndex(s => s.id === params.id);
        if (idx < 0) return errResponse('Store not found', 404);

        const updates = await request.json();
        const current = stores[idx];
        const next = { ...current };
        for (const k of EDITABLE_FIELDS) {
            if (updates[k] !== undefined) next[k] = String(updates[k] || '').trim();
        }
        if (updates.archived !== undefined) next.archived = !!updates.archived;
        next.updatedAt = new Date().toISOString();

        stores[idx] = next;
        await saveStores(env, stores);
        return jsonResponse(next);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestDelete({ env, params }) {
    try {
        const stores = await loadStores(env);
        const idx = stores.findIndex(s => s.id === params.id);
        if (idx < 0) return errResponse('Store not found', 404);
        stores[idx] = { ...stores[idx], archived: true, updatedAt: new Date().toISOString() };
        await saveStores(env, stores);
        return jsonResponse({ archived: params.id });
    } catch (e) {
        return errResponse(e.message);
    }
}
