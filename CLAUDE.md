# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

No build step, no dependencies, no package manager. Open `index.html` directly via `file://` if you need local file/folder links to work natively (Chrome blocks `file://` links from `http://` pages).

## Architecture

Single-page app: `index.html` (shell) + `styles.css` + `app.js` (all logic) + `config.json` (all content). No frameworks, no bundler.

**Data flow:** `loadConfig()` fetches `config.json` at runtime → populates `allGroups` and `pinnedItems` → `renderGroups()` / `renderPinned()` build the DOM from scratch on every load or reload.

**config.json is the only file users edit.** All groups, items, pinned shortcuts, and currency settings live there. Changes take effect on reload (↻ button calls `loadConfig()` again).

**Item types:** `link` (opens URL), `file` (opens via `file://` protocol), `folder` (opens via `file://` protocol). File/folder items get a "Copy path" button as a fallback when `file://` links are blocked.

**Seasonal logic** (`isSeasonActive`): season strings like `"oct-mar"` are parsed into month indices and handle year-boundary wraps. Off-season items get `.off-season` class (dimmed) plus a grey badge.

**Currency widget:** fetches live rates from `frankfurter.dev` on load, rendered in the header. Configured via `config.currencies` in `config.json`.

**Collapse state** is persisted to `localStorage` under the key `hub-collapsed` as a `{groupName: bool}` map.

## Deployment

Hosted on Cloudflare Pages from the `Magenta-Apple-NZ/erp-lite` GitHub repo (auto-deploys on push to `main`). Custom domain: `hub.primetie.co.nz`. Access is restricted to two users via Cloudflare Access (Zero Trust → Applications).

To deploy a change: commit and push to `main` — Cloudflare Pages picks it up automatically.
