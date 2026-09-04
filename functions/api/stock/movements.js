// GET  /api/stock/movements?itemId=&from=&to= — the ledger (§3.5)
// POST /api/stock/movements — append a manual adjustment / wastage /
//      correction. Append-only: mistakes are reversed with a correction
//      (pass correctsId), never edited or deleted.

import { jsonResponse, errResponse } from '../_xero.js';
import { isYmd, nzToday } from '../_dates.js';
import { loadMovements, appendMovement, loadItem, loadSettings, whoami, newId } from './_store.js';

const TYPES = ['adjustment', 'wastage', 'correction'];

export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const itemId = url.searchParams.get('itemId');
        const from = url.searchParams.get('from'), to = url.searchParams.get('to');
        const all = await loadMovements(env);
        let rows = itemId ? (all[itemId] || []) : Object.values(all).flat();
        if (from) rows = rows.filter(m => m.date >= from);
        if (to)   rows = rows.filter(m => m.date <= to);
        rows.sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
        return jsonResponse(rows);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const item = await loadItem(env, body.itemId);
        if (!item) return errResponse('Unknown itemId', 400);
        const type = body.type;
        if (!TYPES.includes(type)) return errResponse('type must be one of ' + TYPES.join(', '), 400);
        const date = body.date || nzToday();
        if (!isYmd(date)) return errResponse('date must be YYYY-MM-DD', 400);
        const settings = await loadSettings(env);
        if (date < settings.stockEpoch) return errResponse(`Movements start at the stock epoch (${settings.stockEpoch})`, 400);
        let qty = Number(body.qty);
        if (!isFinite(qty) || qty === 0) return errResponse('qty must be a non-zero number', 400);
        if (type === 'wastage') qty = -Math.abs(qty); // wastage always reduces stock
        const mov = {
            id: newId('mov'),
            itemId: item.id, unit: item.unit,
            date, qty: Math.round(qty * 100) / 100, type,
            reason: String(body.reason || '').trim(),
            correctsId: type === 'correction' ? (body.correctsId || null) : null,
            createdAt: new Date().toISOString(),
            createdBy: whoami(request),
        };
        await appendMovement(env, mov);
        return jsonResponse(mov, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}
