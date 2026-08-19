# Business Hub

**Live:** [hub.primetie.co.nz](https://hub.primetie.co.nz) (Cloudflare Pages + Access)
**Repo:** `Magenta-Apple-NZ/erp-lite`
**Original sprint:** Apr 17 → Jul 17, 2026 (12 weeks · ~3 hrs/week)
**Status (Aug 2026):** The original five-phase sprint is delivered and the platform has grown past it — orders, dispatch, imports/forecast, sales analytics, stocktake, Letter-of-Credit checking, courier (test mode), and Hub-side payroll are all live. This doc now describes what's shipped and what's still open, not a sprint in flight.

---

## Part 1 — Context

### What this is
The Business Hub is a mini-ERP for Prime Ties. It replaced a patchwork of separate tools — a Chrome Extension scraper, Make webhooks, and a Render-hosted packing-slip generator — with one platform that owns orders, dispatch, Xero invoice coordination, imports, and reporting.

### Who uses it
Two people, both behind Cloudflare Access. No public surface, no external customers logging in.

| User | Role |
|---|---|
| Andrew (head office) | Order entry, oversight, Xero, imports, LC, all admin |
| Warehouse staff (shared desktop) | Queue + flag actions, packing slips, dispatch, stocktake |

### What we set out to kill — and did
- **Triple-keying.** An order was keyed into the Farmlands portal (scraped), into a Make scenario, and into Xero. Now it enters once and the packing slip + Xero invoice flow from it.
- **The manual dispatch log.** Replaced by an append-only log that writes itself as orders move through the Hub.
- **The manual "is it paid?" check.** Order payment status now reconciles automatically from Xero.

### Convergence — three workstreams

| Workstream | Role | State |
|---|---|---|
| Chrome Extension | Data capture from Farmlands / Xero portals — browser scraping a server can't do | **Permanent.** POSTs clean order payloads to `/api/orders/inbound`. |
| Business Hub | System of record — orders, ship-tos, status history, packing slips, Xero refs, dispatch log, imports, reporting | **Permanent.** The platform. |
| Make + Render PSG | Glue that drove the old pipeline | **Being retired.** Slip rendering + Xero push are now native to the Hub; confirm what still runs through Make. |

Convergence point: `/api/orders`. Once an order exists in Hub KV, packing-slip rendering, freight calculation, and Xero invoice push are all local operations.

### Architecture
- **Frontend** — single-page app, no framework, no bundler. `index.html` + `app.js` + `styles.css` + `config.json`, with per-view modules: `orders.js`, `warehouse.js` (stocktake), `imports.js`, `sales.js`, `dispatch-log.js`, `payslips.js`, `lc.js`, `admin.js`, `calendar.js`.
- **Backend** — Cloudflare Pages Functions under `/functions/api/` (Workers). Domains: `orders/`, `xero/`, `sales-history/`, `catalog/`, `import/`, `stocktake/`, `lc/` + `lc-*`, `courier/`, `payroll/`, `print/`, `calendar/`.
- **Persistence** — Cloudflare KV. `ORDERS_KV` (orders, `sales_history`, stocktake snapshots, import forecast, payroll blobs, LC records — hot/write-heavy). `XERO_KV` (OAuth tokens + cached customers, alerts, payment-reconcile state). Catalogue **items** and **stores** are read live from published Google Sheets (single source of truth, edge-cached).
- **Integrations** — Xero (OAuth: invoices, payments, AR alerts), Google Drive (LC document archive), Google Calendar, PrintNode (depot printing), GoSweetSpot / Post Haste (courier, test mode), Chrome Extension (order intake).
- **Auth** — Cloudflare Access locks the whole site to Andrew + warehouse. `/api/me` resolves the role from the authenticated email.
- **Deploy** — push to `main` → Pages auto-deploys static assets and Workers.

### Source-of-truth decisions
- The Hub owns the order/dispatch model. Xero is a downstream subscriber — invoices are pushed from the Hub; payment status flows back. Xero can't be the source: no packing-slip type, no multi-branch ship-to (e.g. PGG Wrightson corporate → Martinborough branch).
- Xero (not MYOB) is the accounting path. MYOB decommission remains a parallel track, out of scope here.
- Catalogue (items + stores) lives in Google Sheets, read live by the Hub — so pricing, kg-per-unit, product **Type/Size**, and store **zones** are edited in one place.
- Packing slip layout is a customer-facing interface — it matches current PGG Wrightson / Farmlands expectations. The format is a published spec now that it's shipped.

### Still out of scope
Real-time per-SKU stock-on-hand (we have periodic **stocktake snapshots** + a forward **forecast**, not continuous inventory) · supplier PO automation · MYOB decommission · pricing/costing rebuild · mobile-first warehouse UI.

---

## Part 2 — What's shipped

The original five phases are delivered. Marking them against the plan:

| Phase | Goal | Status |
|---|---|---|
| **1 · Order model + Xero push** | Order entered once → packing slip + Xero invoice | ✅ Delivered — plus automatic payment reconciliation back from Xero |
| **2 · Warehouse queue + freight** | Warehouse works from Hub; freight computed server-side | ✅ Delivered — queue, PrintNode auto-print, zone/units-per-box freight, stores catalogue |
| **3 · Close the invoicing loop** | "Complete" finalises the sale | ✅ Delivered — dispatch → Xero; payment status syncs |
| **4 · Dispatch log** | Manual log goes away | ✅ Delivered — auto log feeds payroll + analytics |
| **5 · Imports + seasonal demand** | "Enough stock for 60 days?" | ✅ Delivered — shipment milestones, stock trajectory, forecast, full sales analytics |

### By domain

**Orders & dispatch**
- Order list + new/edit form with Xero customer typeahead; multi-branch ship-to; freight lines
- Native packing slips (Render PSG retired for new work); PrintNode auto-print to the depot
- Xero push: draft → invoice, PKS-id-derived numbers, contact-ID self-heal via live Xero search, **push available on any status until invoiced** (stages needn't be linear)
- **Payment reconciliation** — `/api/xero/reconcile-payments` stamps `paidAt` from Xero (auto on Orders load, throttled; manual "Sync payments" button)
- Dispatch log view built from timestamped status events

**Catalogue** — items + stores from Google Sheets; product **Type/Size** and store **zone** columns drive freight and sales classification deterministically.

**Sales History & analytics** — historical seed + live-order append; Sales by Month, Cumulative (Calendar/Financial page toggle), Product Type × Size, Annual Summary, Top Stores; page-level size filter (All / 10kg / 1kg); CSV round-trip + **Replace-historical** bulk import. **Stocktake** editor embedded here (snapshots, value-over-time, CSV import).

**Imports / forecast** — shipments with editable milestone timelines, cost breakdown, and an 18-month stock trajectory (Average / Good / Great) with shipment arrivals overlaid.

**Letter of Credit checker** — upload + extract, per-document AI checks primed with real ANZ discrepancy patterns, grouped requirements, manual-accept overrides, Drive archival, and a print-ready ANZ presentation packet.

**Payroll (Hub-side)** — per-employee rates × dispatched/packed boxes + hours → on-screen payslip + PDF.

**Platform** — Google Calendar, AR unpaid/overdue dashboard alerts, role-gated views.

---

## Part 3 — Live backlog

What's genuinely still open, roughly by value:

1. **Courier go-live.** GoSweetSpot / Post Haste integration is built and reconciles ordered-vs-invoiced labels, but runs in **mock/test mode**. To ship: set `GSS_ACCESS_KEY` / `GSS_SITE_ID`, drop `COURIER_TEST_MODE`, and re-expose the front-end control (currently hidden).
2. **Xero Payroll API push (P1–P3, below).** The largest un-started track — push a Timesheet to Xero Payroll so Xero produces the official payslip, and eventually Jake self-submits. Pre-req: confirm Xero **Payroll** is enabled on the org.
3. **Make / Extension cutover.** Confirm what still runs through Make and retire it; the Extension stays as the intake source.
4. **Data hygiene.** Ongoing: customer-name normalisation (`PGG` vs `PGG Wrightson`, `Horticentre` vs `HortiCentre Ltd`), placeholder-contact cleanup, historical-seed corrections.
5. **Polish / hardening.** Consistent Xero error handling (token/rate/network), warehouse SOP, and grooming the Q3 backlog (stock-on-hand, supplier POs, MYOB retirement).

---

## Payroll → Xero Payroll API integration

**Already shipped:** Hub-side payroll captures the inputs — boxes dispatched (from the Dispatch Log), boxes packed 10kg / 1kg, hours worked — multiplies by per-employee rates, and renders an on-screen payslip + PDF. Stored in `payroll_config`, `packing_log`, `timesheets` KV blobs. Enough to compute pay; the official payslip is still keyed into Xero Payroll by hand.

**Goal:** Hub prepares the period inputs; Xero Payroll computes PAYE / KiwiSaver / ESCT / Holiday Pay and produces the official payslip. Eventually Jake submits his own numbers from a stripped-down view, dispatched boxes pre-filled from his Dispatch Log activity.

**Pre-req:** Confirm Enviroware/Prime Tie has Xero **Payroll** enabled on the org we already OAuth against — it's a separate subscription to standard Xero.

### Phase P1 — Plumbing & one-employee push (~1 week)
- Add OAuth scopes: `payroll.timesheets`, `payroll.employees.read`, `payroll.payruns.read`, `payroll.settings.read`. User re-consents Xero.
- `/api/xero/payroll/settings` — fetch Xero `EarningsRates` + `Employees`, cache in KV.
- Mapping screen: each Hub line item → Xero `EarningsRateID`; each Hub employee → Xero `EmployeeID` (persisted as `payroll_xero_map`).
- "Push to Xero" on the payslip preview builds a Xero **Timesheet** for the period (one line per Hub line item) and POSTs it; Xero handles tax / KiwiSaver / leave at pay-run time. Inline link to the timesheet.

**Exit:** Andrew clicks "Generate payslip" then "Push to Xero" and the timesheet appears in Xero ready for pay run, no retyping.

### Phase P2 — Self-service view for Jake (~3–4 days)
- `/payroll-submit` route — stripped-down employee view. Dispatched boxes pre-filled (read-only); hours + packed boxes editable; submit pushes the timesheet.
- Add Jake to Cloudflare Access; gate admin vs. submit views by authenticated email.

**Exit:** Jake submits his own period; Andrew approves the pay run in Xero.

### Phase P3 — Polish
- "Already submitted this period" guard (read timesheets back from Xero).
- Optional reimbursements field wired to Xero Reimbursement Pay Items.
- YTD figures on the preview (from Xero pay-run history).

---

## Risks & watchpoints

- **Warehouse adoption.** The queue must be faster than the email + sheet habit. Judge on *use*, not build completion.
- **Xero rate limits** — 60 calls/min/org. Fine for two users; the payment-reconcile and alerts endpoints self-throttle (5-min caches) to stay clear.
- **Xero token refresh** — refresh tokens rotate on every use; the Hub re-reads KV on a refresh race and prompts a reconnect if it can't recover.
- **Packing slip format drift** — PGG Wrightson and similar have established expectations. Parity before innovation; it's a published interface now.
- **KV has no transactions.** Orders self-heal on index races; bulk writes back up first (`backup:sales_history:<ts>` etc.).
- **Extension is a single point of failure** — runs only on Andrew's machine. The manual order-entry form is the safety valve.
- **Service-account Drive** — LC archival requires a Shared Drive (service accounts have no personal-Drive quota) and full `drive` scope with `supportsAllDrives`.

---

## What success looks like — and where we stand

1. **Andrew never keys an order twice.** ✅ Order → slip → Xero invoice from one entry.
2. **Warehouse works from the Hub each morning.** ✅ Queue, slips, dispatch, stocktake — pending the real verdict: sustained daily use.
3. **Dispatch → Authorised Xero invoice is one action.** ✅ Push + payment sync close the loop.
4. **The manual log is gone.** ✅ Events captured automatically.
5. **"Next container — will it cover spring?" answerable from the Hub.** ✅ Imports forecast + stock trajectory.

Remaining to call the whole thing "done": courier live, Xero Payroll push, and Make fully retired.
