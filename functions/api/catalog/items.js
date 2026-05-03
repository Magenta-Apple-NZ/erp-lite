// GET /api/catalog/items
//
// Reads the items catalog from a published Google Sheet (CSV view) instead
// of KV. The sheet is the single source of truth — no upload UI, no manual
// edits in the Hub. Cloudflare's edge fetch cache (60s) absorbs load.
//
// Sheet headers expected: Id, Name, Unit Price, 150+ kg, 500+ kg, 2000+ kg
// Mapped to the shape orders.js consumes:
//   { id, name, defaultPrice, pb1Quantity:150, pb1Price, pb2Quantity:500,
//     pb2Price, pb3Quantity:2000, pb3Price }

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

export async function onRequestGet({ env }) {
    try {
        const url = (env && env.CATALOG_ITEMS_CSV_URL) || ITEMS_CSV_URL;
        const resp = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
        if (!resp.ok) return errResponse('Sheet fetch failed: ' + resp.status, 502);
        const csv = await resp.text();
        const rows = parseCsv(csv);
        if (!rows.length) return jsonResponse([]);

        // Locate columns by header name so column order can change in the
        // sheet without breaking the API.
        const header = rows[0].map(h => h.trim().toLowerCase());
        const col = name => header.indexOf(name.toLowerCase());
        const idCol    = col('id');
        const nameCol  = col('name');
        const priceCol = col('unit price');
        const t1Col    = col('150+ kg');
        const t2Col    = col('500+ kg');
        const t3Col    = col('2000+ kg');

        const items = rows.slice(1)
            .filter(r => r.length && ((idCol >= 0 && r[idCol]) || (nameCol >= 0 && r[nameCol])))
            .map(r => {
                const item = {
                    id:           idCol    >= 0 ? (r[idCol]   || '').trim() : '',
                    name:         nameCol  >= 0 ? (r[nameCol] || '').trim() : '',
                    defaultPrice: priceCol >= 0 ? num(r[priceCol]) : null,
                };
                const t1 = t1Col >= 0 ? num(r[t1Col]) : null;
                const t2 = t2Col >= 0 ? num(r[t2Col]) : null;
                const t3 = t3Col >= 0 ? num(r[t3Col]) : null;
                if (t1 != null) { item.pb1Quantity = 150;  item.pb1Price = t1; }
                if (t2 != null) { item.pb2Quantity = 500;  item.pb2Price = t2; }
                if (t3 != null) { item.pb3Quantity = 2000; item.pb3Price = t3; }
                return item;
            });

        return jsonResponse(items);
    } catch (e) {
        return errResponse(e.message);
    }
}
