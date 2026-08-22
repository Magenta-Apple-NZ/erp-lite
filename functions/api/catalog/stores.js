// GET    /api/catalog/stores              — list (JSON)
// GET    /api/catalog/stores?format=csv   — CSV download
// GET    /api/catalog/stores?archived=true— include archived rows
// POST   /api/catalog/stores              — bulk CSV (seed or round-trip, auto-detected)
//                                            OR JSON action: add / reseed-from-sheet
//
// The Hub now owns the stores list. Source data (Google Sheet) is used
// only as the one-time seed bootstrap; from then on the KV blob is the
// source of truth. UI in Catalogue → Stores can view / edit / add /
// archive / round-trip via CSV.

import { jsonResponse, errResponse } from '../_xero.js';

const STORES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf_VXDqVAC5KqHJZTil7H-2MoeK5lSqx5OWmCaigi6Xn7wNdznlp0mS-D5rgI35-X4Vh-itflowh1j/pub?gid=1005144257&single=true&output=csv';

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

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const EDITABLE_FIELDS = ['customerCode', 'customer', 'branch', 'city', 'address', 'postcode', 'phone', 'zoneCourier', 'zoneFreight'];

// Stable identity for a store, used to merge sheet re-seeds without clobbering
// Hub edits or shuffling ids. Prefer the customer code; fall back to
// customer+branch. Independent of the row-order `store-NNNN` id.
function storeKey(s) {
    const code = (s.customerCode || '').trim().toLowerCase();
    if (code) return 'code:' + code;
    return 'cb:' + ((s.customer || '') + '|' + (s.branch || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Non-destructive merge of parsed sheet rows into the existing KV list:
// update matched rows' fields (non-blank wins), add new rows with fresh ids,
// keep unmatched Hub rows, never delete. Returns { merged, added, updated }.
function mergeSeed(existing, incoming) {
    const byKey = new Map(existing.map(s => [storeKey(s), s]));
    const now = new Date().toISOString();
    let seq = nextSeq(existing), added = 0, updated = 0;
    for (const row of incoming) {
        const k = storeKey(row);
        const prev = byKey.get(k);
        if (prev) {
            const next = { ...prev };
            for (const f of EDITABLE_FIELDS) {
                if (row[f] != null && String(row[f]).trim() !== '') next[f] = row[f];
            }
            next.updatedAt = now;
            byKey.set(k, next);
            updated++;
        } else {
            byKey.set(k, { ...row, id: 'store-' + String(seq++).padStart(4, '0'), createdAt: now, updatedAt: now, source: 'sheet' });
            added++;
        }
    }
    return { merged: [...byKey.values()], added, updated };
}

// Parse the legacy Google-Sheet shape: "Customer Code, Customer, Branch,
// City, Street Address, Postcode, Phone". Used for the bootstrap seed
// and the "Re-seed from Sheet" admin action.
async function fetchSheetCsv(env) {
    const url = (env && env.CATALOG_STORES_CSV_URL) || STORES_CSV_URL;
    const resp = await fetch(url, { cf: {} });
    if (!resp.ok) throw new Error('Sheet fetch failed: ' + resp.status);
    return resp.text();
}

function parseSheetCsv(csv, startSeq = 1) {
    const rows = parseCsv(csv);
    if (!rows.length) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    const col = name => header.indexOf(name.toLowerCase());
    // The Store ID is the stable dedup key. Accept a dedicated Store ID column
    // or the Customer Code (same role). Rows without one are skipped so an
    // ID-less row can never fall back to fuzzy customer+branch matching and
    // spawn a duplicate on every re-seed.
    const codeCol   = [col('store id'), col('storeid'), col('customer code'), col('customercode')].find(i => i >= 0) ?? -1;
    const custCol   = col('customer');
    const branchCol = col('branch');
    const cityCol   = col('city');
    const addrCol   = col('street address');
    const postCol   = col('postcode');
    const phoneCol  = col('phone');
    // Optional courier/freight zone columns (either casing).
    const zcCol     = [col('zone_courier'), col('zone courier')].find(i => i >= 0) ?? -1;
    const zfCol     = [col('zone_freight'), col('zone freight')].find(i => i >= 0) ?? -1;

    let seq = startSeq, skippedNoId = 0;
    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        // Ignore fully-blank rows.
        if (!r.length || r.every(c => !String(c || '').trim())) continue;
        // A row must carry a Store ID (customer code). No ID → skip it, rather
        // than create an unkeyed row that duplicates on the next seed.
        const code = codeCol >= 0 ? String(r[codeCol] || '').trim() : '';
        if (!code) { skippedNoId++; continue; }
        out.push({
            id: 'store-' + String(seq++).padStart(4, '0'),
            customerCode: code,
            customer:     custCol   >= 0 ? (r[custCol]   || '').trim() : '',
            branch:       branchCol >= 0 ? (r[branchCol] || '').trim() : '',
            city:         cityCol   >= 0 ? (r[cityCol]   || '').trim() : '',
            address:      addrCol   >= 0 ? (r[addrCol]   || '').trim() : '',
            postcode:     postCol   >= 0 ? (r[postCol]   || '').trim() : '',
            phone:        phoneCol  >= 0 ? (r[phoneCol]  || '').trim() : '',
            zoneCourier:  zcCol     >= 0 ? (r[zcCol]     || '').trim() : '',
            zoneFreight:  zfCol     >= 0 ? (r[zfCol]     || '').trim() : '',
            archived:     false,
            source:       'sheet',
            createdAt:    new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        });
    }
    // Expose how many rows were dropped for lack of a Store ID so the UI can
    // warn (property on the array; ignored by callers that don't read it).
    out.skippedNoId = skippedNoId;
    return out;
}

// Detect whether an uploaded CSV is the original sheet shape (no Id
// column) or our own export (Id + Source columns) for round-trip edits.
function looksLikeRoundTrip(headerCells) {
    const lower = headerCells.map(h => h.trim().toLowerCase());
    return lower.includes('id') && lower.some(h => h === 'source');
}

function parseRoundTripCsv(csv) {
    const rows = parseCsv(csv);
    if (!rows.length) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    const col = name => header.indexOf(name);
    const idCol       = col('id');
    const codeCol     = col('customercode');
    const custCol     = col('customer');
    const branchCol   = col('branch');
    const cityCol     = col('city');
    const addrCol     = col('address');
    const postCol     = col('postcode');
    const phoneCol    = col('phone');
    const zcCol       = [col('zonecourier'), col('zone_courier')].find(i => i >= 0) ?? -1;
    const zfCol       = [col('zonefreight'), col('zone_freight')].find(i => i >= 0) ?? -1;
    const archivedCol = col('archived');
    const sourceCol   = col('source');

    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r.length || r.every(c => !String(c || '').trim())) continue;
        const id = idCol >= 0 ? (r[idCol] || '').trim() : '';
        if (!id) continue; // skip rows without id in round-trip
        out.push({
            id,
            customerCode: codeCol   >= 0 ? (r[codeCol]   || '').trim() : '',
            customer:     custCol   >= 0 ? (r[custCol]   || '').trim() : '',
            branch:       branchCol >= 0 ? (r[branchCol] || '').trim() : '',
            city:         cityCol   >= 0 ? (r[cityCol]   || '').trim() : '',
            address:      addrCol   >= 0 ? (r[addrCol]   || '').trim() : '',
            postcode:     postCol   >= 0 ? (r[postCol]   || '').trim() : '',
            phone:        phoneCol  >= 0 ? (r[phoneCol]  || '').trim() : '',
            zoneCourier:  zcCol     >= 0 ? (r[zcCol]     || '').trim() : '',
            zoneFreight:  zfCol     >= 0 ? (r[zfCol]     || '').trim() : '',
            archived:     archivedCol >= 0 ? /^(true|1|yes)$/i.test((r[archivedCol] || '').trim()) : false,
            source:       sourceCol >= 0 ? ((r[sourceCol] || '').trim().toLowerCase() || 'sheet') : 'sheet',
        });
    }
    return out;
}

