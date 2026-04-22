// GET /api/xero/callback — Xero redirects here after user authorises

import { validateOAuthState, saveTokens } from '../_xero.js';

export async function onRequestGet({ env, request }) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
        return htmlRedirect('/#orders?xero_error=' + encodeURIComponent(error));
    }
    if (!code || !state) {
        return htmlRedirect('/#orders?xero_error=missing_params');
    }

    const stateOk = await validateOAuthState(env, state);
    if (!stateOk) {
        return htmlRedirect('/#orders?xero_error=invalid_state');
    }

    // Exchange code for tokens
    const tokenResp = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: env.XERO_REDIRECT_URI,
            client_id: env.XERO_CLIENT_ID,
            client_secret: env.XERO_CLIENT_SECRET,
        }),
    });

    if (!tokenResp.ok) {
        const msg = await tokenResp.text();
        return htmlRedirect('/#orders?xero_error=' + encodeURIComponent('token_exchange: ' + msg));
    }

    const tokenData = await tokenResp.json();

    // Get the tenant (organisation) ID
    const connectionsResp = await fetch('https://api.xero.com/connections', {
        headers: { 'Authorization': 'Bearer ' + tokenData.access_token },
    });

    if (!connectionsResp.ok) {
        return htmlRedirect('/#orders?xero_error=connections_failed');
    }

    const connections = await connectionsResp.json();
    if (!connections.length) {
        return htmlRedirect('/#orders?xero_error=no_xero_org');
    }

    // Use the first (and typically only) organisation
    const tenantId = connections[0].tenantId;
    await saveTokens(env, tokenData, tenantId);

    return htmlRedirect('/#orders?xero_connected=1');
}

function htmlRedirect(url) {
    // Use a meta-refresh so the hash fragment survives the redirect
    return new Response(
        `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${url}"></head><body></body></html>`,
        { headers: { 'Content-Type': 'text/html' } }
    );
}
