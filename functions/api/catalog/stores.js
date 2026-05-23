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

const EDITABLE_FIELDS = ['customerCode', 'customer', 'branch', 'city', 'address', 'postcode', 'phone'];

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
    const codeCol   = col('customer code');
    const custCol   = col('customer');
    const branchCol = col('branch');
    const cityCol   = col('city');
    const addrCol   = col('street address');
    const postCol   = col('postcode');
    const phoneCol  = col('phone');

    let seq = startSeq;
    const out = [];
    for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r.length || !((custCol >= 0 && r[custCol]) || (branchCol >= 0 && r[branchCol]))) continue;
        out.push({
            id: 'store-' + String(seq++).padStart(4, '0'),
            customerCode: codeCol   >= 0 ? (r[codeCol]   || '').trim() : '',
            customer:     custCol   >= 0 ? (r[custCol]   || '').trim() : '',
            branch:       branchCol >= 0 ? (r[branchCol] || '').trim() : '',
            city:         cityCol   >= 0 ? (r[cityCol]   || '').trim() : '',
            address:      addrCol   >= 0 ? (r[addrCol]   || '').trim() : '',
            postcode:     postCol   >= 0 ? (r[postCol]   || '').trim() : '',
            phone:        phoneCol  >= 0 ? (r[phoneCol]  || '').trim() : '',
            archived:     false,
            source:       'sheet',
            createdAt:    new Date().toISOString(),
            updatedAt:    new Date().toISOString(),
        });
    }
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
            archived:     archivedCol >= 0 ? /^(true|1|yes)$/i.test((r[archivedCol] || '').trim()) : false,
            source:       sourceCol >= 0 ? ((r[sourceCol] || '').trim().toLowerCase() || 'sheet') : 'sheet',
        });
    }
    return out;
}

function storesToCsv(stores) {
    const headers = ['Id','CustomerCode','Customer','Branch','City','Address','Postcode','Phone','Archived','Source'];
    const lines = [headers.join(',')];
    for (const s of stores) {
        lines.push([
            s.id, s.customerCode, s.customer, s.branch, s.city, s.address,
            s.postcode, s.phone, s.archived ? 'true' : 'false', s.source || 'sheet',
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
async function getStoresWithBootstrap(env) {
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

            // Re-seed from the published Google Sheet (admin reset).
            if (body.action === 'reseed-from-sheet') {
                const csv = await fetchSheetCsv(env);
                const seeded = parseSheetCsv(csv);
                const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
                await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
                await saveStores(env, seeded);
                return jsonResponse({
                    action: 'reseed-from-sheet',
                    seeded: seeded.length,
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

        if (isRoundTrip) {
            const parsed = parseRoundTripCsv(csv);
            const byId = new Map(existing.map(s => [s.id, s]));
            const updates = [], adds = [];
            for (const row of parsed) {
                const prev = byId.get(row.id);
                if (!prev) { adds.push(row); continue; }
                const changed = EDITABLE_FIELDS.some(k => (prev[k] || '') !== (row[k] || ''))
                             || (!!prev.archived) !== (!!row.archived);
                if (changed) updates.push(row);
            }
            const summary = {
                mode: 'round-trip',
                csvRowsParsed: parsed.length,
                adds: adds.length,
                updates: updates.length,
                unchanged: parsed.length - adds.length - updates.length,
            };
            if (!apply) return jsonResponse({ mode: 'dry-run', summary });

            const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
            await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
            const nowIso = new Date().toISOString();
            for (const row of adds)    byId.set(row.id, { ...row, createdAt: nowIso, updatedAt: nowIso, source: row.source || 'hub' });
            for (const row of updates) byId.set(row.id, { ...byId.get(row.id), ...row, updatedAt: nowIso });
            const merged = [...byId.values()];
            await saveStores(env, merged);
            return jsonResponse({ mode: 'apply', summary: { ...summary, backupTs, totalRowsAfter: merged.length } });
        }

        // Seed mode — sheet CSV shape (no Id column). Replace all sheet-
        // sourced rows; preserve any hub-added stores.
        const seeded = parseSheetCsv(csv, nextSeq(existing.filter(s => s.source === 'hub')));
        const summary = {
            mode: 'seed',
            csvRowsParsed: seeded.length,
        };
        if (!apply) return jsonResponse({ mode: 'dry-run', summary });

        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        await env.ORDERS_KV.put(`backup:stores:${backupTs}`, JSON.stringify(existing));
        const hubRows = existing.filter(s => s.source === 'hub');
        const merged = [...seeded, ...hubRows];
        await saveStores(env, merged);
        return jsonResponse({
            mode: 'apply',
            summary: { ...summary, backupTs, hubRowsPreserved: hubRows.length, totalRowsAfter: merged.length },
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
