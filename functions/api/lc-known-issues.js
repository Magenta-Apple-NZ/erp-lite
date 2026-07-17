function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}

const KV_KEY = 'lc_known_issues';

// GET /api/lc-known-issues
export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get(KV_KEY);
        return jsonResponse({ issues: raw ? JSON.parse(raw) : [] });
    } catch (e) {
        return errResponse(e.message);
    }
}

// POST /api/lc-known-issues — add a pattern
// body: { docType, docTitle, checkId, checkText, pattern }
export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const { docType, docTitle, checkId, checkText, pattern } = body;
        if (!pattern?.trim()) return errResponse('pattern is required', 400);

        const raw    = await env.ORDERS_KV.get(KV_KEY);
        const issues = raw ? JSON.parse(raw) : [];

        const id  = 'ki-' + Date.now();
        const item = {
            id,
            docType:   docType   || '',
            docTitle:  docTitle  || docType || '',
            checkId:   checkId   || '',
            checkText: checkText || '',
            pattern:   pattern.trim(),
            addedAt:   new Date().toISOString(),
        };

        issues.unshift(item);
        await env.ORDERS_KV.put(KV_KEY, JSON.stringify(issues));
        return jsonResponse({ ok: true, item }, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}

// DELETE /api/lc-known-issues?id=xxx
export async function onRequestDelete({ env, request }) {
    try {
        const id  = new URL(request.url).searchParams.get('id');
        if (!id) return errResponse('id required', 400);

        const raw    = await env.ORDERS_KV.get(KV_KEY);
        const issues = raw ? JSON.parse(raw) : [];
        const next   = issues.filter(i => i.id !== id);
        await env.ORDERS_KV.put(KV_KEY, JSON.stringify(next));
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
