// GET /api/sales/monthly[?format=csv]
//
// Returns the monthly kg totals, aggregated straight from the
// sales_history table. One source of truth: every consumer (dashboard
// mini-chart, imports forecast Recompute, CSV export) sees the same
// numbers because they all read this endpoint, which reads sales_history.
//
// No more sheet fetching. No more cutoff/weave logic. Historical rows
// (source: 'historical') and live Hub rows (source: 'hub') both
// contribute their per-row total kg = bundlesKg + looseKg + ecoTiesKg.

import { jsonResponse, errResponse } from '../_xero.js';

export async function onRequestGet({ env, request }) {
    try {
        const raw = await env.ORDERS_KV.get('sales_history');
        const rows = raw ? JSON.parse(raw) : [];

        const monthly = {};
        for (const r of rows) {
            const ym = `${r.year}-${String(r.month).padStart(2, '0')}`;
            const total = (Number(r.bundlesKg) || 0)
                        + (Number(r.looseKg)   || 0)
                        + (Number(r.ecoTiesKg) || 0);
            if (total === 0) continue;
            monthly[ym] = (monthly[ym] || 0) + total;
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

        return jsonResponse({ monthly });
    } catch (e) {
        return errResponse(e.message);
    }
}
