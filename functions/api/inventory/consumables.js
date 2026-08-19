// GET  /api/inventory/consumables — packaging usage + on-hand from a BOM
// POST /api/inventory/consumables — save baseline counts / reorder points
//
// Packaging is expensed, not a stocktake asset, so this tracks QUANTITIES:
// how much of each consumable sales have burnt through since a baseline count,
// what's on hand, and when to reorder. Consumption is derived from a Bill of
// Materials keyed on kg sold by type×size (a "box" = 10kg):
//
//   Bundled 1kg box  → 1 PT box · 10 red bags · 2 1kg-bundled labels · 2 staples · 0.01 tape
//   Bundled 10kg box → 1 PT box ·               2 10kg-bundled labels · 2 staples · 0.01 tape
//   Loose 1kg box    → 1 PT box · 10 black bags · 2 1kg-loose labels  · 2 staples · 0.01 tape
//   Loose 10kg box   → 1 PT box ·               2 10kg-loose labels  · 2 staples · 0.01 tape
//
// eco Ties intentionally excluded for now.

import { jsonResponse, errResponse } from '../_xero.js';

const CFG_KEY = 'inventory:consumables';

// Per-kg coefficients on {B1,B10,L1,L10} = kg sold of Bundled/Loose × 1kg/10kg.
const CONSUMABLES = [
    { key: 'primeTieBox',  name: 'Prime Tie Boxes',        unit: 'boxes',   coef: { B1: 0.1,   B10: 0.1,   L1: 0.1,   L10: 0.1 } },
    { key: 'redBag',       name: 'Red Bags · 1kg Bundled', unit: 'bags',    coef: { B1: 1 } },
    { key: 'blackBag',     name: 'Black Bags · 1kg Loose', unit: 'bags',    coef: { L1: 1 } },
    { key: 'lblBundled1',  name: '1kg Bundled Labels',     unit: 'labels',  coef: { B1: 0.2 } },
    { key: 'lblBundled10', name: '10kg Bundled Labels',    unit: 'labels',  coef: { B10: 0.2 } },
    { key: 'lblLoose1',    name: '1kg Loose Labels',       unit: 'labels',  coef: { L1: 0.2 } },
    { key: 'lblLoose10',   name: '10kg Loose Labels',      unit: 'labels',  coef: { L10: 0.2 } },
    { key: 'staple',       name: 'Staples',                unit: 'staples', coef: { B1: 0.2, B10: 0.2, L1: 0.2, L10: 0.2 } },
    { key: 'tapeRoll',     name: 'Tape Rolls',             unit: 'rolls',   coef: { B1: 0.001, B10: 0.001, L1: 0.001, L10: 0.001 } },
];

// Sum kg sold by type×size across sales rows dated after `sinceIso`.
function kgSince(rows, sinceIso) {
    let B1 = 0, B10 = 0, L1 = 0, L10 = 0;
    for (const r of rows) {
        const date = (r.date || '').slice(0, 10);
        if (!date || (sinceIso && date <= sinceIso)) continue;
        const x = r.xkg;
        if (x) {
            B1 += Number(x.b1) || 0; B10 += Number(x.b10) || 0;
            L1 += Number(x.l1) || 0; L10 += Number(x.l10) || 0;
            continue;
        }
        const bk = Number(r.bundlesKg) || 0, lk = Number(r.looseKg) || 0, ek = Number(r.ecoTiesKg) || 0;
        if ((bk > 0) + (lk > 0) + (ek > 0) !== 1) continue; // can't split mixed rows without a cross
        const one = Number(r.oneKg) || 0, ten = Number(r.tenKg) || 0;
        if (bk > 0) { B1 += one; B10 += ten; }
        else if (lk > 0) { L1 += one; L10 += ten; }
    }
    return { B1, B10, L1, L10 };
}

async function loadConfig(env) {
    try { return JSON.parse(await env.ORDERS_KV.get(CFG_KEY) || '{}') || {}; }
    catch { return {}; }
}

export async function onRequestGet({ env }) {
    try {
        const cfg = await loadConfig(env);
        // Baseline date: the config's own, else the latest stocktake, else null.
        let asAt = cfg.asAt || null;
        if (!asAt) {
            const list = JSON.parse(await env.ORDERS_KV.get('stocktake:list') || '[]');
            asAt = list[0]?.date || null;
        }

        const salesRaw = await env.ORDERS_KV.get('sales_history');
        const sales    = salesRaw ? JSON.parse(salesRaw) : [];
        const kg       = kgSince(sales, asAt);

        const today = new Date().toISOString().slice(0, 10);
        const days  = asAt ? Math.max(1, Math.round((Date.parse(today) - Date.parse(asAt)) / 86400000) || 1) : null;

        const levels = cfg.levels || {};
        const rows = CONSUMABLES.map(c => {
            const used = Math.round(Object.entries(c.coef)
                .reduce((s, [k, v]) => s + v * (kg[k] || 0), 0) * 100) / 100;
            const lvl     = levels[c.key] || {};
            const onHand  = lvl.onHand != null && lvl.onHand !== '' ? Number(lvl.onHand) : null;
            const reorder = lvl.reorder != null && lvl.reorder !== '' ? Number(lvl.reorder) : null;
            const running = onHand != null ? Math.round((onHand - used) * 100) / 100 : null;
            const perWeek = used > 0 && days ? (used / days) * 7 : 0;
            return {
                key: c.key, name: c.name, unit: c.unit,
                used, onHand, reorder, running,
                perWeek: Math.round(perWeek * 10) / 10,
                weeksCover: running != null && perWeek > 0 ? Math.round((running / perWeek) * 10) / 10 : null,
                low: onHand != null && reorder != null ? running <= reorder : false,
            };
        });

        return jsonResponse({ asAt, asOf: today, daysSince: days, rows });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const cfg  = await loadConfig(env);
        if (body.asAt !== undefined)   cfg.asAt = body.asAt || null;
        if (body.levels !== undefined) cfg.levels = { ...(cfg.levels || {}), ...body.levels };
        cfg.updatedAt = new Date().toISOString();
        await env.ORDERS_KV.put(CFG_KEY, JSON.stringify(cfg));
        return jsonResponse({ ok: true });
    } catch (e) {
        return errResponse(e.message);
    }
}
