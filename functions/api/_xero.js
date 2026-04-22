// Shared Xero OAuth helper — imported by all Xero API functions.
// Handles token storage in KV and transparent refresh.

const TOKEN_KEY = 'tokens';
const STATE_TTL = 600; // 10 min OAuth state window

export async function getValidToken(env) {
    const stored = await env.XERO_KV.get(TOKEN_KEY, { type: 'json' });
    if (!stored) {
        throw new XeroAuthError('Xero not connected');
    }

    if (Date.now() < stored.expiresAt - 60_000) {
        return stored;
    }

    // Access token expired — refresh it
    const resp = await fetch('https://identity.xero.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: stored.refreshToken,
            client_id: env.XERO_CLIENT_ID,
            client_secret: env.XERO_CLIENT_SECRET,
        }),
    });

    if (!resp.ok) {
        const body = await resp.text();
        throw new XeroAuthError('Token refresh failed: ' + body);
    }

    const data = await resp.json();
    const refreshed = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
        tenantId: stored.tenantId,
    };
    await env.XERO_KV.put(TOKEN_KEY, JSON.stringify(refreshed));
    return refreshed;
}

export async function saveTokens(env, tokenData, tenantId) {
    const tokens = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
        tenantId,
    };
    await env.XERO_KV.put(TOKEN_KEY, JSON.stringify(tokens));
    return tokens;
}

export async function saveOAuthState(env, state) {
    await env.XERO_KV.put('oauth_state:' + state, '1', { expirationTtl: STATE_TTL });
}

export async function validateOAuthState(env, state) {
    const val = await env.XERO_KV.get('oauth_state:' + state);
    if (!val) return false;
    await env.XERO_KV.delete('oauth_state:' + state);
    return true;
}

export function xeroHeaders(token) {
    return {
        'Authorization': 'Bearer ' + token.accessToken,
        'Xero-tenant-id': token.tenantId,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
}

export class XeroAuthError extends Error {
    constructor(msg) { super(msg); this.name = 'XeroAuthError'; }
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}
