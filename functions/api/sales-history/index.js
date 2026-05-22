// GET    /api/sales-history              — JSON: { count, byYear, byMonth, rows? }
// GET    /api/sales-history?format=csv   — CSV download (same shape as seed input)
// POST   /api/sales-history              — seed from CSV; ?apply=true commits
//
// The denormalised sales-history table is one JSON array stored under the
// single KV key `sales_history`. Each row represents one sale (one row per
// invoice/order) with the three product volume columns the business cares
// about: PT Bundles, PT Loose, eco Ties.
//
// Source taxonomy:
//   source: 'historical'   — seeded from the legacy sales CSV (pre-cutoff)
//   source: 'hub'          — appended by the Hub when a live order is pushed
//                            to Xero (handled in functions/api/xero/push.js)
//
// On seed apply, historical rows are replaced wholesale; `hub` rows are
// preserved so a re-seed doesn't wipe live activity.

import { jsonResponse, errResponse } from '../_xero.js';

// ── CSV parsing (RFC-4180-ish) ──
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

// NZ financial year ends 31 Mar. April–Dec belong to FY ending the next year.
function fyLabel(year, month) {
    const endY = month >= 4 ? year + 1 : year;
    const startY = endY - 1;
    return `${String(startY).slice(-2)}/${String(endY).slice(-2)}`;
}

