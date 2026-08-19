// GET /api/inventory/running  (?id=<snapshotId>)
//
// Turns the latest stocktake snapshot into a live "running" stocktake by
// burning each row down from sales recorded since the count was taken:
//   - RTS finished rows  → burn = kg sold of that type×size (RTS is measured
//                          in 1kg units, so a 10kg sale burns 10 units).
//   - Prime Tie Boxes    → burn = (Bundles + Loose) kg ÷ 10  (1 box per 10kg).
//   - Brown/eco Boxes    → burn = ecoTies kg ÷ 10.
//   - Raw / Processed    → static for now (shipment-driven stage moves are a
//                          follow-up; those advance on a shipment milestone).
// Manual restocks are a follow-up too. Read-only: this computes, never writes.

import { jsonResponse, errResponse } from '../_xero.js';

// Classify a stocktake row from its description into a burn rule.
function classify(desc) {
    const d = String(desc || '').toLowerCase();
    if (/box/.test(d)) {
        return { kind: 'boxes', scope: /brown|eco/.test(d) ? 'eco' : 'primetie' };
    }
    if (/\brts\b|ready.to.ship/.test(d)) {
        const type = /loose/.test(d) ? 'loose' : /eco/.test(d) ? 'ecoTies' : 'bundles';
        const size = /\b10\s*kg\b/.test(d) ? 'tenKg' : /\b1\s*kg\b/.test(d) ? 'oneKg' : null;
        return { kind: 'finished', type, size };
    }
    if (/raw|en\s*route|in.process/.test(d)) return { kind: 'raw' };
    if (/processed/.test(d)) return { kind: 'processed' };
    return { kind: 'static' };
}

// Accumulate kg sold per type×size across sales rows dated after `sinceIso`.
function burnSince(rows, sinceIso) {
    const b = { bundles: { oneKg: 0, tenKg: 0 }, loose: { oneKg: 0, tenKg: 0 }, ecoTies: { oneKg: 0, tenKg: 0 } };
    for (const r of rows) {
        const date = (r.date || '').slice(0, 10);
        if (!date || date <= sinceIso) continue;
        const x = r.xkg;
        if (x) {
            b.bundles.oneKg += Number(x.b1)  || 0; b.bundles.tenKg += Number(x.b10) || 0;
            b.loose.oneKg   += Number(x.l1)  || 0; b.loose.tenKg   += Number(x.l10) || 0;
            b.ecoTies.oneKg += Number(x.e1)  || 0; b.ecoTies.tenKg += Number(x.e10) || 0;
            continue;
        }
        // No cross — attribute the size totals only when the row is a single type.
        const bk = Number(r.bundlesKg) || 0, lk = Number(r.looseKg) || 0, ek = Number(r.ecoTiesKg) || 0;
        if ((bk > 0) + (lk > 0) + (ek > 0) !== 1) continue;
        const one = Number(r.oneKg) || 0, ten = Number(r.tenKg) || 0;
        const t = bk > 0 ? 'bundles' : lk > 0 ? 'loose' : 'ecoTies';
        b[t].oneKg += one; b[t].tenKg += ten;
    }
    return b;
}

export async function onRequestGet({ env, request }) {
    try {
        const id = new URL(request.url).searchParams.get('id');

        // Resolve the snapshot: explicit id, else the most recent.
        let snapId = id;
        if (!snapId) {
            const list = JSON.parse(await env.ORDERS_KV.get('stocktake:list') || '[]');
            if (!list.length) return jsonResponse({ empty: true });
            snapId = list[0].id; // list is sorted newest-first
        }
        const snap = await env.ORDERS_KV.get('stocktake:' + snapId, { type: 'json' });
        if (!snap) return errResponse('Snapshot not found', 404);

        const sinceIso = (snap.date || '').slice(0, 10);
        const salesRaw = await env.ORDERS_KV.get('sales_history');
        const sales    = salesRaw ? JSON.parse(salesRaw) : [];
        const burn     = burnSince(sales, sinceIso);

        const primeTieKg = burn.bundles.oneKg + burn.bundles.tenKg + burn.loose.oneKg + burn.loose.tenKg;
        const ecoKg      = burn.ecoTies.oneKg + burn.ecoTies.tenKg;

        const today = new Date().toISOString().slice(0, 10);
        const days  = Math.max(1, Math.round((Date.parse(today) - Date.parse(sinceIso)) / 86400000) || 1);

        const rows = (snap.items || []).map(it => {
            const rule = classify(it.description);
            let used = 0;
            if (rule.kind === 'finished') {
                used = rule.size ? burn[rule.type][rule.size] : (burn[rule.type].oneKg + burn[rule.type].tenKg);
            } else if (rule.kind === 'boxes') {
                used = (rule.scope === 'eco' ? ecoKg : primeTieKg) / 10;
            }
            used = Math.round(used * 100) / 100;
            const anchorUnits  = Number(it.units) || 0;
            const runningUnits = Math.round((anchorUnits - used) * 100) / 100;
            const unitValue    = Number(it.unitValue) || 0;
            const perWeek      = used > 0 ? (used / days) * 7 : 0;
            return {
                description: it.description,
                active:      Boolean(it.active),
                kind:        rule.kind,
                unitValue,
                anchorUnits,
                used,
                runningUnits,
                anchorNet:   Math.round(anchorUnits  * unitValue * 100) / 100,
                runningNet:  Math.round(runningUnits * unitValue * 100) / 100,
                perWeek:     Math.round(perWeek * 10) / 10,
                weeksCover:  perWeek > 0 ? Math.round((runningUnits / perWeek) * 10) / 10 : null,
            };
        });

        return jsonResponse({
            snapshotId:   snap.id,
            snapshotDate: sinceIso,
            label:        snap.label,
            asOf:         today,
            daysSince:    days,
            rows,
            totals: {
                anchor:  Math.round(rows.reduce((s, r) => s + r.anchorNet,  0) * 100) / 100,
                running: Math.round(rows.reduce((s, r) => s + r.runningNet, 0) * 100) / 100,
            },
            note: 'Raw/processed rows are static until shipment-driven stage moves and manual restocks are added.',
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
