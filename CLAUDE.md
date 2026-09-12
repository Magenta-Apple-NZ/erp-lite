# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

The Business Hub is the mini-ERP for Prime Ties / Enviroware: orders enter once and flow to packing slips, courier labels, Xero invoices, the dispatch log, sales history, stock and forecasts. Two users behind Cloudflare Access. Read `Business-Hub.md` for the north star, what's shipped and the backlog; `Stock-Rebuild.md` for the stock engine; `README.md` for setup.

## Architecture in one breath

Single-page app with no framework or bundler (`index.html`, `styles.css`, `app.js`, one IIFE module per view sharing the global scope) + Cloudflare Pages Functions under `functions/api/` + Cloudflare KV (`ORDERS_KV`, `XERO_KV`). Catalogue items and stores are published Google Sheets read live. Deploy = push to `main`.

## Conventions (follow these)

- **Dates.** Every business date is a Pacific/Auckland `YYYY-MM-DD` string. Use `functions/api/_dates.js` (`nzYmd`, `nzToday`, `addDays`, `daysBetween`) — never `new Date().toISOString().slice(0,10)`. UTC ISO timestamps are audit metadata only.
- **Classification.** Order lines become product kg only through `functions/api/sales-history/_writer.js` (`rowFromOrder`, catalogue Type/Size first). Do not write another classifier.
- **Stock.** A count is the opening stock at 12:00am on its date. Stock is derived on read; never store a running balance. Engine logic goes in `functions/api/stock/_engine.js` (pure) with a test in `tests/stock-engine.test.js`.
- **Sales history sync.** Any endpoint that writes an order must call `syncSalesHistory(env, order)` afterwards.
- **Shared helpers** live in underscore-prefixed files (`_xero.js`, `_freight.js`, `_courier.js`, `_dates.js`, `import/_cost.js`); Pages ignores them as routes.
- **Anthropic calls** go through raw `fetch` (pattern in `functions/api/lc-extract.js` / `orders/extract-pdf.js`), model `claude-sonnet-5`.
- **Frontend style.** Plain template literals with `escHtml`; modals use `.modal-overlay` / `.modal-box`; toasts via `showToast`; the Hub is light-only (do not add `prefers-color-scheme` rules).
- **Tests.** `npm test` runs under both `TZ=UTC` and `TZ=Pacific/Auckland`; run it before committing engine changes. `node --check` every edited file.
- **Commits.** One change per commit with a descriptive message; push to `main` to deploy.

## Things not to do

- Don't touch the raw historical sales seed (`source: 'historical'` rows) except through the Sales Data tools.
- Don't add per-product reorder points; products are replenished by shipments.
- Don't reintroduce description parsing anywhere in the stock path.
- Don't make Loose / eco Ties active; they are parked by decision.

## Memory

Persistent notes live in `~/.claude/projects/.../memory/` (see `MEMORY.md` there): depot printer status, Xero granular scopes, project overview.
