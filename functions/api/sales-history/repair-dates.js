// POST /api/sales-history/repair-dates
//
// One-shot migration: re-parses every row's `date` field with the robust
// date parser and rewrites `month`, `year`, `fy`, and a normalised `date`.
// Use this when a round-trip upload landed dates in a format my parser
// couldn't read (e.g. Excel reformatted ISO → D/M/YYYY on save), leaving
// month: undefined and year: a small number.
//
// Dry-run by default; ?apply=true commits with a snapshot of the
// pre-write sales_history blob in `backup:sales_history:<ts>`.

import { jsonResponse, errResponse } from '../_xero.js';

function parseAnyDate(s) {
    const raw = String(s || '').trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
        const yr = parseInt(iso[1], 10);
        const mo = parseInt(iso[2], 10);
        const dy = parseInt(iso[3], 10);
        if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
            return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
        }
    }
    const slash = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (slash) {
        let dy = parseInt(slash[1], 10);
        let mo = parseInt(slash[2], 10);
        let yr = parseInt(slash[3], 10);
        if (yr < 100) yr += 2000;
        if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
        return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    }
    return null;
}

function fyLabel(year, month) {
    const endY = month >= 4 ? year + 1 : year;
    const startY = endY - 1;
    return `${String(startY).slice(-2)}/${String(endY).slice(-2)}`;
}

function rowNeedsRepair(r) {
    const yrOk = Number.isInteger(r.year) && r.year >= 2000 && r.year <= 2100;
    const moOk = Number.isInteger(r.month) && r.month >= 1 && r.month <= 12;
    return !yrOk || !moOk;
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const raw = await env.ORDERS_KV.get('sales_history');
        const rows = raw ? JSON.parse(raw) : [];
        if (!rows.length) {
            return jsonResponse({ mode: apply ? 'apply' : 'dry-run', summary: { total: 0, repaired: 0, unparseable: 0 } });
        }

        const repaired = [];
        const unparseable = [];
        let unchangedCount = 0;

        for (const r of rows) {
            if (!rowNeedsRepair(r)) { unchangedCount++; continue; }
            const iso = parseAnyDate(r.date);
            if (!iso) { unparseable.push(r.id); continue; }
            const [yr, mo] = iso.split('-').map(n => parseInt(n, 10));
            repaired.push({ ...r, date: iso, month: mo, year: yr, fy: fyLabel(yr, mo) });
        }

        const summary = {
            total: rows.length,
            repaired: repaired.length,
            unparseable: unparseable.length,
            unchanged: unchangedCount,
            sampleUnparseable: unparseable.slice(0, 5),
            sampleRepaired: repaired.slice(0, 3).map(r => ({ id: r.id, date: r.date, year: r.year, month: r.month })),
        };

        if (!apply) {
            return jsonResponse({ mode: 'dry-run', summary });
        }

        // Apply: backup then write the fully-merged blob.
        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        await env.ORDERS_KV.put(`backup:sales_history:${backupTs}`, JSON.stringify(rows));

        const byId = new Map(rows.map(r => [r.id, r]));
        for (const r of repaired) byId.set(r.id, r);
        const merged = [...byId.values()];
        await env.ORDERS_KV.put('sales_history', JSON.stringify(merged));

        return jsonResponse({ mode: 'apply', summary: { ...summary, backupTs, totalRowsAfter: merged.length } });
    } catch (e) {
        return errResponse(e.message);
    }
}
