# Stock engine — current model

**Status:** live (built Sep 2026) · **Timezone:** Pacific/Auckland; every business date is a local `YYYY-MM-DD` string, compared as strings · **Code:** `functions/api/stock/_engine.js` (pure), `_store.js` (KV), `stock.js` (UI) · **Tests:** `tests/stock-engine.test.js`, run under both `TZ=UTC` and `TZ=Pacific/Auckland`.

This document describes the model as it is now. The decision history is condensed in §9.

---

## 1. Principles

1. Nothing in the engine parses a description. Every row references an item id; product lines resolve through the catalogue's Type/Size.
2. Each item has exactly one unit — products `kg`, consumables `each` (with a display unit type: box, roll, bag…). Never summed together.
3. Stock is **derived on read** per item: latest committed count ± movements ± receipts − sales. Nothing stores a running balance.
4. **A count is the opening stock at 12:00am on its date.** Sales, movements and shipments landing on that date come off it. Ranges since a baseline are `[date, asOf]`.
5. On-order is never inside on-hand. An item with no committed count is `unknown`, never `0` or `ok`.
6. Committed counts freeze expected / variance / valuation. Everything else recomputes when history changes.
7. One seasonal sales curve (Imports → Forecast → monthly averages; Good ×1.1, Great ×1.2) drives the stock trajectory, the monthly forecast and the consumables forecast.

---

## 2. Items

Three products (`prime-tie-bundled` active; `prime-tie-loose`, `eco-ties` parked inactive) and any number of consumables, in KV `stock:item:<id>` with index `stock:items:index`.

```js
{ id, name, class: 'product'|'consumable', unit: 'kg'|'each', unitLabel: 'box', active, key, sortOrder,
  salesKey: 'bundles'|'loose'|'ecoTies',          // products: which sales_history bucket depletes it
  unitValue, accountCode,                         // valuation; Bundled's is derived from shipments
  profile: { retailer, retailerUrl, supplierSku, description, imageUrl, leadTimeDays, typicalCost, packSize },
  courierSku: 'FR-01'..'FR-04' | null, courierLabel: bool,   // label books (see §4.3)
  reorder: { mode, manualPoint, safetyDays, reorderQty } }
```

- **Products** carry no reorder point; status is only unknown / out / ok. Replenishment is a shipment decision read off the trajectory.
- **Consumables** get reorder tiers (`out → critical → low → watch → ok`) from trailing usage × (lead time + safety days), plus the forecast-based order-by date.
- **Images**: pasted URL, or an uploaded photo resized in the browser and stored in KV (`stock:image:<id>`, served by `/api/stock/items/:id/image`).
- Sheet SKU ↔ product mapping is one fixed table (`SKU_TABLE`): `PT-b-10/PT-b-1b → bundles`, `PT-l-10/PT-l-1b → loose`, `ET-b-10/ET-b-1b → ecoTies`, with kg per unit 10 / 1.

## 3. Prime Tie Bundled — shipments and FIFO

- Every shipment is Prime Tie Bundled (shipments have no product lines yet).
- **Received** = its last dated milestone ("Arrived in Tauranga") is ticked. Receipts are derived on read from the forecast's shipment list, never posted, so double-posting is impossible. A shipment sub-counted in the baseline count is never received again.
- **Cost per kg** = landed cost: all V3 cost lines (raw, Bangladesh, freight, misc, extra) converted to NZD ÷ yield kg (`import/_cost.js`, mirrors the Imports view). Falls back to the listed $/kg, then to the previous lot's cost.
- **FIFO lots** (`fifoFor`): the opening count is the first lot (or one lot per shipment when sub-counted, oldest first, each at its own $/kg); each received shipment is a lot; sales and wastage take from the oldest lot. Positive adjustments become a lot at the latest cost. Output: lots with remaining kg and value, on-hand value, weighted average $/kg, and every withdrawal with the cost of the kg it consumed.
- **COGS** (`cogsFor`): Bundled = what sales took from the lots at each lot's $/kg; Loose / eco Ties = kg × own cost per kg. Wastage is costed the same way but reported separately. Shown per sale in the ledger, per month under the lots, and on the tile.
- **On order** = shipments with status ordered / in-transit / customs, shown beside on-hand, never added to it. A low item with a shipment landing before its projected stock-out is flagged *covered*.

## 4. Consumption

All depletion is derived from `sales_history` (one row per order, NZ-dated, synced on every order write, courier-label creation and Xero push). Per row:

### 4.1 Products
`bundlesKg / looseKg / ecoTiesKg` → the product with that `salesKey`.

### 4.2 Consumables matrix
Products we sell (items sheet minus courier/freight) × consumables. Cells are **pieces per sale** (2 staples, 0.1 of a box); stock is in **units**; the consumable's *Quantity per unit* (`profile.packSize`) converts: 2 staples from a 1,000-staple box = 0.002 boxes. Units sold per SKU come from the row's type×size split (`xkg` ÷ kg per unit). A *Per order* row is consumed once per despatch. Stored as `stock:bom` (single version).

### 4.3 Courier label books
Four consumables seeded once (`labels-fr-01..04`, "Aramex labels · Local / Inner Island / Outer Island / Inter Island"), each tied to a courier SKU. The sales row carries the invoiced quantity per courier SKU (`svc`) and the total (`labels`); a book depletes one label per invoiced label of its own service. No matrix cell. Any consumable can be linked to a service (or "any courier label") from its card. Stopgap until the Posthaste (on-demand label) move — then deactivate the books.

