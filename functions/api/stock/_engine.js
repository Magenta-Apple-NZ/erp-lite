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
    stockEpoch:            '2026-10-01',
    consumptionWindowDays: 28,
    defaultLeadTimeDays:   14,   // consumables: days from ordering to delivery
    defaultSafetyDays:     7,
    watchMultiplier:       1.25,
    perDespatch:           [],
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
export function consumption({ rows, items, bom, settings, from, to }) {
    const byItem = {};
    const add = (id, q) => { if (id && q) byItem[id] = (byItem[id] || 0) + q; };
    const productBySalesKey = {};
    for (const it of items || []) {
        if (it.class === 'product' && it.salesKey) productBySalesKey[it.salesKey] = it.id;
    }
    const epoch = settings?.stockEpoch;
    let rowCount = 0, rowsWithoutXkg = 0;
    for (const r of rows || []) {
        const d = String(r.date || '').slice(0, 10);
        if (!inRange(d, from, to)) continue;
        if (epoch && d < epoch) continue;
        rowCount++;
        for (const [salesKey, field] of Object.entries(SALES_KG_FIELD)) {
            add(productBySalesKey[salesKey], Number(r[field]) || 0);
        }
        const recipes = recipesFor(bom, d);
        if (r.xkg && typeof r.xkg === 'object') {
            for (const [sku, t] of Object.entries(SKU_TABLE)) {
                const kg = Number(r.xkg[t.xkg]) || 0;
                if (!kg) continue;
                const units = kg / t.kgPerUnit;
                for (const e of recipes[sku] || []) add(e.consumableId, units * (Number(e.qty) || 0));
            }
        } else {
            rowsWithoutXkg++;
        }
        for (const e of settings?.perDespatch || []) add(e.consumableId, Number(e.qty) || 0);
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
        out.push({ date, qty: r2(s.kg), shipmentId: s.id, note: s.note || s.id, itemId: SHIPMENT_PRODUCT_ID,
                   unitCost: Number(s.pricePerKg) > 0 ? Number(s.pricePerKg) : null });
    }
    return out;
}

export function pendingShipments(shipments) {
    return (shipments || [])
        .filter(s => ON_ORDER_STATUSES.includes(deriveShipStatus(s)))
        .map(s => ({ id: s.id, note: s.note || s.id, kg: r2(s.kg), eta: shipmentEta(s), status: deriveShipStatus(s), itemId: SHIPMENT_PRODUCT_ID }))
        .sort((a, b) => String(a.eta || '9999').localeCompare(String(b.eta || '9999')));
}

// Product valuation ($/kg) auto-derived from the most recent shipment that
// carries a listed price per kg (the only per-kg price shipments record).
// Returns { unitValue, source } or null.
export function productValueFromShipments(shipments) {
    const priced = (shipments || [])
        .filter(s => Number(s.pricePerKg) > 0)
        .sort((a, b) => String(b.ym || '').localeCompare(String(a.ym || '')));
    const s = priced[0];
    if (!s) return null;
    return { unitValue: Number(s.pricePerKg), source: `${s.note || s.id} · $${Number(s.pricePerKg).toFixed(2)}/kg listed` };
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
        .filter(s => Number(s.pricePerKg) > 0 && (shipmentEta(s) || `${s.ym || ''}-01`) <= from)
        .sort((a, b) => String(shipmentEta(b) || b.ym).localeCompare(String(shipmentEta(a) || a.ym)))[0];
    const openingCost = pricedBefore ? Number(pricedBefore.pricePerKg) : (Number(item.unitValue) || 0);

    // Chronological events. On the same day: receipts land, then movements,
    // then sales — so a shipment can be sold the day it arrives.
    const events = [];
    events.push({ date: from, order: 0, kind: 'lot', id: 'opening', note: baseline.countLabel || 'Opening count', qty: baseline.qty, unitCost: openingCost });
    for (const r of receipts({ shipments, from, to, epoch })) {
        events.push({ date: r.date, order: 0, kind: 'lot', id: r.shipmentId, note: r.note, qty: r.qty, unitCost: r.unitCost });
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
            lots.push({ id: ev.id, note: ev.note, date: ev.date, qty: r2(ev.qty), remaining: ev.qty, unitCost: cost });
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
        if (later) best = { date: c.date, qty: Number(line.countedQty), countId: c.id, countLabel: c.label, committedAt: c.committedAt || null };
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
    const recd = item.id === SHIPMENT_PRODUCT_ID
        ? receipts({ shipments: world.shipments, from, to, epoch: world.settings?.stockEpoch }).reduce((s, x) => s + x.qty, 0)
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
            id: item.id, name: item.name, class: item.class, unit: item.unit, key: !!item.key, sortOrder: item.sortOrder ?? 0,
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
    const missing = (count.lines || []).filter(l => l.counted !== false && (l.countedQty == null || l.countedQty === '' || isNaN(Number(l.countedQty))));
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
        const countedQty = r2(l.countedQty);
        const exp = expected[l.itemId];
        const varianceQty = exp == null ? null : r2(countedQty - exp);
        const variancePct = exp == null || exp === 0 ? null : Math.round((varianceQty / exp) * 10000) / 100;
        return { ...l, counted: true, countedQty, expectedQty: exp ?? null, varianceQty, variancePct,
                 unitValue: item.unitValue ?? null, accountCode: item.accountCode || world.settings?.valuation?.defaultAccountCode || '' };
    });
    return { ...count, lines, status: 'committed', committedAt: committedAt || null, committedBy: committedBy || null };
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
