// KV access for the stock system. Every stock endpoint reads/writes through
// here so the key layout lives in one place (see Stock-Rebuild.md §3).
//
//   stock:settings            Settings
//   stock:items:index         [itemId]
//   stock:item:<id>           Item
//   stock:bom                 { versions: [...] }
//   stock:counts:index        [{ id, label, date, status }]
//   stock:count:<id>          Count
//   stock:movements:index     [itemId]
//   stock:movements:<itemId>  [Movement]   (append-only)

import { DEFAULT_SETTINGS, productValueFromShipments, SHIPMENT_PRODUCT_ID } from './_engine.js';
import { costShipments } from '../import/_cost.js';

export const K = {
    settings:    'stock:settings',
    itemsIndex:  'stock:items:index',
    item:        id => 'stock:item:' + id,
    bom:         'stock:bom',
    countsIndex: 'stock:counts:index',
    count:       id => 'stock:count:' + id,
    movIndex:    'stock:movements:index',
    movements:   id => 'stock:movements:' + id,
};

export async function getJson(env, key, fallback = null) {
    const v = await env.ORDERS_KV.get(key, { type: 'json' });
    return v == null ? fallback : v;
}
export async function putJson(env, key, value) {
    await env.ORDERS_KV.put(key, JSON.stringify(value));
}

// Who is acting — Cloudflare Access stamps the authenticated email on every
// request that reaches the Functions.
export function whoami(request) {
    return request?.headers?.get('cf-access-authenticated-user-email') || 'unknown';
}

export function newId(prefix) {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 6);
    return `${prefix}_${t}${r}`;
}

export function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// ── Settings ──
export async function loadSettings(env) {
    const saved = await getJson(env, K.settings, {});
    return { ...DEFAULT_SETTINGS, ...saved, valuation: { ...DEFAULT_SETTINGS.valuation, ...(saved.valuation || {}) } };
}
export async function saveSettings(env, settings) {
    await putJson(env, K.settings, settings);
}

// ── Items ──
// The three key products are seeded on first read so the engine always has
// its product buckets. Consumables are added by hand in Admin → Stock.
// Only Prime Tie Bundled is tracked for now (fed by shipments, FIFO-costed).
// Loose and eco Ties exist so their sales buckets resolve, but stay inactive
// until they are wanted — reactivate from Catalogue → Stock.
export const PRODUCT_SEED = [
    { id: 'prime-tie-bundled', name: 'Prime Tie Bundled', class: 'product', unit: 'kg', active: true,  key: true,  sortOrder: 10, salesKey: 'bundles', aliases: [], accountCode: '1440', unitValue: null, unitValueAsAt: null, reorder: { mode: 'auto', manualPoint: null, safetyDays: null, reorderQty: null } },
    { id: 'prime-tie-loose',   name: 'Prime Tie Loose',   class: 'product', unit: 'kg', active: false, key: false, sortOrder: 20, salesKey: 'loose',   aliases: [], accountCode: '1440', unitValue: null, unitValueAsAt: null, reorder: { mode: 'auto', manualPoint: null, safetyDays: null, reorderQty: null } },
    { id: 'eco-ties',          name: 'eco Ties',          class: 'product', unit: 'kg', active: false, key: false, sortOrder: 30, salesKey: 'ecoTies', aliases: [], accountCode: '1440', unitValue: null, unitValueAsAt: null, reorder: { mode: 'auto', manualPoint: null, safetyDays: null, reorderQty: null } },
];
const ITEMS_SCHEMA_KEY = 'stock:items:schema';
const ITEMS_SCHEMA = 3;

// Courier label books — one per Aramex service, tied to its courier SKU so
// each depletes only by that service's invoiced labels. Seeded once (v3).
export const LABEL_SEED = [
    { id: 'labels-fr-01', name: 'Aramex labels · Local',        courierSku: 'FR-01' },
    { id: 'labels-fr-02', name: 'Aramex labels · Inner Island', courierSku: 'FR-02' },
    { id: 'labels-fr-03', name: 'Aramex labels · Outer Island', courierSku: 'FR-03' },
    { id: 'labels-fr-04', name: 'Aramex labels · Inter Island', courierSku: 'FR-04' },
].map((l, i) => ({
    ...l, class: 'consumable', unit: 'each', unitLabel: 'label', active: true, key: false, sortOrder: 900 + i, aliases: [],
    accountCode: '', unitValue: null, unitValueAsAt: null, salesKey: null,
    profile: { retailer: 'Aramex', retailerUrl: '', supplierSku: '', imageUrl: '', description: 'Book of physical courier labels', leadTimeDays: null, typicalCost: null, packSize: 1, minOrderQty: null, notes: '' },
    reorder: { mode: 'auto', manualPoint: null, safetyDays: null, reorderQty: null },
}));

