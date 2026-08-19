// GET /api/inventory/reconcile — one kg-of-Prime-Ties flow.
//
//   Opening stock (last count) − Sales since + Shipments in since = Expected now
//
// Everything is the same base unit: kg of product. The stocktake is the anchor
// (product rows only — packaging excluded), sales deplete it, shipments that
// entered the pipeline since replenish it. Shipments already sitting in the
// count (tagged [40]/[41] etc.) are NOT re-added — they're already in opening.
//
// The number that matters is the GAP: once a newer count exists,
//   gap = actual counted − expected = wastage / yield loss / miscount.
// Dollars are deliberately out of scope here (kg only, part 1).

import { jsonResponse, errResponse } from '../_xero.js';

// Product rows only — raw / processed / finished (RTS). Boxes + anything else
// are packaging/other and don't belong in the kg-of-product pool.
function isProductRow(desc) {
    const d = String(desc || '').toLowerCase();
    if (/box/.test(d)) return false;
    return /\brts\b|ready.to.ship|raw|en\s*route|in.process|processed/.test(d);
}
function productKg(snap) {
    return Math.round((snap.items || [])
        .filter(i => isProductRow(i.description))
        .reduce((s, i) => s + (Number(i.units) || 0), 0) * 100) / 100;
}

// Shipment numbers referenced by a snapshot's row tags, e.g. "… [41]" → 41.
function taggedShipNums(snap) {
    const nums = new Set();
    for (const i of (snap.items || [])) {
        const m = String(i.description || '').match(/\[(\d+)\]/g);
        if (m) m.forEach(t => nums.add(t.replace(/[^\d]/g, '')));
    }
    return nums;
}
function shipNum(s) {
    const m = String(s.id || s.note || '').match(/(\d+)/);
    return m ? m[1] : null;
}
function shipStartIso(s) {
    if (s.startDate) return String(s.startDate).slice(0, 10);
    const dates = (s.milestones || []).map(m => m.date).filter(Boolean).sort();
    if (dates.length) return dates[0].slice(0, 10);
    if (s.ym) return s.ym + '-01';
    return null;
}
function shipStarted(s) {
    if ((s.milestones || []).some(m => m.done)) return true;
    const start = shipStartIso(s);
    return start ? start <= new Date().toISOString().slice(0, 10) : false;
}

// Total kg of product sold in (fromIso, toIso].
function salesKg(rows, fromIso, toIso) {
    let kg = 0;
    for (const r of rows) {
        const d = (r.date || '').slice(0, 10);
        if (!d || (fromIso && d <= fromIso) || (toIso && d > toIso)) continue;
        kg += (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
    }
    return Math.round(kg * 100) / 100;
}

export async function onRequestGet({ env }) {
    try {
        const list = JSON.parse(await env.ORDERS_KV.get('stocktake:list') || '[]');
        if (!list.length) return jsonResponse({ empty: true });

        const latest = await env.ORDERS_KV.get('stocktake:' + list[0].id, { type: 'json' });
        if (!latest) return jsonResponse({ empty: true });
        const prev = list[1] ? await env.ORDERS_KV.get('stocktake:' + list[1].id, { type: 'json' }) : null;

        const salesRaw = await env.ORDERS_KV.get('sales_history');
        const sales    = salesRaw ? JSON.parse(salesRaw) : [];

        let shipments = [];
        try {
            const fc = await env.ORDERS_KV.get('import:forecast', { type: 'json' });
            shipments = (fc && Array.isArray(fc.shipments)) ? fc.shipments : [];
        } catch { /* forecast optional */ }

        const today   = new Date().toISOString().slice(0, 10);
        const countDate = (latest.date || '').slice(0, 10);
        const tagged  = taggedShipNums(latest);

        // Shipments that entered the pipeline since the count and aren't already
        // sitting in it (untagged) — these replenish the pool.
        const inbound = shipments
            .filter(s => {
                const n = shipNum(s);
                if (n && tagged.has(n)) return false;      // already in opening
                const start = shipStartIso(s);
                return shipStarted(s) && (!start || start > countDate);
            })
            .map(s => ({ id: s.id, note: s.note || s.id, kg: Number(s.kg) || 0, start: shipStartIso(s) }));
        const inboundKg = Math.round(inbound.reduce((sum, s) => sum + s.kg, 0) * 100) / 100;

        const opening  = productKg(latest);
        const sold     = salesKg(sales, countDate, today);
        const expected = Math.round((opening - sold + inboundKg) * 100) / 100;

        // Realized gap for the last CLOSED period (needs two counts).
        let closedPeriod = null;
        if (prev) {
            const pDate = (prev.date || '').slice(0, 10);
            const pOpening = productKg(prev);
            const pSold = salesKg(sales, pDate, countDate);
            const pInbound = shipments
                .filter(s => { const n = shipNum(s); const st = shipStartIso(s);
                    return !(n && taggedShipNums(prev).has(n)) && st && st > pDate && st <= countDate; })
                .reduce((sum, s) => sum + (Number(s.kg) || 0), 0);
            const pExpected = Math.round((pOpening - pSold + pInbound) * 100) / 100;
            closedPeriod = {
                from: pDate, to: countDate,
                opening: pOpening, sold: pSold, shipmentsIn: Math.round(pInbound * 100) / 100,
                expected: pExpected, actual: opening,
                gap: Math.round((opening - pExpected) * 100) / 100, // actual − expected (neg = loss)
            };
        }

        return jsonResponse({
            countDate, countLabel: latest.label, asOf: today,
            opening, soldSince: sold, shipmentsInSince: inboundKg, expectedNow: expected,
            inboundShipments: inbound,
            closedPeriod,
            note: 'kg only (part 1). Raw/processed/RTS treated as one pool; the gap at the next count is wastage + yield loss + miscount.',
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
