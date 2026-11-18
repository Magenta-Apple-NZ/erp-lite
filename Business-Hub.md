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

- **Frontend** — single-page app, no framework, no bundler: `index.html` + `styles.css` + `app.js`, one IIFE module per view (`orders.js`, `stock.js`, `warehouse.js` (Imports/forecast), `shipdocs.js` (shipment export documents), `sales.js`, `admin.js` (Settings), `integrations.js` (Settings → Integrations), `remittance.js`, `payslips.js`, `lc.js`, `calendar.js`). Chart.js via CDN.
- **Backend** — Cloudflare Pages Functions under `functions/api/`. Domains: `orders/`, `xero/`, `sales-history/`, `catalog/`, `import/`, `stock/`, `courier/`, `payroll/`, `print/`, `calendar/`, `lc-*`. Shared helpers are underscore-prefixed (`_dates.js`, `_xero.js`, `_freight.js`, `_courier.js`, `_gdrive.js`, `_integrations.js`, `stock/_engine.js`, `stock/_store.js`, `import/_cost.js`, `import/_exportdocs.js`, `import/_shipxero.js`, `import/_xlsx.js`, `sales-history/_writer.js`).
- **Persistence** — Cloudflare KV. `ORDERS_KV`: orders, `sales_history`, stock (`stock:*`), import forecast, shipment export documents (`shipdocs:*`), payroll, LC records, legacy `stocktake:*`. `XERO_KV`: OAuth tokens, cached customers, alerts, payment-reconcile state, chart-of-accounts cache, remittance log (`remit:*`) + settings.
- **Reference data** — catalogue items (SKU, kg, Type/Size, units per box, prices) and stores (branch, zone, pickup) are published Google Sheets read live at the edge.
- **Integrations** — Xero (invoices, payments, P&L, AR alerts, shipment bills and the export invoice to JPS), GoSweetSpot / Post Haste (courier), PrintNode (depot printing), Google Drive (LC archive), Google Calendar, Anthropic (LC extraction, PO-PDF import, supplier packing list / proforma / JPS invoice extraction), Chrome Extension (order intake → `/api/orders/inbound`).
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

**Orders & dispatch** — list + new/edit form with Xero customer typeahead, multi-branch ship-to, catalogue SKU autocomplete, server-side freight (zones, units-per-box, 14-box courier ceiling, pickup stores skip freight). PDF PO import (Claude extracts a customer's PO into the form). Native packing slips with PrintNode auto-print. Non-linear status; Xero push on any status until invoiced; automatic payment reconciliation. Remittance reconciliation: a customer remittance PDF is read by Claude, tied out (invoices − deductions = total), matched to Xero by invoice number (full / part / overpaid / missing), then one click posts each rebate as a GST-inclusive AR credit note allocated to the largest invoices plus one batch payment for the cash, so the bank-feed line matches in one click (`functions/api/xero/remittance/*`, `remittance.js`; logged per remittance in `XERO_KV` so it can't be applied twice). Dispatch log from timestamped events. Order audit + storeId mapping tools.

**Courier** — GoSweetSpot / Post Haste live. Three-page label wizard (Recipient → Items → Print), box counts from catalogue units-per-box, two-fold label reconciliation that blocks creation on mismatch, PrintNode label printing, label popup (PDF, print, download, tracking). Aramex physical label books are tracked as stock per courier service until the Posthaste (on-demand) move.

