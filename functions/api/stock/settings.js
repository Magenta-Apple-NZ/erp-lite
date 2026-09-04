// GET /api/stock/settings — engine settings (Stock-Rebuild.md §3.1)
// PUT /api/stock/settings — replace (validated)

import { jsonResponse, errResponse } from '../_xero.js';
import { isYmd } from '../_dates.js';
import { loadSettings, saveSettings, loadItems } from './_store.js';

export async function onRequestGet({ env }) {
    try {
        return jsonResponse(await loadSettings(env));
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPut({ env, request }) {
    try {
        const body = await request.json();
        const current = await loadSettings(env);
        const next = { ...current };

        if (body.stockEpoch !== undefined) {
            if (!isYmd(body.stockEpoch)) return errResponse('stockEpoch must be YYYY-MM-DD', 400);
            next.stockEpoch = body.stockEpoch;
        }
        for (const k of ['consumptionWindowDays', 'defaultLeadTimeDays', 'defaultSafetyDays', 'watchMultiplier']) {
            if (body[k] !== undefined) {
                const n = Number(body[k]);
                if (!isFinite(n) || n < 0 || (n === 0 && k !== 'defaultSafetyDays')) return errResponse(`${k} must be a positive number`, 400);
                next[k] = n;
            }
        }
        if (body.perDespatch !== undefined) {
            if (!Array.isArray(body.perDespatch)) return errResponse('perDespatch must be an array', 400);
            const items = await loadItems(env);
            const consumables = new Set(items.filter(i => i.class === 'consumable').map(i => i.id));
            for (const e of body.perDespatch) {
                if (!e || !consumables.has(e.consumableId)) return errResponse('perDespatch references unknown consumable: ' + (e && e.consumableId), 400);
                if (!(Number(e.qty) >= 0)) return errResponse('perDespatch qty must be ≥ 0', 400);
            }
            next.perDespatch = body.perDespatch.map(e => ({ consumableId: e.consumableId, qty: Number(e.qty) }));
        }
        if (body.valuation !== undefined && typeof body.valuation === 'object') {
            next.valuation = { ...current.valuation, ...body.valuation };
        }
        await saveSettings(env, next);
        return jsonResponse(next);
    } catch (e) {
        return errResponse(e.message);
    }
}
