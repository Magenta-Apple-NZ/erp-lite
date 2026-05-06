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

export async function onRequestGet({ request }) {
    const email = request.headers.get('CF-Access-Authenticated-User-Email');

    // TEMP DEBUG: dump all incoming headers when ?debug=1 is passed.
    const url = new URL(request.url);
    if (url.searchParams.get('debug') === '1') {
        const headers = {};
        for (const [k, v] of request.headers) headers[k] = v;
        return meResponse({ email, headers });
    }

    if (!email) {
        return meResponse({ email: null, name: 'Unknown', role: 'admin' });
    }
    const nameParts = email.split('@')[0].split('.');
    const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const role = ROLE_MAP[email.toLowerCase()] || 'admin';
    return meResponse({ email, name, role });
}
