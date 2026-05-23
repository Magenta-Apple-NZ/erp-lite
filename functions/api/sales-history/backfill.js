// POST /api/sales-history/backfill
//
// One-shot: walks orders_index and writes a `source: 'hub'` row to
// sales_history for every Hub order, idempotent by order id. Used to
// catch up orders that pre-dated the Xero-push hook (commit 1687e88) or
// were created via inbound webhook + dispatched without going through
// /api/xero/push.
//
// Dry-run by default; ?apply=true commits. Apply backs up the current
// sales_history to `backup:sales_history:<ts>` first.

import { jsonResponse, errResponse } from '../_xero.js';
import { rowFromOrder } from './_writer.js';

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const indexRaw = await env.ORDERS_KV.get('orders_index');
        const ids = indexRaw ? [...new Set(JSON.parse(indexRaw))] : [];

        // Skip any leftover HST-* keys (we wipe those during the seed).
        const hubIds = ids.filter(id => !id.startsWith('HST-'));

        const histRaw = await env.ORDERS_KV.get('sales_history');
        const existing = histRaw ? JSON.parse(histRaw) : [];
        const existingById = new Map(existing.map(r => [r.id, r]));

        const orders = await Promise.all(
            hubIds.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))
        );

        const wouldAdd = [];
        const wouldUpdate = [];
        const skipped = { noOrder: 0, noProductKg: 0 };

        for (const o of orders) {
            if (!o) { skipped.noOrder++; continue; }
            const row = rowFromOrder(o);
            if (!row) { skipped.noProductKg++; continue; }
            const prev = existingById.get(row.id);
            if (!prev) {
                wouldAdd.push(row);
            } else {
                // Only flag as update if any tracked field differs — avoids
                // noise from re-running the backfill on already-synced rows.
                const changed = ['date','customer','branch','poNumber','invoice',
                                 'bundlesKg','looseKg','ecoTiesKg']
                    .some(k => (prev[k] ?? null) !== (row[k] ?? null));
                if (changed) wouldUpdate.push(row);
            }
        }

        const summary = {
            ordersScanned: hubIds.length,
            existingHubRows: existing.filter(r => r.source === 'hub').length,
            wouldAdd: wouldAdd.length,
            wouldUpdate: wouldUpdate.length,
            skipped,
            sampleAdd: wouldAdd.slice(0, 5).map(r => r.id),
            sampleUpdate: wouldUpdate.slice(0, 5).map(r => r.id),
        };

        if (!apply) {
            return jsonResponse({ mode: 'dry-run', summary });
        }

        // Apply: backup, then merge new + updated rows into sales_history.
        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        await env.ORDERS_KV.put(`backup:sales_history:${backupTs}`, JSON.stringify(existing));

        for (const row of wouldAdd) existingById.set(row.id, row);
        for (const row of wouldUpdate) existingById.set(row.id, row);
        const merged = [...existingById.values()];
        await env.ORDERS_KV.put('sales_history', JSON.stringify(merged));

        return jsonResponse({
            mode: 'apply',
            summary: {
                ...summary,
                backupTs,
                totalRowsAfter: merged.length,
            },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
