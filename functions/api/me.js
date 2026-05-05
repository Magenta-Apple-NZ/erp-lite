// GET /api/me — returns the current user's identity from Cloudflare Access JWT

import { jsonResponse } from './_xero.js';

// Email → role. Anyone not listed defaults to 'admin'.
// Frontend hides nav/views based on role; this is UX-only, not access enforcement.
const ROLE_MAP = {
    'tetleyshed@gmail.com': 'warehouse',
};

export async function onRequestGet({ request }) {
    const email = request.headers.get('CF-Access-Authenticated-User-Email');
    if (!email) {
        return jsonResponse({ email: null, name: 'Unknown', role: 'admin' });
    }
    const nameParts = email.split('@')[0].split('.');
    const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    const role = ROLE_MAP[email.toLowerCase()] || 'admin';
    return jsonResponse({ email, name, role });
}
