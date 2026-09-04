// Stock engine — pure functions over plain data. No KV, no fetch, no Date.now.
// Everything here is unit-testable (tests/stock-engine.test.js) and is the
// single place the dashboard, counts and reorder logic get their numbers.
//
// Units: a product item is kg, a consumable is each. They are never summed.
// Dates: 'YYYY-MM-DD' NZ-local strings, compared as strings. A count taken on
// day D is "as at end of D", so everything dated D is already inside it and
// ranges since a baseline are (D, asOf] — from exclusive, to inclusive.
//
// See Stock-Rebuild.md for the model.

import { addDays } from '../_dates.js';

export const DEFAULT_SETTINGS = {
    stockEpoch:            '2026-09-01',   // testing from 1 Sep 2026; go-live count 1 Oct
    consumptionWindowDays: 28,
    defaultLeadTimeDays:   14,   // consumables: days from ordering to delivery
    defaultSafetyDays:     7,
    watchMultiplier:       1.25,
    perDespatch:           [],   // pieces used once per order
    perLabel:              [],   // pieces used per courier label (Aramex physical labels — stopgap until Posthaste)
    valuation:             { defaultAccountCode: '1440', gstBasis: 'ex' },
};

// The only sales↔stock mapping in the system. Sheet SKU → the sales_history
// type×size kg bucket it lands in, its kg per sales unit, and the product
// bucket. `units sold = xkg[key] / kgPerUnit`.
export const SKU_TABLE = {
    'PT-b-10': { xkg: 'b10', kgPerUnit: 10, salesKey: 'bundles' },
    'PT-b-1b': { xkg: 'b1',  kgPerUnit: 1,  salesKey: 'bundles' },
    'PT-l-10': { xkg: 'l10', kgPerUnit: 10, salesKey: 'loose'   },
    'PT-l-1b': { xkg: 'l1',  kgPerUnit: 1,  salesKey: 'loose'   },
    'ET-b-10': { xkg: 'e10', kgPerUnit: 10, salesKey: 'ecoTies' },
    'ET-b-1b': { xkg: 'e1',  kgPerUnit: 1,  salesKey: 'ecoTies' },
};
export const SALES_KG_FIELD = { bundles: 'bundlesKg', loose: 'looseKg', ecoTies: 'ecoTiesKg' };

// Until shipments carry per-product lines, every shipment is Prime Tie Bundled.
export const SHIPMENT_PRODUCT_ID = 'prime-tie-bundled';

// Shipments arrive pre-stamped by the store (import/_cost.js): kgIn = kg that
// lands (yield kg for V3), unitCost = landed $/kg from cost lines, else the
// listed pricePerKg. These helpers are the only place the engine reads them.
export function shipKg(s) {
    if (Number(s?.kgIn) > 0) return Number(s.kgIn);
    return Number(s?.kg) || 0;
}
export function shipUnitCost(s) {
    if (Number(s?.unitCost) > 0) return Number(s.unitCost);
    if (Number(s?.pricePerKg) > 0) return Number(s.pricePerKg);
    return null;
}
// "#41" — the shipment number people use, from seq or the note/id.
export function shipNumber(s) {
    if (Number(s?.seq) > 0) return Number(s.seq);
    const m = String(s?.note || s?.id || '').match(/(\d+)/);
    return m ? Number(m[1]) : null;
}
export function shipLabel(s) {
    const n = shipNumber(s);
    return n != null ? `Shipment #${n}` : String(s?.note || s?.id || 'Shipment');
}

export const STATUS_ORDER = ['out', 'critical', 'low', 'watch', 'unknown', 'ok'];

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const r4 = n => Math.round((Number(n) || 0) * 10000) / 10000;

// (from, to] on 'YYYY-MM-DD' strings; either bound may be null/undefined.
export function inRange(date, from, to) {
    const d = String(date || '').slice(0, 10);
    if (!d) return false;
    if (from && d <= from) return false;
    if (to && d > to) return false;
    return true;
}

// ── Packaging recipes (BOM) ──────────────────────────────────────────────
// Latest version whose effectiveFrom ≤ date. No version → nothing consumes.
export function recipesFor(bom, date) {
    const versions = (bom?.versions || [])
        .filter(v => v && v.effectiveFrom && v.effectiveFrom <= date)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
    return versions[0]?.recipes || {};
}

// ── Consumption (derived from sales_history) ─────────────────────────────
// Returns { byItem: {itemId: qty}, rowCount, rowsWithoutXkg }. Product qty is
// kg; consumable qty is each, expanded through the recipe in force on the
// row's date. Rows before stockEpoch are ignored.
// Courier service SKUs — matrix rows so labels/satchels burn per consignment.
// Freight (FR-05+) is never a matrix row.
export const COURIER_SKUS = ['FR-01', 'FR-02', 'FR-03', 'FR-04'];

// Matrix cells are in PIECES (staples, labels…); stock is in UNITS (boxes,
// rolls). "Quantity per unit" (profile.packSize) converts: a 1,000-staple box
// with 2 staples per sale = 0.002 boxes per sale.
export function piecesPerUnit(items) {
    const out = {};
    for (const it of items || []) {
        if (it.class !== 'consumable') continue;
        const n = Number(it.profile?.packSize);
        out[it.id] = n > 0 ? n : 1;
    }
    return out;
}