export async function loadItems(env) {
    let index = await getJson(env, K.itemsIndex, null);
    if (!Array.isArray(index)) {
        for (const p of PRODUCT_SEED) await putJson(env, K.item(p.id), p);
        index = PRODUCT_SEED.map(p => p.id);
        await putJson(env, K.itemsIndex, index);
        await putJson(env, ITEMS_SCHEMA_KEY, ITEMS_SCHEMA);
    }
    // One-time migrations. v2 parks Loose + eco Ties (decision 4 Sep 2026);
    // v3 seeds the four Aramex label books, each tied to its courier SKU.
    const schema = await getJson(env, ITEMS_SCHEMA_KEY, 1);
    if (schema < 2) {
        for (const id of ['prime-tie-loose', 'eco-ties']) {
            const it = await getJson(env, K.item(id), null);
            if (it) await putJson(env, K.item(id), { ...it, active: false, key: false });
        }
    }
    if (schema < 3) {
        for (const l of LABEL_SEED) {
            if (await getJson(env, K.item(l.id), null)) continue;
            await putJson(env, K.item(l.id), { ...l, createdAt: new Date().toISOString() });
            if (!index.includes(l.id)) index.push(l.id);
        }
        await putJson(env, K.itemsIndex, index);
    }
    if (schema < ITEMS_SCHEMA) await putJson(env, ITEMS_SCHEMA_KEY, ITEMS_SCHEMA);
    const [items, shipments] = await Promise.all([
        Promise.all(index.map(id => getJson(env, K.item(id), null))),
        loadShipments(env),
    ]);
    // Only the shipment-fed product (Prime Tie Bundled) is valued from
    // shipments; Loose and eco Ties keep their own hand-entered cost per kg.
    const pv = productValueFromShipments(shipments);
    return items.filter(Boolean)
        .map(it => it.id === SHIPMENT_PRODUCT_ID && pv
            ? { ...it, unitValue: pv.unitValue, unitValueSource: pv.source }
            : it)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name)));
}
export async function loadItem(env, id) {
    return getJson(env, K.item(id), null);
}
export async function saveItem(env, item) {
    await putJson(env, K.item(item.id), item);
    const index = await getJson(env, K.itemsIndex, []);
    if (!index.includes(item.id)) {
        index.push(item.id);
        await putJson(env, K.itemsIndex, index);
    }
}

// ── BOM ──
export async function loadBom(env) {
    const b = await getJson(env, K.bom, null);
    return b && Array.isArray(b.versions) ? b : { versions: [] };
}
export async function saveBom(env, bom) {
    await putJson(env, K.bom, bom);
}

// ── Counts ──
export async function loadCountsIndex(env) {
    const idx = await getJson(env, K.countsIndex, []);
    return idx.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
}
export async function loadCount(env, id) {
    return getJson(env, K.count(id), null);
}
export async function saveCount(env, count) {
    await putJson(env, K.count(count.id), count);
    const idx = await getJson(env, K.countsIndex, []);
    const entry = { id: count.id, label: count.label, date: count.date, status: count.status, committedAt: count.committedAt || null };
    const i = idx.findIndex(e => e.id === count.id);
    if (i >= 0) idx[i] = entry; else idx.push(entry);
    await putJson(env, K.countsIndex, idx);
}
export async function loadCommittedCounts(env) {
    const idx = await loadCountsIndex(env);
    const docs = await Promise.all(idx.filter(e => e.status === 'committed').map(e => loadCount(env, e.id)));
    return docs.filter(Boolean);
}

// ── Movements ──
export async function loadMovements(env) {
    const index = await getJson(env, K.movIndex, []);
    const lists = await Promise.all(index.map(id => getJson(env, K.movements(id), [])));
    const out = {};
    index.forEach((id, i) => { out[id] = lists[i] || []; });
    return out;
}
export async function appendMovement(env, mov) {
    const list = await getJson(env, K.movements(mov.itemId), []);
    list.push(mov);
    await putJson(env, K.movements(mov.itemId), list);
    const index = await getJson(env, K.movIndex, []);
    if (!index.includes(mov.itemId)) {
        index.push(mov.itemId);
        await putJson(env, K.movIndex, index);
    }
}

// ── External inputs ──
export async function loadSales(env) {
    const raw = await env.ORDERS_KV.get('sales_history');
    return raw ? JSON.parse(raw) : [];
}
// Shipments come back stamped with kgIn (yield kg for V3), unitCost (landed
// $/kg from their cost lines, else listed $/kg) and costBasis — see
// import/_cost.js. The engine reads those, never the raw cost lines.
export async function loadShipments(env) {
    const fc = await getJson(env, 'import:forecast', null);
    const list = fc && Array.isArray(fc.shipments) ? fc.shipments : [];
    return costShipments(env, list);
}

// Everything the engine needs, loaded in parallel.
export async function loadWorld(env) {
    const [settings, items, bom, counts, movements, sales, shipments] = await Promise.all([
        loadSettings(env), loadItems(env), loadBom(env), loadCommittedCounts(env),
        loadMovements(env), loadSales(env), loadShipments(env),
    ]);
    return { settings, items, bom, counts, movements, sales, shipments };
}
