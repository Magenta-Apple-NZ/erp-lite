// Signature and seal images for the proforma invoice, stored in KV.
//   GET    /api/import/export-docs/settings/signature|seal  → image bytes
//   POST   { data: <base64>, mediaType }  (≤ 600 KB; the browser downsizes first)
//   DELETE

import { jsonResponse, errResponse } from '../../../_xero.js';
import { K, ASSET_NAMES, getJson, putJson } from '../_store.js';

const MAX_B64 = 600 * 1024;

export async function onRequestGet({ env, params }) {
    if (!ASSET_NAMES.includes(params.asset)) return new Response('Not found', { status: 404 });
    const a = await getJson(env, K.asset(params.asset), null);
    if (!a?.data) return new Response('Not found', { status: 404 });
    return new Response(Uint8Array.from(atob(a.data), c => c.charCodeAt(0)), { headers: { 'Content-Type': a.mediaType || 'image/png', 'Cache-Control': 'private, no-store' } });
}

export async function onRequestPost({ env, params, request }) {
    try {
        if (!ASSET_NAMES.includes(params.asset)) return errResponse('Unknown image', 404);
        const body = await request.json();
        const data = String(body.data || '').replace(/^data:[^;]+;base64,/, '');
        const mediaType = /^image\/(png|jpeg|webp)$/.test(body.mediaType || '') ? body.mediaType : 'image/png';
        if (!data) return errResponse('No image data', 400);
        if (data.length > MAX_B64) return errResponse('Image too large', 413);
        await putJson(env, K.asset(params.asset), { mediaType, data, uploadedAt: new Date().toISOString() });
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestDelete({ env, params }) {
    if (!ASSET_NAMES.includes(params.asset)) return errResponse('Unknown image', 404);
    await env.ORDERS_KV.delete(K.asset(params.asset));
    return jsonResponse({ ok: true });
}
