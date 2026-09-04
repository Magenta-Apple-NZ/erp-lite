# Stock & Stocktake System — Rebuild Spec (v2, corrected against the codebase)

**Status:** spec of record · **Cutover:** 1 October 2026 · **Timezone:** Pacific/Auckland — every business date is a local `YYYY-MM-DD` string, compared as strings.

This is the original brief corrected after reading the real schemas. Where it departs from the brief, the reason is stated. Decisions confirmed with Andrew on 4 Sep 2026 are marked **[decided]**.

---

## 1. What the code actually has (and what changed as a result)

| Brief assumed | Code reality | Consequence |
|---|---|---|
| Order lines may be packs or kg | Lines are `{ sku, description, quantity, unitPrice, accountCode, kgPerUnit }`. `quantity` = **units of the SKU** (one 10kg box, or one 1kg bag). | BOM is declared **per SKU**, with fractional quantities (a 1kg bag uses 0.1 of a 10kg box). No divisibility rejection needed. |
| New catalogue with `sizes[]` | Product catalogue already exists as a **Google Sheet** (`functions/api/catalog/items.js`). 6 product SKUs = 3 types × {10kg, 1kg bag}: `PT-b-10, PT-b-1b, PT-l-10, PT-l-1b, ET-b-10, ET-b-1b`. No 20kg. | No second product catalogue. Stock items map to sheet SKUs by a fixed lookup table (§3.2). Consumables exist only in KV. |
| Shipments have lines with status | A shipment is `{ id, ym, kg, note, milestones[{label,date,done}], startDate? }` — one kg total, no product split, status **derived** from milestones (`planning → ordered → in-transit → customs → delivered`). | **[decided]** A shipment is 100 % Prime Tie Bundled for now. Receipts are derived from the final milestone, not posted as ledger rows (§5.3). |
| Consumption derived from orders | `sales_history` already holds one NZ-dated row per order with kg by type (`bundlesKg/looseKg/ecoTiesKg`) and by type×size (`xkg.b1/b10/l1/l10/e1/e10`), synced on every order write. | **[decided]** All depletion — product kg *and* consumable burn — is derived from `sales_history`, so the sales chart, the stock engine and reorder maths share one source. Stock depletes on the **order date**. |
| Blob storage for images | KV only, no R2 binding. | `imageUrl` links out to the supplier page. No upload. |
| Test suite exists | No `package.json`, no runner. | Add a zero-dependency `node:test` suite; engine maths lives in a pure module. |
| Trailing 28-day usage | Sales are extremely seasonal (Nov ≈ 50 kg, Jul ≈ 7,000 kg). | **[decided]** Keep `avgDaily` from Sales History for uniformity. Known limitation: cover will read "unknown/∞" in the off-season. `consumptionWindowDays` is a setting so it can be widened. |
| Hessian, transfers, permissions | — | **[decided]** Hessian ignored. No Bundled→Loose transfer. Single role (no permissions) — `createdBy` still stamped from the Cloudflare Access email header. |
| Catalogue under Warehouse | Admin already has a Catalogue area (Prices / Stores / Printers / Sales Data / Payroll). | **[decided]** Stock items, packaging recipes and engine settings live in **Admin → Stock**. Warehouse keeps only Dashboard + Counts. |

---

## 2. Principles (unchanged from the brief)

1. Nothing in the stock engine ever parses a description. Every row references an item id.
2. Each item has exactly one unit — products `kg`, consumables `each`. Never summed together.
3. Stock is computed **per item**, from that item's own latest committed count.
4. Consumables are governed by an explicit packaging recipe (BOM). No hard-coded ratios, no `if (eco)`.
5. `onOrder` is never inside `onHand`.
6. An item with no committed count is `unknown`, never `0` or `ok`.
7. Committed counts snapshot their expected/variance and valuation; nothing recomputes them later.

---

## 3. Data model (KV, `ORDERS_KV`)

