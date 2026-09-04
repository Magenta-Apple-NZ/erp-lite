// GET  /api/stock/counts — list (newest first)
// POST /api/stock/counts — create a draft, pre-populated with every active
//                          item so omission is deliberate (Stock-Rebuild.md §3.4)

import { jsonResponse, errResponse } from '../../_xero.js';
import { isYmd, nzToday } from '../../_dates.js';
import { loadCountsIndex, loadItems, loadSettings, saveCount, whoami } from '../_store.js';

export async function onRequestGet({ env }) {
    try {
        return jsonResponse(await loadCountsIndex(env));
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json().catch(() => ({}));
        const date = body.date || nzToday();
        if (!isYmd(date)) return errResponse('date must be YYYY-MM-DD', 400);
        const settings = await loadSettings(env);
        if (date < settings.stockEpoch) return errResponse(`Counts start at the stock epoch (${settings.stockEpoch})`, 400);
        const items = await loadItems(env);
        const count = {
            id: 'cnt_' + date.replace(/-/g, '') + '_' + Math.random().toString(36).slice(2, 6),
            label: String(body.label || '').trim() || `Count ${date}`,
            date,
            status: 'draft',
            createdAt: new Date().toISOString(),
            createdBy: whoami(request),
            committedAt: null, committedBy: null,
            lines: items.filter(i => i.active !== false).map(i => ({
                itemId: i.id, counted: true, countedQty: null,
                expectedQty: null, varianceQty: null, variancePct: null, varianceReason: '',
                unitValue: null, accountCode: null,
            })),
        };
        await saveCount(env, count);
        return jsonResponse(count, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}
