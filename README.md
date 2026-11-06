# Business Hub — developer notes

Mini-ERP for Prime Ties / Enviroware: orders → packing slips → courier labels → Xero invoices → dispatch log → sales history → stock and forecasts. Live at [hub.primetie.co.nz](https://hub.primetie.co.nz) behind Cloudflare Access.

| Doc | What it's for |
|---|---|
| [Business-Hub.md](Business-Hub.md) | The project: north star, architecture, what's shipped, backlog |
| [Stock-Rebuild.md](Stock-Rebuild.md) | The stock engine model and API |
| [CLAUDE.md](CLAUDE.md) | Conventions for AI-assisted changes |

## Run locally

No build step. Static files plus Cloudflare Pages Functions.

```bash
# frontend only (no /api)
python3 -m http.server 8000

# frontend + functions against local KV
npx wrangler pages dev . --kv ORDERS_KV --kv XERO_KV
```

Environment variables for the Functions (set in the Pages dashboard; see `wrangler.toml` for the full list): Xero client id/secret/redirect, PrintNode key, GoSweetSpot keys, `ANTHROPIC_API_KEY`, `HUB_WEBHOOK_KEY`, `NOTIFY_FEED_TOKEN`, `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` and/or `MCP_TOKEN` (MCP server), optional catalogue CSV URL overrides.

## Notification feed

`GET /api/feeds/notifications/<NOTIFY_FEED_TOKEN>` serves the Hub's notifications (orders not yet in Xero, shipments overdue or arriving, sticky tax and calendar reminders) in the New Tab Dashboard's Notification Feed Spec v1. The builder in `functions/api/feeds/_notifications.js` is pure and mirrors `fetchNotificationItems()` in `app.js`; keep the two in step. Daily items carry a date-suffixed id so a dismissal lasts a day, like the Hub's own 24h dismissal; sticky calendar items keep one id per occurrence.

Setup: set `NOTIFY_FEED_TOKEN` to a long random string, add a Zero Trust Access policy that lets `/api/feeds/notifications/*` through without a login (the dashboard polls without a session; same pattern as `/api/orders/inbound`), then register `https://hub.primetie.co.nz/api/feeds/notifications/<token>` in the dashboard's Notifications settings. The feed URL is a credential.

## MCP server (read-only)

`POST /api/mcp` exposes the Hub to Claude (claude.ai connectors, Claude Code) as a remote MCP server: stateless JSON-RPC over Streamable HTTP, hand-written in `functions/api/mcp/` (`_server.js` protocol, `_tools.js` tools, `_auth.js` auth). Tools: `search_orders`, `get_order` (incl. activity log), `sales_summary` (kg by month / FY / customer / branch), `stock_levels`, `stock_item_ledger`, `consumables_forecast`, `shipments`, `receivables`. Stock and Xero tools call the existing endpoint handlers in-process, so the numbers match the Hub's screens.

Read-only is enforced: tools get an `ORDERS_KV` whose `put` / `delete` reject. `XERO_KV` stays writable only because a Xero call may refresh (and Xero rotates) the OAuth token. Adding a write tool means going through the normal write paths (`syncSalesHistory`, activity event), not lifting this guard.

Auth is checked by the endpoint itself and never trusts identity headers unverified:
- **Access JWT** — `/api/mcp` has its own Access application (*Business Hub MCP*, path `api/mcp`) so a service token reaches only the MCP, never the Hub's write endpoints. Set `ACCESS_TEAM_DOMAIN` (`primetie.cloudflareaccess.com`) and `ACCESS_AUD` (that application's audience tag, not the Hub's). `Cf-Access-Jwt-Assertion` is checked against the team's signing keys, audience, issuer and expiry, and the email maps to a name as `/api/me` does. Covers a claude.ai connector using Cloudflare Access as its OAuth provider, and Claude Code with an Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret` headers) via a **Service Auth** policy attached to that application. An *Allow* policy that includes the token still redirects to login.
- **Bearer token** — set `MCP_TOKEN` and send `Authorization: Bearer <token>`. Only reachable if `/api/mcp` is bypassed in Access (as `/api/orders/inbound` is), which also stops Access issuing JWTs on that path, so pick one route. Fine for local dev.

With neither configured the endpoint answers 503.

Claude Code with a service token:

```
claude mcp add --transport http business-hub https://hub.primetie.co.nz/api/mcp \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

## Tests

```bash
npm test
```

Runs the stock-engine acceptance suite twice, under `TZ=UTC` and `TZ=Pacific/Auckland`; both must pass. Zero dependencies (`node:test`).

## Deploy

Commit and push to `main`. Cloudflare Pages deploys the static assets and the Functions together. Environment or binding changes need a redeploy.

## Layout

```
index.html styles.css app.js      shell, dashboard, routing, chart registry
orders.js stock.js warehouse.js   views (warehouse.js = Imports / forecast)
sales.js admin.js payslips.js lc.js calendar.js dispatch-log.js
config.json                       static dashboard groups + printer registry
functions/api/                    Pages Functions; _prefixed files are shared helpers, not routes
tests/                            node:test suites
```

## Conventions worth knowing

- Business dates are NZ calendar dates (`functions/api/_dates.js`: `nzYmd`, `nzToday`, `addDays`). Never `toISOString().slice(0,10)` for a business date.
- A stock count is the opening stock at 12:00am on its date.
- Order lines are classified by the catalogue's Type/Size via `sales-history/_writer.js`; every other consumer (payroll, exports, stock) calls that, never its own heuristic.
- KV has no transactions; bulk writes back up to `backup:*` first.