### 3.1 Settings — `stock:settings`
```js
{
  stockEpoch:            '2026-10-01',   // engine computes nothing before this
  consumptionWindowDays: 28,             // trailing window for avgDaily
  defaultSafetyDays:     7,
  watchMultiplier:       1.25,
  perDespatch:           [ { consumableId, qty } ],   // consumed once per order, e.g. courier label
  valuation:             { defaultAccountCode: '1440', gstBasis: 'ex' }
}
```

### 3.2 Item — `stock:item:<id>`, index `stock:items:index → [id]`
```js
{
  id: 'prime-tie-bundled',      // stable slug, never reused
  name: 'Prime Tie Bundled',
  class: 'product' | 'consumable',
  unit: 'kg' | 'each',          // immutable once the item has a committed count line
  active: true,
  key: true,                    // products only: pinned KPI tile on the dashboard
  sortOrder: 10,
  aliases: [],                  // CSV import names → this item (explicit, never fuzzy)

  // valuation (report only — the engine never reads these)
  accountCode: '1440', unitValue: 12.5, unitValueAsAt: '2026-10-01',

  // products only — which sales_history bucket depletes this item
  salesKey: 'bundles' | 'loose' | 'ecoTies',

  // consumables only
  profile: { retailer, retailerUrl, supplierSku, imageUrl, leadTimeDays, typicalCost, packSize, minOrderQty, notes },

  reorder: { mode: 'auto' | 'manual', manualPoint: null, safetyDays: 7, reorderQty: null }
}
```
Products are seeded as the three key items. Each maps to `sales_history` via `salesKey` (kg) and, for the BOM, via the fixed SKU ↔ `xkg` table — the only "mapping" in the system, in one place:

| Sheet SKU | `xkg` key | kg/unit | Product |
|---|---|---|---|
| PT-b-10 | b10 | 10 | prime-tie-bundled |
| PT-b-1b | b1 | 1 | prime-tie-bundled |
| PT-l-10 | l10 | 10 | prime-tie-loose |
| PT-l-1b | l1 | 1 | prime-tie-loose |
| ET-b-10 | e10 | 10 | eco-ties |
| ET-b-1b | e1 | 1 | eco-ties |

`units sold (SKU) = xkg[key] ÷ kg/unit`.

### 3.3 Packaging recipes (BOM) — `stock:bom`
```js
{ versions: [ { effectiveFrom: '2026-10-01', recipes: {
    'PT-l-10': [ { consumableId: 'box-10kg', qty: 1 }, { consumableId: 'staple', qty: 2 }, … ],
    'PT-l-1b': [ { consumableId: 'bag-black', qty: 1 }, { consumableId: 'box-10kg', qty: 0.1 }, … ],
    …
} } ] }
```
Versioned by `effectiveFrom`; a sales row uses the latest version whose `effectiveFrom ≤ row.date`. Recipes are keyed by sheet SKU. A SKU with no recipe consumes nothing (that is how eco Ties starts).

### 3.4 Count — `stock:count:<id>`, index `stock:counts:index → [{id,label,date,status}]`
```js
{
  id: 'cnt_20261001', label: 'Opening count', date: '2026-10-01',
  status: 'draft' | 'committed', committedAt, createdBy,
  lines: [ {
    itemId, counted: true | false,          // false = deliberately "not counted" (item keeps its old baseline)
    countedQty: 842.5,
    expectedQty, varianceQty, variancePct,  // frozen at commit (null while draft)
    varianceReason: '',
    unitValue, accountCode                  // snapshotted at commit for the valuation report
  } ]
}
```
A count pre-populates every active item. Only lines with `counted: true` rebase the item. Drafts never affect `onHand`.

### 3.5 Movement — `stock:movements:<itemId> → [Movement]`, index `stock:movements:index → [itemId]`
```js
{ id: 'mov_…', itemId, date: 'YYYY-MM-DD', qty: -25, unit,
  type: 'adjustment' | 'wastage' | 'correction',
  reason: 'Damaged', createdAt: ISO-UTC, createdBy: 'andrew@…' }
```
Append-only. Mistakes are reversed with a `correction`. (No `receipt`/`transfer` types yet — see §5.3.)

