# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project ambition

**The Business Hub is evolving from a static dashboard into a mini-ERP.** Over a 12-week sprint (Apr 17 — Jul 17, 2026), it will become the system of record for orders, dispatch, and Xero invoice coordination. It consolidates three separate systems (Chrome Extension scraper, Make webhooks, Packing Slip Generator on Render) into one integrated platform.

**End state (Jul 17):** Warehouse staff work autonomously from the Hub queue. Orders enter once, generate packing slips natively, and push to Xero. Manual logs and triple-keying are gone.

See `Business-Hub.md` for the full context (users, architecture, source-of-truth decisions) and the 5-phase roadmap with success criteria.

## Running locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

No build step. Open `index.html` directly via `file://` if you need local file/folder links to work natively (Chrome blocks `file://` links from `http://` pages).

## Architecture

**Frontend:** Single-page app (`index.html` + `styles.css` + `app.js` + `config.json`). No frameworks, no bundler.

**Backend:** Cloudflare Workers (Pages Functions) under `/functions/api/`. Currently includes:
- `_xero.js` — Shared Xero OAuth logic
- `xero/auth.js` — Initiate OAuth flow
- `xero/callback.js` — Handle OAuth callback, store tokens in XERO_KV
- `xero/status.js` — Get Xero organisation & contact list
- `xero/customers.js` — Fetch Xero customers for typeahead
- `xero/push.js` — (Planned) Push invoice to Xero

**Data layer:** Cloudflare KV (persistent key-value store). Currently planned namespaces:
- `ORDERS_KV` — Order records (ID, customer, items, ship-to, status, packing slip data)
- `XERO_KV` — Xero OAuth tokens + cached customer/location data

### Frontend data flow

`loadConfig()` fetches `config.json` at runtime → populates `allGroups` and `pinnedItems` → `renderGroups()` / `renderPinned()` build the DOM. **config.json is the only file users edit** for static content (groups, links, seasonal items).

**Item types:** `link` (opens URL), `file`, `folder`. File/folder items get a "Copy path" button as fallback.

**Seasonal logic:** Items tagged with `"season": "oct-mar"` are dimmed off-season with a grey badge.

**Currency widget:** Fetches live rates from `frankfurter.dev` on load.

**Collapse state:** Persisted to `localStorage` under `hub-collapsed`.

### Backend data flow (Phase 1+)

App routes like `/orders` and `/warehouse` will call Cloudflare Worker endpoints (`/api/orders`, `/api/orders/[id]`, etc.) to fetch/create/update orders in KV. Xero integration flows through `/api/xero/push`.

## Current progress

**✅ Phase 1 scaffolding complete** (Week 1–3, in progress):
- Cloudflare Functions boilerplate and OAuth flow implemented
- Order creation form with Xero customer typeahead
- KV namespace bindings declared in `wrangler.toml`
- Orders list and detail views drafted in the UI

**⏳ Next steps:**
- Provision `ORDERS_KV` and `XERO_KV` namespaces in Cloudflare dashboard
- End-to-end verification: create order → render packing slip → push Xero draft
- Seed store locations into KV from existing Google Sheet

**🚫 Feature-frozen:** Packing Slip Generator (Render service) receives no new work from this point. All slip rendering moves to Hub.

## Deployment

Hosted on Cloudflare Pages from the `Magenta-Apple-NZ/erp-lite` GitHub repo (auto-deploys on push to `main`). Custom domain: `hub.primetie.co.nz`. Access restricted to two users via Cloudflare Access.

Deploy: commit and push to `main` — Pages + Workers both auto-deploy.

**KV provisioning:** Namespaces must be created in the Cloudflare dashboard and their IDs added to `wrangler.toml` before Phase 1 can be verified.
