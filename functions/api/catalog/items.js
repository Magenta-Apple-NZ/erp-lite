// GET /api/catalog/items
//
// Reads the items catalog from a published Google Sheet (CSV view) instead
// of KV. The sheet is the single source of truth — no upload UI, no manual
// edits in the Hub. Cloudflare's edge fetch cache (60s) absorbs load.
//
// Sheet headers expected: Id, Name, Unit Price, KG, 150+ kg, 500+ kg, 2000+ kg
// Mapped to the shape orders.js consumes:
//   { id, name, defaultPrice, kgPerUnit, pb1Quantity:150, pb1Price,
//     pb2Quantity:500, pb2Price, pb3Quantity:2000, pb3Price }
// KG is the kg-per-unit for the SKU (typically 10 for bundles, 1 for bags).

import { jsonResponse, errResponse } from '../_xero.js';

const ITEMS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf_VXDqVAC5KqHJZTil7H-2MoeK5lSqx5OWmCaigi6Xn7wNdznlp0mS-D5rgI35-X4Vh-itflowh1j/pub?gid=0&single=true&output=csv';

// Minimal RFC-4180-ish CSV parser. Handles quoted fields with embedded
// commas, doubled quotes ("") for literal quotes, and \r\n / \n line endings.
function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], next = text[i + 1];
        if (inQuotes) {
            if (c === '"' && next === '"') { field += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { field += c; }
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
            } else { field += c; }
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function num(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : null;
}

// Normalise the sheet's Type / Size labels to the canonical bucket keys used
// across sales history (independent dimensions: type x size = six products).
function normType(v) {
    const l = String(v || '').toLowerCase();
    if (/eco/.test(l))    return 'ecoTies';
    if (/bundle/.test(l)) return 'bundles';
    if (/loose/.test(l))  return 'loose';
    return null;
}
function normSize(v) {
    const l = String(v || '').toLowerCase().trim();
    if (/\b10\s*kg\b/.test(l) || l === '10') return 'tenKg';
    if (/\b1\s*kg\b/.test(l)  || l === '1')  return 'oneKg';
    return null;
}

function parseItemsCsv(csv) {
    const rows = parseCsv(csv);
    if (!rows.length) return [];
    const header = rows[0].map(h => h.trim().toLowerCase());
    const col = name => header.indexOf(name.toLowerCase());
    const idCol    = col('id');
    const nameCol  = col('name');
    const priceCol = col('unit price');
    const kgCol    = col('kg');
    const t1Col    = col('150+ kg');
    const t2Col    = col('500+ kg');
    const t3Col    = col('2000+ kg');
    const uxbCol   = [col('units per box'), col('per box'), col('unitsperbox'), col('box qty')].find(i => i >= 0) ?? -1;
    // Explicit product classification (independent of the SKU heuristics).
    const typeCol  = [col('type'), col('product type')].find(i => i >= 0) ?? -1;
    const sizeCol  = [col('size'), col('product size')].find(i => i >= 0) ?? -1;

    return rows.slice(1)
        .filter(r => r.length && ((idCol >= 0 && r[idCol]) || (nameCol >= 0 && r[nameCol])))
        .map(r => {
            const item = {
                id:           idCol    >= 0 ? (r[idCol]   || '').trim() : '',
                name:         nameCol  >= 0 ? (r[nameCol] || '').trim() : '',
                defaultPrice: priceCol >= 0 ? num(r[priceCol]) : null,
            };
            const kg = kgCol >= 0 ? num(r[kgCol]) : null;
            if (kg != null) item.kgPerUnit = kg;
            const uxb = uxbCol >= 0 ? num(r[uxbCol]) : null;
            if (uxb != null && uxb > 0) item.unitsPerBox = uxb;
            const type = typeCol >= 0 ? normType(r[typeCol]) : null;
            if (type) item.type = type;
            const size = sizeCol >= 0 ? normSize(r[sizeCol]) : null;
            if (size) item.size = size;
            const t1 = t1Col >= 0 ? num(r[t1Col]) : null;
            const t2 = t2Col >= 0 ? num(r[t2Col]) : null;
            const t3 = t3Col >= 0 ? num(r[t3Col]) : null;
            if (t1 != null) { item.pb1Quantity = 150;  item.pb1Price = t1; }
            if (t2 != null) { item.pb2Quantity = 500;  item.pb2Price = t2; }
            if (t3 != null) { item.pb3Quantity = 2000; item.pb3Price = t3; }
            return item;
        });
}

async function fetchItemsCsv(env, bust) {
    const url = (env && env.CATALOG_ITEMS_CSV_URL) || ITEMS_CSV_URL;
    const resp = await fetch(url, { cf: bust ? {} : { cacheTtl: 60, cacheEverything: true } });
    if (!resp.ok) throw new Error('Sheet fetch failed: ' + resp.status);
    return resp.text();
}

// SKU (uppercased) -> item, for server-side classification (the sales writer).
export async function loadItemsMap(env) {
    const csv = await fetchItemsCsv(env, false);
    const map = new Map();
    for (const it of parseItemsCsv(csv)) {
        if (it.id) map.set(it.id.toUpperCase(), it);
    }
    return map;
}

export async function onRequestGet({ env, request }) {
    try {
        const bust = new URL(request.url).searchParams.has('bust');
        const csv = await fetchItemsCsv(env, bust);
        return jsonResponse(parseItemsCsv(csv));
    } catch (e) {
        return errResponse(e.message, /Sheet fetch/.test(e.message) ? 502 : 500);
    }
}
