// GET /api/stock/counts/:id/valuation[?format=csv] — Enviroware-format
// dollar valuation of a committed count (§7). Uses the unitValue /
// accountCode snapshotted at commit, so an old count doesn't move when
// today's prices change. The engine never reads these numbers.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { loadCount, loadItems } from '../../_store.js';
import { valuationRows } from '../../_engine.js';

function csvField(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function niceDate(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${d} ${months[m - 1]} ${y}`;
}

export async function onRequestGet({ env, params, request }) {
    try {
        const count = await loadCount(env, params.id);
        if (!count) return errResponse('Count not found', 404);
        if (count.status !== 'committed') return errResponse('Valuation is only available for committed counts', 409);
        const items = await loadItems(env);
        const { rows, total } = valuationRows(count, items);
        const url = new URL(request.url);
        if (url.searchParams.get('format') !== 'csv') {
            return jsonResponse({ id: count.id, label: count.label, date: count.date, rows, total });
        }
        const lines = [
            'Enviroware LTD',
            `Stocktake,${csvField(count.label)}`,
            `As at,${niceDate(count.date)}`,
            '',
            'Active,Item Description,Account,Units,Unit Value,Net',
            ...rows.map(r => ['Y', csvField(r.description), csvField(r.accountCode), r.units, r.unitValue.toFixed(2), r.net.toFixed(2)].join(',')),
            `,,,,Total,${total.toFixed(2)}`,
        ];
        return new Response(lines.join('\r\n') + '\r\n', {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="stocktake-${count.date}.csv"`,
            },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
