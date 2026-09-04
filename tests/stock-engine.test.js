// Stock engine acceptance tests (Stock-Rebuild.md §9). Zero dependencies:
//   npm test   → runs under TZ=UTC and TZ=Pacific/Auckland and must agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nzYmd, addDays, daysBetween } from '../functions/api/_dates.js';
import {
    consumption, receipts, pendingShipments, onHandFor, computeLevels,
    commitCount, expectedForCount, valuationRows, statusFor, recipesFor,
    SHIPMENT_PRODUCT_ID,
} from '../functions/api/stock/_engine.js';

// ── Fixture ──────────────────────────────────────────────────────────────
const settings = { stockEpoch: '2026-10-01', consumptionWindowDays: 28, defaultSafetyDays: 7, watchMultiplier: 1.25, perDespatch: [{ consumableId: 'label-courier', qty: 1 }], valuation: { defaultAccountCode: '1440', gstBasis: 'ex' } };

const items = [
    { id: 'prime-tie-bundled', name: 'Prime Tie Bundled', class: 'product', unit: 'kg', active: true, key: true, sortOrder: 10, salesKey: 'bundles', unitValue: 12.5, accountCode: '1440', reorder: { mode: 'manual', manualPoint: 2000 } },
    { id: 'prime-tie-loose',   name: 'Prime Tie Loose',   class: 'product', unit: 'kg', active: true, key: true, sortOrder: 20, salesKey: 'loose',   unitValue: 11,   accountCode: '1440', reorder: { mode: 'manual', manualPoint: 500 } },
    { id: 'eco-ties',          name: 'eco Ties',          class: 'product', unit: 'kg', active: true, key: true, sortOrder: 30, salesKey: 'ecoTies', unitValue: 8,    accountCode: '1440', reorder: { mode: 'manual', manualPoint: 100 } },
    { id: 'box-10kg',      name: '10kg Box',      class: 'consumable', unit: 'each', active: true, sortOrder: 100, unitValue: 0.85, accountCode: '1450', profile: { leadTimeDays: 14 }, reorder: { mode: 'auto', safetyDays: 7 } },
    { id: 'staple',        name: 'Staples',       class: 'consumable', unit: 'each', active: true, sortOrder: 110, unitValue: 0.01, accountCode: '1450', profile: { leadTimeDays: 3 },  reorder: { mode: 'auto', safetyDays: 7 } },
    { id: 'bag-red',       name: 'Red Bag',       class: 'consumable', unit: 'each', active: true, sortOrder: 120, unitValue: 0.1,  accountCode: '1450', profile: { leadTimeDays: 10 }, reorder: { mode: 'auto', safetyDays: 7 } },
    { id: 'bag-eco',       name: 'eco Bag',       class: 'consumable', unit: 'each', active: true, sortOrder: 130, unitValue: 0.1,  accountCode: '1450', profile: { leadTimeDays: 10 }, reorder: { mode: 'auto', safetyDays: 7 } },
    { id: 'label-courier', name: 'Courier Label', class: 'consumable', unit: 'each', active: true, sortOrder: 140, unitValue: 0.05, accountCode: '1450', profile: { leadTimeDays: 5 },  reorder: { mode: 'auto', safetyDays: 7 } },
];

const bom = { versions: [{ effectiveFrom: '2026-10-01', recipes: {
    'PT-l-10': [{ consumableId: 'box-10kg', qty: 1 }, { consumableId: 'staple', qty: 4 }, { consumableId: 'bag-red', qty: 1 }],
    'PT-b-10': [{ consumableId: 'box-10kg', qty: 1 }, { consumableId: 'staple', qty: 4 }],
    'PT-b-1b': [{ consumableId: 'box-10kg', qty: 0.1 }, { consumableId: 'bag-red', qty: 1 }],
    'ET-b-10': [{ consumableId: 'box-10kg', qty: 1 }, { consumableId: 'bag-eco', qty: 2 }],
} }] };