### 4.4 Classification
`sales-history/_writer.js` classifies each order line by the catalogue's Type (deterministic); a SKU the catalogue knows but doesn't type (Hessian, freight) is `other` and never depletes anything. Payroll boxes and the order export use the same function. **Run Backfill orders** (Settings → Sales Data) after any classifier or catalogue change to re-file existing rows.

## 5. Counts and movements

- **Count** (`stock:count:<id>`): draft pre-populated with every active item (re-synced on open); live expected / variance while typing; explicit *Not counted*; per-shipment sub-count for Bundled (kg per shipment at its $/kg, totalling into Counted); commit freezes expected / variance / valuation and makes it the baseline; **Reopen to edit** returns it to draft with figures kept; label and date editable on committed counts (the baseline moves with the date). Expected for a count = stock at the start of that date.
- **Movements** (`stock:movements:<itemId>`, append-only): `receipt` (+), `adjustment` (±, "set on hand to X"), `wastage` (−), `correction`. The UI offers **Receive / Adjust** on every item; orders take stock out automatically. Mistakes are reversed with an opposite entry, never edited.
- **Ledger** (`/api/stock/items/:id/ledger`): baseline count, every order (linked, with customer and label count), shipments landed at $/kg, every movement with who posted it, running balance that closes at on-hand, COGS per sale for products.
- **Settings** (`stock:settings`): `stockEpoch` (2026-08-01; nothing before it counts), `consumptionWindowDays` (28), `defaultLeadTimeDays` (14), `defaultSafetyDays` (7), `watchMultiplier` (1.25), `perDespatch`, valuation defaults.

## 6. Forecasts

- **Trajectory** (`projectionFor`): from today, month-end on-hand N months ahead (13 or 36) per scenario. Products: their SKUs' share of the trailing-year mix × the seasonal curve, plus pending shipments in their ETA month (Bundled). Consumables: via the consumables forecast. Chart = actual (solid) + projected (dashed), landing months annotated.
- **Consumables forecast** (`consumablesForecast`): seasonal kg → sales units via the trailing-365-day product mix → pieces via the matrix (+ per-order, + labels per kg for label books) → month-by-month walk of on-hand (current month pro-rated) → run-out date; **order by** = run-out − (lead time + safety days); *Order now* when that has passed. One table with the current level and the forecast per consumable; default scenario Great +20%.
- **Imports page alignment**: `/api/import/forecast` overrides the hand-typed stocktake with the committed count (`stockAnchor`), reports stock now (count − sales + landed ± adjustments), flags sub-counted shipments so they aren't added again, and supplies monthly **Actual** = Bundled kg sold from the count date on (same filter as the engine). A month's est. sales = max(actual, forecast) — conservative; the Closing cell explains when the forecast overrode the actual. Actual cells open the month's orders (All / Bundled / Loose / eco, totals, in-count rows marked).

## 7. API

| Method | Path | Purpose |
|---|---|---|
| GET/PUT | `/api/stock/settings` | engine settings (§5) |
| GET/POST, GET/PATCH | `/api/stock/items[/:id]` | items; `POST/GET/DELETE …/:id/image`; `GET …/:id/ledger`; `GET …/:id/history?project=N` |
| GET/PUT | `/api/stock/bom` | consumables matrix (+ `products` for the rows) |
| GET/POST, GET/PATCH/DELETE | `/api/stock/counts[/:id]` | counts; `POST …/:id/commit`, `POST …/:id/reopen`, `GET …/:id/valuation[?format=csv]` |
| GET/POST | `/api/stock/movements` | ledger entries |
| GET | `/api/stock/levels?asOf=` | the one dashboard call: per item on-hand, on-order, value, COGS, status, covered, lots |
| GET | `/api/stock/consumables-forecast?months=` | §6 |
| GET | `/api/stock/shipments` | shipments by number with landed $/kg (sub-count picker) |
| GET | `/api/stock/sales?month=` | the month's orders with total vs Bundled kg |
| GET | `/api/stocktake[/:id]` | legacy $-valued snapshots, read-only archive |

## 8. Acceptance (all held by tests)

No description parsing · renaming changes nothing · units never summed · 5 × PT-l-10 reduces loose by 50 kg and each consumable by 5 × its cell ÷ pack size · eco Ties has its own cells, no exclusion · a shipment ticked twice is received once · no count → unknown · on-order never in on-hand · commit freezes variance · count = opening stock at 12:00am (2,000 on 1 Sep − 300 sold 1 Sep − 590 later = 1,110) · Bundled COGS from FIFO takes · Loose/eco COGS at unit cost · label book depletes only by its own service · forecast actuals are Bundled-only from sales history · identical results under UTC and NZ.

## 9. Decision history (condensed)

- 4 Sep 2026: rebuilt from the $-valued stocktake editor. Shipments = 100% Bundled; depletion from sales history on the order date; catalogue stays in Sheets; no blob storage; single role; Loose and eco Ties parked.
- Cost basis moved from listed $/kg to landed cost from V3 cost lines; FIFO lots; per-shipment sub-count on the opening count.
- Consumables: matrix in pieces with pack-size conversion; per-product lead time; forecast on the shared curve. Courier labels went from matrix rows → per-label setting → four label-book consumables tied to courier SKUs (final).
- Hero products lost their reorder point; In/Out/Adjust became Receive/Adjust; counts became reopenable; the consumables table absorbed the forecast.
- Hessian (1 kg/unit, untyped) was being filed as Loose and burning bags — classifier now trusts the catalogue Type only.
- 12 Sep 2026: count convention flipped from "end of day" to **opening stock at 12:00am on its date**; forecast Actual and stock now reconciled to the same filter; epoch moved to 1 Aug 2026.
