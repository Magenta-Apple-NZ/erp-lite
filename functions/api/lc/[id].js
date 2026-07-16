import { jsonResponse, errResponse } from '../_xero.js';

export async function onRequestGet({ env, params }) {
    try {
        const lc = await env.ORDERS_KV.get('lc:' + params.id, { type: 'json' });
        if (!lc) return errResponse('LC not found', 404);
        return jsonResponse(lc);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPatch({ env, params, request }) {
    try {
        const lc = await env.ORDERS_KV.get('lc:' + params.id, { type: 'json' });
        if (!lc) return errResponse('LC not found', 404);

        const body = await request.json();

        // Deep-merge the three mutable state maps; shallow-merge everything else.
        const updated = {
            ...lc,
            ...body,
            id:          lc.id,       // immutable
            lcNumber:    lc.lcNumber, // immutable
            docStatus:  { ...lc.docStatus,  ...(body.docStatus  || {}) },
            docChecks:  { ...lc.docChecks,  ...(body.docChecks  || {}) },
            condChecks: { ...lc.condChecks, ...(body.condChecks || {}) },
            docLinks:   { ...lc.docLinks,   ...(body.docLinks   || {}) },
            updatedAt:  new Date().toISOString(),
        };

        await env.ORDERS_KV.put('lc:' + params.id, JSON.stringify(updated));
        return jsonResponse(updated);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestDelete({ env, params }) {
    try {
        const lc = await env.ORDERS_KV.get('lc:' + params.id, { type: 'json' });
        if (!lc) return errResponse('LC not found', 404);

        await env.ORDERS_KV.delete('lc:' + params.id);

        const raw = await env.ORDERS_KV.get('lc_index');
        const ids = raw ? JSON.parse(raw) : [];
        await env.ORDERS_KV.put('lc_index', JSON.stringify(ids.filter(i => i !== params.id)));

        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