### 3.6 Legacy (read-only)
`stocktake:<id>`, `stocktake:list` — kept for prior-year valuations, shown under Warehouse → Counts → Archive. Never feed the engine. The Imports/Forecast crude stocktake (`startingKg` + `stocktakeDate`) is out of scope; tech debt to replace its seed with `onHand(prime-tie-bundled, date)` later.

---

## 4. Consumption (derived on read, never stored)

For each `sales_history` row with `stockEpoch ≤ row.date`, in range:
```
product kg:     item[salesKey]        += row.<salesKey>Kg
per SKU units:  units[sku]             = row.xkg[key] / kgPerUnit         (table §3.2)
consumables:    for each (sku, units): for each recipe entry (BOM version for row.date):
                    consumed[consumableId] += units × qty
per despatch:   for each row:  consumed[consumableId] += settings.perDespatch qty
```
Rows lacking `xkg` (pre-Hub historical rows) cannot burn consumables — irrelevant after the epoch since every Hub row carries it; the engine reports a `rowsWithoutXkg` count so the gap is visible, never silent.

Editing a historical order changes historical stock (single source of truth). Committed counts snapshot `expectedQty`, so stored variances don't move.

---

## 5. The engine — `functions/api/stock/_engine.js` (pure, testable)

### 5.1 On hand
```
baseline(item)         = latest committed count line for item with counted:true and date ≤ asOf
onHand(item, asOf)     = baseline.countedQty
                       + Σ movements    (baseline.date < d ≤ asOf)
                       + Σ receipts     (baseline.date < d ≤ asOf)     // products only, §5.3
                       − Σ consumption  (baseline.date < d ≤ asOf)     // §4
onHand = null (status 'unknown') when there is no baseline.
```
Baselines are **per item** — a March recount of boxes rebases boxes only.

### 5.2 On order
`onOrder(prime-tie-bundled) = Σ shipment.kg` for shipments whose derived status ∈ {ordered, in-transit, customs}. Zero for every other item until shipments carry lines. Shown beside `onHand`, never added to it.

### 5.3 Receipts (deviation from the brief, by design)
A shipment is received when its final milestone ("Arrived in New Zealand") is `done`; the receipt is **derived on read**: `+kg` to prime-tie-bundled on that milestone's date. No ledger row is written, so double-posting is impossible by construction and un-ticking the milestone reverses it automatically. This trades the brief's idempotent-upsert machinery for zero state. Revisit only when shipments gain per-product lines.

### 5.4 Low stock
```
avgDaily     = consumption over trailing consumptionWindowDays ÷ windowDays   (from sales_history)
daysCover    = onHand ÷ avgDaily                      (null when avgDaily = 0)
reorderPoint = mode='manual' ? manualPoint : avgDaily × (leadTimeDays + safetyDays)
               (products have no leadTime → auto mode uses settings.defaultSafetyDays + shipment lead of 0 → effectively manual for products)
```
Tiers, first match wins: `out` (onHand ≤ 0) → `critical` (daysCover < leadTimeDays) → `low` (onHand ≤ reorderPoint) → `watch` (≤ reorderPoint × watchMultiplier) → `ok`. `unknown` when no baseline, or avgDaily = 0 and no manual point.
`covered: true` when low/critical but an in-transit shipment's ETA (final milestone date, or `ym`-01) lands before the projected stock-out date.

---

## 6. API

| Method | Path | Purpose |
|---|---|---|
| GET / PUT | `/api/stock/settings` | §3.1 |
| GET / POST | `/api/stock/items` | list / create |
| GET / PATCH | `/api/stock/items/:id` | read / edit (soft delete via `active:false`; `unit` locked once counted) |
| GET / PUT | `/api/stock/bom` | §3.3 |
| GET / POST | `/api/stock/counts` | list / create draft (pre-populated) |
| GET / PATCH | `/api/stock/counts/:id` | read / edit draft (PATCH refused once committed) |
| POST | `/api/stock/counts/:id/commit` | freeze variances + valuation, make it a baseline |
| GET | `/api/stock/counts/:id/valuation` | Enviroware-format rows (+ `?format=csv`) |
| GET / POST | `/api/stock/movements` | ledger (`?itemId=&from=&to=`) / manual adjustment or wastage |
| GET | `/api/stock/levels?asOf=` | **the only dashboard call** — per item: onHand, onOrder, avgDaily, daysCover, reorderPoint, status, covered, baselineDate, unit |
| GET | `/api/stock/items/:id/history?from=&to=` | daily on-hand series + movement/receipt annotations for the trajectory chart |

