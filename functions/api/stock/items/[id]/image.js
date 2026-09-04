// Item image, stored in KV (there is no blob storage on this Pages project).
//   GET    /api/stock/items/:id/image        → the image bytes
//   POST   /api/stock/items/:id/image        { data: <base64>, mediaType }  (≤ 400 KB)
//   DELETE /api/stock/items/:id/image
// The browser resizes to a thumbnail before uploading, so a photo is a few
// tens of KB. POST also points the item's profile.imageUrl at this endpoint.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { loadItem, saveItem, getJson, putJson } from '../../_store.js';

const key = id => 'stock:image:' + id;
const MAX_B64 = 400 * 1024;

export async function onRequestGet({ env, params }) {
    try {
        const img = await getJson(env, key(params.id), null);
        if (!img || !img.data) return new Response('Not found', { status: 404 });
        const bin = Uint8Array.from(atob(img.data), c => c.charCodeAt(0));
        return new Response(bin, { headers: { 'Content-Type': img.mediaType || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, params, request }) {
    try {
        const item = await loadItem(env, params.id);
        if (!item) return errResponse('Item not found', 404);
        const body = await request.json();
        const data = String(body.data || '').replace(/^data:[^;]+;base64,/, '');
        const mediaType = /^image\/(jpeg|png|webp|gif)$/.test(body.mediaType || '') ? body.mediaType : 'image/jpeg';
        if (!data) return errResponse('No image data', 400);
        if (data.length > MAX_B64) return errResponse('Image too large — the browser should have resized it', 413);
        await putJson(env, key(params.id), { mediaType, data, uploadedAt: new Date().toISOString() });
        const imageUrl = `/api/stock/items/${encodeURIComponent(params.id)}/image?v=${Date.now().toString(36)}`;
        const next = { ...item, profile: { ...(item.profile || {}), imageUrl }, updatedAt: new Date().toISOString() };
        await saveItem(env, next);
        return jsonResponse({ ok: true, imageUrl });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestDelete({ env, params }) {
    try {
        await env.ORDERS_KV.delete(key(params.id));
        const item = await loadItem(env, params.id);
        if (item && item.profile && String(item.profile.imageUrl || '').startsWith('/api/stock/items/')) {
            await saveItem(env, { ...item, profile: { ...item.profile, imageUrl: '' }, updatedAt: new Date().toISOString() });
        }
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
