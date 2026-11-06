// Who is making this request — from Cloudflare Access, never from the body.
// Shared by /api/me (frontend identity) and the order activity log (audit
// attribution), so both name people the same way.

// Email → { name, role }. Anyone not listed defaults to admin and a name
// derived from the email prefix. Frontend hides nav/views based on role
// (UX-only, not access enforcement) and uses `name` for dispatch attribution.
const USER_MAP = {
    'tetleyshed@gmail.com': { name: 'Jake', role: 'warehouse' },
};

// Decode the CF Access JWT payload. CF's edge already verified the signature
// before forwarding the request, so we trust it and just read the claims.
function emailFromJwt(jwt) {
    if (!jwt) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        return payload.email || null;
    } catch {
        return null;
    }
}

// → { email, name, role }; email null (name 'Unknown') when Access didn't
// authenticate the request (local dev, webhooks).
export function userFromRequest(request) {
    // Cloudflare *may* set CF-Access-Authenticated-User-Email if the app config
    // forwards identity headers, but it's optional. The JWT is always there
    // when Access has authenticated the request, so prefer that.
    const h = request?.headers;
    const email = h?.get('CF-Access-Authenticated-User-Email')
        || emailFromJwt(h?.get('Cf-Access-Jwt-Assertion'));
    return userFromEmail(email);
}

// Map a (verified or trusted) email to { email, name, role }.
export function userFromEmail(email) {
    if (!email) return { email: null, name: 'Unknown', role: 'admin' };
    const mapped = USER_MAP[email.toLowerCase()];
    const role = mapped?.role || 'admin';
    const name = mapped?.name
        || email.split('@')[0].split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    return { email, name, role };
}
