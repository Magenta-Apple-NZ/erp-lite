// GET /api/import/export-docs/:shipmentId/file?key=<key> — a stored supplier PDF.

import { K, loadRecord } from '../_store.js';

export async function onRequestGet({ env, params, request }) {
    try {
        const key = new URL(request.url).searchParams.get('key') || '';
        if (!key.startsWith(params.id + ':')) return new Response('Not found', { status: 404 });
        const data = await env.ORDERS_KV.get(K.file(key));
        if (!data) return new Response('Not found', { status: 404 });
        const rec = await loadRecord(env, params.id);
        const meta = (rec.fileHistory || []).find(f => f.key === key);
        const filename = (meta?.filename || 'supplier.pdf').replace(/"/g, '');
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        return new Response(bytes, {
            headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'private, max-age=3600' },
        });
    } catch (e) {
        return new Response(e.message, { status: 500 });
    }
}