// One order: 5 × PT-l-10 on 3 Oct.
const saleLoose5 = { id: 'PKS-0001', date: '2026-10-03', bundlesKg: 0, looseKg: 50, ecoTiesKg: 0, xkg: { b1: 0, b10: 0, l1: 0, l10: 50, e1: 0, e10: 0 } };
// One order: 2 × ET-b-10 on 5 Oct.
const saleEco2   = { id: 'PKS-0002', date: '2026-10-05', bundlesKg: 0, looseKg: 0, ecoTiesKg: 20, xkg: { b1: 0, b10: 0, l1: 0, l10: 0, e1: 0, e10: 20 } };
// Pre-epoch row — must be ignored entirely.
const salePre    = { id: 'PKS-0000', date: '2026-09-30', bundlesKg: 100, looseKg: 100, ecoTiesKg: 100, xkg: { b10: 100, l10: 100, e10: 100 } };

const opening = {
    id: 'cnt_open', label: 'Opening count', date: '2026-10-01', status: 'committed', committedAt: '2026-10-01T05:00:00Z',
    lines: [
        { itemId: 'prime-tie-bundled', counted: true, countedQty: 5000 },
        { itemId: 'prime-tie-loose',   counted: true, countedQty: 800 },
        { itemId: 'eco-ties',          counted: true, countedQty: 300 },
        { itemId: 'box-10kg',          counted: true, countedQty: 400 },
        { itemId: 'staple',            counted: true, countedQty: 10000 },
        { itemId: 'bag-red',           counted: true, countedQty: 1000 },
        { itemId: 'bag-eco',           counted: true, countedQty: 500 },
        // label-courier deliberately NOT counted → must report unknown
        { itemId: 'label-courier',     counted: false, countedQty: null },
    ],
};

const shipArrived = { id: 'ship-41', ym: '2026-10', kg: 1000, note: 'Shipment 41', pricePerKg: 4.5, milestones: [
    { label: 'Request for documents', date: '2026-08-01', done: true },
    { label: 'Left Italy',            date: '2026-08-10', done: true },
    { label: 'Arrived in Bangladesh', date: '2026-09-01', done: true },
    { label: 'Left Bangladesh',       date: '2026-09-15', done: true },
    { label: 'Arrived in New Zealand', date: '2026-10-10', done: true },
] };
const shipInTransit = { id: 'ship-42', ym: '2026-11', kg: 1500, note: 'Shipment 42', milestones: [
    { label: 'Request for documents', date: '2026-09-01', done: true },
    { label: 'Left Italy',            date: '2026-09-20', done: true },
    { label: 'Arrived in Bangladesh', date: '2026-10-05', done: true },
    { label: 'Left Bangladesh',       date: null, done: false },
    { label: 'Arrived in New Zealand', date: '2026-11-20', done: false },
] };

function world(overrides = {}) {
    return { settings, items, bom, counts: [opening], movements: {}, sales: [salePre, saleLoose5, saleEco2], shipments: [shipArrived, shipInTransit], ...overrides };
}

// ── Dates (§8.1) ─────────────────────────────────────────────────────────
test('nzYmd buckets a UTC timestamp into the NZ calendar day, whatever the host TZ', () => {
    assert.equal(nzYmd('2026-09-30T13:00:00Z'), '2026-10-01'); // 2am NZDT on 1 Oct
    assert.equal(nzYmd('2026-10-01T10:59:00Z'), '2026-10-01'); // 11:59pm NZDT
    assert.equal(nzYmd('2026-10-01T11:00:00Z'), '2026-10-02'); // midnight rolls over
});