// Parse the historical Prime Tie sales CSV into sales rows. Throws on
// missing required columns. Returns { rows, skipped }.
function parseHistoricalCsv(csv) {
    const lines = parseCsv(csv);
    if (lines.length < 2) throw new Error('CSV has no data rows');

    const header = lines[0].map(h => h.trim());
    const findCol = pred => header.findIndex(pred);

    const dateCol     = findCol(h => h.toLowerCase() === 'date');
    const customerCol = findCol(h => h.toLowerCase() === 'customer');
    const branchCol   = findCol(h => h.toLowerCase() === 'branch');
    const poCol       = findCol(h => /^po#?$/i.test(h.trim()));
    const invCol      = findCol(h => h.toLowerCase() === 'invoice');
    // Column matching tolerates both old format ("Prime Tie Bundles Volume")
    // and the current "Prime Tie (Bundled) Volume" / "(Loose)" form.
    const bundleCol = findCol(h => {
        const l = h.toLowerCase();
        return l.includes('prime tie') && /bundle/.test(l) && l.includes('volume');
    });
    const looseCol = findCol(h => {
        const l = h.toLowerCase();
        return l.includes('prime tie') && /loose/.test(l) && l.includes('volume');
    });
    const ecoCol = findCol(h => {
        const l = h.toLowerCase();
        return /eco\s*ties?/.test(l) && l.includes('volume');
    });

    if (dateCol < 0 || customerCol < 0) {
        throw new Error('CSV missing required Date / Customer columns. Found: ' + header.join(', '));
    }

    const rows = [];
    const skipped = { blank: 0, noDate: 0, noCustomer: 0, cancelled: 0, allZero: 0 };
    let idx = 0;

    for (let i = 1; i < lines.length; i++) {
        const r = lines[i];
        if (!r.length || r.every(c => !String(c || '').trim())) { skipped.blank++; continue; }
        idx++;

        const isoDate = parseNzDate(r[dateCol]);
        if (!isoDate) { skipped.noDate++; continue; }
        const customer = (r[customerCol] || '').trim();
        if (!customer) { skipped.noCustomer++; continue; }

        const invoice = (r[invCol] || '').trim();
        if (invoice.toUpperCase() === 'CANCELLED') { skipped.cancelled++; continue; }

        const bundleKg = bundleCol >= 0 ? parseNum(r[bundleCol]) : 0;
        const looseKg  = looseCol  >= 0 ? parseNum(r[looseCol])  : 0;
        const ecoKg    = ecoCol    >= 0 ? parseNum(r[ecoCol])    : 0;
        if (bundleKg === 0 && looseKg === 0 && ecoKg === 0) { skipped.allZero++; continue; }

        const [yr, mo] = isoDate.split('-').map(n => parseInt(n, 10));
        rows.push({
            id:        'historical-' + String(idx).padStart(4, '0'),
            source:    'historical',
            date:      isoDate,
            month:     mo,
            year:      yr,
            fy:        fyLabel(yr, mo),
            customer,
            branch:    (r[branchCol] || '').trim(),
            poNumber:  (r[poCol] || '').replace(/\s+/g, ''),
            invoice,
            bundlesKg: bundleKg,
            looseKg,
            ecoTiesKg: ecoKg,
        });
    }

    return { rows, skipped };
}

function statsByYear(rows) {
    const out = {};
    for (const r of rows) {
        const y = String(r.year);
        if (!out[y]) out[y] = { count: 0, bundlesKg: 0, looseKg: 0, ecoTiesKg: 0 };
        out[y].count++;
        out[y].bundlesKg += Number(r.bundlesKg) || 0;
        out[y].looseKg   += Number(r.looseKg)   || 0;
        out[y].ecoTiesKg += Number(r.ecoTiesKg) || 0;
    }
    return out;
}

function statsByMonth(rows) {
    const out = {};
    for (const r of rows) {
        const ym = `${r.year}-${String(r.month).padStart(2, '0')}`;
        if (!out[ym]) out[ym] = 0;
        out[ym] += (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
    }
    return out;
}

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowsToCsv(rows) {
    const sorted = rows.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const out = [
        ['Date','Month','Year','Financial Year','Customer','Branch','PO#','Invoice',
         'Prime Tie Bundles kg','Prime Tie Loose kg','eco Ties kg','Source','Id'].join(',')
    ];
    for (const r of sorted) {
        out.push([
            r.date, r.month, r.year, r.fy,
            r.customer, r.branch, r.poNumber, r.invoice,
            r.bundlesKg, r.looseKg, r.ecoTiesKg,
            r.source, r.id,
        ].map(csvEscape).join(','));
    }
    return out.join('\n') + '\n';
}

async function loadAll(env) {
    const raw = await env.ORDERS_KV.get('sales_history');
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

export async function onRequestGet({ env, request }) {
    try {
        const rows = await loadAll(env);
        const { searchParams } = new URL(request.url);

        if (searchParams.get('format') === 'csv') {
            return new Response(rowsToCsv(rows), {
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="sales-history.csv"',
                },
            });
        }

        return jsonResponse({
            count: rows.length,
            byYear: statsByYear(rows),
            byMonth: statsByMonth(rows),
            // Only ship rows when explicitly requested — payload grows fast
            // and most consumers want aggregates.
            rows: searchParams.get('rows') === 'true' ? rows : undefined,
        });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const csv = await request.text();
        if (!csv || !csv.trim()) return errResponse('Empty CSV body', 400);

        const { rows: parsedRows, skipped } = parseHistoricalCsv(csv);
        const byYear = statsByYear(parsedRows);
        const negativeCount = parsedRows.filter(r =>
            r.bundlesKg < 0 || r.looseKg < 0 || r.ecoTiesKg < 0
        ).length;

        const summary = {
            csvRowsParsed: parsedRows.length,
            skipped,
            byYear,
            negativeRows: negativeCount,
            sampleIds: parsedRows.slice(0, 3).map(r => r.id),
        };

        if (!apply) {
            return jsonResponse({ mode: 'dry-run', summary });
        }

        // ── Apply ──
        // 1) Snapshot current sales_history + orders_index to backup keys
        // 2) Wipe HST-* legacy orders (the misstep this seed replaces)
        // 3) Replace historical rows in sales_history, preserve hub rows
        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');

        const existingHistory = await loadAll(env);
        await env.ORDERS_KV.put(
            `backup:sales_history:${backupTs}`,
            JSON.stringify(existingHistory)
        );

        let hstDeleted = 0;
        const indexRaw = await env.ORDERS_KV.get('orders_index');
        if (indexRaw) {
            await env.ORDERS_KV.put(`backup:orders_index:${backupTs}`, indexRaw);
            const ids = [...new Set(JSON.parse(indexRaw))];
            const hstIds = ids.filter(id => id.startsWith('HST-'));
            for (const id of hstIds) {
                await env.ORDERS_KV.delete('order:' + id);
                hstDeleted++;
            }
            const liveIds = ids.filter(id => !id.startsWith('HST-'));
            await env.ORDERS_KV.put('orders_index', JSON.stringify(liveIds));
        }

        const hubRows = existingHistory.filter(r => r.source === 'hub');
        const merged = [...parsedRows, ...hubRows];
        await env.ORDERS_KV.put('sales_history', JSON.stringify(merged));

        return jsonResponse({
            mode: 'apply',
            summary: {
                ...summary,
                backupTs,
                hstOrdersDeleted: hstDeleted,
                hubRowsPreserved: hubRows.length,
                totalRowsAfter: merged.length,
            },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
