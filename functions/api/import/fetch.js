// GET /api/import/fetch  — server-side proxy for Google Sheets CSV
// Fetches the stored sheet URL from KV and returns the CSV body.
// Running server-side avoids CORS issues and keeps the sheet URL private.

import { errResponse } from '../_xero.js';

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get('import:schedule');
        const schedule = raw ? JSON.parse(raw) : null;
        const url = schedule?.sheetUrl;

        if (!url) {
            return new Response(JSON.stringify({ error: 'No sheet URL configured' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!url.startsWith('https://docs.google.com/spreadsheets/')) {
            return new Response(JSON.stringify({ error: 'Only Google Sheets URLs are supported' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const resp = await fetch(url, {
            headers: { 'User-Agent': 'EnvirowareHub/1.0' },
        });

        if (!resp.ok) {
            return new Response(JSON.stringify({ error: `Sheet fetch failed: ${resp.status} ${resp.statusText}` }), {
                status: resp.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const csv = await resp.text();
        return new Response(csv, {
            headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        });

    } catch (e) {
        return errResponse(e.message);
    }
}