// What ONE sales row (one order) consumes, per item: product kg from the
// type buckets; consumables from the matrix (pieces ÷ pieces per unit), plus
// the per-order and per-courier-label lists. Shared by consumption() and the
// per-item ledger so both always agree.
export function rowConsumption(r, { items, bom, settings, pieces, productBySalesKey, courierLabelIds }) {
    const out = {};
    const add = (id, q) => { if (id && q) out[id] = (out[id] || 0) + q; };
    const addPieces = (id, q) => add(id, q / (pieces[id] || 1));
    const d = String(r.date || '').slice(0, 10);
    for (const [salesKey, field] of Object.entries(SALES_KG_FIELD)) add(productBySalesKey[salesKey], Number(r[field]) || 0);
    const recipes = recipesFor(bom, d);
    let hasSplit = false;
    if (r.xkg && typeof r.xkg === 'object') {
        hasSplit = true;
        for (const [sku, t] of Object.entries(SKU_TABLE)) {
            const kg = Number(r.xkg[t.xkg]) || 0;
            if (!kg) continue;
            const units = kg / t.kgPerUnit;
            for (const e of recipes[sku] || []) addPieces(e.consumableId, units * (Number(e.qty) || 0));
        }
    }
    for (const e of settings?.perDespatch || []) addPieces(e.consumableId, Number(e.qty) || 0);
    // Courier labels: the labels invoiced on the order deplete every
    // courier-label consumable one piece per label (plus any legacy perLabel).
    const labels = Number(r.labels) || 0;
    if (labels > 0) {
        for (const id of courierLabelIds || []) addPieces(id, labels);
        for (const e of settings?.perLabel || []) addPieces(e.consumableId, labels * (Number(e.qty) || 0));
    }
    return { byItem: out, hasSplit };
}

function consumptionContext(items, bom, settings) {
    const productBySalesKey = {};
    const courierLabelIds = [];
    for (const it of items || []) {
        if (it.class === 'product' && it.salesKey) productBySalesKey[it.salesKey] = it.id;
        if (it.class === 'consumable' && it.courierLabel) courierLabelIds.push(it.id);
    }
    return { items, bom, settings, pieces: piecesPerUnit(items), productBySalesKey, courierLabelIds };
}

export function consumption({ rows, items, bom, settings, from, to }) {
    const byItem = {};
    const ctx = consumptionContext(items, bom, settings);
    const epoch = settings?.stockEpoch;
    let rowCount = 0, rowsWithoutXkg = 0;
    for (const r of rows || []) {
        const d = String(r.date || '').slice(0, 10);
        if (!inRange(d, from, to)) continue;
        if (epoch && d < epoch) continue;
        rowCount++;
        const rc = rowConsumption(r, ctx);
        if (!rc.hasSplit) rowsWithoutXkg++;
        for (const [id, q] of Object.entries(rc.byItem)) byItem[id] = (byItem[id] || 0) + q;
    }
    for (const k of Object.keys(byItem)) byItem[k] = r4(byItem[k]);
    return { byItem, rowCount, rowsWithoutXkg };
}

// ── Shipments (import:forecast) ──────────────────────────────────────────
// Status is derived from milestones exactly as the Imports view does.
export function deriveShipStatus(s) {
    const ms = s?.milestones || [];
    if (!ms.length) return s?.status || 'planning';
    const lastDone = ms.reduce((acc, m, i) => (m.done ? i : acc), -1);
    if (lastDone <= 0) return 'planning';
    if (lastDone === 1) return 'ordered';
    if (lastDone >= ms.length - 1) return 'delivered';
    if (lastDone === ms.length - 2) return 'customs';
    return 'in-transit';
}
export const ON_ORDER_STATUSES = ['ordered', 'in-transit', 'customs'];

// Planned/actual arrival: the final milestone's date, else the 1st of its month.
export function shipmentEta(s) {
    const ms = s?.milestones || [];
    const last = ms[ms.length - 1];
    if (last && last.date) return String(last.date).slice(0, 10);
    if (s?.ym && /^\d{4}-\d{2}$/.test(s.ym)) return s.ym + '-01';
    return null;
}

// Received = final milestone done. Derived on read, so ticking it twice (or
// saving the shipment twice) can never post two receipts.
export function receipts({ shipments, from, to, epoch }) {
    const out = [];
    for (const s of shipments || []) {
        if (deriveShipStatus(s) !== 'delivered') continue;
        const date = shipmentEta(s);
        if (!date || !inRange(date, from, to)) continue;
        if (epoch && date < epoch) continue;
        out.push({ date, qty: r2(shipKg(s)), shipmentId: s.id, note: shipLabel(s), itemId: SHIPMENT_PRODUCT_ID,
                   unitCost: shipUnitCost(s), costBasis: s.costBasis || (Number(s.pricePerKg) > 0 ? 'listed' : null) });
    }
    return out;
}

