// GET  /api/import/forecast — retrieve Prime Ties stock forecast config
// POST /api/import/forecast — patch forecast config (startingKg, monthlyAvg, shipments)
//
// One number, one source: when a committed stock count exists for Prime Tie
// Bundled, GET overrides the hand-typed startingKg / stocktakeDate with that
// count (and reports the engine's on-hand now), so the Stock Trajectory, the
// Monthly Forecast and the Warehouse dashboard all run from the same figure:
//   count − sales (orders) + shipments landed ± adjustments = stock now
// The manual pair is kept as a fallback until the first count is committed.

import { jsonResponse, errResponse } from '../_xero.js';
import { nzToday } from '../_dates.js';
import { loadWorld } from '../stock/_store.js';
import { baselineFor, onHandFor, SHIPMENT_PRODUCT_ID } from '../stock/_engine.js';

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

// The stock engine's anchor for Prime Tie Bundled, or null before the first
// committed count. Never lets an engine error break the forecast.
async function stockAnchor(env) {
    try {
        const world = await loadWorld(env);
        const item = world.items.find(i => i.id === SHIPMENT_PRODUCT_ID);
        if (!item) return null;
        const today = nzToday();
        const base = baselineFor(item.id, world.counts, today);
        if (!base) return null;
        const now = onHandFor(item, world, today);
        return {
            source: 'count', kg: base.qty, date: base.date, countId: base.countId, label: base.countLabel || 'Stock count',
            onHandNow: now.onHand, asOf: today,
            soldSince: now.consumed, receivedSince: now.receipts, adjustedSince: now.movements,
        };
    } catch {
        return null;
    }
}

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get(KEY);
        const config = raw ? JSON.parse(raw) : { ...DEFAULTS };
        const anchor = await stockAnchor(env);
        if (anchor) {
            config.manualStartingKg    = config.startingKg;
            config.manualStocktakeDate = config.stocktakeDate;
            config.startingKg    = anchor.kg;
            config.stocktakeDate = anchor.date;
            config.stocktake     = anchor;
        } else {
            config.stocktake = { source: 'manual', kg: config.startingKg ?? 0, date: config.stocktakeDate || null };
        }
        return jsonResponse(config);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const raw = await env.ORDERS_KV.get(KEY);
        const existing = raw ? JSON.parse(raw) : { ...DEFAULTS };
        if (body.startingKg    !== undefined) existing.startingKg    = body.startingKg;
        if (body.stocktakeDate !== undefined) existing.stocktakeDate = body.stocktakeDate;
        if (body.monthlyAvg    !== undefined) existing.monthlyAvg    = body.monthlyAvg;
        if (body.shipments     !== undefined) existing.shipments     = body.shipments;
        if (body.stageDefaults !== undefined) existing.stageDefaults = body.stageDefaults;
        existing.version  = (existing.version || 1) + 1;
        existing.savedAt  = new Date().toISOString();
        await env.ORDERS_KV.put(KEY, JSON.stringify(existing));
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
