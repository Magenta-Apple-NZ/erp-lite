// GET  /api/stock/items — list (seeds the three products on first read)
// POST /api/stock/items — create an item (Stock-Rebuild.md §3.2)

import { jsonResponse, errResponse } from '../../_xero.js';
import { isYmd } from '../../_dates.js';
import { loadItems, loadItem, saveItem, slugify } from '../_store.js';

export const CLASSES = ['product', 'consumable'];
export const UNITS = ['kg', 'each'];
export const SALES_KEYS = ['bundles', 'loose', 'ecoTies'];

const num = v => (v == null || v === '' ? null : (isFinite(Number(v)) ? Number(v) : NaN));

// Shared field validation for create + patch. Returns { error } or { fields }.
export function validateItemFields(body, { partial = false } = {}) {
    const f = {};
    if (!partial || body.name !== undefined) {
        if (!body.name || !String(body.name).trim()) return { error: 'name is required' };
        f.name = String(body.name).trim();
    }
    if (!partial) {
        if (!CLASSES.includes(body.class)) return { error: 'class must be product or consumable' };
        if (!UNITS.includes(body.unit)) return { error: 'unit must be kg or each' };
        f.class = body.class; f.unit = body.unit;
    }
    if (body.active !== undefined) f.active = body.active !== false;
    // Unit type for "each" items — box, roll, bag, sheet… (display only)
    if (body.unitLabel !== undefined) f.unitLabel = String(body.unitLabel || '').trim().toLowerCase().slice(0, 30) || null;
    if (body.key !== undefined) f.key = !!body.key;
    if (body.sortOrder !== undefined) { const n = num(body.sortOrder); if (isNaN(n)) return { error: 'sortOrder must be a number' }; f.sortOrder = n ?? 0; }
    if (body.aliases !== undefined) {
        if (!Array.isArray(body.aliases)) return { error: 'aliases must be an array' };
        f.aliases = body.aliases.map(a => String(a).trim()).filter(Boolean);
    }
    if (body.accountCode !== undefined) f.accountCode = String(body.accountCode || '').trim();
    if (body.unitValue !== undefined) { const n = num(body.unitValue); if (isNaN(n)) return { error: 'unitValue must be a number' }; f.unitValue = n; }
    if (body.unitValueAsAt !== undefined) {
        if (body.unitValueAsAt && !isYmd(body.unitValueAsAt)) return { error: 'unitValueAsAt must be YYYY-MM-DD' };
        f.unitValueAsAt = body.unitValueAsAt || null;
    }
    if (body.salesKey !== undefined) {
        if (body.salesKey && !SALES_KEYS.includes(body.salesKey)) return { error: 'salesKey must be one of ' + SALES_KEYS.join(', ') };
        f.salesKey = body.salesKey || null;
    }
    if (body.profile !== undefined) {
        const p = body.profile || {};
        const lead = num(p.leadTimeDays), cost = num(p.typicalCost), pack = num(p.packSize), moq = num(p.minOrderQty);
        if ([lead, cost, pack, moq].some(n => isNaN(n))) return { error: 'profile numbers must be numeric' };
        f.profile = {
            retailer: String(p.retailer || '').trim(), retailerUrl: String(p.retailerUrl || '').trim(),
            supplierSku: String(p.supplierSku || '').trim(), imageUrl: String(p.imageUrl || '').trim(),
            leadTimeDays: lead, typicalCost: cost, packSize: pack, minOrderQty: moq,
            notes: String(p.notes || '').trim(),
        };
    }
    if (body.reorder !== undefined) {
        const r = body.reorder || {};
        const mode = r.mode === 'manual' ? 'manual' : 'auto';
        const point = num(r.manualPoint), safety = num(r.safetyDays), qty = num(r.reorderQty);
        if ([point, safety, qty].some(n => isNaN(n))) return { error: 'reorder numbers must be numeric' };
        f.reorder = { mode, manualPoint: point, safetyDays: safety, reorderQty: qty };
    }
    return { fields: f };
}

export async function onRequestGet({ env }) {
    try {
        return jsonResponse(await loadItems(env));
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const v = validateItemFields(body);
        if (v.error) return errResponse(v.error, 400);
        const id = slugify(body.id || body.name);
        if (!id) return errResponse('Could not derive an id from the name', 400);
        if (await loadItem(env, id)) return errResponse(`Item "${id}" already exists`, 409);
        const item = {
            id, active: true, key: false, sortOrder: 100, aliases: [],
            accountCode: '', unitValue: null, unitValueAsAt: null,
            salesKey: null, profile: null,
            reorder: { mode: 'auto', manualPoint: null, safetyDays: null, reorderQty: null },
            ...v.fields,
            createdAt: new Date().toISOString(),
        };
        if (item.class === 'consumable') item.salesKey = null;
        await saveItem(env, item);
        return jsonResponse(item, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}
