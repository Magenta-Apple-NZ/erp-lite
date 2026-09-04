// GET /api/stock/bom — packaging recipes, versioned by effectiveFrom (§3.3)
// PUT /api/stock/bom — replace all versions (validated against items + SKUs)

import { jsonResponse, errResponse } from '../_xero.js';
import { isYmd } from '../_dates.js';
import { loadBom, saveBom, loadItems } from './_store.js';
import { SKU_TABLE } from './_engine.js';

export async function onRequestGet({ env }) {
    try {
        return jsonResponse({ ...(await loadBom(env)), skus: Object.keys(SKU_TABLE) });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPut({ env, request }) {
    try {
        const body = await request.json();
        if (!Array.isArray(body.versions)) return errResponse('versions must be an array', 400);
        const items = await loadItems(env);
        const consumables = new Set(items.filter(i => i.class === 'consumable').map(i => i.id));
        const seen = new Set();
        const versions = [];
        for (const v of body.versions) {
            if (!v || !isYmd(v.effectiveFrom)) return errResponse('each version needs effectiveFrom YYYY-MM-DD', 400);
            if (seen.has(v.effectiveFrom)) return errResponse('duplicate effectiveFrom ' + v.effectiveFrom, 400);
            seen.add(v.effectiveFrom);
            const recipes = {};
            for (const [sku, entries] of Object.entries(v.recipes || {})) {
                if (!SKU_TABLE[sku]) return errResponse('unknown SKU in recipes: ' + sku, 400);
                if (!Array.isArray(entries)) return errResponse('recipe for ' + sku + ' must be an array', 400);
                const clean = [];
                for (const e of entries) {
                    if (!e || !consumables.has(e.consumableId)) return errResponse(`recipe ${sku} references unknown consumable: ${e && e.consumableId}`, 400);
                    const qty = Number(e.qty);
                    if (!isFinite(qty) || qty < 0) return errResponse(`recipe ${sku}: qty must be ≥ 0`, 400);
                    if (qty > 0) clean.push({ consumableId: e.consumableId, qty });
                }
                recipes[sku] = clean;
            }
            versions.push({ effectiveFrom: v.effectiveFrom, recipes });
        }
        versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        const bom = { versions, updatedAt: new Date().toISOString() };
        await saveBom(env, bom);
        return jsonResponse({ ...bom, skus: Object.keys(SKU_TABLE) });
    } catch (e) {
        return errResponse(e.message);
    }
}
