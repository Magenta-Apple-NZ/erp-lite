// GET /api/stock/bom — consumables matrix: what one sales unit of each
//     product we sell consumes. Versioned by effectiveFrom (§3.3). Also
//     returns `products` (the items-sheet catalogue minus freight) so the
//     UI can draw the matrix by product name.
// PUT /api/stock/bom — replace all versions (validated against items + catalogue)

import { jsonResponse, errResponse } from '../_xero.js';
import { isYmd } from '../_dates.js';
import { loadBom, saveBom, loadItems } from './_store.js';
import { SKU_TABLE } from './_engine.js';
import { loadItemsMap } from '../catalog/items.js';

const isFreight = id => /^FR-/i.test(String(id || ''));

// Sellable products from the sheet. `tracked` = the engine can expand this
// SKU's recipe from sales (it has a type×size mapping); others are shown but
// never consume anything until they're mapped.
async function loadProducts(env) {
    const tracked = new Set(Object.keys(SKU_TABLE).map(s => s.toUpperCase()));
    let products = [];
    try {
        const map = await loadItemsMap(env);
        products = [...map.values()]
            .filter(i => i.id && !isFreight(i.id))
            .map(i => ({ sku: i.id, name: i.name || i.id, tracked: tracked.has(i.id.toUpperCase()) }));
    } catch { /* sheet unreachable — fall back to the mapped SKUs */ }
    if (!products.length) products = Object.keys(SKU_TABLE).map(sku => ({ sku, name: sku, tracked: true }));
    // Mapped SKUs first, in table order; the rest alphabetical.
    const order = Object.keys(SKU_TABLE).map(s => s.toUpperCase());
    products.sort((a, b) => {
        const ia = order.indexOf(a.sku.toUpperCase()), ib = order.indexOf(b.sku.toUpperCase());
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.name.localeCompare(b.name);
    });
    return products;
}

export async function onRequestGet({ env }) {
    try {
        const [bom, products] = await Promise.all([loadBom(env), loadProducts(env)]);
        return jsonResponse({ ...bom, skus: Object.keys(SKU_TABLE), products });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPut({ env, request }) {
    try {
        const body = await request.json();
        if (!Array.isArray(body.versions)) return errResponse('versions must be an array', 400);
        const [items, products] = await Promise.all([loadItems(env), loadProducts(env)]);
        const consumables = new Set(items.filter(i => i.class === 'consumable').map(i => i.id));
        const knownSku = new Set([...Object.keys(SKU_TABLE), ...products.map(p => p.sku)].map(s => s.toUpperCase()));
        const seen = new Set();
        const versions = [];
        for (const v of body.versions) {
            if (!v || !isYmd(v.effectiveFrom)) return errResponse('each version needs effectiveFrom YYYY-MM-DD', 400);
            if (seen.has(v.effectiveFrom)) return errResponse('duplicate effectiveFrom ' + v.effectiveFrom, 400);
            seen.add(v.effectiveFrom);
            const recipes = {};
            for (const [sku, entries] of Object.entries(v.recipes || {})) {
                if (!knownSku.has(String(sku).toUpperCase())) return errResponse('unknown product SKU in matrix: ' + sku, 400);
                if (!Array.isArray(entries)) return errResponse('recipe for ' + sku + ' must be an array', 400);
                const clean = [];
                for (const e of entries) {
                    if (!e || !consumables.has(e.consumableId)) return errResponse(`${sku} references unknown consumable: ${e && e.consumableId}`, 400);
                    const qty = Number(e.qty);
                    if (!isFinite(qty) || qty < 0) return errResponse(`${sku}: qty must be ≥ 0`, 400);
                    if (qty > 0) clean.push({ consumableId: e.consumableId, qty });
                }
                if (clean.length) recipes[sku] = clean;
            }
            versions.push({ effectiveFrom: v.effectiveFrom, recipes });
        }
        versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        const bom = { versions, updatedAt: new Date().toISOString() };
        await saveBom(env, bom);
        return jsonResponse({ ...bom, skus: Object.keys(SKU_TABLE), products });
    } catch (e) {
        return errResponse(e.message);
    }
}
