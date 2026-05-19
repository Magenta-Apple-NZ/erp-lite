// GET /api/sales/monthly[?format=csv]
//
// Returns the weaved monthly kg series — the single source of truth that
// drives the Sales History charts, the dashboard mini-chart, and any CSV
// export. Months before HUB_LIVE_YM come from the historical sales sheet
// (closed/audited); from HUB_LIVE_YM onward they come from Hub orders.
// This keeps every consumer in lock-step instead of each computing its
// own near-but-not-quite-matching number.

import { jsonResponse, errResponse } from '../_xero.js';

const HUB_LIVE_YM = '2026-04';

// ── CSV parser (RFC-4180-ish: handles quoted fields with embedded commas) ──
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], next = text[i + 1];
        if (inQuotes) {
            if (c === '"' && next === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (field.length || row.length) {
                    row.push(field);
                    rows.push(row);
                    row = []; field = '';
                }
                if (c === '\r' && next === '\n') i++;
            } else field += c;
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function parseNum(s) {
    if (s == null || s === '') return 0;
    const n = parseFloat(String(s).replace(/[,$\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

// NZ DD/MM/YY or DD/MM/YYYY → 'YYYY-MM' (returns null if unparseable).
function parseNzDateYm(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    let yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    const mo = parseInt(m[2], 10);
    if (mo < 1 || mo > 12) return null;
    return `${yr}-${String(mo).padStart(2, '0')}`;
}

// Mirror of the client-side lineKg. Catalog-stamped kgPerUnit wins; legacy
// text-parse fallback for "1kg"/"10kg"; otherwise 0 (freight/fees excluded).
function lineKg(l) {
    let kgPer;
    if (l && l.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) {
        kgPer = Number(l.kgPerUnit);
    } else {
        const text = `${l?.description || ''} ${l?.name || ''} ${l?.sku || ''}`;
        const m = text.match(/\b(10|1)\s*kg\b/i);
        kgPer = m ? Number(m[1]) : 0;
    }
    return (Number(l?.quantity) || 0) * kgPer;
}

async function fetchSheetMonthly(env) {
    const result = {};
    const raw = await env.ORDERS_KV.get('sales:config');
    const config = raw ? JSON.parse(raw) : null;
    const url = config?.sheetUrl;
    if (!url || !url.startsWith('https://docs.google.com/spreadsheets/')) return result;

    let resp;
    try {
        resp = await fetch(url, { headers: { 'User-Agent': 'EnvirowareHub/1.0' } });
    } catch (e) { return result; }
    if (!resp.ok) return result;

    const csv = await resp.text();
    const rows = parseCsv(csv);
    if (rows.length < 2) return result;

    const headers = rows[0].map(h => h.trim().toLowerCase());
    const dateCol = headers.findIndex(h => h === 'date');
    if (dateCol < 0) return result;

    // Any column header containing "volume" / "kg" / "weight" is treated as
    // a kg/qty column. Per-row total kg = sum across all such columns.
    const kgCols = headers
        .map((h, i) => /volume|\bkg\b|weight/.test(h) ? i : -1)
        .filter(i => i >= 0);
    if (!kgCols.length) return result;

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const ym = parseNzDateYm(r[dateCol]);
        if (!ym) continue;
        let rowKg = 0;
        for (const ci of kgCols) {
            const v = parseNum(r[ci]);
            if (v > 0) rowKg += v;  // ignore returns/credits (negative)
        }
        if (rowKg > 0) result[ym] = (result[ym] || 0) + rowKg;
    }
    return result;
}

async function fetchOrderMonthly(env) {
    const result = {};
    const indexRaw = await env.ORDERS_KV.get('orders_index');
    if (!indexRaw) return result;
    const ids = [...new Set(JSON.parse(indexRaw))];
    const orders = await Promise.all(
        ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))
    );
    for (const o of orders) {
        if (!o) continue;
        const ym = (o.createdAt || '').slice(0, 7);
        if (!ym || ym < HUB_LIVE_YM) continue;
        const kg = (o.lines || []).reduce((s, l) => s + lineKg(l), 0);
        if (kg > 0) result[ym] = (result[ym] || 0) + kg;
    }
    return result;
}

export async function onRequestGet({ env, request }) {
    try {
        const [sheet, orders] = await Promise.all([fetchSheetMonthly(env), fetchOrderMonthly(env)]);

        // Sheet for ym < HUB_LIVE_YM; orders own everything from cutoff onward.
        const monthly = {};
        for (const [ym, kg] of Object.entries(sheet)) {
            if (ym < HUB_LIVE_YM) monthly[ym] = kg;
        }
        for (const [ym, kg] of Object.entries(orders)) {
            monthly[ym] = kg;
        }

        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'csv') {
            const yms = Object.keys(monthly).sort();
            const lines = ['Month,KG'];
            for (const ym of yms) lines.push(`${ym},${Math.round(monthly[ym])}`);
            return new Response(lines.join('\n') + '\n', {
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="sales-monthly.csv"',
                },
            });
        }

        return jsonResponse({ monthly, cutoff: HUB_LIVE_YM });
    } catch (e) {
        return errResponse(e.message);
    }
}