Before `stockEpoch` every engine endpoint returns `{ beforeEpoch: true }`, not zeros.

---

## 7. UI

```
Admin → Stock            items (products pinned, consumables), consumable profile, packaging recipes (BOM), engine settings
Warehouse
 ├─ Dashboard (default)  3 KPI tiles (on-hand kg, cover, 90-day sparkline, status chip) · trajectory chart with reorder baseline + shipment ETA annotations · consumables table with on-hand/reorder meter, sorted worst-first
 └─ Counts               list · new count (pre-populated, live expected/variance, explicit "not counted") · committed view · valuation export · Archive (legacy snapshots)
Sales History            "Stocktake" tab removed
```
Status colours use one reserved palette (ok / watch / low / critical / out / unknown), always with an icon + text label, never colour alone. kg and $ never share a chart; no dual axes; incoming stock is an annotation, never a stacked series.

---

## 8. Dates & tests

- `functions/api/_dates.js` exports `nzToday()` and `nzYmd(iso)`; the sales-history writer switches to it.
- Never `new Date(x).toISOString().slice(0,10)` in stock code.
- `tests/stock-engine.test.js` (node:test, no deps) covers the acceptance list below and runs under both `TZ=UTC` and `TZ=Pacific/Auckland` (`npm test` runs both).

---

## 9. Acceptance criteria

1. No stock code path classifies by description; the `isProductRow`/`classify` regexes are deleted with the legacy endpoints.
2. Renaming an item changes nothing.
3. Every on-hand is in its own unit; no view sums kg and each.
4. A sales row for 5 × PT-l-10 reduces prime-tie-loose by 50 kg and each consumable by 5 × its recipe qty — from the BOM only.
5. eco Ties is governed by its own recipe; no eco exclusion anywhere.
6. A shipment ticked "Arrived" twice (or saved twice) yields exactly one receipt.
7. No committed count → `unknown`.
8. `onOrder` never appears inside `onHand`.
9. Commit freezes variance; later order edits don't change it.
10. Tests pass identically under both timezones.
11. The count editor exists at one route (Warehouse → Counts).
12. Valuation CSV for a committed count matches the Enviroware FY format.

## 10. Build order
1. `_dates.js`, settings, items, BOM (+ Admin → Stock UI)
2. Counts: draft / edit / commit (expected stubbed until 4)
3. Movements ledger
4. Engine: consumption from sales_history + BOM, receipts, `levels` — with tests
5. Warehouse Dashboard + Counts UI; remove Sales History tab; archive legacy
6. Valuation export; delete `/api/inventory/*`

Steps 1–4 ship before 1 October so the opening count has somewhere to go.

---

## 11. Addendum — 4 Sep 2026 (after first review)