test('a row dated 2026-10-01 falls inside an October range regardless of TZ', () => {
    const rows = [{ id: 'x', date: '2026-10-01', bundlesKg: 10, looseKg: 0, ecoTiesKg: 0, xkg: { b10: 10 } }];
    const c = consumption({ rows, items, bom, settings, from: '2026-09-30', to: '2026-10-31' });
    assert.equal(c.byItem['prime-tie-bundled'], 10);
    const c2 = consumption({ rows, items, bom, settings, from: '2026-10-01', to: '2026-10-31' });
    assert.equal(c2.byItem['prime-tie-bundled'], undefined, 'from is exclusive: the count on D already includes D');
});

test('addDays / daysBetween are pure calendar arithmetic across the NZ DST change', () => {
    assert.equal(addDays('2026-09-26', 1), '2026-09-27'); // NZ DST starts 27 Sep 2026
    assert.equal(addDays('2026-10-01', -28), '2026-09-03');
    assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
});

// ── BOM expansion (§9 #4, #5) ────────────────────────────────────────────
test('5 × PT-l-10 reduces loose by 50 kg and each consumable by 5 × its recipe qty', () => {
    const c = consumption({ rows: [saleLoose5], items, bom, settings, from: '2026-10-01', to: '2026-10-31' }).byItem;
    assert.equal(c['prime-tie-loose'], 50);
    assert.equal(c['box-10kg'], 5);
    assert.equal(c['staple'], 20);
    assert.equal(c['bag-red'], 5);
    assert.equal(c['label-courier'], 1, 'per-despatch consumable once per order');
    assert.equal(c['prime-tie-bundled'], undefined);
});

test('eco Ties is governed by its own recipe, not an exclusion', () => {
    const c = consumption({ rows: [saleEco2], items, bom, settings, from: '2026-10-01', to: '2026-10-31' }).byItem;
    assert.equal(c['eco-ties'], 20);
    assert.equal(c['box-10kg'], 2);
    assert.equal(c['bag-eco'], 4);
});

test('1kg bags use fractional box quantities', () => {
    const row = { id: 'p', date: '2026-10-04', bundlesKg: 7, looseKg: 0, ecoTiesKg: 0, xkg: { b1: 7 } }; // 7 bags
    const c = consumption({ rows: [row], items, bom, settings, from: '2026-10-01', to: '2026-10-31' }).byItem;
    assert.equal(c['box-10kg'], 0.7);
    assert.equal(c['bag-red'], 7);
});

test('rows before the stock epoch are ignored; rows without xkg are counted, not silently dropped', () => {
    const c = consumption({ rows: [salePre], items, bom, settings, from: null, to: '2026-10-31' });
    assert.equal(c.rowCount, 0);
    const noX = { id: 'n', date: '2026-10-06', bundlesKg: 10, looseKg: 0, ecoTiesKg: 0 };
    const c2 = consumption({ rows: [noX], items, bom, settings, from: null, to: '2026-10-31' });
    assert.equal(c2.byItem['prime-tie-bundled'], 10);
    assert.equal(c2.rowsWithoutXkg, 1);
});

test('BOM versions apply by effective date; a SKU with no recipe consumes nothing', () => {
    const v2 = { versions: [
        { effectiveFrom: '2026-10-01', recipes: { 'PT-l-10': [{ consumableId: 'staple', qty: 4 }] } },
        { effectiveFrom: '2026-11-01', recipes: { 'PT-l-10': [{ consumableId: 'staple', qty: 2 }] } },
    ] };
    assert.equal(recipesFor(v2, '2026-10-15')['PT-l-10'][0].qty, 4);
    assert.equal(recipesFor(v2, '2026-11-01')['PT-l-10'][0].qty, 2);
    assert.deepEqual(recipesFor(v2, '2026-09-01'), {});
    const c = consumption({ rows: [saleEco2], items, bom: v2, settings: { ...settings, perDespatch: [] }, from: null, to: '2026-12-31' }).byItem;
    assert.equal(c['box-10kg'], undefined);
});

