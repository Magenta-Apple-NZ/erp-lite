// GET  /api/import/forecast — retrieve Prime Ties stock forecast config
// POST /api/import/forecast — patch forecast config (startingKg, monthlyAvg, shipments)

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'import:forecast';

// Seed defaults derived from FY25/FY26 actuals + FY27 forward estimates
const DEFAULTS = {
    startingKg: 10200,
    // Monthly average sales kg [Jan..Dec], FY27 forward estimates
    monthlyAvg: [2000, 750, 1000, 2000, 3000, 5500, 7000, 5000, 1000, 200, 50, 400],
    shipments: [
        {
            id: 'ship-41',
            ym: '2026-06',
            kg: 18888,
            note: 'Shipment 41',
            milestones: [
                { label: 'Request for documents', date: null, done: false },
                { label: 'Left Italy',             date: null, done: false },
                { label: 'Arrived in Bangladesh',  date: null, done: false },
                { label: 'Left Bangladesh',        date: null, done: false },
                { label: 'Arrived in New Zealand', date: null, done: false },
            ],
        },
        { id: 'ship-42', ym: '2026-12', kg: 17313, note: 'Shipment 42', milestones: [] },
        { id: 'ship-43', ym: '2027-07', kg: 17313, note: 'Shipment 43', milestones: [] },
    ],
};

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get(KEY);
        return jsonResponse(raw ? JSON.parse(raw) : DEFAULTS);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const raw = await env.ORDERS_KV.get(KEY);
        const existing = raw ? JSON.parse(raw) : { ...DEFAULTS };
        if (body.startingKg !== undefined) existing.startingKg = body.startingKg;
        if (body.monthlyAvg !== undefined) existing.monthlyAvg = body.monthlyAvg;
        if (body.shipments  !== undefined) existing.shipments  = body.shipments;
        existing.version  = (existing.version || 1) + 1;
        existing.savedAt  = new Date().toISOString();
        await env.ORDERS_KV.put(KEY, JSON.stringify(existing));
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