export function pendingShipments(shipments) {
    return (shipments || [])
        .filter(s => ON_ORDER_STATUSES.includes(deriveShipStatus(s)))
        .map(s => ({ id: s.id, note: shipLabel(s), kg: r2(shipKg(s)), unitCost: shipUnitCost(s), eta: shipmentEta(s), status: deriveShipStatus(s), itemId: SHIPMENT_PRODUCT_ID }))
        .sort((a, b) => String(a.eta || '9999').localeCompare(String(b.eta || '9999')));
}

// Product valuation ($/kg) auto-derived from the most recent shipment that
// carries a listed price per kg (the only per-kg price shipments record).
// Returns { unitValue, source } or null.
export function productValueFromShipments(shipments) {
    const priced = (shipments || [])
        .filter(s => shipUnitCost(s) != null)
        .sort((a, b) => String(b.ym || '').localeCompare(String(a.ym || '')));
    const s = priced[0];
    if (!s) return null;
    const cost = shipUnitCost(s);
    const basis = s.costBasis === 'landed' ? 'landed' : 'listed';
    return { unitValue: cost, basis, source: `${shipLabel(s)} · $${cost.toFixed(2)}/kg ${basis}` };
}

// ── FIFO cost lots (the shipment-fed product) ────────────────────────────
// Every received shipment is a lot: kg at that shipment's $/kg. Sales and
// wastage take from the oldest lot first. The opening count is the first lot,
// costed at the latest priced shipment on or before the count date (else the
// item's unitValue). Returns null when there is no baseline.
export function fifoFor(item, world, asOf) {
    const baseline = baselineFor(item.id, world.counts, asOf);
    if (!baseline) return null;
    const from = baseline.date, to = asOf;
    const epoch = world.settings?.stockEpoch;
    const shipments = world.shipments || [];
    const pricedBefore = shipments
        .filter(s => shipUnitCost(s) != null && (shipmentEta(s) || `${s.ym || ''}-01`) <= from)
        .sort((a, b) => String(shipmentEta(b) || b.ym).localeCompare(String(shipmentEta(a) || a.ym)))[0];
    const openingCost = pricedBefore ? shipUnitCost(pricedBefore) : (Number(item.unitValue) || 0);

    // Chronological events. On the same day: receipts land, then movements,
    // then sales — so a shipment can be sold the day it arrives.
    const events = [];
    const countedShips = new Set();
    if (baseline.lots) {
        // Sub-count by shipment: one opening lot per shipment, oldest number
        // first, each at its own $/kg (typed on the count, else the shipment's
        // landed/listed cost, else the opening cost).
        const subs = baseline.lots.map((l, i) => {
            const ship = shipments.find(s => s.id === l.shipmentId) || null;
            const typed = l.unitCost != null && l.unitCost !== '' ? Number(l.unitCost) : null;
            const cost = typed != null ? typed : (ship ? shipUnitCost(ship) : null);
            return { i, ship, l, cost, num: ship ? shipNumber(ship) : (Number(String(l.label || '').match(/(\d+)/)?.[1]) || null) };
        }).sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9) || a.i - b.i);
        for (const s of subs) {
            if (s.l.shipmentId) countedShips.add(s.l.shipmentId);
            events.push({ date: from, order: 0, kind: 'lot', id: s.l.shipmentId || 'opening-' + s.i,
                          note: s.l.label || (s.ship ? shipLabel(s.ship) : baseline.countLabel || 'Opening count'),
                          qty: Number(s.l.kg) || 0, unitCost: s.cost != null ? s.cost : openingCost, basis: 'counted' });
        }
    } else {
        events.push({ date: from, order: 0, kind: 'lot', id: 'opening', note: baseline.countLabel || 'Opening count', qty: baseline.qty, unitCost: openingCost });
    }
    for (const r of receipts({ shipments, from, to, epoch })) {
        if (countedShips.has(r.shipmentId)) continue; // already on the shelf at the count
        events.push({ date: r.date, order: 0, kind: 'lot', id: r.shipmentId, note: r.note, qty: r.qty, unitCost: r.unitCost, basis: r.costBasis });
    }
    for (const m of (world.movements?.[item.id] || [])) {
        if (!inRange(m.date, from, to)) continue;
        const q = Number(m.qty) || 0;
        if (q > 0) events.push({ date: m.date, order: 1, kind: 'lot', id: m.id, note: m.reason || m.type, qty: q, unitCost: null });
        else if (q < 0) events.push({ date: m.date, order: 1, kind: 'take', qty: -q });
    }
    const field = SALES_KG_FIELD[item.salesKey];
    if (field) {
        for (const r of world.sales || []) {
            const d = String(r.date || '').slice(0, 10);
            if (!inRange(d, from, to) || (epoch && d < epoch)) continue;
            const kg = Number(r[field]) || 0;
            if (kg > 0) events.push({ date: d, order: 2, kind: 'take', qty: kg });
        }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

    const lots = [];
    let shortfall = 0; // sold before any lot could cover it — taken from the next lot to land
    const take = qty => {
        let left = qty;
        for (const l of lots) {
            if (left <= 0) break;
            const t = Math.min(l.remaining, left);
            l.remaining -= t; left -= t;
        }
        if (left > 0) shortfall += left;
    };
    for (const ev of events) {
        if (ev.kind === 'lot') {
            const cost = ev.unitCost != null ? ev.unitCost : (lots.length ? lots[lots.length - 1].unitCost : openingCost);
            lots.push({ id: ev.id, note: ev.note, date: ev.date, qty: r2(ev.qty), remaining: ev.qty, unitCost: cost, basis: ev.unitCost != null ? (ev.basis || null) : 'carried' });
            if (shortfall > 0) { const t = Math.min(shortfall, ev.qty); lots[lots.length - 1].remaining -= t; shortfall -= t; }
        } else {
            take(ev.qty);
        }
    }
    const out = lots.map(l => ({ ...l, remaining: r2(l.remaining), value: r2(l.remaining * l.unitCost) }));
    const onHand = r2(out.reduce((s, l) => s + l.remaining, 0) - shortfall);
    const value = r2(out.reduce((s, l) => s + l.value, 0));
    const held = out.reduce((s, l) => s + l.remaining, 0);
    return { lots: out, onHand, value, avgCost: held > 0 ? Math.round((value / held) * 10000) / 10000 : null, shortfall: r2(shortfall), openingCost };
}