// ── On hand / on order / receipts (§9 #6, #7, #8) ────────────────────────
test('on hand = baseline − consumption + movements + receipts, per item, in its own unit', () => {
    const w = world({ movements: { 'box-10kg': [{ id: 'm1', itemId: 'box-10kg', date: '2026-10-08', qty: -10, type: 'wastage' }] } });
    const loose = onHandFor(items[1], w, '2026-10-31');
    assert.equal(loose.onHand, 750);
    const box = onHandFor(items[3], w, '2026-10-31');
    assert.equal(box.onHand, 400 - 5 - 2 - 10);
    const bundled = onHandFor(items[0], w, '2026-10-31');
    assert.equal(bundled.receipts, 1000, 'arrived shipment is a receipt');
    assert.equal(bundled.onHand, 6000);
});

test('a shipment ticked "Arrived" is received exactly once, however many times it is saved', () => {
    const twice = [shipArrived, { ...shipArrived, milestones: shipArrived.milestones.map(m => ({ ...m })) }];
    // Two objects with the same id = the same shipment saved twice; dedupe by id.
    const unique = [...new Map(twice.map(s => [s.id, s])).values()];
    assert.equal(receipts({ shipments: unique, from: '2026-10-01', to: '2026-10-31' }).length, 1);
    // And re-deriving is idempotent by construction.
    const a = receipts({ shipments: [shipArrived], from: '2026-10-01', to: '2026-10-31' });
    const b = receipts({ shipments: [shipArrived], from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(a, b);
    assert.equal(a[0].qty, 1000);
});

test('onOrder is in-transit shipments only and never appears inside onHand', () => {
    const lv = computeLevels(world(), '2026-10-31');
    const bundled = lv.items.find(i => i.id === SHIPMENT_PRODUCT_ID);
    assert.equal(bundled.onOrder, 1500);
    assert.equal(bundled.onHand, 6000);
    assert.equal(pendingShipments(world().shipments)[0].eta, '2026-11-20');
    for (const it of lv.items) if (it.id !== SHIPMENT_PRODUCT_ID) assert.equal(it.onOrder, 0);
});

test('an item with no committed count reports unknown, never 0 or ok', () => {
    const lv = computeLevels(world(), '2026-10-31');
    const lbl = lv.items.find(i => i.id === 'label-courier');
    assert.equal(lbl.onHand, null);
    assert.equal(lbl.status, 'unknown');
    const empty = computeLevels(world({ counts: [] }), '2026-10-31');
    assert.ok(empty.items.every(i => i.status === 'unknown' && i.onHand === null));
});

test('per-item baselines: a later partial recount rebases only the items it contains', () => {
    const recount = { id: 'cnt_2', label: 'Boxes only', date: '2026-10-20', status: 'committed', committedAt: '2026-10-20T05:00:00Z',
        lines: [{ itemId: 'box-10kg', counted: true, countedQty: 350 }] };
    const w = world({ counts: [opening, recount] });
    const lv = computeLevels(w, '2026-10-31');
    assert.equal(lv.items.find(i => i.id === 'box-10kg').baselineDate, '2026-10-20');
    assert.equal(lv.items.find(i => i.id === 'box-10kg').onHand, 350);
    assert.equal(lv.items.find(i => i.id === 'prime-tie-loose').baselineDate, '2026-10-01');
});

test('before the stock epoch the engine says so instead of returning zeros', () => {
    const lv = computeLevels(world(), '2026-09-30');
    assert.equal(lv.beforeEpoch, true);
    assert.equal(lv.items, undefined);
});

// ── Status tiers (§5.4) ──────────────────────────────────────────────────
test('status tiers evaluate in order and auto reorder points use lead time + safety', () => {
    const base = { watchMultiplier: 1.25, mode: 'auto', leadTimeDays: 14 };
    assert.equal(statusFor({ ...base, onHand: null }), 'unknown');
    assert.equal(statusFor({ ...base, onHand: 0, avgDaily: 1, daysCover: 0, reorderPoint: 21 }), 'out');
    assert.equal(statusFor({ ...base, onHand: 10, avgDaily: 1, daysCover: 10, reorderPoint: 21 }), 'critical');
    assert.equal(statusFor({ ...base, onHand: 20, avgDaily: 1, daysCover: 20, reorderPoint: 21 }), 'low');
    assert.equal(statusFor({ ...base, onHand: 25, avgDaily: 1, daysCover: 25, reorderPoint: 21 }), 'watch');
    assert.equal(statusFor({ ...base, onHand: 100, avgDaily: 1, daysCover: 100, reorderPoint: 21 }), 'ok');
    assert.equal(statusFor({ ...base, onHand: 100, avgDaily: 0, daysCover: null, reorderPoint: 0 }), 'unknown', 'no usage signal → never ok');
    assert.equal(statusFor({ ...base, mode: 'manual', onHand: 100, avgDaily: 0, daysCover: null, reorderPoint: 150 }), 'low');
});

test('a low item with a shipment landing before stock-out is flagged covered', () => {
    // Bundled: on hand 6000 by 31 Oct, manual point far above → low; heavy usage → stock-out in ~3 days; ship-42 ETA 20 Nov is after → not covered.
    const heavy = { id: 'h', date: '2026-10-30', bundlesKg: 5000, looseKg: 0, ecoTiesKg: 0, xkg: { b10: 5000 } };
    const w = world({ sales: [heavy], items: items.map(i => i.id === SHIPMENT_PRODUCT_ID ? { ...i, reorder: { mode: 'manual', manualPoint: 9000 } } : i) });
    let lv = computeLevels(w, '2026-10-31');
    let b = lv.items.find(i => i.id === SHIPMENT_PRODUCT_ID);
    assert.equal(b.status, 'low');
    assert.equal(b.covered, false);
    // Move the ETA to tomorrow → covered.
    const soon = { ...shipInTransit, milestones: shipInTransit.milestones.map((m, i, a) => i === a.length - 1 ? { ...m, date: '2026-11-01' } : m) };
    lv = computeLevels({ ...w, shipments: [shipArrived, soon] }, '2026-10-31');
    b = lv.items.find(i => i.id === SHIPMENT_PRODUCT_ID);
    assert.equal(b.covered, true);
    assert.equal(b.coveredBy.id, 'ship-42');
});

// ── Counts: commit freezes variance (§9 #9) ──────────────────────────────
test('committing snapshots expected/variance/valuation; later sales edits do not move it', () => {
    const w = world();
    const draft = { id: 'cnt_nov', label: 'November', date: '2026-11-01', status: 'draft', lines: [
        { itemId: 'prime-tie-loose', counted: true, countedQty: 740 },
        { itemId: 'box-10kg',        counted: true, countedQty: 390 },
        { itemId: 'staple',          counted: false, countedQty: null },
    ] };
    assert.equal(expectedForCount(draft, w)['prime-tie-loose'], 750);
    const committed = commitCount(draft, w, { committedAt: '2026-11-01T05:00:00Z', committedBy: 'andrew' });
    const loose = committed.lines.find(l => l.itemId === 'prime-tie-loose');
    assert.equal(loose.expectedQty, 750);
    assert.equal(loose.varianceQty, -10);
    assert.equal(loose.variancePct, -1.33);
    assert.equal(loose.unitValue, 11);
    assert.equal(loose.accountCode, '1440');
    assert.equal(committed.lines.find(l => l.itemId === 'staple').counted, false);
    // "Edit" history afterwards: the stored variance is a fact, not a formula.
    const w2 = world({ sales: [] });
    assert.equal(expectedForCount(draft, w2)['prime-tie-loose'], 800);
    assert.equal(loose.expectedQty, 750);
    // And the committed count is now the baseline for those items, but only those.
    const lv = computeLevels({ ...w, counts: [opening, committed] }, '2026-11-15');
    assert.equal(lv.items.find(i => i.id === 'prime-tie-loose').baselineDate, '2026-11-01');
    assert.equal(lv.items.find(i => i.id === 'staple').baselineDate, '2026-10-01');
    assert.throws(() => commitCount(committed, w), /already committed/);
});

test('commit refuses a counted line with no quantity, naming it', () => {
    const draft = { id: 'c', label: 'x', date: '2026-11-01', status: 'draft', lines: [{ itemId: 'staple', counted: true, countedQty: null }] };
    assert.throws(() => commitCount(draft, world()), e => e.missing[0] === 'staple');
});

// ── Valuation (§7, §9 #12) ───────────────────────────────────────────────
test('valuation uses snapshotted values and excludes not-counted lines; the engine never reads $', () => {
    const committed = commitCount({ id: 'c', label: 'x', date: '2026-11-01', status: 'draft', lines: [
        { itemId: 'prime-tie-loose', counted: true, countedQty: 100 },
        { itemId: 'staple', counted: false, countedQty: null },
    ] }, world());
    const { rows, total } = valuationRows(committed, items.map(i => ({ ...i, unitValue: 999 })));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unitValue, 11, 'snapshotted at commit, not today\'s price');
    assert.equal(rows[0].net, 1100);
    assert.equal(total, 1100);
    assert.equal(rows[0].description, 'Prime Tie Loose');
});

// ── FIFO cost lots (Prime Tie Bundled ↔ shipments) ───────────────────────
import { fifoFor } from '../functions/api/stock/_engine.js';

test('received shipments are FIFO lots at their $/kg; sales take the oldest lot first', () => {
    // Opening 5000 kg (no priced shipment before 1 Oct → item.unitValue 12.5),
    // ship-41 lands 10 Oct: 1000 kg @ $4.50. Sell 5200 kg on 15 Oct.
    const sale = { id: 'big', date: '2026-10-15', bundlesKg: 5200, looseKg: 0, ecoTiesKg: 0, xkg: { b10: 5200 } };
    const f = fifoFor(items[0], world({ sales: [sale] }), '2026-10-31');
    assert.equal(f.lots.length, 2);
    assert.equal(f.lots[0].id, 'opening');
    assert.equal(f.lots[0].remaining, 0);
    assert.equal(f.lots[1].id, 'ship-41');
    assert.equal(f.lots[1].remaining, 800);
    assert.equal(f.lots[1].unitCost, 4.5);
    assert.equal(f.value, 3600);
    assert.equal(f.onHand, 800);
    assert.equal(f.avgCost, 4.5);
    // Matches the plain on-hand arithmetic.
    assert.equal(onHandFor(items[0], world({ sales: [sale] }), '2026-10-31').onHand, 800);
});

test('a sale before any lot can cover it is a shortfall, taken from the next shipment to land', () => {
    const early = { id: 'e', date: '2026-10-05', bundlesKg: 5300, looseKg: 0, ecoTiesKg: 0, xkg: { b10: 5300 } };
    const f = fifoFor(items[0], world({ sales: [early] }), '2026-10-31');
    assert.equal(f.lots[0].remaining, 0);
    assert.equal(f.lots[1].remaining, 700, '300 kg shortfall came off ship-41 when it landed');
    assert.equal(f.shortfall, 0);
    assert.equal(f.onHand, 700);
    const f2 = fifoFor(items[0], world({ sales: [early] }), '2026-10-08'); // before ship-41 lands
    assert.equal(f2.shortfall, 300);
    assert.equal(f2.onHand, -300);
});

test('wastage depletes lots FIFO; positive adjustments become a lot at the latest cost', () => {
    const w = world({ sales: [], movements: { 'prime-tie-bundled': [
        { id: 'w1', itemId: 'prime-tie-bundled', date: '2026-10-12', qty: -100, type: 'wastage' },
        { id: 'a1', itemId: 'prime-tie-bundled', date: '2026-10-20', qty: 50, type: 'adjustment' },
    ] } });
    const f = fifoFor(items[0], w, '2026-10-31');
    assert.equal(f.lots[0].remaining, 4900);
    assert.equal(f.lots[2].unitCost, 4.5, 'adjustment lot takes the latest lot cost');
    assert.equal(f.onHand, 5950);
});

test('levels carry FIFO value for the shipment-fed product only; a count is valued at FIFO average cost', () => {
    const sale = { id: 'big', date: '2026-10-15', bundlesKg: 5200, looseKg: 0, ecoTiesKg: 0, xkg: { b10: 5200 } };
    const w = world({ sales: [sale] });
    const lv = computeLevels(w, '2026-10-31');
    const b = lv.items.find(i => i.id === SHIPMENT_PRODUCT_ID);
    assert.equal(b.value, 3600);
    assert.equal(b.avgCost, 4.5);
    assert.equal(lv.items.find(i => i.id === 'prime-tie-loose').value, null);
    const committed = commitCount({ id: 'c', label: 'Nov', date: '2026-11-01', status: 'draft', lines: [
        { itemId: 'prime-tie-bundled', counted: true, countedQty: 790 },
    ] }, w);
    assert.equal(committed.lines[0].unitValue, 4.5, 'FIFO average cost, not the item unitValue');
    assert.equal(committed.lines[0].expectedQty, 800);
});

// ── Landed cost per kg from shipment cost lines (import/_cost.js) ─────────
import { shipmentCost, shipmentKgIn } from '../functions/api/import/_cost.js';

test('a V3 shipment is costed at landed NZD ÷ yield kg; listed price is the fallback', () => {
    const forex = { EUR: 0.5, USD: 0.6, BDT: 70 }; // NZD base: 1 NZD = 0.5 EUR …
    const v3 = { id: 'ship-42', schema: 3, whiteRawKg: 6000, colourRawKg: 4000, wastePct: 10, fixedLines: {
        rawWhite:       { rate: 1.5, ccy: 'EUR' },   // 9,000 EUR → 18,000 NZD
        rawColour:      { rate: 0.75, ccy: 'EUR' },  // 3,000 EUR → 6,000 NZD
        freightBdNz:    { amount: 34000, ccy: 'NZD' },
        bundling:       { rate: 70, ccy: 'BDT' },    // 9,000 yield kg × 70 BDT = 630,000 BDT → 9,000 NZD
    } };
    assert.equal(shipmentKgIn(v3), 9000);
    const c = shipmentCost(v3, forex);
    assert.equal(c.basis, 'landed');
    assert.equal(c.total, 67000);
    assert.equal(c.unitCost, Math.round((67000 / 9000) * 10000) / 10000);
    // No cost lines → listed $/kg.
    assert.deepEqual(shipmentCost({ id: 'x', kg: 1000, pricePerKg: 4.5 }, forex), { unitCost: 4.5, basis: 'listed', total: null, kg: 1000 });
    assert.equal(shipmentCost({ id: 'y', kg: 1000 }, forex), null);
});

test('the engine prefers the stamped landed unitCost over the listed price', () => {
    const stamped = { ...shipArrived, unitCost: 7.25, costBasis: 'landed', kgIn: 950 };
    const r = receipts({ shipments: [stamped], from: '2026-10-01', to: '2026-10-31' })[0];
    assert.equal(r.qty, 950);
    assert.equal(r.unitCost, 7.25);
    assert.equal(r.costBasis, 'landed');
    const f = fifoFor(items[0], world({ sales: [], shipments: [stamped, shipInTransit] }), '2026-10-31');
    assert.equal(f.lots[1].unitCost, 7.25);
    assert.equal(f.lots[1].basis, 'landed');
});

// ── Sub-count by shipment → opening FIFO lots ────────────────────────────
test('a sub-counted opening count becomes one lot per shipment at its own $/kg, oldest first', () => {
    const ship40 = { id: 'ship-40', ym: '2026-05', kg: 5000, note: 'Shipment 40', unitCost: 8.98, costBasis: 'landed', milestones: [
        { label: 'a', date: '2026-05-01', done: true }, { label: 'Arrived in New Zealand', date: '2026-06-01', done: true }] };
    const ship41 = { ...shipArrived, unitCost: 9.5, costBasis: 'landed', milestones: shipArrived.milestones.map(m => ({ ...m, done: true, date: m.date || '2026-09-20' })) };
    // Count on 1 Oct: 450 kg of #40 and 1500 kg of #41 on the shelf (entered newest first).
    const count = { id: 'cnt_sub', label: 'Opening', date: '2026-10-01', status: 'committed', committedAt: '2026-10-01T05:00:00Z', lines: [
        { itemId: 'prime-tie-bundled', counted: true, countedQty: 1950, lots: [
            { shipmentId: 'ship-41', label: 'Shipment #41', kg: 1500, unitCost: null },
            { shipmentId: 'ship-40', label: 'Shipment #40', kg: 450,  unitCost: 8.98 },
        ] },
    ] };
    const w = world({ counts: [count], shipments: [ship40, ship41, shipInTransit], sales: [] });
    const f = fifoFor(items[0], w, '2026-10-31');
    assert.deepEqual(f.lots.map(l => [l.id, l.qty, l.unitCost, l.basis]), [['ship-40', 450, 8.98, 'counted'], ['ship-41', 1500, 9.5, 'counted']]);
    assert.equal(f.onHand, 1950);
    assert.equal(f.value, 450 * 8.98 + 1500 * 9.5);
    // #41's "Arrived" milestone is after the count date yet it must NOT be received again.
    assert.equal(onHandFor(items[0], w, '2026-10-31').onHand, 1950);
    // Selling 600 kg takes all of #40 first, then 150 of #41.
    const sale = { id: 's', date: '2026-10-10', bundlesKg: 600, looseKg: 0, ecoTiesKg: 0, xkg: { b10: 600 } };
    const f2 = fifoFor(items[0], { ...w, sales: [sale] }, '2026-10-31');
    assert.equal(f2.lots[0].remaining, 0);
    assert.equal(f2.lots[1].remaining, 1350);
    assert.equal(f2.value, 1350 * 9.5);
});

test('committing a sub-counted line sums the lots, snapshots each $/kg and values at the weighted average', () => {
    const ship41 = { ...shipArrived, unitCost: 9.5, costBasis: 'landed' };
    const draft = { id: 'd', label: 'Opening', date: '2026-11-01', status: 'draft', lines: [
        { itemId: 'prime-tie-bundled', counted: true, countedQty: null, lots: [
            { shipmentId: 'ship-41', kg: 1500, unitCost: null }, { shipmentId: null, label: 'Shipment #40', kg: 500, unitCost: 8.98 },
        ] },
    ] };
    const c = commitCount(draft, world({ shipments: [ship41, shipInTransit], sales: [] }));
    const line = c.lines[0];
    assert.equal(line.countedQty, 2000);
    assert.equal(line.lots[0].unitCost, 9.5, 'snapshotted from the shipment');
    assert.equal(line.lots[0].label, 'Shipment #41');
    assert.equal(line.unitValue, Math.round(((1500 * 9.5 + 500 * 8.98) / 2000) * 10000) / 10000);
});

test('renaming an item changes nothing about its stock', () => {
    const renamed = items.map(i => i.id === 'box-10kg' ? { ...i, name: 'Carton (10 kilo)' } : i);
    const a = computeLevels(world(), '2026-10-31').items.find(i => i.id === 'box-10kg');
    const b = computeLevels(world({ items: renamed }), '2026-10-31').items.find(i => i.id === 'box-10kg');
    assert.equal(a.onHand, b.onHand);
    assert.equal(a.status, b.status);
});
