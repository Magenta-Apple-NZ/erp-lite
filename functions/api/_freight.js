// Server-side freight/courier calculation — mirrors the order form so orders
// that never touch it (PGG orders via /api/orders/inbound) still get freight.
//
// Two independent store zones:
//   ZoneCourier  ∈ {Local, Inner, Outer, Inter}  → fixed FR-01..04 rate
//   ZoneFreight  = region (Auckland/Waikato, …)   → FR-05 per-box / FR-06 pallet
//
// Method is decided by box count (not a manual flag): courier up to ~14 boxes
// (1m²), freight beyond that; at 25 boxes a full pallet is charged on FR-06 and
// any remainder rides FR-05. A minimum (min_pallet, when set) floors the
// freight charge on FR-06. A region with no freight rate (Local) stays on
// courier. Returns an array of 0..2 lines.
//
// Freight REGION rates are read live from the published freight tab (same doc
// as items/stores). Courier rates stay fixed on FR-01..04 by zone.

import { loadItemsMap } from './catalog/items.js';
import { getStoresWithBootstrap } from './catalog/stores.js';

const COURIER_MAX_BOXES = 14;   // ~1m²; above this we freight
const BOXES_PER_PALLET  = 25;

const FREIGHT_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf_VXDqVAC5KqHJZTil7H-2MoeK5lSqx5OWmCaigi6Xn7wNdznlp0mS-D5rgI35-X4Vh-itflowh1j/pub?gid=764885648&single=true&output=csv';

// ZoneCourier label → fixed FR courier code + rate.
export const COURIER_ZONES = {
    'local': { code: 'FR-01', price: 7,     name: 'Courier - Local' },
    'inner': { code: 'FR-02', price: 14.99, name: 'Courier - Inner Island' },
    'outer': { code: 'FR-03', price: 18.99, name: 'Courier - Outer Island' },
    'inter': { code: 'FR-04', price: 27.99, name: 'Courier - Inter Island' },
};

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const num  = v => { const n = parseFloat(String(v ?? '').replace(/[,$\s]/g, '')); return isFinite(n) ? n : 0; };

// Store ZoneCourier labels are "Local" / "Inner Island" / "Outer Island" /
// "Inter Island" (see Catalogue → Stores); COURIER_ZONES is keyed on the
// first word so either the short or the full label resolves.
function courierZoneFor(label) {
    const key = norm(label).split(' ')[0];
    return COURIER_ZONES[key] || null;
}

// Minimal CSV parse (handles quoted fields).
function parseCsv(text) {
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], n = text[i + 1];
        if (q) { if (c === '"' && n === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
        else if (c === '"') q = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') { if (field.length || row.length) { row.push(field); rows.push(row); row = []; field = ''; } if (c === '\r' && n === '\n') i++; }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// Load the freight region rates for the current pricing year, keyed by region.
// Row: year, region, courier_per_box, freight_per_box, min_pallet, full_pallet,
// zone_courier, zone_freight.
export async function loadFreightRates(env) {
    const url = (env && env.CATALOG_FREIGHT_CSV_URL) || FREIGHT_CSV_URL;
    const resp = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!resp.ok) throw new Error('freight sheet fetch ' + resp.status);
    const rows = parseCsv(await resp.text());
    if (rows.length < 2) return [];
    const head = rows[0].map(h => norm(h));
    const col = name => head.indexOf(name);
    const c = { year: col('year'), region: col('region'), freight: col('freight_per_box'),
                min: col('min_pallet'), pallet: col('full_pallet'),
                zc: col('zone_courier'), zf: head.findIndex(h => h.startsWith('zone_fr')) };
    const parsed = rows.slice(1).filter(r => r.length && r[c.region]).map(r => ({
        year:      parseInt(r[c.year], 10) || 0,
        region:    (r[c.region] || '').trim(),
        freight:   c.freight >= 0 ? num(r[c.freight]) : 0,
        minPallet: c.min     >= 0 ? num(r[c.min])     : 0,
        pallet:    c.pallet  >= 0 ? num(r[c.pallet])  : 0,
        zoneFreight: c.zf >= 0 ? (r[c.zf] || '').trim() : '',
    }));
    // Latest year present that is ≤ the current calendar year (fallback: max).
    const yr = new Date().getFullYear();
    const years = [...new Set(parsed.map(p => p.year))].filter(Boolean);
    const useYear = years.filter(y => y <= yr).sort((a, b) => b - a)[0] || Math.max(...years, 0);
    return parsed.filter(p => p.year === useYear);
}

// Match a store's ZoneFreight label to a rate row: by the row's zone_freight
// join column first, then by region name (exact, then fuzzy).
// Region labels are compared ignoring spacing around "/" so "Auckland / Waikato"
// (stores) still matches "Auckland/Waikato" (freight tab).
const zkey = s => norm(s).replace(/\s*\/\s*/g, '/');

function rateForFreightZone(label, rates) {
    const z = zkey(label);
    if (!z) return null;
    return rates.find(r => r.zoneFreight && zkey(r.zoneFreight) === z)
        || rates.find(r => zkey(r.region) === z)
        || rates.find(r => { const rr = zkey(r.region); return rr.includes(z) || z.includes(rr); })
        || null;
}

function isCourierLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    return /^FR-\d|COURIER|FREIGHT|CARTAGE|LABEL/.test(sku) || /courier|freight|cartage|\blabel/.test(desc);
}

