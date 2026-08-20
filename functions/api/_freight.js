// Server-side freight/courier calculation — mirrors the order form so orders
// that never touch it (PGG orders via /api/orders/inbound) still get a freight
// line. Rates are REGION-based: a store's zone label resolves to a region row
// giving courier_per_box, freight_per_box and a full_pallet price.
//
//   Courier  = boxes × courier_per_box            → FR-01..04 (nearest tier)
//   Freight  = boxes × freight_per_box            → FR-05 (Per Carton)
//   Pallet   = ceil(boxes/25) × full_pallet       → FR-06 (Per Pallet)
//
// The fulfilment method picks courier vs freight (default courier); freight
// auto-switches to pallet pricing once an order fills a pallet.
//
// INTERIM: the 2026 rates are hard-coded from the pricing sheet and matched on
// the region name. Once that tab is published for live reads and its
// zone_courier/zone_freight columns are filled, swap FREIGHT_RATES for a live
// fetch and match on those zone labels.

import { loadItemsMap } from './catalog/items.js';
import { getStoresWithBootstrap } from './catalog/stores.js';

const BOXES_PER_PALLET = 25;

// region, courier per box, freight per box, full-pallet price (2026).
const FREIGHT_RATES = [
    { region: 'Northland',               courier: 18.99, freight: 14.99, pallet: 375 },
    { region: 'Auckland/Waikato',        courier: 14.99, freight: 10.99, pallet: 275 },
    { region: 'Tauranga / Te Puke',      courier: 5,     freight: 0,     pallet: 0 },
    { region: 'Wider Bay of Plenty',     courier: 14.99, freight: 0,     pallet: 0 },
    { region: 'Hawkes Bay',              courier: 18.99, freight: 10.99, pallet: 275 },
    { region: 'Wellington/Wairapa',      courier: 18.99, freight: 10.99, pallet: 275 },
    { region: 'South Island',            courier: 27.99, freight: 19.99, pallet: 500 },
    { region: 'Christchurch / Cromwell', courier: 27.99, freight: 19.99, pallet: 500 },
];

// Courier FR codes by price tier — used as the Xero ItemCode; the actual unit
// price is the region rate, so this just picks the nearest-purpose code.
const COURIER_CODES = [
    { code: 'FR-01', price: 7 },
    { code: 'FR-02', price: 14.99 },
    { code: 'FR-03', price: 18.99 },
    { code: 'FR-04', price: 27.99 },
];

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function isCourierLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    return /^FR-\d|COURIER|FREIGHT|CARTAGE|LABEL/.test(sku) || /courier|freight|cartage|\blabel/.test(desc);
}

// Match an order's ship-to to a store (exact customer+branch, then branch).
function resolveStore(order, stores) {
    const cust = norm(order?.customer?.name);
    const br   = norm(order?.shipTo?.branch);
    if (!br && !cust) return null;
    return (cust && br && stores.find(s => norm(s.customer) === cust && norm(s.branch) === br))
        || (br && stores.find(s => norm(s.branch) === br))
        || (br && stores.find(s => { const b = norm(s.branch); return b && (b.includes(br) || br.includes(b)); }))
        || null;
}

// Region row for a store zone label (region name for now; zone_courier/
// zone_freight labels once the sheet is published).
function rateForZone(zoneLabel) {
    const z = norm(zoneLabel);
    if (!z) return null;
    return FREIGHT_RATES.find(r => norm(r.region) === z)
        || FREIGHT_RATES.find(r => { const rr = norm(r.region); return rr.includes(z) || z.includes(rr); })
        || null;
}

function nearestCourierCode(rate) {
    return COURIER_CODES.reduce((best, c) =>
        Math.abs(c.price - rate) < Math.abs(best.price - rate) ? c : best, COURIER_CODES[0]).code;
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

// Compute a courier/freight line to append, or null when it shouldn't/can't be
// added (already has freight, pickup, export, no store/zone, nothing to box).
export async function computeAutoFreightLine(env, order) {
    const lines = order?.lines || [];
    if (lines.some(isCourierLine)) return null;
    const method = String(order?.fulfilmentMethod || 'courier').toLowerCase();
    if (method === 'pickup') return null;
    if (order?.customer?.isExport) return null;

    const stores = await getStoresWithBootstrap(env).catch(() => []);
    const store  = resolveStore(order, stores || []);
    if (!store) return null;

    // Freight uses the store's freight zone, courier its courier zone; each
    // falls back to the other so a single filled zone still resolves.
    const zoneLabel = method === 'freight'
        ? (store.zoneFreight || store.zoneCourier)
        : (store.zoneCourier || store.zoneFreight);
    const rate = rateForZone(zoneLabel);
    if (!rate) return null;

    const itemsMap = await loadItemsMap(env).catch(() => null);
    const boxes = boxCount(lines, itemsMap);
    if (boxes <= 0) return null;

    if (method === 'freight') {
        if (boxes >= BOXES_PER_PALLET && rate.pallet > 0) {
            return { sku: 'FR-06', description: `Freight - Per Pallet (${rate.region})`,
                quantity: Math.ceil(boxes / BOXES_PER_PALLET), unitPrice: rate.pallet, autoFreight: true };
        }
        if (rate.freight > 0) {
            return { sku: 'FR-05', description: `Freight - ${rate.region}`,
                quantity: boxes, unitPrice: rate.freight, autoFreight: true };
        }
        // Freight not offered in this region — fall through to courier.
    }
    if (rate.courier > 0) {
        return { sku: nearestCourierCode(rate.courier), description: `Courier - ${rate.region}`,
            quantity: boxes, unitPrice: rate.courier, autoFreight: true };
    }
    return null;
}
