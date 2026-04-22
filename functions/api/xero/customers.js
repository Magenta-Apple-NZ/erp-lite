// GET /api/xero/customers — return Xero contacts where IsCustomer=true
// Cached in KV for 1 hour to avoid hammering the Xero API

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../_xero.js';

const CACHE_KEY = 'customers_cache';
const CACHE_TTL = 3600; // 1 hour

export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const bust = url.searchParams.get('bust') === '1';

        if (!bust) {
            const cached = await env.XERO_KV.get(CACHE_KEY, { type: 'json' });
            if (cached) return jsonResponse(cached);
        }

        const token = await getValidToken(env);

        const resp = await fetch(
            'https://api.xero.com/api.xro/2.0/Contacts?where=IsCustomer%3D%3Dtrue&order=Name',
            { headers: xeroHeaders(token) }
        );

        if (!resp.ok) {
            const body = await resp.text();
            return errResponse('Xero API error: ' + body, resp.status);
        }

        const data = await resp.json();
        const customers = (data.Contacts || []).map(c => ({
            xeroContactId: c.ContactID,
            name: c.Name,
            email: c.EmailAddress || '',
        }));

        await env.XERO_KV.put(CACHE_KEY, JSON.stringify(customers), { expirationTtl: CACHE_TTL });
        return jsonResponse(customers);

    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message, 401);
        return errResponse(e.message);
    }
}
