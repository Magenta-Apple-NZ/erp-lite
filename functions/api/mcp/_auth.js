// Who may call /api/mcp. Unlike the rest of the Hub, this endpoint never
// trusts identity headers as-is: it may sit behind an Access bypass (for
// Claude Code with a token), where anyone could forge them. Two ways in:
//
//   1. Authorization: Bearer <MCP_TOKEN>  (Pages secret; Claude Code, scripts)
//   2. A Cloudflare Access JWT (Cf-Access-Jwt-Assertion), verified here
//      against the team's signing keys, audience and expiry. This is what a
//      claude.ai connector sends when Access is the OAuth provider in front
//      of the endpoint. Needs ACCESS_TEAM_DOMAIN (e.g.
//      primetie.cloudflareaccess.com) and ACCESS_AUD (the Access
//      application's audience tag).
//
// → { ok: true, user: { email, name, via } } or { ok: false, status, error }.

import { userFromEmail } from '../_users.js';

const CERTS_TTL_MS = 60 * 60 * 1000;
let certsCache = { url: null, at: 0, keys: [] };

const b64urlBytes = s => {
    const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

// Constant-time string compare (token check).
function safeEqual(a, b) {
    const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
    let diff = x.length ^ y.length;
    for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
    return diff === 0;
}

// Dashboard values pasted with a stray space, newline or wrapping quotes
// would otherwise fail every request as "wrong audience" or similar.
const setting = v => String(v ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
const teamHost = env => setting(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');

async function accessKeys(env, { refresh = false } = {}) {
    const url = `https://${teamHost(env)}/cdn-cgi/access/certs`;
    if (!refresh && certsCache.url === url && Date.now() - certsCache.at < CERTS_TTL_MS) return certsCache.keys;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Access certs ${r.status}`);
    const { keys = [] } = await r.json();
    certsCache = { url, at: Date.now(), keys };
    return keys;
}

// Verify an Access JWT. Returns its claims, or throws with the reason.
export async function verifyAccessJwt(jwt, env) {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const [h, p, sig] = parts;
    const header = b64urlJson(h), claims = b64urlJson(p);
    if (header.alg !== 'RS256') throw new Error('unexpected alg ' + header.alg);

    let jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env, { refresh: true })).find(k => k.kid === header.kid); // key rotation
    if (!jwk) throw new Error('unknown signing key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) throw new Error('bad signature');

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now - 30) throw new Error('expired');
    if (typeof claims.nbf === 'number' && claims.nbf > now + 30) throw new Error('not yet valid');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(setting(env.ACCESS_AUD))) throw new Error('wrong audience');
    if (claims.iss !== `https://${teamHost(env)}`) throw new Error('wrong issuer');
    return claims;
}

export async function authenticate(request, env) {
    const token     = setting(env.MCP_TOKEN);
    const hasToken  = !!token;
    const hasAccess = !!(teamHost(env) && setting(env.ACCESS_AUD));
    if (!hasToken && !hasAccess) {
        return { ok: false, status: 503, error: 'MCP is not configured: set MCP_TOKEN and/or ACCESS_TEAM_DOMAIN + ACCESS_AUD' };
    }

    const bearer = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (hasToken && bearer && safeEqual(bearer, token)) {
        return { ok: true, user: { email: null, name: 'MCP token', via: 'token' } };
    }

    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    if (hasAccess && jwt) {
        try {
            const claims = await verifyAccessJwt(jwt, env);
            // Access service tokens carry common_name instead of an email.
            if (claims.email) return { ok: true, user: { ...userFromEmail(claims.email), via: 'access' } };
            return { ok: true, user: { email: null, name: `Service token ${claims.common_name || ''}`.trim(), via: 'access' } };
        } catch (e) {
            return { ok: false, status: 401, error: 'Access token rejected: ' + e.message };
        }
    }
    return { ok: false, status: 401, error: 'Unauthorized' };
}

// Test hook: forget cached signing keys.
export function _resetCertsCache() { certsCache = { url: null, at: 0, keys: [] }; }