- **Only Prime Tie Bundled is tracked.** Loose and eco Ties are seeded/migrated to `active:false`; reactivate from Catalogue → Stock if ever needed.
- **FIFO cost lots.** `fifoFor()` in the engine: every received shipment is a lot (kg at its listed `pricePerKg`); the opening count is the first lot, costed at the latest priced shipment on or before the count date. Sales and wastage take from the oldest lot first; positive adjustments become a lot at the latest cost. `levels` returns `value`, `avgCost`, `lots`, `shortfall` for the shipment-fed product, and a committed count values it at FIFO average cost as at the count date. Shipments only record a *listed* $/kg — landed cost is a follow-up.
- **Consumables matrix** replaces "packaging recipes": rows are the items-sheet products minus freight (`/api/stock/bom` → `products`), keyed by SKU. Only SKUs with a type×size mapping (`SKU_TABLE`) actually consume; others are shown as "no sales mapping yet".
- **Consumable fields** stripped to Retailer, Unit price, Quantity per unit, Image link, Link to product (+ name, active). Lead time is a single engine setting (`defaultLeadTimeDays`, default 14).
- **Stock nav item** added (Warehouse → Dashboard / Counts had no link before).
- **Testing from 1 Sep 2026.** Default `stockEpoch` is now `2026-09-01` (editable under Settings → Stock → Engine settings). Go-live count stays 1 Oct.
- **Counted shipments never double up.** `stockAnchor()` returns `countedShipmentIds`; the forecast flags those shipments `inCount` and `computeForecast` skips them as incoming, and the engine skips their receipt. "Arrived" = final milestone (Arrived in Tauranga) ticked.
- **Catalogue renamed Settings.** Prime Tie Bundled's popover shows on hand, weighted FIFO cost, the per-shipment lot breakdown and on-order shipments; stock changes only via a count or an adjustment. Products can carry an image link (URL only — no blob storage).
- **Consumables forecast.** `consumablesForecast()` shares the Imports seasonal curve (kg/month) and scenarios (Average / Good ×1.1 / Great ×1.2): kg → sales units via the trailing-365-day product mix from Sales History (`salesMix`), units → consumables via the matrix (+ per-order lines × orders-per-kg), then each consumable's on hand is walked 12 months (current month pro-rated) to a run-out date; **order by** = run-out − (lead time + safety). Lead time is per consumable (`profile.leadTimeDays`), falling back to the engine default. Dashboard section with scenario toggle and month-end strip. Endpoint `/api/stock/consumables-forecast`.
- **Consumables matrix** is a single table (no versions; stored as one version effective 2020-01-01).
- **Pieces vs units.** Matrix cells are in *pieces* (what one sale uses); stock is in *units* (boxes, rolls). `profile.packSize` ("Quantity per unit") converts: consumption = pieces ÷ packSize (`piecesPerUnit()`). 2 staples from a 1,000-staple box = 0.002 boxes per 10 kg sold.
- **Courier rows.** The four courier SKUs (FR-01..04) are matrix rows; the sales-history writer records their unit counts per row (`svc`), the engine burns per consignment, and the forecast uses courier consignments per kg from the trailing mix. Freight (FR-05+) is never a row. Run *Backfill orders* in Settings → Sales Data once so existing rows carry `svc`.
- **Receipts.** `receipt` movement type (always +) for consumable deliveries; "Receive" on each consumable row prefills the ledger form.
- **Courier consumables are per label, not per product (corrected).** The sales-history row carries `labels` (labels created on the order's courier record, else the labels invoiced on FR-01..04 lines). `settings.perLabel` lists the pieces each label uses; the engine burns `labels × perLabel`, the forecast uses labels-per-kg from the trailing mix. Courier SKUs are no longer matrix rows. This covers physical Aramex labels until the move to Posthaste (on-demand) — clear the row then. Creating a courier label re-syncs the sales row.
- **Per-item ledger (audit trail).** `ledgerFor()` lists the baseline count, every order (via `rowConsumption`, the same per-row expansion `consumption()` uses), shipments landed, manual receipts/adjustments/wastage, with a running balance that closes at on hand. `GET /api/stock/items/:id/ledger`; click any item name on the Stock dashboard.
- **Courier labels (corrected again, final).** A label book is an ordinary consumable flagged `courierLabel`. It depletes by the labels *invoiced* on each order (courier lines FR-01..04, quantity each; fallback: labels created). No matrix row, no per-label setting in the UI. Opening count − labels invoiced = on hand; the forecast uses labels-per-kg.
- **In / Out / Adjust** on every item (dashboard tiles + consumables table) post movements without a full count: In = receipt, Out = wastage, Adjust = "set on hand to X" (adjustment of the difference). The bottom ledger form is gone; counts are for opening stock and periodic true-ups.
- **Count dates are editable** on drafts and committed counts (committed: only label/date may change; frozen figures stay; the baseline moves with the date).
