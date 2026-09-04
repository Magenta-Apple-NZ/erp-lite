// GET    /api/stock/counts/:id — the count; drafts also get a live
//                                `expected` map {itemId: qty} at the count date
// PATCH  /api/stock/counts/:id — edit a draft (label, date, lines). Refused
//                                once committed.
// DELETE /api/stock/counts/:id — drafts only.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { isYmd } from '../../../_dates.js';
import { loadCount, saveCount, loadWorld, loadSettings, getJson, putJson, K } from '../../_store.js';
import { expectedForCount } from '../../_engine.js';

export async function onRequestGet({ env, params }) {
    try {
        const count = await loadCount(env, params.id);
        if (!count) return errResponse('Count not found', 404);
        if (count.status === 'committed') return jsonResponse(count);
        const world = await loadWorld(env);

        // Keep a draft in step with Settings → Stock: items added since the
        // draft was created are appended (so nothing is silently omitted),
        // and untouched lines for items since deactivated are dropped.
        const active = world.items.filter(i => i.active !== false);
        const have = new Set((count.lines || []).map(l => l.itemId));
        const blankLine = i => ({ itemId: i.id, counted: true, countedQty: null, expectedQty: null, varianceQty: null, variancePct: null, varianceReason: '', unitValue: null, accountCode: null });
        const added = active.filter(i => !have.has(i.id)).map(blankLine);
        const activeIds = new Set(active.map(i => i.id));
        const touched = l => l.countedQty != null || l.counted === false || (Array.isArray(l.lots) && l.lots.length) || (l.varianceReason || '').trim();
        const kept = (count.lines || []).filter(l => activeIds.has(l.itemId) || touched(l));
        if (added.length || kept.length !== (count.lines || []).length) {
            const order = Object.fromEntries(world.items.map((i, idx) => [i.id, idx]));
            count.lines = kept.concat(added).sort((a, b) => (order[a.itemId] ?? 999) - (order[b.itemId] ?? 999));
            count.updatedAt = new Date().toISOString();
            await saveCount(env, count);
        }

        const expected = count.date < world.settings.stockEpoch ? {} : expectedForCount(count, world);
        const units = Object.fromEntries(world.items.map(i => [i.id, i.unit]));
        return jsonResponse({ ...count, expected, units });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPatch({ env, params, request }) {
    try {
        const count = await loadCount(env, params.id);
        if (!count) return errResponse('Count not found', 404);
        const body = await request.json();
        if (count.status === 'committed') {
            // Frozen figures stay frozen; only the label and the effective date
            // may change (the date moves the baseline, so it's a real change).
            const extra = Object.keys(body).filter(k => !['label', 'date'].includes(k));
            if (extra.length) return errResponse('Committed counts are frozen — only label and date can change', 409);
        }
        if (body.label !== undefined) count.label = String(body.label).trim() || count.label;
        if (body.date !== undefined) {
            if (!isYmd(body.date)) return errResponse('date must be YYYY-MM-DD', 400);
            const settings = await loadSettings(env);
            if (body.date < settings.stockEpoch) return errResponse(`Counts start at the stock epoch (${settings.stockEpoch})`, 400);
            count.date = body.date;
        }
        if (body.lines !== undefined) {
            if (!Array.isArray(body.lines)) return errResponse('lines must be an array', 400);
            const byId = Object.fromEntries((count.lines || []).map(l => [l.itemId, l]));
            for (const l of body.lines) {
                if (!l || !l.itemId) continue;
                const cur = byId[l.itemId] || { itemId: l.itemId, counted: true, countedQty: null, expectedQty: null, varianceQty: null, variancePct: null, varianceReason: '', unitValue: null, accountCode: null };
                if (l.counted !== undefined) cur.counted = l.counted !== false;
                if (l.countedQty !== undefined) {
                    if (l.countedQty === null || l.countedQty === '') cur.countedQty = null;
                    else { const n = Number(l.countedQty); if (!isFinite(n)) return errResponse('countedQty must be a number for ' + l.itemId, 400); cur.countedQty = n; }
                }
                if (l.varianceReason !== undefined) cur.varianceReason = String(l.varianceReason || '');
                // Sub-count by shipment: [{ shipmentId, label, kg, unitCost|null }].
                // countedQty follows the sum while lots are present.
                if (l.lots !== undefined) {
                    if (l.lots === null || (Array.isArray(l.lots) && !l.lots.length)) {
                        delete cur.lots;
                    } else {
                        if (!Array.isArray(l.lots)) return errResponse('lots must be an array for ' + l.itemId, 400);
                        const lots = [];
                        for (const x of l.lots) {
                            const kg = Number(x?.kg);
                            if (!isFinite(kg) || kg < 0) return errResponse('lot kg must be a number ≥ 0 for ' + l.itemId, 400);
                            const cost = x.unitCost == null || x.unitCost === '' ? null : Number(x.unitCost);
                            if (cost != null && !isFinite(cost)) return errResponse('lot $/kg must be a number for ' + l.itemId, 400);
                            lots.push({ shipmentId: x.shipmentId || null, label: String(x.label || ''), kg, unitCost: cost });
                        }
                        cur.lots = lots;
                        cur.countedQty = Math.round(lots.reduce((s, x) => s + x.kg, 0) * 100) / 100;
                    }
                }
                byId[l.itemId] = cur;
            }
            // Keep the original line order; append any new items at the end.
            const order = (count.lines || []).map(l => l.itemId);
            for (const id of Object.keys(byId)) if (!order.includes(id)) order.push(id);
            count.lines = order.map(id => byId[id]);
        }
        count.updatedAt = new Date().toISOString();
        await saveCount(env, count);
        return jsonResponse(count);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestDelete({ env, params }) {
    try {
        const count = await loadCount(env, params.id);
        if (!count) return errResponse('Count not found', 404);
        if (count.status === 'committed') return errResponse('Committed counts cannot be deleted', 409);
        await env.ORDERS_KV.delete(K.count(params.id));
        const idx = await getJson(env, K.countsIndex, []);
        await putJson(env, K.countsIndex, idx.filter(e => e.id !== params.id));
        return jsonResponse({ deleted: params.id });
    } catch (e) {
        return errResponse(e.message);
    }
}
