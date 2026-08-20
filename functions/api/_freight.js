// Server-side freight/courier calculation — mirrors the order form so orders
// that never touch it (PGG orders via /api/orders/inbound) still get freight.
//
// Two independent store zones:
//   ZoneCourier  ∈ {Local, Inner, Outer, Inter}  → fixed FR-01..04 rate
//   ZoneFreight  = region (Auckland/Waikato, …)   → FR-05 per-box / FR-06 pallet
//
// Method is decided by box count (not a manual flag): courier up to ~14 boxes
// (1m²), freight beyond that; at 25 boxes a full pallet is charged on FR-06 and
// any remainder rides FR-05. A region with no freight rate (Local) stays on
// courier. Returns an array of 0..2 lines.
//
// INTERIM: rates are hard-coded from the pricing sheet (2026). Swap for a live
// fetch of the published freight tab (keyed on its zone_courier/zone_freight
// columns) when it's available. `min_pallet` (partial-pallet minimum) is not
// yet in the sheet — add it here + in the pallet branch once you have values.

import { loadItemsMap } from './catalog/items.js';
import { getStoresWithBootstrap } from './catalog/stores.js';

const COURIER_MAX_BOXES = 14;   // ~1m²; above this we freight
const BOXES_PER_PALLET  = 25;

// ZoneCourier label → fixed FR courier code + rate.
const COURIER_ZONES = {
    'local': { code: 'FR-01', price: 7,     name: 'Courier - Local' },
    'inner': { code: 'FR-02', price: 14.99, name: 'Courier - Inner Island' },
    'outer': { code: 'FR-03', price: 18.99, name: 'Courier - Outer Island' },
    'inter': { code: 'FR-04', price: 27.99, name: 'Courier - Inter Island' },
};

// ZoneFreight label → per-box freight rate + full-pallet price (2026).
const FREIGHT_ZONES = {
    'auckland/waikato':   { freight: 10.99, pallet: 275, region: 'Auckland/Waikato' },
    'northland':          { freight: 14.99, pallet: 375, region: 'Northland' },
    'hawkes bay':         { freight: 10.99, pallet: 275, region: 'Hawkes Bay' },
    'wellington/wairapa': { freight: 10.99, pallet: 275, region: 'Wellington/Wairarapa' },
    'south':              { freight: 19.99, pallet: 500, region: 'South Island' },
    'local':              { freight: 0,     pallet: 0,   region: 'Local' },
};

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function isCourierLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    return /^FR-\d|COURIER|FREIGHT|CARTAGE|LABEL/.test(sku) || /courier|freight|cartage|\blabel/.test(desc);
}

function resolveStore(order, stores) {
    const cust = norm(order?.customer?.name);
    const br   = norm(order?.shipTo?.branch);
    if (!br && !cust) return null;
    return (cust && br && stores.find(s => norm(s.customer) === cust && norm(s.branch) === br))
        || (br && stores.find(s => norm(s.branch) === br))
        || (br && stores.find(s => { const b = norm(s.branch); return b && (b.includes(br) || br.includes(b)); }))
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

    const cz = COURIER_ZONES[norm(store.zoneCourier)];
    const fz = FREIGHT_ZONES[norm(store.zoneFreight)];

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
    return out.length ? out : (cz ? [courierLine(cz, boxes)] : []);
}