// ── Baseline & on hand ───────────────────────────────────────────────────
// Latest committed count line for the item dated ≤ asOf. Per item — a recount
// of boxes rebases boxes only.
export function baselineFor(itemId, counts, asOf) {
    let best = null;
    for (const c of counts || []) {
        if (c.status !== 'committed' || !c.date || (asOf && c.date > asOf)) continue;
        const line = (c.lines || []).find(l => l.itemId === itemId && l.counted !== false && l.countedQty != null && l.countedQty !== '');
        if (!line) continue;
        const later = !best || c.date > best.date || (c.date === best.date && String(c.committedAt || '') > String(best.committedAt || ''));
        if (later) best = { date: c.date, qty: Number(line.countedQty), countId: c.id, countLabel: c.label, committedAt: c.committedAt || null,
                            // Sub-count by shipment (kg on hand per shipment at the count) → opening FIFO lots.
                            lots: Array.isArray(line.lots) && line.lots.length ? line.lots : null };
    }
    return best;
}

export function onHandFor(item, world, asOf) {
    const baseline = baselineFor(item.id, world.counts, asOf);
    if (!baseline) return { onHand: null, baseline: null, consumed: 0, movements: 0, receipts: 0 };
    const from = baseline.date, to = asOf;
    const consumed = consumption({ rows: world.sales, items: world.items, bom: world.bom, settings: world.settings, from, to }).byItem[item.id] || 0;
    const movements = (world.movements?.[item.id] || [])
        .filter(m => inRange(m.date, from, to))
        .reduce((s, m) => s + (Number(m.qty) || 0), 0);
    // Shipments already sub-counted in the baseline are on the shelf — never
    // add them again when their final milestone is ticked later.
    const countedShips = new Set((baseline.lots || []).map(l => l.shipmentId).filter(Boolean));
    const recd = item.id === SHIPMENT_PRODUCT_ID
        ? receipts({ shipments: world.shipments, from, to, epoch: world.settings?.stockEpoch })
            .filter(x => !countedShips.has(x.shipmentId)).reduce((s, x) => s + x.qty, 0)
        : 0;
    return {
        baseline,
        consumed: r2(consumed), movements: r2(movements), receipts: r2(recd),
        onHand: r2(baseline.qty - consumed + movements + recd),
    };
}

// ── Status ───────────────────────────────────────────────────────────────
export function statusFor({ onHand, avgDaily, daysCover, reorderPoint, leadTimeDays, mode, watchMultiplier }) {
    if (onHand == null) return 'unknown';
    if (onHand <= 0) return 'out';
    if (avgDaily > 0 && leadTimeDays > 0 && daysCover != null && daysCover < leadTimeDays) return 'critical';
    if (mode === 'manual') {
        if (reorderPoint == null) return 'unknown';
    } else if (!(avgDaily > 0)) {
        return 'unknown'; // no usage signal and no manual point — never claim "ok"
    }
    if (onHand <= reorderPoint) return 'low';
    if (onHand <= reorderPoint * (watchMultiplier || 1.25)) return 'watch';
    return 'ok';
}

