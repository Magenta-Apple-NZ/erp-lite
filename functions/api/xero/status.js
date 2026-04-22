// GET /api/xero/status — returns whether Xero is connected

import { jsonResponse } from '../_xero.js';

export async function onRequestGet({ env }) {
    const tokens = await env.XERO_KV.get('tokens', { type: 'json' });
    if (!tokens) return jsonResponse({ connected: false });

    // Optimistically report connected; let the next real API call detect expiry
    return jsonResponse({
        connected: true,
        expiresAt: tokens.expiresAt,
        tenantId: tokens.tenantId,
    });
}
