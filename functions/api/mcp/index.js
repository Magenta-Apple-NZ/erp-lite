// /api/mcp — the Hub as a remote MCP server (read-only tools).
//
// POST  JSON-RPC message or batch → JSON response (202 for notifications only)
// GET   405: no server-initiated stream (stateless server)
//
// Auth is checked here on every request (see _auth.js): a bearer MCP_TOKEN or
// a verified Cloudflare Access JWT. Protocol in _server.js, tools in _tools.js.

import { authenticate } from './_auth.js';
import { handleMessage } from './_server.js';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
});

export async function onRequestPost({ env, request }) {
    const auth = await authenticate(request, env);
    if (!auth.ok) {
        return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: auth.error } }, auth.status,
            auth.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="business-hub-mcp"' } : {});
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

    const ctx = { env, user: auth.user };
    if (Array.isArray(body)) {
        if (!body.length) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch' } }, 400);
        const replies = (await Promise.all(body.map(m => handleMessage(m, ctx)))).filter(Boolean);
        return replies.length ? json(replies) : new Response(null, { status: 202 });
    }
    const reply = await handleMessage(body, ctx);
    return reply ? json(reply) : new Response(null, { status: 202 });
}

export async function onRequestGet() {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}

export async function onRequestDelete() {
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