// ── Levels — the dashboard payload ───────────────────────────────────────
export function computeLevels(world, asOf) {
    const s = { ...DEFAULT_SETTINGS, ...(world.settings || {}) };
    if (s.stockEpoch && asOf < s.stockEpoch) {
        return { beforeEpoch: true, stockEpoch: s.stockEpoch, asOf };
    }
    const windowDays = Number(s.consumptionWindowDays) || 28;
    const windowFrom = addDays(asOf, -windowDays);
    const win = consumption({ rows: world.sales, items: world.items, bom: world.bom, settings: s, from: windowFrom, to: asOf });
    const pending = pendingShipments(world.shipments);
    const onOrderBundled = r2(pending.reduce((sum, p) => sum + p.kg, 0));

    const items = (world.items || []).filter(i => i.active !== false).map(item => {
        const oh = onHandFor(item, { ...world, settings: s }, asOf);
        const avgDaily = r4((win.byItem[item.id] || 0) / windowDays);
        // Lead time is a global setting for consumables (a per-item override
        // is honoured if present). Products have no supplier lead time here.
        const leadTimeDays = Number(item.profile?.leadTimeDays) || (item.class === 'consumable' ? Number(s.defaultLeadTimeDays) || 0 : 0);
        const safetyDays = item.reorder?.safetyDays != null ? Number(item.reorder.safetyDays) : Number(s.defaultSafetyDays) || 0;
        // "manual" without a point is just auto.
        const hasManual = item.reorder?.manualPoint != null && item.reorder.manualPoint !== '';
        const mode = item.reorder?.mode === 'manual' && hasManual ? 'manual' : 'auto';
        const reorderPoint = mode === 'manual'
            ? (item.reorder?.manualPoint != null && item.reorder.manualPoint !== '' ? Number(item.reorder.manualPoint) : null)
            : r2(avgDaily * (leadTimeDays + safetyDays));
        const onHand = oh.onHand;
        const daysCover = onHand != null && avgDaily > 0 ? Math.round((onHand / avgDaily) * 10) / 10 : null;
        const onOrder = item.id === SHIPMENT_PRODUCT_ID ? onOrderBundled : 0;
        const status = statusFor({ onHand, avgDaily, daysCover, reorderPoint, leadTimeDays, mode, watchMultiplier: s.watchMultiplier });

        // Incoming cover: low/critical but a pending shipment lands before the
        // projected stock-out → flag covered so it isn't reordered twice.
        let covered = false, coveredBy = null;
        if ((status === 'low' || status === 'critical') && onOrder > 0 && daysCover != null) {
            const stockout = addDays(asOf, Math.floor(daysCover));
            const ship = pending.find(p => p.itemId === item.id && p.eta && p.eta <= stockout);
            if (ship) { covered = true; coveredBy = ship; }
        }
        // FIFO cost lots for the shipment-fed product: value on hand + lots.
        const fifo = item.id === SHIPMENT_PRODUCT_ID ? fifoFor(item, { ...world, settings: s }, asOf) : null;
        return {
            id: item.id, name: item.name, class: item.class, unit: item.unit, unitLabel: item.unitLabel || null, key: !!item.key, sortOrder: item.sortOrder ?? 0,
            onHand, onOrder,
            value: fifo ? fifo.value : null, avgCost: fifo ? fifo.avgCost : null, lots: fifo ? fifo.lots : undefined, shortfall: fifo ? fifo.shortfall : undefined,
            baselineDate: oh.baseline?.date || null, baselineQty: oh.baseline?.qty ?? null, baselineCount: oh.baseline?.countId || null,
            consumedSinceBaseline: oh.consumed, movementsSinceBaseline: oh.movements, receiptsSinceBaseline: oh.receipts,
            avgDaily, daysCover, reorderPoint, reorderMode: mode, leadTimeDays, safetyDays,
            status, covered, coveredBy,
        };
    });

    return {
        asOf, stockEpoch: s.stockEpoch, windowDays, windowFrom,
        rowsWithoutXkg: win.rowsWithoutXkg,
        items, pendingShipments: pending,
    };
}

// Daily on-hand series for one item over [from, to], plus the events that
// moved it, for the trajectory chart. Each point is as-at end of that day.
export function historyFor(item, world, from, to) {
    const series = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
        series.push({ date: d, onHand: onHandFor(item, world, d).onHand });
    }
    const events = [
        ...(world.movements?.[item.id] || []).filter(m => inRange(m.date, addDays(from, -1), to))
            .map(m => ({ date: m.date, kind: m.type, qty: Number(m.qty) || 0, note: m.reason || '' })),
        ...(item.id === SHIPMENT_PRODUCT_ID
            ? receipts({ shipments: world.shipments, from: addDays(from, -1), to, epoch: world.settings?.stockEpoch })
                .map(x => ({ date: x.date, kind: 'receipt', qty: x.qty, note: x.note }))
            : []),
        ...(world.counts || []).filter(c => c.status === 'committed' && inRange(c.date, addDays(from, -1), to)
            && (c.lines || []).some(l => l.itemId === item.id && l.counted !== false && l.countedQty != null))
            .map(c => ({ date: c.date, kind: 'count', qty: Number((c.lines.find(l => l.itemId === item.id)).countedQty), note: c.label })),
    ].sort((a, b) => a.date.localeCompare(b.date));
    return { itemId: item.id, unit: item.unit, from, to, series, events };
}

// ── Counts ───────────────────────────────────────────────────────────────
// Expected qty for every line of a count (as at the count date), from the
// committed counts only — drafts never feed the engine.
export function expectedForCount(count, world) {
    const out = {};
    for (const line of count.lines || []) {
        const item = (world.items || []).find(i => i.id === line.itemId);
        if (!item) continue;
        out[line.itemId] = onHandFor(item, world, count.date).onHand;
    }
    return out;
}

