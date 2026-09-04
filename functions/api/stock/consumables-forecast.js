// GET /api/stock/consumables-forecast?months=12 — when each consumable runs
// out, per scenario (Average / Good / Great), sharing the Imports seasonal
// sales forecast. See consumablesForecast() in _engine.js.

import { jsonResponse, errResponse } from '../_xero.js';
import { nzToday } from '../_dates.js';
import { loadWorld, getJson } from './_store.js';
import { consumablesForecast } from './_engine.js';

export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const months = Math.max(1, Math.min(24, parseInt(url.searchParams.get('months') || '12', 10) || 12));
        const [world, forecastCfg] = await Promise.all([loadWorld(env), getJson(env, 'import:forecast', null)]);
        const monthlyAvg = forecastCfg && Array.isArray(forecastCfg.monthlyAvg) ? forecastCfg.monthlyAvg : null;
        return jsonResponse(consumablesForecast(world, { monthlyAvg, today: nzToday(), months }));
    } catch (e) {
        return errResponse(e.message);
    }
}
