# Business Hub — Project Manifesto

**Owner:** Andrew McLeod — Calibrate (trading as Prime Ties / Enviroware)
**Live:** [hub.primetie.co.nz](https://hub.primetie.co.nz)
**Repo:** `Magenta-Apple-NZ/erp-lite`

> Companion to `Business-Hub-Brief.md` (one folder up). The brief is the technical snapshot; this is the why and the how-it-gets-used.

---

## Purpose

The Hub exists to **remove triple-keying from a two-person business**. Orders that used to be retyped from Farmlands portal → Make → packing slip generator → Xero now enter once and flow end-to-end. Sales history, dispatch logs, and shipment forecasts that used to live in three spreadsheets now live in one place that updates itself.

It is deliberately small: two users, one shared desktop, one warehouse, one printer station, one accountant. Anything that doesn't make that day-to-day easier doesn't ship.

---

## Principles

1. **Single source of truth.** An order, a sale, a shipment — each exists in exactly one place. Everything else is a view of it.
2. **The sheet is sacred (until the Hub overtakes it).** Historical sales pre-2026-04 live in the Google Sheet; from 2026-04 onward the Hub is authoritative. A single weaved series (`/api/sales/monthly`) feeds every chart so nothing diverges.
3. **No re-keying.** Order entered = packing slip generated = Xero invoice pushed = dispatch logged. One action per stage.
4. **Optimise for the work that happens.** Andrew reviews 5–20 orders a morning; warehouse dispatches them. Catalogue admin happens once a season. UI weight follows that.
5. **Cloud-backed, no DB to babysit.** Cloudflare KV holds orders + tokens. Google Sheets hold reference data the user already maintains in Sheets. No separate database server.
6. **Print is a first-class output.** Packing slips and address sheets go straight to the warehouse printer via PrintNode — no manual download/print.

---

## Who Uses It

| User | Where | Primary tasks |
|---|---|---|
| **Andrew** (admin) | Desktop, phone | Review API orders, push to Xero, monitor sales/forex/imports, link Xero invoices, manage catalogue |
| **Warehouse** (Jake) | Shared desktop in warehouse | Open the day's queue, send slips to the warehouse printer, mark orders dispatched |

Auth is via Cloudflare Access — only these two users can reach the app.

---

## Core Use Cases

### 1. Receive an order via API (Make.com / Chrome Extension / DocuPipe)
An external system POSTs to `/api/orders/inbound`. The Hub:
- Auto-assigns the next `PKS-####` ID
- Stores it with `status: 'new'`, `source: 'inbound'`
- Shows it in the orders list and on Andrew's dashboard "Needs Attention" alerts

**Andrew's turn:** opens the order detail page → sees an orange "Ready to push to Xero" banner → clicks **Send to Xero** → invoice drafted, status advances to `sent_to_xero`. One action, one source of truth.

### 2. Create an order manually
Hub user picks a customer (Xero typeahead), branch (catalogue store list), and line items (catalogue SKU autocomplete that stamps `kgPerUnit` for accurate kg/box maths). Auto-numbered `PKS-####`. Optional checkbox: "Don't push to Xero — invoice was created in Xero, I'll link it manually" for orders that originated in Xero.

### 3. Dispatch an order from the warehouse
Warehouse opens the orders list (filtered to their attribution), opens an order, clicks **Send Packing Slip → Warehouse** (printer registry in `config.json` defines which printers handle which document types), then **Mark as Dispatched**. The dispatcher dropdown defaults to the logged-in person; admin can override.

### 4. Quick mobile check-in (Andrew on the go)
On a phone (<640px), the nav collapses to **Orders** + **Calendar** only. Orders list reflows from table to cards. Andrew can review an inbound order, link it to a Xero invoice he just created in the Xero mobile app, and mark it dispatched — all from his phone.

### 5. See the sales picture
Sales History view shows monthly bar chart, cumulative line chart (Calendar / Financial Year toggle, NZ FY), Top Stores leaderboard with LY% comparison, and an Annual Summary table. All read from the same weaved monthly series (`/api/sales/monthly`) — sheet for closed periods, Hub orders for the live period. No chart can disagree with the table or the dashboard.

### 6. Forecast stock vs incoming shipments
Imports view models the next 18 months: opening stock − projected sales + arrivals from in-flight shipments. Shipments have 7 milestones (Start LC → Arrived in Tauranga); editing any milestone updates the arrival month the forecast uses. Monthly sales averages can be auto-computed from the historical series ("Recompute from history") so the forecast isn't fighting hand-entered guesses.

### 7. Glance at FX, shipments, the calendar, alerts
Dashboard tiles: NZD vs USD/EUR/AUD/BDT/ZAR sparklines from frankfurter.dev, incoming shipments next-up, mini sales + orders charts (same weaved series), Google Calendar 28-day strip, orders needing attention, latest orders.

### 8. Manage the catalogue + export
Catalogue admin: edit prices/stores inline, discover printers from PrintNode, **export the weaved monthly sales CSV** for accountant / sheet re-import / archive.

---

## What Replaces What

| Was | Is |
|---|---|
| Farmlands portal → manual order entry → Make webhook | Chrome Extension → `/api/orders/inbound` |
| Packing Slip Generator (Render Flask app) | Native packing slip in `orders.js` + direct PrintNode dispatch |
| MYOB invoice re-entry | Xero invoice draft pushed from the order detail page |
| Dispatch Tally Google Sheet | Hub Dispatch Log (per-person tabs: Jake / Andrew), populated from real status events |
| Sales spreadsheets (3 files) | One weaved series, served by `/api/sales/monthly`, consumed by every chart |
| Hand-entered monthly average sales | "Recompute from history" button |

---

## What This Is Not

- Not stock-on-hand tracking. The Catalogue has stocktake scaffolding but no live workflow.
- Not supplier PO automation.
- Not a Xero / MYOB replacement. Xero remains the accounting source of truth.
- Not multi-tenant. Two users by design.
- Not mobile-first for warehouse. Warehouse work happens on the desktop near the printer; mobile is for Andrew's check-ins.

---

## How "Done" Looks

A normal morning, August 2026:

1. Warehouse opens the Hub. Today's queue: 8 orders, all created via Extension or manually overnight.
2. Andrew reviews each from his phone over coffee; pushes 7 to Xero (one came from Xero originally, he links it).
3. Warehouse prints all 8 slips to the warehouse printer (one click each), packs them, marks each dispatched. Dispatcher dropdown is already set to Jake.
4. Dispatch Log auto-updates. Sales charts auto-update. Dashboard "Needs Attention" empties.
5. Nobody opens Make. Nobody opens the Packing Slip Generator. Nobody re-keys an invoice.

The brief lists the deeper success criteria for Jul 17, 2026; this is what the day-to-day feels like when the project has done its job.
