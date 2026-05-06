// GET /api/me — returns the current user's identity from Cloudflare Access JWT

// Email → role. Anyone not listed defaults to 'admin'.
// Frontend hides nav/views based on role; this is UX-only, not access enforcement.
const ROLE_MAP = {
    'tetleyshed@gmail.com': 'warehouse',
};

function meResponse(data) {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            // Per-user response — never cache at the edge or in the browser.
            'Cache-Control': 'private, no-store',
        },
    });
}

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

export async function onRequestGet({ request }) {
    // Cloudflare *may* set CF-Access-Authenticated-User-Email if the app config
    // forwards identity headers, but it's optional. The JWT is always there
    // when Access has authenticated the request, so prefer that.
    const email = request.headers.get('CF-Access-Authenticated-User-Email')
        || emailFromJwt(request.headers.get('Cf-Access-Jwt-Assertion'));

    if (!email) {
        return meResponse({ email: null, name: 'Unknown', role: 'admin' });
    }
    const nameParts = email.split('@')[0].split('.');
    const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const role = ROLE_MAP[email.toLowerCase()] || 'admin';
    return meResponse({ email, name, role });
}
