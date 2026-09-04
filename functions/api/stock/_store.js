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

import { DEFAULT_SETTINGS, productValueFromShipments } from './_engine.js';

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
export const PRODUCT_SEED = [
    { id: 'prime-tie-bundled', name: 'Prime Tie Bundled', class: 'product', unit: 'kg', active: true, key: true, sortOrder: 10, salesKey: 'bundles', aliases: [], accountCode: '1440', unitValue: null, unitValueAsAt: null, reorder: { mode: 'manual', manualPoint: null, safetyDays: null, reorderQty: null } },
    { id: 'prime-tie-loose',   name: 'Prime Tie Loose',   class: 'product', unit: 'kg', active: true, key: true, sortOrder: 20, salesKey: 'loose',   aliases: [], accountCode: '1440', unitValue: null, unitValueAsAt: null, reorder: { mode: 'manual', manualPoint: null, safetyDays: null, reorderQty: null } },
    { id: 'eco-ties',          name: 'eco Ties',          class: 'product', unit: 'kg', active: true, key: true, sortOrder: 30, salesKey: 'ecoTies', aliases: [], accountCode: '1440', unitValue: null, unitValueAsAt: null, reorder: { mode: 'manual', manualPoint: null, safetyDays: null, reorderQty: null } },
];

export async function loadItems(env) {
    let index = await getJson(env, K.itemsIndex, null);
    if (!Array.isArray(index)) {
        for (const p of PRODUCT_SEED) await putJson(env, K.item(p.id), p);
        index = PRODUCT_SEED.map(p => p.id);
        await putJson(env, K.itemsIndex, index);
    }
    const [items, shipments] = await Promise.all([
        Promise.all(index.map(id => getJson(env, K.item(id), null))),
        loadShipments(env),
    ]);
    // Products are valued from the latest priced shipment, not typed by hand.
    const pv = productValueFromShipments(shipments);
    return items.filter(Boolean)
        .map(it => it.class === 'product' && pv
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
export async function loadShipments(env) {
    const fc = await getJson(env, 'import:forecast', null);
    return fc && Array.isArray(fc.shipments) ? fc.shipments : [];
}

// Everything the engine needs, loaded in parallel.
export async function loadWorld(env) {
    const [settings, items, bom, counts, movements, sales, shipments] = await Promise.all([
        loadSettings(env), loadItems(env), loadBom(env), loadCommittedCounts(env),
        loadMovements(env), loadSales(env), loadShipments(env),
    ]);
    return { settings, items, bom, counts, movements, sales, shipments };
}