// Freeze a draft into a committed count. Pure: returns the new count object
// (or throws). Variances and valuation attributes are snapshotted here and
// never recomputed.
export function commitCount(count, world, { committedAt, committedBy } = {}) {
    if (count.status === 'committed') throw new Error('Count is already committed');
    if (!count.date) throw new Error('Count needs a date');
    // Sub-counted lines (kg per shipment) total up to their countedQty; the
    // $/kg of each lot is snapshotted here (typed, else the shipment's cost).
    const cleanLots = l => {
        if (!Array.isArray(l.lots) || !l.lots.length) return null;
        return l.lots.map(x => {
            const ship = (world.shipments || []).find(s => s.id === x.shipmentId) || null;
            const typed = x.unitCost != null && x.unitCost !== '' ? Number(x.unitCost) : null;
            return { shipmentId: x.shipmentId || null, label: x.label || (ship ? shipLabel(ship) : ''), kg: r2(x.kg),
                     unitCost: typed != null ? typed : (ship ? shipUnitCost(ship) : null) };
        }).filter(x => x.kg > 0);
    };
    const qtyOf = l => { const lots = cleanLots(l); return lots && lots.length ? r2(lots.reduce((s, x) => s + x.kg, 0)) : l.countedQty; };
    const missing = (count.lines || []).filter(l => l.counted !== false && (qtyOf(l) == null || qtyOf(l) === '' || isNaN(Number(qtyOf(l)))));
    if (missing.length) {
        const err = new Error('Every line needs a counted quantity, or mark it "not counted"');
        err.missing = missing.map(l => l.itemId);
        throw err;
    }
    const expected = expectedForCount(count, world);
    // The shipment-fed product is valued at its FIFO average cost as at the
    // count date; everything else at the item's unitValue.
    const fifoCost = {};
    for (const it of world.items || []) {
        if (it.id !== SHIPMENT_PRODUCT_ID) continue;
        const f = fifoFor(it, world, count.date);
        if (f && f.avgCost != null) fifoCost[it.id] = f.avgCost;
    }
    const lines = (count.lines || []).map(l => {
        const raw = (world.items || []).find(i => i.id === l.itemId) || {};
        const item = fifoCost[l.itemId] != null ? { ...raw, unitValue: fifoCost[l.itemId] } : raw;
        if (l.counted === false) {
            return { ...l, counted: false, countedQty: null, expectedQty: expected[l.itemId] ?? null, varianceQty: null, variancePct: null,
                     unitValue: item.unitValue ?? null, accountCode: item.accountCode || world.settings?.valuation?.defaultAccountCode || '' };
        }
        const lots = cleanLots(l);
        const countedQty = lots && lots.length ? r2(lots.reduce((s, x) => s + x.kg, 0)) : r2(l.countedQty);
        const exp = expected[l.itemId];
        const varianceQty = exp == null ? null : r2(countedQty - exp);
        const variancePct = exp == null || exp === 0 ? null : Math.round((varianceQty / exp) * 10000) / 100;
        // Sub-counted: value = kg-weighted average of the lots' $/kg.
        let unitValue = item.unitValue ?? null;
        if (lots && lots.length) {
            const priced = lots.filter(x => x.unitCost != null);
            const kg = priced.reduce((s, x) => s + x.kg, 0);
            if (kg > 0) unitValue = Math.round((priced.reduce((s, x) => s + x.kg * x.unitCost, 0) / kg) * 10000) / 10000;
        }
        return { ...l, counted: true, countedQty, ...(lots ? { lots } : {}), expectedQty: exp ?? null, varianceQty, variancePct,
                 unitValue, accountCode: item.accountCode || world.settings?.valuation?.defaultAccountCode || '' };
    });
    return { ...count, lines, status: 'committed', committedAt: committedAt || null, committedBy: committedBy || null };
}

// The single anchor every stock view shares (Warehouse dashboard, Stock
// Trajectory, Monthly Forecast): the latest committed count for the
// shipment-fed product, plus on hand now and the shipments that count
// already contains (so nothing adds them a second time). Null before the
// first committed count.
export function stockAnchor(world, today) {
    const item = (world.items || []).find(i => i.id === SHIPMENT_PRODUCT_ID);
    if (!item) return null;
    const base = baselineFor(item.id, world.counts, today);
    if (!base) return null;
    const now = onHandFor(item, world, today);
    const fifo = fifoFor(item, world, today);
    return {
        source: 'count', kg: base.qty, date: base.date, countId: base.countId, label: base.countLabel || 'Stock count',
        countedShipmentIds: (base.lots || []).map(l => l.shipmentId).filter(Boolean),
        onHandNow: now.onHand, asOf: today,
        soldSince: now.consumed, receivedSince: now.receipts, adjustedSince: now.movements,
        value: fifo ? fifo.value : null, avgCost: fifo ? fifo.avgCost : null,
    };
}