**Order activity log** — every order write is recorded server-side (`orders/_events.js`): the time from the server clock, the person from Cloudflare Access (not the browser), and a field-level diff of what moved (status, customer, PO, ship-to, each line's qty / price / added / removed, invoice, paid, courier label, payslip). Document events cover the packing slip, address sheet and courier label across PrintNode (outcome logged by `/api/print` even if the tab closes), browser print (dialog opened, not confirmed), PDF download and PDF view. Integrations log as `system` (Xero sync, inbound webhook). Deleting an order leaves a `deleted:order:<id>` tombstone holding the order, its log and who deleted it. The order page shows the log newest first with All / Changes / Documents filters.

**MCP server (read-only)** — `/api/mcp` lets Claude query orders (with their activity log), sales kg, stock levels and ledgers, the consumables forecast, shipments and receivables. Writes are blocked at the KV binding, auth is a verified Access JWT or a bearer token. Setup in README.md. Write tools (e.g. draft order from a PO) are a later step and would go through the normal write paths.

**Stock** — the engine described in Stock-Rebuild.md. Prime Tie Bundled on FIFO shipment lots with landed cost; consumables with a product × consumable matrix; counts (opening stock at 12:00am on their date, per-shipment sub-count, reopen/edit); Receive / Adjust movements; per-item ledger with COGS; 13/36-month trajectory and consumables forecast on the shared seasonal curve; valuation CSV per committed count. Loose and eco Ties are parked (inactive) until wanted.

**Imports / forecast** — shipments with milestone timelines (a stage is done only when ticked; stages run in order, so ticking one ticks those before it and unticking one unticks those after; untouched dates are projections that follow the default gaps; a stage whose date has passed without a tick shows amber, with a one-click catch-up that leaves the last stage alone because it books the stock in; the linked LC's issue and shipment dates are offered for LC ready and Shipped) and V3 landed-cost breakdown (feeds FIFO lot cost); stock trajectory anchored on the committed count; monthly forecast with Average / Good / Great; monthly averages recomputable from history.

**Sales history & analytics** — seed + live append; by month, cumulative (calendar / FY), type × size, annual, top stores; CSV round-trip and replace-historical import; store auto-match with stable storeId.

**Payroll (Hub-side)** — monthly cycle; boxes dispatched auto-counted per pay month from the dispatch log (manual month reassignment), manual packed boxes / hours, base rate + petrol from settings, on-screen payslip + PDF. Inputs are ready for Xero Payroll (not yet pushed).

**Shipment export documents** — the first stage of a shipment (Imports → shipment → Export documents tab, or "+ → Start from supplier documents"). Five steps: 1 · Pistoni's documents (A upload the two PDFs, B check and confirm the bales and figures), 2 · our proforma invoice to JPS (A number, date and rate, B the draft packing list and proforma for Paul), 3 · JPS's proforma invoice (→ the signed copy), 4 · invoices in Xero, 5 · LC details and the final packing list. Each step is one clean row — title (ⓘ tooltip says what it is), status (done / needs attention / to do / waiting), a checks count (✗ / ! / ✓) and its buttons; fields, tables and checks open below on click (the step being worked on opens by itself). Explanations are tooltips; error messages read as one plain sentence (the service's own reply behind Details) and can be dismissed — they stay in the activity log. If the AI service refuses the strict reading format, the PDF is read once more in plain mode (the review checks guard both). Before an invoice goes to Xero its tax codes are checked against the organisation's active tax rates (needs accounting.settings.read; skipped otherwise), so a wrong code stops with the real ones listed. A **Figures side by side** panel puts Pistoni's, our and JPS's proforma invoices next to each other (date, kg, rate, amount, ≈ NZD) with the differences worked out — weight, JPS over ours as handling & sorting per kg, and the order of the dates — green only when a comparison passed, amber when it doesn't match or can't be checked. Sections 2, 3 and 5 share one confirm-and-lock pattern: confirmed sections are read-only, "Unlock to edit" clears the confirmation; figures read from a PDF show as text with ✎ to correct (tagged "corrected"), calculated amounts as plain text; one number and date format throughout. What a document still needs shows as an amber chip when it's something to do now, and a grey "Waiting for the LC" chip when it only arrives with the LC (its number and date, the gross weight). The stage being worked on glows faint orange; finished stages glow green. Every document row is Preview · Download PDF (the generated copy, rendered to an A4 PDF in the browser and named like the kept files) · .xlsx. Pistoni's packing list and proforma PDFs are read by Claude with a strict JSON schema (numbers converted from Italian formatting, printed strings kept so code re-checks the conversion); the review screen shows the bales and the supplier figures with blocking checks (bales 1–N = package count, white / coloured sums = supplier totals, sum = proforma net weight, supplier lines multiply out, printed numbers re-parse) and warnings (shipment number, bale weight range, rate / invoice number not yet ticked). Only failing checks are listed; the ones that pass open from a "✓ N checks passed" popover. A failing check can be **dismissed** instead of corrected (logged with who and when, undoable; it holds only while the check fails in exactly the same way), except what the documents need (missing bales or data, the rate / number ticks, the JPS invoice number, currency and deposit). Only Confirm makes the bales the shipment's data and, on a V3 shipment, sets its white / coloured kg. Then the export invoice (number = previous + 1, date = today NZ, USD rate defaulting to the previous shipment, both ticked each time; amount = net kg × rate) → draft packing list + proforma invoice → LC number / date / gross weight (prefilled from the linked LC, cross-checked against it) → final packing list. Documents are print-ready HTML (print → Save as PDF; one A4 page up to ~60 bales), laid out like the Shipment 43 draft and Shipment 42 final packing lists (lettered AA. IRC NO … block, signature and seal), plus the packing list as .xlsx with COUNT / SUM formulas; each generated document is frozen in KV with the data it was made from. Document settings (tabs: Enviroware · JPS Enterprise · Documents · Xero) are seeded from Commercial Invoice 101/2026, the Shipment 43 draft packing list (SBAC Bank BIN 000000203-0002, separate from the VAT reg no. 000060296-0202) and JPS's Shipment 43 proforma (Enviroware's ANZ bank, JPS's own details); layout sections (identifier rows, goods wording, sign-off) always come from the code. Each shipment's linked LC is checked to quote the same applicant numbers. The proforma follows that invoice's layout. Supplier EUR prices never reach an output. Nothing is emailed or written to Drive. Then the money for stage 1, joined to the shipment's cost centres: JPS's invoice (read the same way, or typed in; figures like "USD$1.82" parse) is split into the **LC deposit** (= our proforma, net kg × export rate; the LC pays it back as **LC Refund**) and **Handling & Sorting** (the rest — JPS's margin, ≈ USD 0.63/kg, checked against the previous shipment). The three invoices — the Pistoni bill (EUR), our proforma as a zero-rated sales invoice to JPS (USD) and the JPS bill (deposit + handling lines) — are created in Xero on a click (Draft by default; account codes and tax types in Document settings, nothing is sent until they're set; **in NZD at the day's rate** by default because this Xero organisation has no multi-currency — each line keeps the EUR / USD amount and rate — or in their own currency once multi-currency is on), a refused or failed attempt is kept on the shipment until one succeeds (what Xero said line by line, what was sent, how far it got) and shown under that invoice, in the activity log, the Functions log and over MCP, and **Refresh from Xero** reads back status and what was paid in NZD (payment Amount ÷ CurrencyRate). **Update cost breakdown** shows and applies every change the documents imply: white / coloured kg, Raw Product rates, LC Deposit / LC Refund at the export rate, Handling & Sorting from the JPS invoice, actual NZD and paid flags from Xero (V3 shipments; saved through the Imports view's own save). **Signed JPS proforma**: JPS's sales proforma (their template has the wrong street number, "Buyerer's", "SWFIT", "Tauraqnga", duplicated terms) is rewritten from the captured JPS invoice — their letterhead, Enviroware as buyer with its bank, the goods line, amount in words, the terms once each (last date of shipment, expiry date and container size are JPS's proforma's own — read from their PDF or typed in step 3, required for the signed copy, editable after confirming since they aren't on the bill; JPS opens the LC on them, so the linked LC's 44C, 31D and container are checked against them, and a signed copy printed before the terms last changed asks to be generated again) — signed and sealed by Andrew, Paul's side left to sign; generated only once the signature image is uploaded. Read-only over MCP (`shipment_export_docs`, incl. dismissed checks). Code: `functions/api/import/_exportdocs.js` (pure: checks, defaults, templates), `import/_shipxero.js` (pure: JPS split, Xero payloads, cost plan), `import/_xlsx.js`, `import/export-docs/*`, `shipdocs.js`; tests `tests/export-docs*.test.js`, `tests/shipxero.test.js`.

**Letter of Credit** — steps 6–10 of a shipment, carrying on from its export documents (1–5), on the shipment's Letter of Credit tab in the same layout (one row per step with status and checks, details on click, explanations in tooltips, the current step glowing orange and finished ones green; the step strips link the two tabs): 6 · the LC (upload + AI extract; key dates Issued · Shipped (editable, the B/L on-board date) · Latest shipment · Present by (shipment + 21 days) · Expires, green when met, amber within 21 days, red when missed; the LC cross-checked against our proforma and bales from step 5 and against JPS's contract terms from step 3), 7 · our documents (commercial invoice — from our confirmed proforma number, flagged when the LC cites another — final packing list from step 5 with its generated copy, beneficiary's and inspection certificates, draft at sight), 8 · shipping documents (B/L, certificate of origin; manual accept), 9 · within 21 days of shipment (insurance notice, copy documents to the applicant; drafted emails; due date from the shipment date), 10 · present to ANZ (general conditions, ANZ claim form, print checklist + covering letter; done once the shipment's LC presented stage is ticked on the Overview), then the LC text (MT700, § links open it) and recurring issues. Every document is uploaded and AI-checked against the LC (primed with ANZ discrepancy patterns), with Drive archive. `#lc/<id>` for an LC linked to a shipment opens that shipment's tab (`#imports/ship/<id>/lc`); an unlinked LC shows the same steps on its own page.

**Platform** — Settings (prices, stores, printers, sales data, payroll, stock, integrations; `#admin/<tab>` opens a tab directly). **Integrations** checks every outside service live on open — Xero (organisation, and each permission the Hub asks for ticked against what the connection was granted), Google Calendar, Google Drive (service-account sign-in and the address to share folders with), the catalogue sheets, PrintNode (the config.json printers online), Post Haste (live or test mode), the Claude API key and model, the Claude connector, the Chrome extension and the dashboard feeds — and Connect / Reconnect for Xero and Google Calendar return to it. It shows whether each secret is set, never the secret (`functions/api/_integrations.js`, `GET /api/integrations`, `integrations.js`; tests `tests/integrations.test.js`). Google Calendar, three-column dashboard (sales/stock · Xero P&L + AR · calendar), notifications view + nav badge, role-gated navigation.

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
