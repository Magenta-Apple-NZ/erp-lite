// Server-side freight calculation — mirrors the order form's recalcFreight so
// orders that never touch the form (e.g. PGG orders received via
// /api/orders/inbound) still get a courier freight line.
//
// Courier only: zone → the matching "Courier - <zone>" catalogue item (FR-01…),
// quantity = box count = Σ ceil(product qty ÷ units-per-box). Freight (the
// single variable-priced product) stays an operator judgement call.

import { loadItemsMap } from './catalog/items.js';
import { getStoresWithBootstrap } from './catalog/stores.js';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function isCourierLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    return /^FR-\d|COURIER|FREIGHT|CARTAGE|LABEL/.test(sku) || /courier|freight|cartage|\blabel/.test(desc);
}

// Resolve the order's ship-to to a store's courier zone. Prefer an exact
// customer+branch match, then branch-only, then a loose branch contains-match.
function resolveCourierZone(order, stores) {
    const cust = norm(order.customer?.name);
    const br   = norm(order.shipTo?.branch);
    if (!br && !cust) return '';
    let hit = (cust && br) ? stores.find(s => norm(s.customer) === cust && norm(s.branch) === br) : null;
    if (!hit && br) hit = stores.find(s => norm(s.branch) === br);
    if (!hit && br) hit = stores.find(s => { const b = norm(s.branch); return b && (b.includes(br) || br.includes(b)); });
    return hit ? String(hit.zoneCourier || '').trim() : '';
}

// The "Courier - <zone>" catalogue item for a zone, e.g. "Inner Island" → FR-02.
function freightItemForZone(zone, itemsList) {
    const z = norm(zone).replace(/^courier\s*-\s*/, '');
    if (!z) return null;
    return itemsList.find(i =>
        isCourierLine({ sku: i.id, description: i.name }) &&
        norm(i.name).replace(/^courier\s*-\s*/, '') === z
    ) || null;
}

// Boxes = Σ ceil(qty ÷ units-per-box) over product (non-freight) lines.
function boxCount(lines, itemsMap) {
    let boxes = 0;
    for (const l of lines || []) {
        if (isCourierLine(l)) continue;
        const qty = Number(l.quantity) || 0;
        if (qty <= 0) continue;
        const it  = itemsMap.get(String(l.sku || '').toUpperCase());
        const per = it && it.unitsPerBox > 0 ? it.unitsPerBox : 1;
        boxes += Math.ceil(qty / per);
    }
    return boxes;
}

// Compute a courier freight line to append to an order, or null when it
// shouldn't/can't be added (already has freight, pickup, export, no zone,
// no matching rate, or nothing to box).
export async function computeAutoFreightLine(env, order) {
    const lines = order?.lines || [];
    if (lines.some(isCourierLine)) return null;
    const method = String(order?.fulfilmentMethod || 'courier').toLowerCase();
    if (method === 'pickup') return null;
    if (order?.customer?.isExport) return null;

    const stores = await getStoresWithBootstrap(env).catch(() => []);
    const zone   = resolveCourierZone(order, stores || []);
    if (!zone) return null;

    const itemsMap = await loadItemsMap(env).catch(() => null);
    if (!itemsMap) return null;
    const item = freightItemForZone(zone, [...itemsMap.values()]);
    if (!item) return null;

    const boxes = boxCount(lines, itemsMap);
    if (boxes <= 0) return null;

    return {
        sku:         item.id,
        description: item.name,
        quantity:    boxes,
        unitPrice:   item.defaultPrice != null ? item.defaultPrice : 0,
        autoFreight: true,
    };
}
