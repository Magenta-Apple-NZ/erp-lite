# Prime Ties — Streamlining Roadmap

**Horizon:** 3-month sprint (Apr 17 → Jul 17, 2026)
**Capacity:** A few hours a week, hands-on (target ~3 hrs/week ≈ 36 hrs total)
**Author:** Andrew McLeod

---

## Three-workstream architecture

Three systems exist today. Each has a distinct role. They converge into the Hub over time — none are deleted until the Hub can replace their output exactly.

### Current state

| Workstream | Where it runs | What it does today | Owner |
|---|---|---|---|
| **Chrome Extension** | Browser (Andrew's machine) | Scrapes Farmlands & Xero portals; posts to Make webhook + Render | Andrew only |
| **Packing Slip Generator** | Render (Node, always-on) | Receives order payload, generates PDF, uploads to Google Drive, returns slip URL | Standalone service |
| **Business Hub** | Cloudflare Pages | Dashboard of links/tools, growing into order management + Xero push | Andrew + warehouse |

### Current flow (Make scenario)

```
Extension scrapes Farmlands
  → POST to Make webhook
    → Parse JSON → Iterator → Array aggregator → Data store → Google Sheets
    → Xero: Create Invoice (draft)
    → HTTP POST /packing-slip → Render
      → Google Drive: upload PDF
      → Gmail: notify Andrew
```

All three pipelines end at the same two outputs: **packing slip PDF** + **Xero draft invoice**.

### Convergence point

The Hub's `/api/orders` is where all three pipelines will eventually land. Once an order exists in Hub KV, both outputs (packing slip from Hub's own renderer, Xero invoice via Hub's `/api/xero/push`) can be produced natively.

### Distinct roles (permanent, not transitional)

- **Chrome Extension** — *data capture only*. Scraping Farmlands and Xero portals is something a browser script does better than anything server-side. This role is permanent even post-convergence. The extension's job shifts from "drive Make + Render" to "POST a clean order payload to Hub `/api/orders`".
- **Hub** — *system of record*. Orders, ship-to addresses, status history, packing slips, Xero invoice refs, dispatch log. Everything that needs to be shared between Andrew and warehouse staff lives here.
- **Render / Packing Slip Generator** — *transitional*. Currently the only thing that can render a PDF. Once Hub's packing slip view is good enough (Phase 1 exit criteria), Render is retired. No new features go into Render from this point forward.
- **Make** — *transitional glue*. Webhooks, Google Sheets write-back, and Gmail notifications are all intermediary steps. Once Extension posts direct to Hub and Hub has its own notification path, Make is retired. No new scenarios should be added to Make.

### Convergence timeline

| Milestone | What changes |
|---|---|
| **Phase 1 complete** (Weeks 1–3) | Hub can create an order, render a packing slip, and push to Xero. Packing Slip Generator on Render is feature-frozen. |
| **Extension cutover** (Week 4–6, parallel to Phase 2) | Extension gains a new POST target: `hub.primetie.co.nz/api/orders`. Run parallel with Make for 2–4 weeks to verify parity. |
| **Make retirement** (after parallel verification) | Remove Make webhook from Extension. Make scenario is archived, not deleted — keep it as a fallback for 30 days then remove. |
| **Render retirement** (after Make retirement) | Once packing slips are being generated from Hub for all orders, shut down the Render service. Export any PDFs already in Google Drive before removing. |
| **Store locations migration** (Phase 2 or alongside) | Google Sheet of store locations (`StoreCode`, `StoreName`, `City`, branch address) moves into Hub KV (Phase 2) or D1 (Phase 4). Extension reads from Hub `/api/locations` rather than fetching the Sheet CSV directly. |
| **Freight intelligence migration** (alongside Extension cutover) | Carton estimation, city-zone mapping, FR-01/FR-07 courier code logic, and freight.csv rate lookup all live in `farmlands.js` today. These move into Hub's order schema and `/api/orders` validation — so any order created via Hub (not just Extension) gets the same freight intelligence. |

### Decision: parallel running vs clean cutover

Run **parallel** for the Extension-to-Hub cutover. Rationale:
- The Make/Render pipeline is production and handles live invoicing
- Parallel mode means Extension POSTs to both Hub and Make simultaneously for 2–4 weeks
- Compare outputs (packing slip accuracy, Xero invoice lines, freight codes) before cutting the wire
- Clean cutover only after one full week of zero discrepancies

Do **not** run parallel for Render retirement — just switch off once Make is gone (Render only receives from Make).

---

## Guiding decisions (from prioritisation pass)

- **Biggest pain:** Dispatch & packing slips + Inventory/import timing.
- **Source of truth for orders:** The **Hub** owns the order/dispatch data model. Xero is a downstream subscriber — invoices get pushed to Xero when an order is dispatched. Xero can't be the source because Xero has no packing slip document type and can't hold multi-branch ship-to data (e.g. PGG Wrightson corporate customer → Martinborough branch delivery). This is exactly why the Packing Slip Generator was built in the first place.
- **BusinessHub's future:** Grow into a mini-ERP. Two users — Andrew (head office) + warehouse staff on a shared desktop.
- **MYOB → Xero:** Mid-transition. This roadmap assumes Xero is the forward accounting path but does not try to finish MYOB decommission in the 3-month window (parallel track).
- **Warehouse scope:** Read-mostly. Flag orders, access a small set of spreadsheets, and use the dispatch log. No stock-on-hand entry this sprint.
- **Logging:** Replace the currently-manual dispatch log with a Hub log view. (Assumed scope — see note at bottom.)

## Architecture shift this sprint implies

The Hub moves from static site to full-stack. Still one repo, still deployed via Cloudflare Pages, but with:

- **Cloudflare Worker** (Pages Functions) — server-side logic, Xero OAuth, API calls.
- **Cloudflare KV or D1** — persistent store for orders, ship-to addresses, dispatch log, warehouse flags.
- **Cloudflare Access** (already in place) — locks it to Andrew + warehouse staff.

The Hub owns the order schema. Xero is called when financial state needs to change (invoice authorised on dispatch). The Render-hosted Packing Slip Generator either (a) gets folded into the Hub so it reads from Hub KV directly, or (b) stays separate and reads from the Hub's API — open question, decide in Week 1.

Non-goals for this sprint (explicit): inventory stock-on-hand tracking, supplier PO automation, MYOB decommission, pricing/costing rebuild, mobile-first warehouse UI.

---

## Phase 1 — Order model + Xero push (Weeks 1–3, ~8 hrs) ✅ IN PROGRESS

**Goal:** The Hub holds orders and can push an invoice to Xero. Kill the tally → slip → Xero triple-keying.

**Already built:**
- Cloudflare Functions scaffolded: `/api/orders` (list + create), `/api/orders/[id]` (get + patch), `/api/xero/auth`, `/api/xero/callback`, `/api/xero/status`, `/api/xero/customers`, `/api/xero/push`
- Orders UI: list view, new order form with Xero customer typeahead, packing slip detail view
- Xero OAuth flow working (ORDERS_KV + XERO_KV namespaces need provisioning in Cloudflare dashboard)
- KV namespace bindings declared in `wrangler.toml`

**Remaining to complete Phase 1:**
- Provision KV namespaces in Cloudflare dashboard and set real IDs in `wrangler.toml`
- Verify end-to-end: create order → render packing slip → push to Xero draft invoice
- Ship-to branch: add store locations to KV (`xero_cache:stores`) so "Ship To" is a searchable dropdown, not free text (seed from existing Google Sheet export)

**Packing Slip Generator (Render) is feature-frozen from this point.** No new work goes into the Render service — all slip rendering now comes from Hub's `/orders/:id` view.

**Exit criteria:** An order entered once in the Hub produces a correct packing slip AND a matching Xero draft invoice, no retyping.

## Phase 2 — Warehouse queue + Extension cutover (Weeks 4–6, ~8 hrs)

**Goal:** Warehouse staff work from the Hub independently. Extension begins posting to Hub.

- `/warehouse` view: orders grouped by status — *Ready to pack* / *Packing* / *Packed* / *Held*.
- Flag actions write status + note + timestamp + actor (who clicked) to KV. This data feeds the log in Phase 4.
- Add warehouse staff email to Cloudflare Access.
- Desktop-at-a-glance styling: bigger type, clear priority ordering, one-click flags.
- **Store locations in Hub KV**: export Google Sheet as JSON, seed into KV, expose `/api/locations`. Ship-to dropdown on new order form uses this.
- **Extension parallel mode**: add Hub POST target alongside existing Make webhook. Compare outputs for 2–4 weeks.
- **Freight intelligence**: carton estimation, city-zone → FR-01/FR-07 logic, freight.csv rate lookup move from `farmlands.js` into Hub's order creation API. Extension sends raw line items; Hub calculates freight fields before saving.

**Exit criteria:** Warehouse staff can see the day's queue and flag orders without Andrew. Extension is posting to Hub in parallel with Make.

## Phase 3 — Close the loop on invoicing (Weeks 7–8, ~6 hrs)

**Goal:** The "Packed" flag is the action that finalises the sale.

- Flagging an order *Packed* → Worker updates the Xero draft to *Authorised*, adds dispatch date + tracking note, optionally attaches the packing slip PDF.
- Retire the Dispatch Tally sheet as a data-entry surface. If Looker Studio or any report still needs tally-shaped data, regenerate from Hub KV via a scheduled Worker export.
- Sales Data sheet: drop if unused, or auto-populate from Xero weekly.

**Exit criteria:** One Hub action records dispatch + invoicing + feeds the log + updates analytics.

## Phase 4 — Dispatch log (replaces manual log) (Weeks 9–10, ~4 hrs)

**Goal:** Replace whatever's currently manual with a queryable, append-only log.

- `/log` view: chronological dispatch log from the timestamped events Phase 2 has been writing since Week 4. Columns: date, order #, customer, ship-to branch, items, packed by, dispatched by, carrier/tracking, linked Xero invoice.
- Filters: date range, customer, staff member.
- Export to CSV for anything that needs to live outside the Hub (accountant, audits).
- If the manual log also captures things Phase 2 doesn't (e.g. receiving inbound, stock adjustments, customer callbacks), add the fields and a second log type here — needs 30 min of scoping with you before building.

**Exit criteria:** Nothing about dispatches is being written by hand anymore. Looking up "what did we send to X on Y" takes one filtered view.

## Phase 5 — Imports view + seasonal demand + hardening (Weeks 11–12, ~6 hrs)

**Goal:** Answer "do we have enough stock for the next 60 days?" and leave the system solid.

- `/imports` view: manual-entry shipments with ETA, status (*Ordered / On water / At port / Cleared / In warehouse*), SKUs + qty.
- Seasonal demand overlay: pull 12-month sales-by-SKU from Xero, chart monthly, overlay upcoming shipments so coverage gaps are obvious against seasonal peaks (spring).
- Error handling on all Xero calls (token refresh, rate limits, network).
- 1-page SOP for warehouse staff + 15-min walkthrough.
- Backlog grooming for Q3: stock-on-hand, supplier PO intake, MYOB retirement.

**Exit criteria:** Imports view answers the coverage question in under a minute. System is trustworthy enough to leave running.

---

## Parallel, low-effort wins (any week, 15-min slots)

- Pin `/orders`, `/warehouse`, `/log` in `config.json` as each phase lands.
- Add an "MYOB cutover checklist" link in the Accounting group so the transition has a visible home.
- Tag suppliers in `config.json` with reorder lead-time so the imports view can flag lateness automatically later.
- Build a branch table for PGG Wrightson (and any other multi-branch customer) so ship-to is a dropdown, not free text.

## Risks & watchpoints

- **Scope creep in Phase 1.** Order model is the foundation. If it takes 12 hrs instead of 8, every later phase slides. Keep the first cut minimal — you can always add fields.
- **Xero API rate limits:** 60 calls/min per org. Fine for two users; mind it if polling gets added.
- **Cloudflare Workers learning curve:** First server-side piece. Budget Week 1 evening for OAuth alone.
- **Warehouse adoption:** The queue has to be faster than email+sheet habit or it won't stick. Judge Phase 2 on *use*, not build completion.
- **Packing slip format drift:** If PGG Wrightson (or any big customer) has a required packing slip layout, make sure the Hub's generator matches what they currently accept — parity before innovation.
- **Manual log scope.** If "logging" means more than dispatch (e.g. a paper log in the warehouse for receiving, or a stock movement journal), Phase 4 grows. Flag for 30-min scoping before Week 9.

## What success looks like on Jul 17

1. Andrew no longer keys any order twice.
2. Warehouse staff open the Hub each morning and work from it autonomously.
3. Dispatch → Authorised Xero invoice is one action, not three.
4. The manual log is gone — everything is written automatically as orders move through the Hub.
5. "When's the next container arriving and will it cover spring?" is answerable from the Hub.

---

### Assumption flagged for confirmation

"Re-create the logging that's currently manual" is assumed to mean the dispatch log (what went out, when, to whom, by whom). Phase 4 covers this naturally because Phase 2 starts writing those events from Week 4. If the manual log is actually something different — a paper book in the warehouse, a separate receiving log, a stock-movement journal, or a customer-callback register — the scope of Phase 4 needs to widen and we should scope it in a 30-minute session before Week 9.
