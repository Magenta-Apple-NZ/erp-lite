# Business Hub

**Owner:** Andrew McLeod — Calibrate (trading as Prime Ties / Enviroware)
**Live:** [hub.primetie.co.nz](https://hub.primetie.co.nz) (Cloudflare Pages + Access) · **Repo:** `Magenta-Apple-NZ/erp-lite`
**Status (Sep 2026):** the original 12-week sprint (Apr–Jul 2026) is delivered and the platform has grown past it. This is the single project document: why it exists, what's shipped, what's still open. Technical detail for the stock engine lives in [Stock-Rebuild.md](Stock-Rebuild.md); developer setup in [README.md](README.md); agent guidance in [CLAUDE.md](CLAUDE.md).

---

## 1. North star

The Hub exists to **remove re-keying from a two-person business**. An order enters once and flows end-to-end: packing slip → courier label → Xero invoice → dispatch log → sales history → stock and forecast. Sales, dispatch, shipments and stock that used to live in spreadsheets live in one place that updates itself.

It is deliberately small: two users, one shared warehouse desktop, one printer station, one accountant. Anything that doesn't make that day easier doesn't ship.

### Principles
1. **Single source of truth.** An order, a sale, a shipment, a count — each exists in exactly one place. Everything else (charts, forecasts, stock levels, payslips) is a view derived from it on read.
2. **The sheet is sacred until the Hub overtakes it.** Historical sales pre-April 2026 live in the Google Sheet seed; from April 2026 the Hub is authoritative. Catalogue items and stores stay in Google Sheets, read live.
3. **No re-keying.** Order entered = slip printed = invoice pushed = dispatch logged = stock depleted. One action per stage.
4. **Optimise for the work that happens.** Andrew reviews 5–20 orders a morning; the warehouse dispatches them; catalogue admin happens once a season. UI weight follows that.
5. **Cloud-backed, no database to babysit.** Cloudflare KV for records, Google Sheets for reference data, no server.
6. **Print is a first-class output.** Slips, address sheets and courier labels go straight to the depot printers via PrintNode.
7. **NZ calendar dates everywhere.** Every business date is a Pacific/Auckland `YYYY-MM-DD`; UTC timestamps are audit metadata only.

### Who uses it
| User | Where | Does |
|---|---|---|
| Andrew (admin) | Desktop + phone | Order review, Xero, imports, LC, stock counts, settings |
| Warehouse (Jake) | Shared depot desktop | Queue, print slips + labels, dispatch |

Both behind Cloudflare Access. `/api/me` maps the email to a role (UX gating only).

### What "done" looks like — a normal morning
1. Warehouse opens the Hub: today's queue, created overnight by the Chrome Extension or by hand.
2. Andrew reviews from his phone; pushes each to Xero (or links one that started in Xero).
3. Warehouse prints slips and courier labels to the depot printers, packs, marks each dispatched.
4. Dispatch log, sales history, stock on hand, consumables forecast and payroll inputs all update themselves.
5. Nobody opens Make. Nobody re-keys an invoice. Nobody counts boxes to know what to reorder.

---

## 2. Architecture

- **Frontend** — single-page app, no framework, no bundler: `index.html` + `styles.css` + `app.js`, one IIFE module per view (`orders.js`, `stock.js`, `warehouse.js` (Imports/forecast), `sales.js`, `admin.js`, `payslips.js`, `lc.js`, `calendar.js`, `dispatch-log.js`). Chart.js via CDN.
- **Backend** — Cloudflare Pages Functions under `functions/api/`. Domains: `orders/`, `xero/`, `sales-history/`, `catalog/`, `import/`, `stock/`, `courier/`, `payroll/`, `print/`, `calendar/`, `lc-*`. Shared helpers are underscore-prefixed (`_dates.js`, `_xero.js`, `_freight.js`, `_courier.js`, `stock/_engine.js`, `stock/_store.js`, `import/_cost.js`, `sales-history/_writer.js`).
- **Persistence** — Cloudflare KV. `ORDERS_KV`: orders, `sales_history`, stock (`stock:*`), import forecast, payroll, LC records, legacy `stocktake:*`. `XERO_KV`: OAuth tokens, cached customers, alerts, payment-reconcile state.
- **Reference data** — catalogue items (SKU, kg, Type/Size, units per box, prices) and stores (branch, zone, pickup) are published Google Sheets read live at the edge.
- **Integrations** — Xero (invoices, payments, P&L, AR alerts), GoSweetSpot / Post Haste (courier), PrintNode (depot printing), Google Drive (LC archive), Google Calendar, Anthropic (LC extraction, PO-PDF import), Chrome Extension (order intake → `/api/orders/inbound`).
- **Deploy** — push to `main`; Pages deploys static assets and Functions together.
- **Tests** — `npm test` runs the stock-engine suite under `TZ=UTC` and `TZ=Pacific/Auckland` (must agree).

### Source-of-truth decisions
| Thing | Lives in | Notes |
|---|---|---|
| Orders, ship-tos, status events, courier record | Hub KV | Xero is downstream (invoice pushed from the Hub; payment status flows back) |
| Sales history | Hub KV `sales_history` | One row per order, NZ-dated, kg by type and type×size, courier label counts; synced on every order write |
| Catalogue (items, stores) | Google Sheets | Type/Size/kg/units-per-box drive classification, freight and box counts |
| Seasonal sales forecast | Imports → Forecast → monthly averages | The one curve behind the stock trajectory, monthly forecast, consumables forecast |
| Stock | Hub KV `stock:*` | Committed counts + derived depletion from sales history; see Stock-Rebuild.md |
| Accounting | Xero | MYOB decommission is a separate track |

---

## 3. What's shipped

**Orders & dispatch** — list + new/edit form with Xero customer typeahead, multi-branch ship-to, catalogue SKU autocomplete, server-side freight (zones, units-per-box, 14-box courier ceiling, pickup stores skip freight). PDF PO import (Claude extracts a customer's PO into the form). Native packing slips with PrintNode auto-print. Non-linear status; Xero push on any status until invoiced; automatic payment reconciliation. Dispatch log from timestamped events. Order audit + storeId mapping tools.

**Courier** — GoSweetSpot / Post Haste live. Three-page label wizard (Recipient → Items → Print), box counts from catalogue units-per-box, two-fold label reconciliation that blocks creation on mismatch, PrintNode label printing, label popup (PDF, print, download, tracking). Aramex physical label books are tracked as stock per courier service until the Posthaste (on-demand) move.

**Stock** — the engine described in Stock-Rebuild.md. Prime Tie Bundled on FIFO shipment lots with landed cost; consumables with a product × consumable matrix; counts (opening stock at 12:00am on their date, per-shipment sub-count, reopen/edit); Receive / Adjust movements; per-item ledger with COGS; 13/36-month trajectory and consumables forecast on the shared seasonal curve; valuation CSV per committed count. Loose and eco Ties are parked (inactive) until wanted.

**Imports / forecast** — shipments with milestone timelines and V3 landed-cost breakdown (feeds FIFO lot cost); stock trajectory anchored on the committed count; monthly forecast with Average / Good / Great; monthly averages recomputable from history.

**Sales history & analytics** — seed + live append; by month, cumulative (calendar / FY), type × size, annual, top stores; CSV round-trip and replace-historical import; store auto-match with stable storeId.

**Payroll (Hub-side)** — monthly cycle; boxes dispatched auto-counted per pay month from the dispatch log (manual month reassignment), manual packed boxes / hours, base rate + petrol from settings, on-screen payslip + PDF. Inputs are ready for Xero Payroll (not yet pushed).

**Letter of Credit checker** — upload + extract, per-document AI checks primed with ANZ discrepancy patterns, manual-accept overrides, Drive archive, print-ready presentation packet.

**Platform** — Settings (prices, stores, printers, sales data, payroll, stock), Google Calendar, three-column dashboard (sales/stock · Xero P&L + AR · calendar), notifications view + nav badge, role-gated navigation.

---

## 4. Live backlog

Roughly by value. Items marked **[review 12 Sep]** came out of the code review and are not yet done.

1. **Xero Payroll push** — the largest un-started track (see §5). Pre-req: confirm Xero Payroll is enabled on the org.
2. **Make / Extension cutover** — confirm what still runs through Make and retire it; the Extension stays as intake.
3. **Concurrency on KV read-modify-write [review 12 Sep]** — `sales_history` upserts, `order_counter`, and `stock:movements` all read-modify-write whole blobs; two overlapping writes can lose a row. Serialise through one writer (Durable Object or queue) or verify-after-write. Orders self-heal on the index; sales rows and movements do not.
4. **Role enforcement server-side [review 12 Sep]** — `/api/me` gates the UI only. Add a `_middleware.js` that maps the Access email to a role and blocks destructive verbs for the warehouse account. Also check `orders/by-po.js` (extension-facing) for the `X-Hub-Key` guard.
5. **Stock engine performance [review 12 Sep]** — `historyFor` recomputes on-hand per day (O(days × rows)); fine at today's window, walk events once before the epoch window grows past a year.
6. **Shipment schema validation [review 12 Sep]** — `POST /api/import/forecast` persists shipments verbatim; validate id / ym / kg / milestones since they feed receipts, lots and on-order.
7. **Consolidate duplicated helpers [review 12 Sep]** — CSV parser ×7, "load every order" ×8, forex / shipment-status / V3 derived maths forked between `warehouse.js` and `functions/api/**`. Extract `_csv.js`, `loadOrders()`, and share the shipment maths.
8. **Dead or undocumented endpoints [review 12 Sep]** — `orders/import.js` + `orders/export.js` (bulk edit pair; `import.js` writes orders without re-syncing sales history) and `import/index.js` + `import/fetch.js` (`import:schedule`) have no frontend caller. Delete or document as manual tools.
9. **Backups** — `backup:*` keys are written without TTL; add a 90-day expiry.
10. **Data hygiene (ongoing)** — customer/store-name consistency; placeholder-contact cleanup; historical-seed corrections; a family-fold safeguard for report grouping.
11. **Polish** — consistent Xero error handling (token / rate / network), an order/backup search tool, GoSweetSpot void-label, warehouse SOP, mobile-first warehouse UI (deliberately out of scope so far).
12. **Frontend consolidation [review 12 Sep]** — one dashboard load still fetches the forecast up to 5× and the calendar 2× (hoist one promise-cached loader in app.js); `api()`, `escHtml`, `showToast`, `fmtDate` and the modal scaffold are each defined in 6–9 modules with slightly different behaviour; `alert()` still used for errors in lc.js / payslips.js / orders.js; ~370 unused CSS selectors (db-alerts, db-grid, imp-connect/cost/matrix families); dead nav-bootstrap blocks in app.js; the Stock trajectory chart should use the shared chart registry so it's destroyed on navigation.
13. **Retire the manual Imports stocktake** — `startingKg` / `stocktakeDate` are still writable as a fallback; once the first count is committed they are superseded by the stock anchor and can go.

### Still out of scope
Supplier PO automation · MYOB decommission · pricing/costing rebuild · multi-tenant anything.

---

## 5. Payroll → Xero Payroll API

**Already shipped:** monthly Hub payroll with clean inputs (`payroll_config`, `payroll_monthly`, dispatch-log boxes per pay month). The official payslip is still keyed into Xero Payroll by hand.

**Goal:** the Hub prepares period inputs; Xero Payroll computes PAYE / KiwiSaver / ESCT / holiday pay and produces the official payslip. Eventually Jake submits his own numbers.

**Pre-req:** confirm Xero **Payroll** is enabled on the org we OAuth against (separate subscription).

- **P1 — plumbing + one-employee push (~1 week).** Scopes `payroll.timesheets payroll.employees.read payroll.payruns.read payroll.settings.read` (re-consent). `/api/xero/payroll/settings` fetches EarningsRates + Employees into KV. Mapping screen: Hub line item → EarningsRateID, Hub employee → EmployeeID (`payroll_xero_map`). "Push to Xero" on the payslip builds and POSTs a Timesheet for the period. *Exit:* Generate payslip → Push to Xero → timesheet appears in Xero, no retyping.
- **P2 — self-service view for Jake (~3–4 days).** `/payroll-submit`: dispatched boxes pre-filled, hours + packed boxes editable, submit pushes the timesheet. Add Jake to Access; gate by email. *Exit:* Jake submits; Andrew approves the pay run in Xero.
- **P3 — polish.** "Already submitted" guard (read timesheets back), reimbursements → Xero Reimbursement Pay Items, YTD on the preview.

---

## 6. Risks & watchpoints

- **Warehouse adoption** — judge on sustained daily use, not build completion.
- **Xero rate limits** (60/min/org) — reconcile and alerts self-throttle with 5-minute caches. Refresh tokens rotate on every use; a refresh race prompts a reconnect.
- **KV has no transactions** — see backlog #3. Bulk writes back up first (`backup:*`).
- **Extension is a single point of failure** — runs on Andrew's machine; the manual order form is the safety valve.
- **Packing slip format** is a published customer-facing interface — parity before innovation.
- **Service-account Drive** — LC archival needs a Shared Drive and full `drive` scope.
- **Seasonality vs trailing usage** — consumables reorder from a 28-day trailing window reads near zero in Nov–Feb; the forecast-based order-by dates are the signal to use, not the reorder tier.

---

## 7. What replaced what

| Was | Is |
|---|---|
| Farmlands portal → manual entry → Make webhook | Chrome Extension → `/api/orders/inbound` (or PDF PO import) |
| Packing Slip Generator (Render) | Native slip in `orders.js` + PrintNode |
| MYOB invoice re-entry | Xero invoice pushed from the order |
| Dispatch tally sheet | Hub dispatch log from status events |
| Three sales spreadsheets | `sales_history` + one weaved monthly series |
| Hand-entered monthly averages | "Recompute from history" |
| Annual $-valued stocktake spreadsheet | Stock counts + FIFO lots + valuation CSV |
| Aramex label books counted by eye | Label-book consumables depleting per invoiced label |
