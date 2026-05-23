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

// Parse any reasonable date string we might receive from a CSV column
// and return ISO `YYYY-MM-DD`. Handles:
//   - ISO: 2019-12-02
//   - NZ slash:  2/12/19, 02/12/2019  (DD/MM/[YY]YY)
//   - US slash (heuristic): treated as DD/MM only when the first part is > 12
//     so an actual US-format date that's ambiguous still parses as NZ.
function parseAnyDate(s) {
    const raw = String(s || '').trim();
    if (!raw) return null;

    // ISO YYYY-MM-DD (allow time suffix)
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
        const yr = parseInt(iso[1], 10);
        const mo = parseInt(iso[2], 10);
        const dy = parseInt(iso[3], 10);
        if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
            return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
        }
    }

    // D/M/Y or D-M-Y with 2- or 4-digit year. NZ convention is DD/MM.
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

// Legacy alias — historical-sales-CSV path still uses this name.
function parseNzDate(s) { return parseAnyDate(s); }

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

function statsBySource(rows) {
    const out = {};
    for (const r of rows) {
        const src = r.source || 'unknown';
        out[src] = (out[src] || 0) + 1;
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
            bySource: statsBySource(rows),
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

// Detect whether the upload is the original historical sales CSV (no
// Id column, kg in "Volume" columns) or a round-trip edit of our own
// export (has Id + Source columns). Each takes a different code path.
function looksLikeRoundTripExport(headerCells) {
    const lower = headerCells.map(h => h.trim().toLowerCase());
    return lower.includes('id') && lower.some(h => h === 'source');
}

// Parse our own export shape (one row per sale with id + source columns
// and per-product "kg" columns). Returns parsed rows ready to upsert.
function parseRoundTripExport(csv) {
    const lines = parseCsv(csv);
    if (lines.length < 2) throw new Error('CSV has no data rows');

    const header = lines[0].map(h => h.trim());
    const lower = header.map(h => h.toLowerCase());
    const col = name => lower.indexOf(name);

    const idCol       = col('id');
    const sourceCol   = col('source');
    const dateCol     = col('date');
    const monthCol    = col('month');
    const yearCol     = col('year');
    const customerCol = col('customer');
    const branchCol   = col('branch');
    const poCol       = col('po#');
    const invCol      = col('invoice');
    // Tolerate "Bundles kg" / "Bundles Volume" / "Bundled Volume" etc.
    const bundleCol = header.findIndex(h => {
        const l = h.toLowerCase();
        return /bundle/.test(l) && (l.includes('kg') || l.includes('volume'));
    });
    const looseCol = header.findIndex(h => {
        const l = h.toLowerCase();
        return /loose/.test(l) && (l.includes('kg') || l.includes('volume'));
    });
    const ecoCol = header.findIndex(h => {
        const l = h.toLowerCase();
        return /eco\s*ti/.test(l) && (l.includes('kg') || l.includes('volume'));
    });

    const rows = [];
    const skipped = { blank: 0, noId: 0, noDate: 0 };
    let nextHistIdx = 0;

    for (let i = 1; i < lines.length; i++) {
        const r = lines[i];
        if (!r.length || r.every(c => !String(c || '').trim())) { skipped.blank++; continue; }

        // Date column normalises ISO / NZ slash / Excel-reformatted alike.
        let isoDate = parseAnyDate(r[dateCol] || '');

        // Month and Year columns are first-class — if the user edits Month
        // or Year in the spreadsheet, those wins over what the Date column
        // says. The Date is then reconstructed using the day component
        // from the original Date + the user's month/year, so stored
        // `date`, `month`, and `year` always agree.
        const rawMonth = monthCol >= 0 ? String(r[monthCol] || '').trim() : '';
        const rawYear  = yearCol  >= 0 ? String(r[yearCol]  || '').trim() : '';
        let yr = NaN, mo = NaN, day = 1;
        if (isoDate) {
            [yr, mo, day] = isoDate.split('-').map(n => parseInt(n, 10));
        }
        if (rawMonth) {
            const m = parseInt(rawMonth, 10);
            if (m >= 1 && m <= 12) mo = m;
        }
        if (rawYear) {
            let y = parseInt(rawYear, 10);
            if (y > 0 && y < 100) y += 2000;
            if (y >= 1900 && y <= 2100) yr = y;
        }
        if (!Number.isInteger(yr) || !Number.isInteger(mo) || mo < 1 || mo > 12) {
            skipped.noDate++;
            continue;
        }
        // Rebuild a consistent ISO date so the stored row is internally
        // coherent regardless of which column the user edited.
        if (!day || day < 1 || day > 31) day = 1;
        isoDate = `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        let id = idCol >= 0 ? (r[idCol] || '').trim() : '';
        // Allow new rows (blank id) by minting a fresh historical id. Keeps
        // the workflow flexible for spreadsheet additions, not just edits.
        if (!id) {
            id = 'historical-edit-' + (++nextHistIdx).toString().padStart(4, '0');
        }
        const source = (sourceCol >= 0 ? (r[sourceCol] || '').trim().toLowerCase() : '')
                       || (id.startsWith('PKS-') ? 'hub' : 'historical');

        rows.push({
            id,
            source,
            date: isoDate,
            month: mo,
            year: yr,
            fy: fyLabel(yr, mo),
            customer: customerCol >= 0 ? (r[customerCol] || '').trim() : '',
            branch:   branchCol   >= 0 ? (r[branchCol]   || '').trim() : '',
            poNumber: poCol       >= 0 ? (r[poCol]       || '').trim() : '',
            invoice:  invCol      >= 0 ? (r[invCol]      || '').trim() : '',
            bundlesKg: bundleCol >= 0 ? parseNum(r[bundleCol]) : 0,
            looseKg:   looseCol  >= 0 ? parseNum(r[looseCol])  : 0,
            ecoTiesKg: ecoCol    >= 0 ? parseNum(r[ecoCol])    : 0,
        });
    }
    return { rows, skipped };
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const csv = await request.text();
        if (!csv || !csv.trim()) return errResponse('Empty CSV body', 400);

        // Branch on column shape: round-trip edit vs seed-from-source.
        const headerLine = parseCsv(csv)[0] || [];
        const isRoundTrip = looksLikeRoundTripExport(headerLine);

        if (isRoundTrip) {
            return await handleRoundTrip(env, csv, apply);
        }
        // Fall through to legacy seed mode (the original Prime Tie sales CSV).

        const { rows: parsedRows, skipped } = parseHistoricalCsv(csv);
        const byYear = statsByYear(parsedRows);
        const negativeCount = parsedRows.filter(r =>
            r.bundlesKg < 0 || r.looseKg < 0 || r.ecoTiesKg < 0
        ).length;

        const summary = {
            mode: 'seed',
            csvRowsParsed: parsedRows.length,
            skipped,
            byYear,
            negativeRows: negativeCount,
            sampleIds: parsedRows.slice(0, 3).map(r => r.id),
        };

        if (!apply) {
            return jsonResponse({ mode: 'dry-run', summary });
        }

        // ── Apply seed ──
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

// Round-trip edit flow: user downloads sales-history.csv, fixes things
// in a spreadsheet, uploads the file back. Match rows by id and update
// in place. Rows present in KV but absent from the upload are left
// alone (no deletes). Rows with a blank id are added as new historicals.
async function handleRoundTrip(env, csv, apply) {
    const { rows: parsed, skipped } = parseRoundTripExport(csv);
    const existing = await loadAll(env);
    const byId = new Map(existing.map(r => [r.id, r]));

    const updates = []; // id whose tracked fields changed
    const adds = [];    // id new to KV
    const tracked = ['date','customer','branch','poNumber','invoice',
                     'bundlesKg','looseKg','ecoTiesKg','source'];

    for (const row of parsed) {
        const prev = byId.get(row.id);
        if (!prev) { adds.push(row); continue; }
        const changed = tracked.some(k => (prev[k] ?? null) !== (row[k] ?? null));
        if (changed) updates.push(row);
    }

    const summary = {
        mode: 'round-trip',
        csvRowsParsed: parsed.length,
        skipped,
        adds: adds.length,
        updates: updates.length,
        unchanged: parsed.length - adds.length - updates.length,
        sampleAdds:    adds.slice(0, 5).map(r => r.id),
        sampleUpdates: updates.slice(0, 5).map(r => r.id),
    };

    if (!apply) return jsonResponse({ mode: 'dry-run', summary });

    const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
    await env.ORDERS_KV.put(`backup:sales_history:${backupTs}`, JSON.stringify(existing));

    for (const r of adds) byId.set(r.id, r);
    for (const r of updates) byId.set(r.id, r);
    const merged = [...byId.values()];
    await env.ORDERS_KV.put('sales_history', JSON.stringify(merged));

    return jsonResponse({
        mode: 'apply',
        summary: { ...summary, backupTs, totalRowsAfter: merged.length },
    });
}