// ── Consumables forecast ─────────────────────────────────────────────────
// Shares the Imports seasonal sales forecast (kg per calendar month, Jan→Dec)
// and its three scenarios. kg → sales units via the trailing product mix from
// Sales History, units → consumables via the matrix, then each consumable's
// on hand is walked month by month to find when it runs out and, less lead
// time + safety days, when it must be ordered.
export const SCENARIOS = { avg: 1, good: 1.1, great: 1.2 };
export const FORECAST_MONTHLY_AVG_DEFAULT = [2000, 750, 1000, 2000, 3000, 5500, 7000, 5000, 1000, 200, 50, 400];
const pad2 = n => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

// Share of kg sold by SKU, and orders per kg, over (from, to].
export function salesMix(rows, from, to) {
    const kgBySku = {};
    let totalKg = 0, kgWithSplit = 0, orders = 0, labels = 0;
    for (const r of rows || []) {
        const d = String(r.date || '').slice(0, 10);
        if (!inRange(d, from, to)) continue;
        const rowKg = (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
        if (rowKg <= 0) continue;
        orders++; totalKg += rowKg;
        if (r.xkg && typeof r.xkg === 'object') {
            for (const [sku, t] of Object.entries(SKU_TABLE)) {
                const kg = Number(r.xkg[t.xkg]) || 0;
                if (kg > 0) { kgBySku[sku] = (kgBySku[sku] || 0) + kg; kgWithSplit += kg; }
            }
        }
        labels += Number(r.labels) || 0;
    }
    const share = {};
    if (kgWithSplit > 0) for (const [sku, kg] of Object.entries(kgBySku)) share[sku] = kg / kgWithSplit;
    else share['PT-b-10'] = 1; // nothing to go on yet — assume 10 kg bundled
    return { share, ordersPerKg: totalKg > 0 ? orders / totalKg : 0, labelsPerKg: totalKg > 0 ? labels / totalKg : 0,
             orders, labels, kg: r2(totalKg), from, to,
             source: kgWithSplit > 0 ? 'sales-history' : 'assumed-10kg-bundled' };
}

export function consumablesForecast(world, { monthlyAvg, today, months = 12, mixDays = 365 } = {}) {
    const s = { ...DEFAULT_SETTINGS, ...(world.settings || {}) };
    const levels = computeLevels(world, today);
    if (levels.beforeEpoch) return { beforeEpoch: true, stockEpoch: s.stockEpoch, asOf: today };
    const avg = Array.isArray(monthlyAvg) && monthlyAvg.length === 12 && monthlyAvg.some(v => Number(v) > 0)
        ? monthlyAvg.map(v => Number(v) || 0) : FORECAST_MONTHLY_AVG_DEFAULT;
    const mix = salesMix(world.sales, addDays(today, -mixDays), today);
    const recipes = recipesFor(world.bom, today);

    // Consumable UNITS used per 1 kg sold: matrix pieces × mix ÷ pieces per
    // unit, plus courier consignments and per-order lines.
    const pieces = piecesPerUnit(world.items);
    const perKg = {};
    const addPerKg = (id, piecesPerKg) => { perKg[id] = (perKg[id] || 0) + piecesPerKg / (pieces[id] || 1); };
    for (const [sku, t] of Object.entries(SKU_TABLE)) {
        const sh = mix.share[sku] || 0;
        if (!sh) continue;
        const unitsPerKg = sh / t.kgPerUnit;
        for (const e of recipes[sku] || []) addPerKg(e.consumableId, unitsPerKg * (Number(e.qty) || 0));
    }
    for (const e of s.perDespatch || []) addPerKg(e.consumableId, mix.ordersPerKg * (Number(e.qty) || 0));
    for (const e of s.perLabel || []) addPerKg(e.consumableId, (mix.labelsPerKg || 0) * (Number(e.qty) || 0));
    for (const it of world.items || []) if (it.class === 'consumable' && it.courierLabel) addPerKg(it.id, mix.labelsPerKg || 0);

    // The next N months; the current month is pro-rated from today.
    const [ty, tm, td] = today.split('-').map(Number);
    const list = [];
    for (let i = 0; i < months; i++) {
        const idx = (tm - 1 + i), y = ty + Math.floor(idx / 12), m = (idx % 12) + 1;
        const dim = daysInMonth(y, m);
        const startDay = i === 0 ? td : 1;
        list.push({ ym: `${y}-${pad2(m)}`, y, m, dim, startDay, fraction: (dim - startDay + 1) / dim, kgAvg: avg[m - 1] * ((dim - startDay + 1) / dim) });
    }

    const items = levels.items.filter(i => i.class === 'consumable').map(c => {
        const usagePerKg = perKg[c.id] || 0;
        const scenarios = {};
        for (const [key, mult] of Object.entries(SCENARIOS)) {
            let bal = c.onHand, runOut = null;
            const ms = [];
            for (const mo of list) {
                const usage = r2(mo.kgAvg * mult * usagePerKg);
                const opening = bal;
                if (bal != null) {
                    bal = r2(bal - usage);
                    if (runOut == null && bal <= 0 && usage > 0) {
                        const frac = Math.max(0, Math.min(1, opening / usage));
                        const span = mo.dim - mo.startDay + 1;
                        runOut = `${mo.y}-${pad2(mo.m)}-${pad2(Math.min(mo.dim, mo.startDay + Math.floor(frac * span)))}`;
                    }
                }
                ms.push({ ym: mo.ym, kg: r2(mo.kgAvg * mult), usage, closing: bal });
            }
            const buffer = (c.leadTimeDays || 0) + (c.safetyDays || 0);
            const reorderBy = runOut ? addDays(runOut, -buffer) : null;
            scenarios[key] = { months: ms, runOutDate: runOut, reorderBy, orderNow: reorderBy != null && reorderBy <= today,
                               usage12: r2(ms.reduce((a, x) => a + x.usage, 0)) };
        }
        return { id: c.id, name: c.name, unit: c.unit, unitLabel: c.unitLabel || null, onHand: c.onHand, onOrder: c.onOrder, status: c.status,
                 baselineDate: c.baselineDate, leadTimeDays: c.leadTimeDays, safetyDays: c.safetyDays, usagePerKg: r4(usagePerKg), scenarios };
    });
    return { asOf: today, stockEpoch: s.stockEpoch, monthlyAvg: avg, mix,
             months: list.map(m => ({ ym: m.ym, kgAvg: r2(m.kgAvg), fraction: Math.round(m.fraction * 1000) / 1000 })), items };
}

// ── Per-item ledger (audit trail) ────────────────────────────────────────
// Every debit and credit behind an item's on hand since its baseline, with
// a running balance: the count, each order (via Sales History), each
// shipment received, each manual movement. Built from the same functions
// the levels use, so the closing balance always equals onHand.
export function ledgerFor(item, world, asOf) {
    const baseline = baselineFor(item.id, world.counts, asOf);
    if (!baseline) return { itemId: item.id, unit: item.unit, baseline: null, entries: [], closing: null };
    const from = baseline.date, to = asOf;
    const epoch = world.settings?.stockEpoch;
    const ctx = consumptionContext(world.items, world.bom, world.settings);
    const entries = [];
    entries.push({ date: from, order: 0, kind: 'count', ref: baseline.countId, label: baseline.countLabel || 'Count', qty: baseline.qty, note: 'Baseline (physical count)' });
    if (item.id === SHIPMENT_PRODUCT_ID) {
        const counted = new Set((baseline.lots || []).map(l => l.shipmentId).filter(Boolean));
        for (const r of receipts({ shipments: world.shipments, from, to, epoch })) {
            if (counted.has(r.shipmentId)) continue;
            entries.push({ date: r.date, order: 1, kind: 'receipt', ref: r.shipmentId, label: r.note, qty: r.qty, note: r.unitCost != null ? `Shipment landed · $${r.unitCost.toFixed(2)}/kg ${r.costBasis || ''}`.trim() : 'Shipment landed' });
        }
    }
    for (const m of world.movements?.[item.id] || []) {
        if (!inRange(m.date, from, to)) continue;
        entries.push({ date: m.date, order: 2, kind: m.type, ref: m.id, label: m.type === 'receipt' ? 'Delivery received' : m.type[0].toUpperCase() + m.type.slice(1), qty: Number(m.qty) || 0, note: m.reason || '', by: m.createdBy || null });
    }
    for (const r of world.sales || []) {
        const d = String(r.date || '').slice(0, 10);
        if (!inRange(d, from, to) || (epoch && d < epoch)) continue;
        const q = rowConsumption(r, ctx).byItem[item.id] || 0;
        if (!q) continue;
        entries.push({ date: d, order: 3, kind: 'sale', ref: r.id, label: r.id, qty: -q,
                       note: [r.customer, r.branch].filter(Boolean).join(' · ') + (r.invoice ? ` · ${r.invoice}` : '') + (r.labels ? ` · ${r.labels} label${r.labels === 1 ? '' : 's'}` : '') });
    }
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || String(a.ref).localeCompare(String(b.ref)));
    let bal = 0;
    for (const e of entries) {
        bal = r4(bal + e.qty);
        e.qty = r4(e.qty);
        e.balance = r2(bal);
        delete e.order;
    }
    return { itemId: item.id, unit: item.unit, baseline: { date: from, qty: baseline.qty, countId: baseline.countId }, asOf, entries, closing: r2(bal) };
}

// Enviroware-format valuation rows for a committed count.
export function valuationRows(count, items) {
    const byId = Object.fromEntries((items || []).map(i => [i.id, i]));
    const rows = (count.lines || [])
        .filter(l => l.counted !== false && l.countedQty != null)
        .map(l => {
            const item = byId[l.itemId] || {};
            const units = Number(l.countedQty) || 0;
            const unitValue = l.unitValue != null ? Number(l.unitValue) : (Number(item.unitValue) || 0);
            return { itemId: l.itemId, description: item.name || l.itemId, unit: item.unit || '', accountCode: l.accountCode || item.accountCode || '', units, unitValue, net: r2(units * unitValue) };
        })
        .sort((a, b) => (byId[a.itemId]?.sortOrder ?? 0) - (byId[b.itemId]?.sortOrder ?? 0) || a.description.localeCompare(b.description));
    const total = r2(rows.reduce((s, r) => s + r.net, 0));
    return { rows, total };
}
