function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}

// GET /api/lc-docs?lcId=xxx  — list archived docs for an LC
export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const lcId = url.searchParams.get('lcId');
        if (!lcId) return errResponse('lcId required', 400);
        const raw = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        const docs = raw ? JSON.parse(raw) : [];
        return jsonResponse({ docs });
    } catch (e) {
        return errResponse(e.message);
    }
}

// POST /api/lc-docs  — archive a document PDF
// body: { lcId, docType, docTitle, filename, data: base64 }
export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const { lcId, docType, docTitle, filename, data } = body;
        if (!lcId || !data) return errResponse('lcId and data required', 400);

        const key = `${lcId}-${docType}-${Date.now()}`;
        const meta = {
            key,
            docType,
            docTitle: docTitle || docType,
            filename: filename || 'document.pdf',
            uploadedAt: new Date().toISOString(),
        };

        await env.ORDERS_KV.put('lc-doc:' + key, data);

        const raw = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        const docs = raw ? JSON.parse(raw) : [];
        docs.unshift(meta);
        await env.ORDERS_KV.put('lc-doc-meta:' + lcId, JSON.stringify(docs));

        return jsonResponse({ ok: true, key, meta }, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}

// DELETE /api/lc-docs?key=xxx&lcId=xxx
export async function onRequestDelete({ env, request }) {
    try {
        const url = new URL(request.url);
        const key = url.searchParams.get('key');
        const lcId = url.searchParams.get('lcId');
        if (!key || !lcId) return errResponse('key and lcId required', 400);

        await env.ORDERS_KV.delete('lc-doc:' + key);

        const raw = await env.ORDERS_KV.get('lc-doc-meta:' + lcId);
        if (raw) {
            const docs = JSON.parse(raw).filter(d => d.key !== key);
            await env.ORDERS_KV.put('lc-doc-meta:' + lcId, JSON.stringify(docs));
        }

        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
