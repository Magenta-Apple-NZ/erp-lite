// Shared helpers for appending rows to the sales_history table from
// elsewhere in the codebase (currently: the Xero push handler). Kept in
// an underscore-prefixed file so Pages doesn't treat it as a route.

import { loadItemsMap } from '../catalog/items.js';
import { nzYmd } from '../_dates.js';

const HUB_LIVE_YM = '2026-04'; // (Reference; sales_history doesn't gate on it)

// Look up an order line's SKU in the items catalogue (Map keyed by SKU).
function catalogItem(l, itemsMap) {
    if (!itemsMap || !l?.sku) return null;
    return itemsMap.get(String(l.sku).toUpperCase()) || null;
}

// Classify an order line into one of three product buckets, or 'other'
// for freight / fees / anything not in the catalog. Layered fallbacks:
//   1. SKU prefix (Prime Tie convention — most reliable for inbound /
//      Farmlands-extension orders that may have only a SKU).
//        PT-L*  → loose      e.g. PT-L-10, PT-L-1B, PT-LOOSE-10
//        PT-B*  → bundles    e.g. PT-B-10, PT-BUNDLE-10
//        ET*    → ecoTies    e.g. ET-10, ET-1B
//   2. Description text keywords (legacy / manual entries).
//   3. Catalog-stamped kgPerUnit (Hub-created orders).
function classifyLine(l, itemsMap) {
    // 1. Explicit Type from the items catalogue (deterministic).
    const cat = catalogItem(l, itemsMap);
    if (cat && cat.type) return cat.type;

    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();

    if (/^PT[-_]?L/.test(sku))   return 'loose';
    if (/^PT[-_]?B/.test(sku))   return 'bundles';
    if (/^ET([-_]|$)/.test(sku)) return 'ecoTies';

    if (/eco\s*ti/.test(desc)) return 'ecoTies';
    if (/bundle/.test(desc))   return 'bundles';
    if (/loose/.test(desc))    return 'loose';

    // NB: kgPerUnit is the SIZE, not the type — only a last-resort guess.
    const kpu = Number(l?.kgPerUnit);
    if (kpu === 10) return 'bundles';
    if (kpu === 1)  return 'loose';
    return 'other';
}

// Kg per unit for the line. Prefer the catalog-stamped value, otherwise
// derive from the SKU suffix (-10 → 10kg, -1B → 1kg), otherwise look
// for "10kg" / "1kg" anywhere in the description.
function inferKgPerUnit(l, itemsMap) {
    const cat = catalogItem(l, itemsMap);
    if (cat && cat.kgPerUnit != null && !isNaN(Number(cat.kgPerUnit))) return Number(cat.kgPerUnit);
    if (l?.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) return Number(l.kgPerUnit);
    const sku = String(l?.sku || '').toUpperCase();
    if (/-10$/.test(sku))    return 10;
    if (/-1B?$/.test(sku))   return 1;
    const desc = String(l?.description || '');
    const m = desc.match(/\b(\d+)\s*kg\b/i);
    if (m) {
        const v = parseInt(m[1], 10);
        if (v === 10 || v === 1) return v;
    }
    return 0;
}

function lineKg(l, itemsMap) {
    return (Number(l?.quantity) || 0) * inferKgPerUnit(l, itemsMap);
}

// Product SIZE (independent of type). Explicit catalogue Size wins, then the
// item name ("10kg"/"1kg"), then the derived per-unit weight. 'tenKg'|'oneKg'|null.
function inferSizeBucket(l, itemsMap) {
    const cat = catalogItem(l, itemsMap);
    if (cat && cat.size) return cat.size;
    const text = String(l?.description || l?.name || '');
    if (/\b10\s*kg\b/i.test(text)) return 'tenKg';
    if (/\b1\s*kg\b/i.test(text))  return 'oneKg';
    const k = inferKgPerUnit(l, itemsMap);
    if (k === 10) return 'tenKg';
    if (k === 1)  return 'oneKg';
    return null;
}

function fyLabel(year, month) {
    const endY = month >= 4 ? year + 1 : year;
    const startY = endY - 1;
    return `${String(startY).slice(-2)}/${String(endY).slice(-2)}`;
}

