# Business Hub

**Live:** [hub.primetie.co.nz](https://hub.primetie.co.nz) (Cloudflare Pages + Access)
**Repo:** `Magenta-Apple-NZ/erp-lite`
**Sprint window:** Apr 17 → Jul 17, 2026 (12 weeks · ~3 hrs/week · ~36 hrs total)
**Status:** Phase 1 (order model + Xero push) in progress. Imports / shipment-tracking prototype work running in parallel.

---

## Part 1 — Context

### What this is
The Business Hub is a mini-ERP for Prime Ties. It replaces a patchwork of three separate tools — a Chrome Extension scraper, Make webhooks, and a Render-hosted packing-slip generator — with one platform that owns orders, dispatch, and Xero invoice coordination.

### Who uses it
Two people, both behind Cloudflare Access. No public surface, no external customers logging in.

| User | Role |
|---|---|
| Andrew (head office) | Order entry, oversight, Xero, all admin |
| Warehouse staff (shared desktop) | Queue + flag actions, packing slips, dispatch |

### What we're trying to kill
- **Triple-keying.** Today an order is keyed into the Farmlands portal (scraped), into a Make scenario, and into Xero. We want one entry; everything else flows from it.
- **The manual dispatch log.** Replaced by an append-only log that writes itself as orders move through the Hub.
- **The triangle of services.** Chrome Extension + Make + Render PSG converge on the Hub. Make and Render get retired once the Hub can do their jobs.

### Convergence — three workstreams

| Workstream | Role | Final state |
|---|---|---|
| Chrome Extension | Data capture from Farmlands / Xero portals — browser scraping is something a server can't do well | **Permanent.** POSTs clean order payloads to `/api/orders`. |
| Business Hub | System of record — orders, ship-tos, status history, packing slips, Xero refs, dispatch log | **Permanent.** The platform. |
| Make + Render PSG | Glue that drives the current pipeline | **Transitional.** Retired after Phase 2 cutover. |

Convergence point: `/api/orders`. Once an order exists in Hub KV, packing-slip rendering and Xero invoice push are local operations.

### Architecture
- **Frontend** — single-page app, no framework, no bundler. `index.html` + `app.js` + `warehouse.js` + `calendar.js` + `styles.css` + `config.json`.
- **Backend** — Cloudflare Pages Functions under `/functions/api/` (Workers).
- **Persistence** — Cloudflare KV. `ORDERS_KV` (orders, hot/write-heavy), `XERO_KV` (OAuth tokens + cached customer/location data). `STORES_KV` and `ITEMS_KV` planned for Phase 2.
- **Auth** — Cloudflare Access locks the whole site to Andrew + warehouse.
- **Deploy** — push to `main` → Pages auto-deploys static assets and Workers.

### Source-of-truth decisions
- The Hub owns the order/dispatch model. Xero is a downstream subscriber — invoices are pushed when an order is dispatched. Xero can't be the source: no packing-slip type, no multi-branch ship-to (e.g. PGG Wrightson corporate → Martinborough branch).
- Xero (not MYOB) is the forward accounting path. MYOB decommission is a parallel track, not in this sprint.
- Warehouse scope this sprint is read-mostly: flag orders, see queues, no stock-on-hand entry yet.
- Packing slip layout is a customer-facing interface — match current PGG Wrightson / Farmlands expectations before any innovation. The format becomes a published spec the moment it ships.

### Non-goals (this sprint)
Inventory stock-on-hand tracking · supplier PO automation · MYOB decommission · pricing/costing rebuild · mobile-first warehouse UI.

---

## Part 2 — Roadmap

Five phases. Phase 1 in progress; later phases sequential except where called out.

### Phase 1 — Order model + Xero push (Weeks 1–3) · in progress
**Goal:** The Hub holds orders and can push an invoice to Xero.

**Built**
- Functions scaffolded — `/api/orders`, `/api/orders/[id]`, `/api/xero/{auth,callback,status,customers,push}`
- Order list, new-order form with Xero customer typeahead, packing-slip detail
- Xero OAuth flow working (KV namespaces still on placeholder IDs)
- KV bindings declared in `wrangler.toml`

**Remaining**
- Provision real `ORDERS_KV` + `XERO_KV` IDs in Cloudflare dashboard
- Verify end-to-end: create order → render packing slip → push Xero draft
- Seed store locations into KV from existing Google Sheet
- Lock the order schema — multi-branch ship-to, freight codes, line items, status, timestamps
- Lock the packing slip layout to match current customer-accepted format
- Token refresh logic so OAuth doesn't fail mid-dispatch (~30–60 day expiry)
- Parallel-running dedup — stable order ID scheme so Make + Hub can't both create the same Xero invoice
- Manual order-entry fallback so the pipeline survives Extension / Andrew's-machine failures

**Exit:** An order entered once produces a correct packing slip *and* a matching Xero draft, no retyping. Render's slip generator is feature-frozen — no new work goes there.

### Phase 2 — Warehouse queue + Extension cutover (Weeks 4–6)
**Goal:** Warehouse staff work from the Hub independently. Extension begins posting to Hub.

- `/warehouse` view: orders by status (Ready / Packing / Packed / Held)
- Flag actions write status + note + timestamp + actor → feeds Phase 4 log
- Add warehouse staff to Cloudflare Access
- Desktop-at-a-glance styling — bigger type, clear priority, one-click flags
- **Store locations to KV** — Google Sheet → JSON → KV; expose `/api/locations`
- **Extension parallel mode** — POSTs to Hub alongside the Make webhook for 2–4 weeks; compare outputs before cutting Make
- **Freight intelligence migration** — carton estimation, city-zone → FR-01/FR-07 logic, freight.csv lookup move from `farmlands.js` into Hub's `/api/orders`. Extension sends raw line items; Hub computes freight server-side.

**Exit:** Warehouse runs the day's queue without Andrew. Extension is dual-posting and outputs match Make's for one full week.

### Phase 3 — Close the loop on invoicing (Weeks 7–8)
**Goal:** "Packed" is the one click that finalises the sale.

- Packing flag → Worker patches Xero draft to *Authorised*, stamps dispatch date + tracking note, optionally attaches the packing-slip PDF
- Retire the Dispatch Tally sheet as a data-entry surface (regenerate as a Worker export if any report still needs tally-shaped data)
- Sales Data sheet: drop or auto-populate from Xero weekly

**Exit:** One Hub action records dispatch + invoicing + log + analytics.

### Phase 4 — Dispatch log (Weeks 9–10)
**Goal:** The manual dispatch log goes away.

- `/log` view: chronological dispatch log built from Phase 2's timestamped events
- Columns: date · order # · customer · ship-to branch · items · packed by · dispatched by · carrier/tracking · Xero invoice link
- Filters: date range, customer, staff member
- CSV export for accountant / audits

**Scoping caveat:** if "the manual log" includes inbound receiving, stock adjustments, or customer callbacks, Phase 4 widens — needs a 30-min scoping sync before Week 9.

**Exit:** Nothing about dispatches is being written by hand. "What did we send to X on Y" is one filtered view.

### Phase 5 — Imports + seasonal demand + hardening (Weeks 11–12)
**Goal:** Answer "do we have enough stock for the next 60 days?" and leave the system trustworthy.

- `/imports` view: shipments with ETA + status (Ordered / On water / At port / Cleared / In warehouse) + SKUs + qty
- Seasonal demand overlay: 12-month sales-by-SKU from Xero, monthly chart, upcoming shipments overlaid so coverage gaps versus seasonal peaks (spring) jump out
- Error handling on all Xero calls — token refresh, rate limits, network
- 1-page warehouse SOP + 15-min walkthrough
- Q3 backlog grooming — stock-on-hand, supplier POs, MYOB retirement

**Exit:** Imports view answers the coverage question in under a minute.

> The shipment-tracking / cost-breakdown / forecast / analytics work that's been landing recently is a Phase 5 prototype running ahead of schedule. Treat it as exploratory until Phase 1's Xero loop is closed.

---

## Planned features (Phase 2+)

Not part of the Phase 1 critical path. Sized and queued by warehouse impact.

| Feature | Phase | Effort | Impact | Notes |
|---|---|---|---|---|
| Courier labels (Aramex / Post Haste / ShipStation) | 2–3 | Med | 🔴 High | Top warehouse pain-point. One carrier in Phase 2 already shifts the day-to-day. Needs locked order schema. |
| PrintNode auto-print packing slips | 2–3 | Low | 🟠 Med | Quick warehouse win once Phase 1 slip view is stable. Already partially wired (warehouse printer reachable via PrintNode). |
| Email notifications (new POs / status changes) | 2–3 | Low–Med | 🟠 Med | Resend or SendGrid. Lands earlier as a generic "notify on status change". |
| WooCommerce order intake | 2+ | Med | 🟡 Varies | Diversifies sources beyond Farmlands. Scope first: one store vs. multi-vendor. |
| DocuPipe reduction | 2 | ? | 🟠 Med | Audit what DocuPipe actually does today before scoping. |
| Calendar (tax / payment dates / shipment milestones) | 2–5 | Low–Med | 🟡 Low | Already drafted (`calendar.js`); now picks up V3 shipment milestones. Administrative, not business-critical. |
| Xero Payroll push (employee self-service) | Post-sprint | Med | 🟠 Med | Hub-side payroll already shipped (rates, packing/timesheets CSV, payslip preview + PDF). Next: push timesheets to Xero Payroll API so it produces the official payslip. See section below. |

---

## Payroll → Xero Payroll API integration

**Already shipped (May 2026):** Hub-side payroll captures the four inputs — boxes dispatched (from Dispatch Log), boxes packed 10kg / 1kg (CSV round-trip), hours worked (CSV round-trip) — multiplies by per-employee rates, and renders an on-screen payslip + PDF. Stored in `payroll_config`, `packing_log`, `timesheets` KV blobs. This is enough for Andrew to compute pay, but the official payslip still gets keyed into Xero Payroll by hand.

**Goal:** Hub prepares the period inputs; Xero Payroll computes PAYE / KiwiSaver / ESCT / Holiday Pay accrual and produces the official payslip PDF. Eventually Jake submits his own numbers from a stripped-down view, with dispatched boxes pre-populated from his Dispatch Log activity.

**Pre-req:** Confirm Enviroware/Prime Tie has Xero Payroll enabled on the same org we already OAuth against. NZ Payroll API is a separate product subscription to standard Xero.

### Phase P1 — Plumbing & one-employee push (~1 week)
- Add OAuth scopes: `payroll.timesheets`, `payroll.employees.read`, `payroll.payruns.read`, `payroll.settings.read`. User re-consents Xero.
- `/api/xero/payroll/settings` — fetch Xero `EarningsRates` + `Employees`, cache in KV.
- Mapping screen in Payroll tab: each Hub line item → Xero `EarningsRateID`; each Hub employee → Xero `EmployeeID`. Persisted as a small KV blob (`payroll_xero_map`).
- "Push to Xero" button on the existing payslip preview. Builds a Xero **Timesheet** (`payroll.xro/1.0/Timesheets`) for the period — one line per Hub line item, units = our quantity — and POSTs it. Xero handles tax / KiwiSaver / leave at pay-run time.
- Inline response with link to the timesheet in Xero.

**Exit:** Andrew clicks "Generate payslip" then "Push to Xero" and the timesheet appears in Xero ready for pay run, no retyping.

### Phase P2 — Self-service view for Jake (~3–4 days)
- New `/payroll-submit` route — stripped-down employee view. Period selector defaults to current month. Dispatched boxes pre-filled from his Dispatch Log activity (read-only). Hours + packed boxes editable. Submit pushes the timesheet to Xero.
- Add Jake to Cloudflare Access. Gate admin vs. submit views by `CF-Access-Authenticated-User-Email` header — Jake only sees the submit view; Andrew sees both.

**Exit:** Jake submits his own period from his phone; Andrew approves the pay run in Xero.

### Phase P3 — Polish
- "Already submitted this period" guard — read timesheets back from Xero, show status.
- Optional reimbursements field (petrol, sundries) wired to Xero Reimbursement Pay Items.
- YTD figures on the on-screen preview (read from Xero pay run history).

---

## Risks & watchpoints

- **Scope creep in Phase 1.** Order model is the foundation; if it takes 12 hrs instead of 8, every later phase slides. Keep the first cut minimal — fields can always be added.
- **Warehouse adoption.** The queue must be faster than the email + sheet habit or it won't stick. Judge Phase 2 on *use*, not build completion. The 4-week live test (May 1–31) is the real verdict.
- **Xero rate limits** — 60 calls/min/org. Fine for two users; mind it if polling is added.
- **Cloudflare Workers learning curve** — first server-side piece. Budget an evening for OAuth alone.
- **Packing slip format drift** — PGG Wrightson and similar customers have established expectations. Parity before innovation; once it ships it's a published interface.
- **KV is append-only.** No transactions, no edits. Phase 1 orders are immutable (status flag only); add edit support later if live testing shows it's needed.
- **Extension is a single point of failure** — runs only on Andrew's machine. The manual order-entry form (Phase 1) is the safety valve.

---

## What success looks like (Jul 17, 2026)

1. Andrew never keys an order twice.
2. Warehouse staff open the Hub each morning and work from it autonomously.
3. Dispatch → Authorised Xero invoice is one action, not three.
4. The manual log is gone — events are captured automatically as orders move.
5. "When's the next container arriving and will it cover spring?" is answerable from the Hub.