function storesToCsv(stores) {
    const headers = ['Id','CustomerCode','Customer','Branch','City','Address','Postcode','Phone','ZoneCourier','ZoneFreight','Archived','Source'];
    const lines = [headers.join(',')];
    for (const s of stores) {
        lines.push([
            s.id, s.customerCode, s.customer, s.branch, s.city, s.address,
            s.postcode, s.phone, s.zoneCourier || '', s.zoneFreight || '',
            s.archived ? 'true' : 'false', s.source || 'sheet',
        ].map(csvEscape).join(','));
    }
    return lines.join('\n') + '\n';
}

async function loadStores(env) {
    const raw = await env.ORDERS_KV.get('stores');
    return raw ? JSON.parse(raw) : null;
}

async function saveStores(env, stores) {
    await env.ORDERS_KV.put('stores', JSON.stringify(stores));
}

function nextSeq(stores) {
    let max = 0;
    for (const s of stores) {
        const m = String(s.id || '').match(/^store-(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
}

// On GET when the KV blob is empty, seed it from the sheet so the first
// request returns useful data and subsequent edits land in KV.
export async function getStoresWithBootstrap(env) {
    let stores = await loadStores(env);
    if (stores) return stores;
    try {
        const csv = await fetchSheetCsv(env);
        stores = parseSheetCsv(csv);
        if (stores.length) {
            await saveStores(env, stores);
        }
    } catch (e) {
        return [];
    }
    return stores || [];
}

export async function onRequestGet({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const includeArchived = searchParams.get('archived') === 'true';
        const all = await getStoresWithBootstrap(env);
        const visible = includeArchived ? all : all.filter(s => !s.archived);

        if (searchParams.get('format') === 'csv') {
            return new Response(storesToCsv(visible), {
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="stores.csv"',
                },
            });
        }
        return jsonResponse(visible);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';
        const contentType = request.headers.get('Content-Type') || '';

        // JSON body — single-row CRUD or admin actions.
        if (contentType.includes('application/json')) {
            const body = await request.json();
            const existing = (await loadStores(env)) || [];

            // Re-seed from the published Google Sheet — non-destructive merge
            // keyed on customerCode/customer+branch. Sheet values update matched
            // stores, new rows are added, Hub-only stores are preserved.
            if (body.action === 'reseed-from-sheet') {
                const csv = await fetchSheetCsv(env);
                const seeded = parseSheetCsv(csv);
                const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
                await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
                const { merged, added, updated } = mergeSeed(existing, seeded);
                await saveStores(env, merged);
                return jsonResponse({
                    action: 'reseed-from-sheet',
                    seeded: seeded.length,
                    skippedNoId: seeded.skippedNoId || 0,
                    added, updated,
                    preserved: merged.length - added,
                    totalRowsAfter: merged.length,
                    backupTs,
                });
            }

            // Hard-delete stores by exact id (bulk). Unlike the per-row DELETE
            // (which only archives), this permanently removes the rows from KV —
            // for clearing accidental duplicates. Backs up first. Matches by
            // exact id regardless of archived state or shared business key.
            if (body.action === 'delete-ids') {
                const ids = Array.isArray(body.ids) ? body.ids.map(x => String(x).trim()).filter(Boolean) : [];
                if (!ids.length) return errResponse('ids array is required', 400);
                const idSet = new Set(ids);
                const remaining = existing.filter(s => !idSet.has(s.id));
                const removed = existing.length - remaining.length;
                const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
                await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
                await saveStores(env, remaining);
                return jsonResponse({
                    action: 'delete-ids',
                    requested: ids.length,
                    removed,
                    missing: ids.filter(id => !existing.some(s => s.id === id)),
                    totalRowsAfter: remaining.length,
                    backupTs,
                });
            }

            // Add a new store (manual entry in the UI).
            if (body.action === 'add') {
                const s = body.store || {};
                const now = new Date().toISOString();
                const created = {
                    id: 'store-' + String(nextSeq(existing)).padStart(4, '0'),
                    customerCode: (s.customerCode || '').trim(),
                    customer:     (s.customer     || '').trim(),
                    branch:       (s.branch       || '').trim(),
                    city:         (s.city         || '').trim(),
                    address:      (s.address      || '').trim(),
                    postcode:     (s.postcode     || '').trim(),
                    phone:        (s.phone        || '').trim(),
                    zoneCourier:  (s.zoneCourier  || '').trim(),
                    zoneFreight:  (s.zoneFreight  || '').trim(),
                    archived:     false,
                    source:       'hub',
                    createdAt:    now,
                    updatedAt:    now,
                };
                if (!created.customer && !created.branch) {
                    return errResponse('Customer or Branch is required', 400);
                }
                existing.push(created);
                await saveStores(env, existing);
                return jsonResponse({ action: 'add', store: created });
            }

            return errResponse('Unknown action', 400);
        }

        // CSV body — bulk seed or round-trip edit, auto-detected.
        const csv = await request.text();
        if (!csv || !csv.trim()) return errResponse('Empty CSV body', 400);

        const headerLine = parseCsv(csv)[0] || [];
        const isRoundTrip = looksLikeRoundTrip(headerLine);
        const existing = (await loadStores(env)) || [];

        // Opt-in authoritative sync: prune existing stores not present in the
        // upload (removes deleted rows AND leftover same-key duplicates).
        const prune = searchParams.get('prune') === 'true';

        if (isRoundTrip) {
            const parsed = parseRoundTripCsv(csv);
            const byId  = new Map(existing.map(s => [s.id, s]));
            const byKey = new Map(existing.map(s => [storeKey(s), s]));
            const keptIds = new Set(); // existing stores an upload row maps to
            const updates = [], adds = [];
            for (const row of parsed) {
                // Match by id, then fall back to the stable business key
                // (customer code / customer+branch) so a re-imported row updates
                // its store even when the id column has drifted — rather than
                // being duplicated as a new record.
                const prev = (row.id && byId.get(row.id)) || byKey.get(storeKey(row)) || null;
                if (!prev) { adds.push(row); continue; }
                keptIds.add(prev.id);
                const changed = EDITABLE_FIELDS.some(k => (prev[k] || '') !== (row[k] || ''))
                             || (!!prev.archived) !== (!!row.archived);
                if (changed) updates.push({ prevId: prev.id, row });
            }
            // Anything not matched by an upload row is pruned when prune is on.
            const pruneIds = prune ? existing.filter(s => !keptIds.has(s.id)).map(s => s.id) : [];
            const summary = {
                mode: 'round-trip',
                csvRowsParsed: parsed.length,
                adds: adds.length,
                updates: updates.length,
                unchanged: parsed.length - adds.length - updates.length,
                pruned: pruneIds.length,
            };
            if (!apply) return jsonResponse({ mode: 'dry-run', summary });

            const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
            await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
            const nowIso = new Date().toISOString();
            let seq = nextSeq(existing);
            for (const row of adds) {
                // Keep the CSV's id if it's genuinely new, else mint one.
                const id = (row.id && !byId.has(row.id)) ? row.id : 'store-' + String(seq++).padStart(4, '0');
                byId.set(id, { ...row, id, createdAt: nowIso, updatedAt: nowIso, source: row.source || 'hub' });
                keptIds.add(id);
            }
            for (const { prevId, row } of updates) {
                byId.set(prevId, { ...byId.get(prevId), ...row, id: prevId, updatedAt: nowIso });
            }
            let merged = [...byId.values()];
            if (prune) merged = merged.filter(s => keptIds.has(s.id));
            await saveStores(env, merged);
            return jsonResponse({ mode: 'apply', summary: { ...summary, backupTs, totalRowsAfter: merged.length } });
        }

        // Seed mode — sheet CSV shape (no Id column). Non-destructive merge on
        // the stable key: update matched stores, add new rows, keep the rest.
        const seeded = parseSheetCsv(csv);
        const preview = mergeSeed(existing, seeded);
        const summary = {
            mode: 'seed',
            csvRowsParsed: seeded.length,
            skippedNoId: seeded.skippedNoId || 0,
            adds: preview.added,
            updates: preview.updated,
        };
        if (!apply) return jsonResponse({ mode: 'dry-run', summary });

        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
        await saveStores(env, preview.merged);
        return jsonResponse({
            mode: 'apply',
            summary: { ...summary, backupTs, totalRowsAfter: preview.merged.length },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
