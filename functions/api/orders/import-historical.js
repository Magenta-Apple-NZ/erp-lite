// POST /api/orders/import-historical
//
// Body: the Prime Tie sales CSV (Month, Year, Financial Year, Date,
// Customer, Branch, PO#, Invoice, Prime Tie Bundles Volume,
// Prime Tie Loose Volume, eco Ties Volume).
//
// Server-side equivalent of scripts/import-historical.js. Each non-empty
// data row becomes one locked, historical order with id `HST-NNNN`
// (sequential by row, so re-running with the same CSV is idempotent —
// existing HST keys are overwritten in place, not duplicated).
//
// Defaults to a DRY RUN — parses the CSV, returns counts + year
// breakdown + a few sample orders, writes nothing. Add `?apply=true` to
// commit. Backups: a snapshot of the pre-write orders_index is saved to
// `backup:orders_index:<timestamp>` before any KV write.
//
// Edits-only safety doesn't apply here — this endpoint is specifically
// for ADDing HST-* orders and merging their ids into orders_index. It
// never touches existing PKS-* orders.

import { jsonResponse, errResponse } from '../_xero.js';

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

function parseNzDate(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    const dy = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let   yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
}

function parseNum(s) {
    if (s == null || s === '') return 0;
    const n = parseFloat(String(s).replace(/[,$\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

// Build the order objects + summary stats from a parsed CSV. Pure — no
// KV access — so the dry-run path can show the same numbers we'd write.
function buildOrders(rows) {
    if (rows.length < 2) {
        return { orders: [], skipped: { blank: 0, noDate: 0, noCustomer: 0, allZero: 0, cancelled: 0 }, byYear: {} };
    }
    const header = rows[0].map(h => h.trim());
    const findCol = pred => header.findIndex(pred);
    const dateCol     = findCol(h => h.toLowerCase() === 'date');
    const customerCol = findCol(h => h.toLowerCase() === 'customer');
    const branchCol   = findCol(h => h.toLowerCase() === 'branch');
    const poCol       = findCol(h => /^po#?$/i.test(h.trim()));
    const invCol      = findCol(h => h.toLowerCase() === 'invoice');
    // Column-name detection is tolerant of parentheses, plurals, and word
    // order — handles both "Prime Tie Bundles Volume" (old) and
    // "Prime Tie (Bundled) Volume" (current). Same idea for Loose / eco Ties.
    const bundleCol = findCol(h => {
        const l = h.toLowerCase();
        return l.includes('prime tie') && /bundle/.test(l) && l.includes('volume');
    });
    const looseCol = findCol(h => {
        const l = h.toLowerCase();
        return l.includes('prime tie') && /loose/.test(l) && l.includes('volume');
    });
    const ecoTieCol = findCol(h => {
        const l = h.toLowerCase();
        return /eco\s*ties?/.test(l) && l.includes('volume');
    });

    if (dateCol < 0 || customerCol < 0) {
        throw new Error('CSV missing required Date / Customer columns. Found headers: ' + header.join(', '));
    }

    const orders = [];
    const skipped = { blank: 0, noDate: 0, noCustomer: 0, allZero: 0, cancelled: 0 };
    let rowIndex = 0;

    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r.length || r.every(c => !String(c || '').trim())) { skipped.blank++; continue; }
        rowIndex++;

        const isoDate  = parseNzDate(r[dateCol]);
        const customer = (r[customerCol] || '').trim();
        const branch   = (r[branchCol]   || '').trim();
        if (!isoDate)  { skipped.noDate++;     continue; }
        if (!customer) { skipped.noCustomer++; continue; }

        const invoice = (r[invCol] || '').trim();
        if (invoice.toUpperCase() === 'CANCELLED') { skipped.cancelled++; continue; }

        const bundleKg = bundleCol >= 0 ? parseNum(r[bundleCol]) : 0;
        const looseKg  = looseCol  >= 0 ? parseNum(r[looseCol])  : 0;
        const ecoTieKg = ecoTieCol >= 0 ? parseNum(r[ecoTieCol]) : 0;

        if (bundleKg === 0 && looseKg === 0 && ecoTieKg === 0) { skipped.allZero++; continue; }

        const lines = [];
        if (bundleKg !== 0) {
            lines.push({
                sku: 'PT-BUNDLE-10',
                description: 'Prime Tie Bundles (10kg)',
                quantity:    bundleKg / 10,
                kgPerUnit:   10,
                unitPrice:   0,
                accountCode: '200',
            });
        }
        if (looseKg !== 0) {
            lines.push({
                sku: 'PT-LOOSE-1',
                description: 'Prime Tie Loose (1kg)',
                quantity:    looseKg,
                kgPerUnit:   1,
                unitPrice:   0,
                accountCode: '200',
            });
        }
        if (ecoTieKg !== 0) {
            lines.push({
                sku: 'ECOTIE',
                description: 'eco Ties',
                quantity:    ecoTieKg,
                kgPerUnit:   1,
                unitPrice:   0,
                accountCode: '200',
            });
        }

        const id = `HST-${String(rowIndex).padStart(4, '0')}`;
        const ts = `${isoDate}T00:00:00.000Z`;

        orders.push({
            id,
            createdAt:    ts,
            updatedAt:    ts,
            dispatchedAt: ts,
            dispatchedBy: 'historical',
            status:       'dispatched',
            source:       'historical-import',
            locked:       true,
            historical:   true,
            customer:     { name: customer },
            shipTo:       { branch },
            poNumber:     (r[poCol] || '').replace(/\s+/g, ''),
            xeroInvoiceNumber: invoice,
            xeroInvoiceId:     null,
            lines,
            packingNotes: '',
            events: [{
                user:      'system',
                action:    'Imported from historical CSV',
                timestamp: new Date().toISOString(),
            }],
        });
    }

    const byYear = {};
    for (const o of orders) {
        const y = o.createdAt.slice(0, 4);
        if (!byYear[y]) byYear[y] = { count: 0, kg: 0 };
        byYear[y].count++;
        byYear[y].kg += o.lines.reduce((s, l) => s + l.quantity * l.kgPerUnit, 0);
    }

    return { orders, skipped, byYear };
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const csv = await request.text();
        if (!csv || !csv.trim()) return errResponse('Empty CSV body', 400);

        const rows = parseCsv(csv);
        const { orders, skipped, byYear } = buildOrders(rows);

        const negativeCount = orders.filter(o =>
            o.lines.some(l => l.quantity < 0)
        ).length;

        const summary = {
            csvRows: rows.length - 1,
            ordersToImport: orders.length,
            skipped,
            byYear,
            negativeLineOrders: negativeCount,
            sampleIds: orders.slice(0, 3).map(o => o.id),
        };

        if (!apply) {
            return jsonResponse({ mode: 'dry-run', summary });
        }

        // Apply: snapshot orders_index, write each HST order, update index.
        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        const indexBefore = await env.ORDERS_KV.get('orders_index') || '[]';
        await env.ORDERS_KV.put(`backup:orders_index:${backupTs}`, indexBefore);

        const existing = [...new Set(JSON.parse(indexBefore))];
        const existingSet = new Set(existing);
        const newIds = [];

        for (const o of orders) {
            await env.ORDERS_KV.put('order:' + o.id, JSON.stringify(o));
            if (!existingSet.has(o.id)) {
                newIds.push(o.id);
                existingSet.add(o.id);
            }
        }

        // Append HST ids to the end (live PKS-* orders stay at the front).
        const mergedIndex = [...existing, ...newIds];
        await env.ORDERS_KV.put('orders_index', JSON.stringify(mergedIndex));

        return jsonResponse({
            mode: 'apply',
            summary: {
                ...summary,
                backupTs,
                indexBefore: existing.length,
                indexAfter: mergedIndex.length,
                newlyAdded: newIds.length,
                overwritten: orders.length - newIds.length,
            },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
