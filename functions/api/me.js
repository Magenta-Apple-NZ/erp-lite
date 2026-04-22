// GET /api/me — returns the current user's identity from Cloudflare Access JWT

import { jsonResponse } from './_xero.js';

export async function onRequestGet({ request }) {
    const email = request.headers.get('CF-Access-Authenticated-User-Email');
    if (!email) {
        return jsonResponse({ email: null, name: 'Unknown' });
    }
    const nameParts = email.split('@')[0].split('.');
    const name = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    return jsonResponse({ email, name });
}