function resolveStore(order, stores) {
    const cust = norm(order?.customer?.name);
    const br   = norm(order?.shipTo?.branch);
    if (!br && !cust) return null;
    const live = (stores || []).filter(s => !s.archived);
    const sc = s => norm(s.customer), sb = s => norm(s.branch);
    return (cust && br && live.find(s => sc(s) === cust && sb(s) === br))
        // Portal branch names embed the store's customer label, e.g.
        // "Fruitfed Supplies Pukekohe" → customer "Fruitfed", branch "Pukekohe";
        // "Farmlands Retail - Pukekohe" → "Farmlands" / "Pukekohe". Match both
        // parts so same-town stores of different customers don't collide.
        || (br && live.find(s => sc(s) && sb(s) && br.includes(sc(s)) && br.includes(sb(s))))
        || (br && live.find(s => sb(s) === br))
        || (br && live.find(s => { const b = sb(s); return b && (b.includes(br) || br.includes(b)); }))
        || null;
}

// Boxes = Σ ceil(qty ÷ units-per-box) over product (non-freight) lines.
function boxCount(lines, itemsMap) {
    let boxes = 0;
    for (const l of lines || []) {
        if (isCourierLine(l)) continue;
        const qty = Number(l.quantity) || 0;
        if (qty <= 0) continue;
        const it  = itemsMap && itemsMap.get(String(l.sku || '').toUpperCase());
        const per = it && it.unitsPerBox > 0 ? it.unitsPerBox : 1;
        boxes += Math.ceil(qty / per);
    }
    return boxes;
}

const courierLine = (cz, boxes) =>
    ({ sku: cz.code, description: cz.name, quantity: boxes, unitPrice: cz.price, autoFreight: true });

// Compute the courier/freight line(s) to append, or [] when none apply.
export async function computeAutoFreightLines(env, order) {
    const lines = order?.lines || [];
    if (lines.some(isCourierLine)) return [];
    if (String(order?.fulfilmentMethod || '').toLowerCase() === 'pickup') return [];
    if (order?.customer?.isExport) return [];

    const stores = await getStoresWithBootstrap(env).catch(() => []);
    const store  = resolveStore(order, stores || []);
    if (!store) return [];

    const itemsMap = await loadItemsMap(env).catch(() => null);
    const boxes = boxCount(lines, itemsMap);
    if (boxes <= 0) return [];

    const cz = courierZoneFor(store.zoneCourier);
    const rates = await loadFreightRates(env).catch(() => []);
    const fz = rateForFreightZone(store.zoneFreight, rates);

    // Up to 1m² (or no freight rate available): courier.
    if (boxes <= COURIER_MAX_BOXES || !fz || fz.freight <= 0) {
        return cz ? [courierLine(cz, boxes)] : [];
    }

    // Freight: full pallets on FR-06, any remainder on FR-05.
    const out = [];
    let rem = boxes;
    if (fz.pallet > 0) {
        const pallets = Math.floor(boxes / BOXES_PER_PALLET);
        if (pallets > 0) {
            out.push({ sku: 'FR-06', description: `Freight - Per Pallet (${fz.region})`,
                quantity: pallets, unitPrice: fz.pallet, autoFreight: true });
            rem = boxes - pallets * BOXES_PER_PALLET;
        }
    }
    if (rem > 0) {
        out.push({ sku: 'FR-05', description: `Freight - ${fz.region}`,
            quantity: rem, unitPrice: fz.freight, autoFreight: true });
    }
    if (!out.length) return cz ? [courierLine(cz, boxes)] : [];

    // Minimum charge (e.g. 1m² floor): if the freight total is below the
    // region's min_pallet, charge that minimum on FR-06 instead.
    if (fz.minPallet > 0) {
        const total = out.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        if (total < fz.minPallet) {
            return [{ sku: 'FR-06', description: `Freight - Minimum (${fz.region})`,
                quantity: 1, unitPrice: fz.minPallet, autoFreight: true }];
        }
    }
    return out;
}
