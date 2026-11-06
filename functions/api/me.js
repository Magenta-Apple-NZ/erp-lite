// GET /api/me — returns the current user's identity from Cloudflare Access JWT

import { userFromRequest } from './_users.js';

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
    return meResponse(userFromRequest(request));
}