// Build the sales_history row for an order. Returns null when the order
// has no countable product kg (e.g. freight-only or empty lines).
export function rowFromOrder(order, itemsMap = null) {
    if (!order || !Array.isArray(order.lines)) return null;
    const buckets = { bundles: 0, loose: 0, ecoTies: 0 };
    const sizes   = { oneKg: 0, tenKg: 0 };
    // type×size cross, so charts can split a type by size: b1/b10, l1/l10, e1/e10.
    const cross = { b1: 0, b10: 0, l1: 0, l10: 0, e1: 0, e10: 0 };
    const CX = { bundles: 'b', loose: 'l', ecoTies: 'e' };
    let hasCross = false;
    for (const l of order.lines) {
        const cat = classifyLine(l, itemsMap);
        if (cat === 'other') continue;
        const kg = lineKg(l, itemsMap);
        if (kg !== 0) {
            buckets[cat] += kg;
            const sz = inferSizeBucket(l, itemsMap);
            if (sz) {
                sizes[sz] += kg;
                cross[CX[cat] + (sz === 'tenKg' ? '10' : '1')] += kg;
                hasCross = true;
            }
        }
    }
    if (buckets.bundles === 0 && buckets.loose === 0 && buckets.ecoTies === 0) {
        return null;
    }
    // Courier labels used = labels INVOICED on the order (courier lines
    // FR-01..04, quantity each). That is the "sold" figure for the label
    // consumable: opening count − labels invoiced = on hand. Falls back to
    // labels created on the courier record if none were invoiced. Freight is
    // never a label.
    // Per service too (svc), so a label book tied to one courier SKU depletes
    // only by that service's invoiced labels.
    let labels = 0;
    const svc = {};
    for (const l of order.lines) {
        const sku = String(l?.sku || '').toUpperCase();
        if (/^FR-0[1-4]$/.test(sku)) { const n = Number(l.quantity) || 0; labels += n; if (n) svc[sku] = (svc[sku] || 0) + n; }
    }
    if (!labels) labels = Number(order.courier?.boxesOrdered) || 0;
    // Bucket by the NZ-local calendar date, not the raw UTC slice of the
    // timestamp — otherwise an order created NZ-evening / early-morning (UTC+12/13)
    // lands in the previous UTC day, and the month/year drift vs what the UI shows.
    const dateIso = nzYmd(order.createdAt || new Date().toISOString());
    const [yr, mo] = dateIso.split('-').map(n => parseInt(n, 10));
    return {
        id:        order.id,
        source:    'hub',
        date:      dateIso,
        month:     mo,
        year:      yr,
        fy:        fyLabel(yr, mo),
        customer:  order.customer?.name || '',
        branch:    order.shipTo?.branch || '',
        ...(order.shipTo?.storeId ? { storeId: order.shipTo.storeId } : {}),
        poNumber:  order.poNumber || '',
        invoice:   order.xeroInvoiceNumber || '',
        bundlesKg: buckets.bundles,
        looseKg:   buckets.loose,
        ecoTiesKg: buckets.ecoTies,
        oneKg:     sizes.oneKg,
        tenKg:     sizes.tenKg,
        ...(hasCross ? { xkg: cross } : {}),
        ...(labels > 0 ? { labels } : {}),
        ...(Object.keys(svc).length ? { svc } : {}),
    };
}

// Append or update one row in sales_history. Idempotent by row.id, so
// re-pushing a Xero invoice (e.g. after a manual correction) overwrites
// the existing hub row rather than duplicating.
export async function upsertRow(env, row) {
    if (!row || !row.id) return;
    const raw = await env.ORDERS_KV.get('sales_history');
    const rows = raw ? JSON.parse(raw) : [];
    const idx = rows.findIndex(r => r.id === row.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    await env.ORDERS_KV.put('sales_history', JSON.stringify(rows));
}

// Drop a row from sales_history by id. No-op if not present.
export async function removeRow(env, id) {
    if (!id) return;
    const raw = await env.ORDERS_KV.get('sales_history');
    if (!raw) return;
    const rows = JSON.parse(raw);
    const filtered = rows.filter(r => r.id !== id);
    if (filtered.length !== rows.length) {
        await env.ORDERS_KV.put('sales_history', JSON.stringify(filtered));
    }
}

// Single canonical sync hook. Called from every order write path so
// sales_history stays in lock-step with ORDERS_KV — irrespective of
// whether the order arrived via /api/orders (manual), /api/orders/inbound
// (API webhook), or /api/xero/push (invoice creation). An order with no
// countable product kg (e.g. freight-only) has its sales_history row
// removed if one exists.
export async function syncSalesHistory(env, order) {
    if (!order || !order.id) return;
    // Load the items catalogue so type/size come from the sheet, not heuristics.
    const itemsMap = await loadItemsMap(env).catch(() => null);
    const row = rowFromOrder(order, itemsMap);
    if (row) {
        try { await upsertRow(env, row); }
        catch (err) { console.error('sales_history upsert failed for', order.id, err); }
    } else {
        try { await removeRow(env, order.id); }
        catch (err) { console.error('sales_history remove failed for', order.id, err); }
    }
}

export { HUB_LIVE_YM };
