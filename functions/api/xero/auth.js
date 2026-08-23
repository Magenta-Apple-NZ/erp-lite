// GET /api/xero/auth — redirect browser to Xero OAuth consent screen

import { saveOAuthState } from '../_xero.js';

const SCOPES = [
    'openid',
    'accounting.transactions',   // invoices live under transactions (there is no accounting.invoices scope)
    'accounting.contacts',       // read + create contacts (push.js creates missing ones)
    'accounting.reports.read',   // P&L / dashboard report widgets
    'offline_access',
].join(' ');

export async function onRequestGet({ env, request }) {
    const state = crypto.randomUUID();
    await saveOAuthState(env, state);

    const redirectUri = 'https://hub.primetie.co.nz/api/xero/callback';
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.XERO_CLIENT_ID || '',
        redirect_uri: redirectUri,
        scope: SCOPES,
        state,
    });
    const authorizeUrl = 'https://login.xero.com/identity/connect/authorize?' + params.toString();

    // Diagnostic: /api/xero/auth?debug=1 shows exactly what we send to Xero
    // (client_id length only — never the value) instead of redirecting.
    if (new URL(request.url).searchParams.get('debug')) {
        const cid = env.XERO_CLIENT_ID || '';
        return new Response(JSON.stringify({
            clientId_present: !!cid,
            clientId_length: cid.length,
            redirect_uri: redirectUri,
            scope: SCOPES,
            authorizeUrl,
        }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    return Response.redirect(authorizeUrl, 302);
}
