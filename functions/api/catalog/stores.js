// GET /api/catalog/stores
//
// Reads the stores catalog from a published Google Sheet (CSV view) instead
// of KV. Sheet is the single source of truth — no upload, no manual edits.
//
// Sheet headers expected:
//   Customer Code, Customer, Branch, City, Street Address, Postcode, Phone
// Mapped to the shape orders.js consumes:
//   { customerCode, customer, branch, city, address, postcode, phone }

import { jsonResponse, errResponse } from '../_xero.js';

const STORES_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf_VXDqVAC5KqHJZTil7H-2MoeK5lSqx5OWmCaigi6Xn7wNdznlp0mS-D5rgI35-X4Vh-itflowh1j/pub?gid=1005144257&single=true&output=csv';

// Same RFC-4180-ish CSV parser as items.js. Duplicated here rather than
// shared because each catalog endpoint is a self-contained worker file
// and the parser is small.
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

export async function onRequestGet({ env, request }) {
    try {
        const url = (env && env.CATALOG_STORES_CSV_URL) || STORES_CSV_URL;
        const { searchParams } = new URL(request.url);
        const bust = searchParams.has('bust');
        const resp = await fetch(url, { cf: bust ? {} : { cacheTtl: 60, cacheEverything: true } });
        if (!resp.ok) return errResponse('Sheet fetch failed: ' + resp.status, 502);
        const csv = await resp.text();
        const rows = parseCsv(csv);
        if (!rows.length) return jsonResponse([]);

        const header = rows[0].map(h => h.trim().toLowerCase());
        const col = name => header.indexOf(name.toLowerCase());
        const codeCol    = col('customer code');
        const custCol    = col('customer');
        const branchCol  = col('branch');
        const cityCol    = col('city');
        const addrCol    = col('street address');
        const postCol    = col('postcode');
        const phoneCol   = col('phone');

        const stores = rows.slice(1)
            .filter(r => r.length && ((custCol >= 0 && r[custCol]) || (branchCol >= 0 && r[branchCol])))
            .map(r => ({
                customerCode: codeCol   >= 0 ? (r[codeCol]   || '').trim() : '',
                customer:     custCol   >= 0 ? (r[custCol]   || '').trim() : '',
                branch:       branchCol >= 0 ? (r[branchCol] || '').trim() : '',
                city:         cityCol   >= 0 ? (r[cityCol]   || '').trim() : '',
                address:      addrCol   >= 0 ? (r[addrCol]   || '').trim() : '',
                postcode:     postCol   >= 0 ? (r[postCol]   || '').trim() : '',
                phone:        phoneCol  >= 0 ? (r[phoneCol]  || '').trim() : '',
            }));

        return jsonResponse(stores);
    } catch (e) {
        return errResponse(e.message);
    }
}
