// ── Admin / Catalogue module ──
// Handles #admin view — pricing matrix and store locations

const Admin = (() => {

    async function api(path, opts = {}) {
        const resp = await fetch(path, opts);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || resp.statusText);
        }
        return resp.json();
    }

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    function parseCsv(text) {
        const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
        if (lines.length < 2) return [];
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, ''));
        return lines.slice(1)
            .filter(l => l.trim())
            .map(line => {
                const values = [];
                let cur = '', inQ = false;
                for (const ch of line) {
                    if (ch === '"') { inQ = !inQ; }
                    else if (ch === ',' && !inQ) { values.push(cur.trim()); cur = ''; }
                    else { cur += ch; }
                }
                values.push(cur.trim());
                return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
            });
    }

    const STORE_HEADERS = ['Customer Code', 'Customer', 'Branch', 'City', 'Street Address', 'Postcode', 'Phone'];
    const STORE_EXAMPLE = ['FF-Te-Puke', 'Fruitfed', 'Fruitfed - Te Puke', 'Te Puke', '1 Jellicoe Street', '3119', '07 533 1234'];

    function downloadCsv(csv, filename) {
        const a = document.createElement('a');
        a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function quoteField(v) {
        const s = String(v ?? '');
        return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }

    function itemsToCsv(items) {
        const headers = ['Id', 'Name', 'Unit Price', '150+ kg', '500+ kg', '2000+ kg'];
        const rows = items.map(i => [
            i.id || '', i.name || '',
            i.defaultPrice ?? '', i.pb1Price ?? '', i.pb2Price ?? '', i.pb3Price ?? '',
        ].map(quoteField).join(','));
        return [headers.join(','), ...rows].join('\n');
    }

    function storesToCsv(stores) {
        const headers = ['Customer Code', 'Customer', 'Branch', 'City', 'Street Address', 'Postcode', 'Phone'];
        const rows = stores.map(s => [
            s.customerCode || '', s.customer || '', s.branch || '',
            s.city || '', s.streetAddress || '', s.postcode || '', s.phone || '',
        ].map(quoteField).join(','));
        return [headers.join(','), ...rows].join('\n');
    }

    function storesTableRows(stores) {
        return stores.slice(0, 20).map(s => `
            <tr>
                <td class="cat-mono">${escHtml(s.customerCode || '')}</td>
                <td>${escHtml(s.customer || s.name || '')}</td>
                <td>${escHtml(s.branch || '')}</td>
                <td>${escHtml(s.city || '')}</td>
                <td>${escHtml(s.postcode || '')}</td>
            </tr>`).join('') +
            (stores.length > 20 ? `<tr><td colspan="5" class="cat-more">…and ${stores.length - 20} more</td></tr>` : '');
    }

    // ── Price matrix row HTML ──
    function matrixRow(item) {
        const p = v => (v != null && v !== '') ? Number(v).toFixed(2) : '';
        return `
        <tr class="matrix-row">
            <td><input type="text" class="matrix-id matrix-cell-input" value="${escHtml(item.id || '')}" placeholder="PT-I-10"></td>
            <td><input type="text" class="matrix-name matrix-cell-input" value="${escHtml(item.name || '')}" placeholder="Product name"></td>
            <td><input type="number" class="matrix-p0 matrix-cell-input matrix-price-input" value="${p(item.defaultPrice)}" placeholder="0.00" min="0" step="0.01"></td>
            <td><input type="number" class="matrix-p150 matrix-cell-input matrix-price-input" value="${p(item.pb1Price)}" placeholder="—" min="0" step="0.01"></td>
            <td><input type="number" class="matrix-p500 matrix-cell-input matrix-price-input" value="${p(item.pb2Price)}" placeholder="—" min="0" step="0.01"></td>
            <td><input type="number" class="matrix-p2000 matrix-cell-input matrix-price-input" value="${p(item.pb3Price)}" placeholder="—" min="0" step="0.01"></td>
            <td><button class="matrix-del" title="Remove row">×</button></td>
        </tr>`;
    }

    // ── Prices tab (pricing matrix) ──
    // The Prices and Stores catalogs are now sourced from published Google
    // Sheets via /api/catalog/items and /api/catalog/stores. The Hub no
    // longer accepts edits — the sheet is the source of truth. This tab is
    // a read-only viewer plus a link out for editing.
    const ITEMS_SHEET_VIEW_URL  = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf_VXDqVAC5KqHJZTil7H-2MoeK5lSqx5OWmCaigi6Xn7wNdznlp0mS-D5rgI35-X4Vh-itflowh1j/pubhtml?gid=0';
    const STORES_SHEET_VIEW_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf_VXDqVAC5KqHJZTil7H-2MoeK5lSqx5OWmCaigi6Xn7wNdznlp0mS-D5rgI35-X4Vh-itflowh1j/pubhtml?gid=1005144257';

    function fmtPrice(v) { return v == null ? '<span class="cat-price-nil">—</span>' : '$' + Number(v).toFixed(2); }

    function renderPricesTab(body, items, onUpdate) {
        body.innerHTML = `
        <div class="cat-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Price Matrix</h2>
                    <p class="cat-sub">Read-only. Source: <a href="${ITEMS_SHEET_VIEW_URL}" target="_blank" rel="noopener">Pricing sheet ↗</a> (cached ~60s).</p>
                </div>
                <button class="btn-secondary btn-sm" id="cat-prices-refresh"
                    title="Bypass the 60s edge cache and re-read the sheet now">Refresh from Sheet</button>
            </div>
            <div class="matrix-wrap">
                <table class="matrix-table matrix-table--readonly">
                    <thead>
                        <tr>
                            <th class="matrix-th-id">ID</th>
                            <th class="matrix-th-name">Product Name</th>
                            <th class="matrix-th-price">Unit Price</th>
                            <th class="matrix-th-price">150+ kg</th>
                            <th class="matrix-th-price">500+ kg</th>
                            <th class="matrix-th-price">2,000+ kg</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.length
                            ? items.map(it => `<tr>
                                <td class="cat-mono">${escHtml(it.id || '')}</td>
                                <td>${escHtml(it.name || '')}</td>
                                <td class="cat-num">${fmtPrice(it.defaultPrice)}</td>
                                <td class="cat-num">${fmtPrice(it.pb1Price)}</td>
                                <td class="cat-num">${fmtPrice(it.pb2Price)}</td>
                                <td class="cat-num">${fmtPrice(it.pb3Price)}</td>
                            </tr>`).join('')
                            : '<tr><td colspan="6" class="cat-empty">No items yet. Add rows in the source sheet.</td></tr>'}
                    </tbody>
                </table>
            </div>
        </div>`;

        document.getElementById('cat-prices-refresh')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'Refreshing…';
            try {
                const fresh = await api('/api/catalog/items?bust=1');
                if (typeof onUpdate === 'function') onUpdate(fresh);
                renderPricesTab(body, fresh, onUpdate);
                showToast('Prices reloaded from sheet');
            } catch (err) {
                showToast('Refresh failed: ' + err.message);
                btn.disabled = false; btn.textContent = 'Refresh from Sheet';
            }
        });
    }

    // ── Stores tab (read-only, sourced from published Google Sheet) ──
    function renderStoresTab(body, stores, onUpdate) {
        body.innerHTML = `
        <div class="cat-section" id="cat-stores">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Store Locations</h2>
                    <p class="cat-sub">Read-only. Source: <a href="${STORES_SHEET_VIEW_URL}" target="_blank" rel="noopener">Stores sheet ↗</a> (cached ~60s). ${stores.length} store${stores.length !== 1 ? 's' : ''}.</p>
                </div>
                <button class="btn-secondary btn-sm" id="cat-stores-refresh"
                    title="Bypass the 60s edge cache and re-read the sheet now">Refresh from Sheet</button>
            </div>
            <table class="cat-table">
                <thead><tr><th>Code</th><th>Customer</th><th>Branch</th><th>City</th><th>Postcode</th></tr></thead>
                <tbody>
                    ${stores.length
                        ? storesTableRows(stores)
                        : '<tr><td colspan="5" class="cat-empty">No stores yet. Add rows in the source sheet.</td></tr>'}
                </tbody>
            </table>
        </div>`;

        document.getElementById('cat-stores-refresh')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true; btn.textContent = 'Refreshing…';
            try {
                const fresh = await api('/api/catalog/stores?bust=1');
                if (typeof onUpdate === 'function') onUpdate(fresh);
                renderStoresTab(body, fresh, onUpdate);
                showToast('Stores reloaded from sheet');
            } catch (err) {
                showToast('Refresh failed: ' + err.message);
                btn.disabled = false; btn.textContent = 'Refresh from Sheet';
            }
        });
    }

    async function renderAdmin(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Catalogue</h1>
                <p class="view-subtitle">Manage product pricing, store locations, and printers.</p>
            </div>
            <div class="cat-header-actions">
                <a class="btn-secondary btn-sm" href="/api/sales/monthly?format=csv"
                   download="sales-monthly.csv"
                   title="Download the weaved monthly sales series — sheet (pre-2026-04) and Hub orders (from cutoff)">
                    Export sales CSV ↓
                </a>
                <a class="btn-secondary btn-sm" href="/api/orders/export"
                   download="orders.csv"
                   title="Download all orders as a flat one-row-per-line-item CSV">
                    Export orders CSV ↓
                </a>
            </div>
        </div>
        <div class="imp-tabs">
            <button class="imp-view-btn active" id="cat-tab-prices">Prices</button>
            <button class="imp-view-btn" id="cat-tab-stores">Stores</button>
            <button class="imp-view-btn" id="cat-tab-printers">Printers</button>
            <button class="imp-view-btn" id="cat-tab-bulk">Bulk Edit</button>
            <button class="imp-view-btn" id="cat-tab-saleshistory">Sales History</button>
        </div>
        <div id="admin-body"><div class="orders-loading">Loading…</div></div>`;

        let items = [], stores = [];
        try {
            [items, stores] = await Promise.all([
                api('/api/catalog/items'),
                api('/api/catalog/stores'),
            ]);
        } catch (e) { /* empty catalog is fine */ }

        const body = document.getElementById('admin-body');

        function switchTab(tab) {
            document.getElementById('cat-tab-prices').classList.toggle('active', tab === 'prices');
            document.getElementById('cat-tab-stores').classList.toggle('active', tab === 'stores');
            document.getElementById('cat-tab-printers').classList.toggle('active', tab === 'printers');
            document.getElementById('cat-tab-bulk').classList.toggle('active', tab === 'bulk');
            document.getElementById('cat-tab-saleshistory').classList.toggle('active', tab === 'saleshistory');
            if (tab === 'prices')            renderPricesTab(body, items, updated => { items = updated; });
            else if (tab === 'stores')       renderStoresTab(body, stores, updated => { stores = updated; });
            else if (tab === 'printers')     renderPrintersTab(body);
            else if (tab === 'bulk')         renderBulkEditTab(body);
            else if (tab === 'saleshistory') renderSalesHistoryTab(body);
        }

        document.getElementById('cat-tab-prices').addEventListener('click',       () => switchTab('prices'));
        document.getElementById('cat-tab-stores').addEventListener('click',       () => switchTab('stores'));
        document.getElementById('cat-tab-printers').addEventListener('click',     () => switchTab('printers'));
        document.getElementById('cat-tab-bulk').addEventListener('click',         () => switchTab('bulk'));
        document.getElementById('cat-tab-saleshistory').addEventListener('click', () => switchTab('saleshistory'));

        switchTab('prices');
    }

    // ── Printers tab ──
    // Lists printers visible to the configured PrintNode API key, alongside the
    // current config.json registry. Lookup is read-only — to map a printer for
    // routing, copy its ID and add an entry to config.json under "printers".
    async function renderPrintersTab(body) {
        body.innerHTML = `<div class="orders-loading">Loading printers…</div>`;

        let resp;
        try {
            resp = await api('/api/print/printers');
        } catch (e) {
            body.innerHTML = `
                <div class="cat-empty">
                    <p><strong>Could not reach PrintNode.</strong></p>
                    <p style="color:#64748b">${escHtml(e.message)}</p>
                    <p style="color:#64748b">Check that <code>PRINTNODE_API_KEY</code> is set in Cloudflare Pages env vars.</p>
                </div>`;
            return;
        }

        const configured = (typeof currentConfig !== 'undefined' && Array.isArray(currentConfig.printers))
            ? currentConfig.printers : [];
        const configuredById = new Map(configured.map(p => [Number(p.id), p]));

        const printerRows = (resp.printers || []).map(p => {
            const cfg = configuredById.get(Number(p.id));
            const stateColour = p.state === 'online' ? '#10b981' : '#ef4444';
            const cfgCell = cfg
                ? `<span style="color:#10b981">✓ ${escHtml(cfg.label)}</span><br><span style="color:#94a3b8;font-size:0.85em">${escHtml((cfg.documents || []).join(', '))}</span>`
                : `<span style="color:#94a3b8">— not in config.json</span>`;
            return `
                <tr>
                    <td><strong>${escHtml(p.name)}</strong>${p.description ? `<br><span style="color:#94a3b8;font-size:0.85em">${escHtml(p.description)}</span>` : ''}</td>
                    <td>${escHtml(p.computer || '')}</td>
                    <td><span style="color:${stateColour}">●</span> ${escHtml(p.state || 'unknown')}</td>
                    <td><code>${escHtml(p.id)}</code> <button class="btn-secondary btn-sm" data-copy-id="${escHtml(p.id)}">Copy</button></td>
                    <td>${cfgCell}</td>
                </tr>`;
        }).join('');

        const orphanRows = configured
            .filter(c => !(resp.printers || []).some(p => Number(p.id) === Number(c.id)))
            .map(c => `
                <tr style="background:#fef2f2">
                    <td><strong>${escHtml(c.label)}</strong><br><span style="color:#ef4444;font-size:0.85em">configured but not visible to PrintNode</span></td>
                    <td>—</td><td><span style="color:#ef4444">● offline / unknown</span></td>
                    <td><code>${escHtml(c.id)}</code></td>
                    <td>${escHtml((c.documents || []).join(', '))}</td>
                </tr>`).join('');

        body.innerHTML = `
            <div class="cat-section">
                <p style="color:#64748b;margin-bottom:1rem">
                    Printers visible to the configured PrintNode API key. To route slips/addresses to a printer,
                    add an entry to <code>config.json</code> under <code>"printers"</code>:
                </p>
                <pre style="background:#f8fafc;padding:0.75rem;border-radius:6px;font-size:0.85em;overflow:auto;margin-bottom:1.25rem">{ "id": 70123456, "label": "Warehouse", "documents": ["slip", "address"] }</pre>
                <table class="cat-table">
                    <thead>
                        <tr>
                            <th>Name</th><th>Computer</th><th>State</th><th>PrintNode ID</th><th>Configured for</th>
                        </tr>
                    </thead>
                    <tbody>${printerRows || `<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:1rem">No printers registered with PrintNode yet</td></tr>`}${orphanRows}</tbody>
                </table>
            </div>`;

        body.querySelectorAll('[data-copy-id]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.copyId;
                try {
                    await navigator.clipboard.writeText(id);
                    showToast(`Copied printer ID ${id}`);
                } catch (e) {
                    showToast('Copy failed — select and copy manually');
                }
            });
        });
    }

    // ── Bulk Edit tab ──
    // Upload a CSV in the same shape as /api/orders/export.csv to bulk-edit
    // existing orders. The flow is always dry-run first → review diff →
    // apply. Edits only (no adds, no deletes); modified orders are backed
    // up to a timestamped KV key before each apply, in case anything needs
    // to be rolled back.
    function renderBulkEditTab(body) {
        body.innerHTML = `
        <div class="cat-section">
            <h2 class="cat-title">Bulk Edit Orders</h2>
            <p class="cat-sub">Download orders, edit in a spreadsheet, re-upload here. Edits only — rows missing from your CSV are left untouched; new line indexes are rejected. Each apply takes a snapshot of every modified order to a backup key first.</p>

            <div class="bulk-step">
                <strong>1.</strong>
                <a class="btn-secondary btn-sm" href="/api/orders/export" download="orders.csv">Download orders.csv</a>
                <span class="bulk-step-hint">One row per order line. Editable columns: status, customer, branch, sku, description, quantity, kg_per_unit, unit_price, xero_invoice.</span>
            </div>

            <div class="bulk-step">
                <strong>2.</strong>
                <input type="file" id="bulk-csv-file" accept=".csv,text/csv">
                <button class="btn-secondary btn-sm" id="bulk-dryrun-btn">Preview changes (dry-run)</button>
            </div>

            <div id="bulk-results"></div>
        </div>`;

        let lastFile = null;
        const resultsEl = document.getElementById('bulk-results');

        document.getElementById('bulk-dryrun-btn').addEventListener('click', async () => {
            const file = document.getElementById('bulk-csv-file').files[0];
            if (!file) { showToast('Choose a CSV file first'); return; }
            lastFile = file;
            resultsEl.innerHTML = '<p class="bulk-loading">Running dry-run…</p>';
            try {
                const csv = await file.text();
                const resp = await fetch('/api/orders/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/csv' },
                    body: csv,
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                const result = await resp.json();
                renderBulkDiff(result, false);
            } catch (e) {
                resultsEl.innerHTML = `<p class="bulk-error">${escHtml(e.message)}</p>`;
            }
        });

        function renderBulkDiff(result, applied) {
            const { summary, changes, errors } = result;
            const changeRows = changes.slice(0, 200).map(c => `
                <tr>
                    <td><a href="#orders/${escHtml(c.orderId)}">${escHtml(c.orderId)}</a></td>
                    <td class="bulk-fields">${c.fieldsChanged.map(escHtml).join(', ')}</td>
                </tr>`).join('');
            const errorRows = errors.slice(0, 200).map(e => `
                <tr class="bulk-err-row">
                    <td>${escHtml(e.orderId || '—')} ${e.csvRow ? `<span class="bulk-csvrow">row ${e.csvRow}</span>` : ''}</td>
                    <td>${escHtml(e.error)}</td>
                </tr>`).join('');

            resultsEl.innerHTML = `
            <div class="bulk-summary ${applied ? 'bulk-summary--applied' : ''}">
                <strong>${applied ? 'Applied' : 'Dry run'}:</strong>
                ${summary.changes} change${summary.changes === 1 ? '' : 's'} across
                ${summary.orders} order${summary.orders === 1 ? '' : 's'};
                ${summary.errors} error${summary.errors === 1 ? '' : 's'};
                ${summary.rows} CSV row${summary.rows === 1 ? '' : 's'} read.
                ${applied && summary.backupTs ? `<br><span class="bulk-backup">Backup key prefix: <code>backup:orders:${escHtml(summary.backupTs)}</code></span>` : ''}
            </div>

            ${changes.length ? `
            <h3 class="bulk-table-title">Changes ${changes.length > 200 ? `(showing first 200 of ${changes.length})` : ''}</h3>
            <div class="bulk-table-wrap">
                <table class="bulk-table">
                    <thead><tr><th>Order</th><th>Fields changed</th></tr></thead>
                    <tbody>${changeRows}</tbody>
                </table>
            </div>` : '<p class="bulk-empty">No changes detected.</p>'}

            ${errors.length ? `
            <h3 class="bulk-table-title bulk-errors-title">Errors ${errors.length > 200 ? `(showing first 200 of ${errors.length})` : ''}</h3>
            <div class="bulk-table-wrap">
                <table class="bulk-table">
                    <thead><tr><th>Order</th><th>Error</th></tr></thead>
                    <tbody>${errorRows}</tbody>
                </table>
            </div>` : ''}

            ${!applied && changes.length ? `
            <div class="bulk-apply-bar">
                <button class="btn-primary" id="bulk-apply-btn">Apply ${changes.length} change${changes.length === 1 ? '' : 's'}</button>
                <span class="bulk-apply-hint">A backup of every modified order is taken before writes.</span>
            </div>` : ''}`;

            document.getElementById('bulk-apply-btn')?.addEventListener('click', async (e) => {
                if (!lastFile) return;
                if (!confirm(`Apply ${changes.length} change(s) to ORDERS_KV? A backup will be taken first.`)) return;
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Applying…';
                try {
                    const csv = await lastFile.text();
                    const resp = await fetch('/api/orders/import?apply=true', {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/csv' },
                        body: csv,
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    const applyResult = await resp.json();
                    renderBulkDiff(applyResult, true);
                    showToast(`Applied ${applyResult.summary.changes} changes`);
                } catch (err) {
                    showToast('Apply failed: ' + err.message);
                    btn.disabled = false; btn.textContent = `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`;
                }
            });
        }
    }

    // ── Sales History tab ──
    // The combined sales history table is the source of truth for the Sales
    // History view going forward. This tab:
    //   - Shows current row count + by-year stats
    //   - Lets you download the full table as CSV
    //   - Lets you (re-)seed historical rows from the legacy sales CSV.
    //     Apply also wipes the legacy HST-* orders left over from an earlier
    //     attempt and preserves any source:'hub' rows already in the table.
    async function renderSalesHistoryTab(body) {
        body.innerHTML = `
        <div class="cat-section">
            <h2 class="cat-title">Sales History</h2>
            <p class="cat-sub">Single denormalised table — one row per sale. Historical seed from the legacy CSV; live Hub orders append a row on Xero push. Powers the Sales History view and exports cleanly to CSV.</p>
            <div id="sh-stats" class="cat-sub">Loading current state…</div>

            <div class="bulk-step" style="margin-top:1rem">
                <strong>Download</strong>
                <a class="btn-secondary btn-sm" href="/api/sales-history?format=csv" download="sales-history.csv">Export sales-history.csv ↓</a>
                <span class="bulk-step-hint">Edit in a spreadsheet, re-upload below — rows match by Id and update in place.</span>
            </div>

            <div class="bulk-step">
                <strong>Backfill</strong>
                <button class="btn-secondary btn-sm" id="sh-backfill-btn">Backfill Hub orders</button>
                <span class="bulk-step-hint">Walks orders_index and adds a row for every Hub order missing one (existing rows untouched). Run this once if Hub orders aren't showing.</span>
            </div>

            <h3 class="bulk-table-title" style="margin-top:1.5rem">Upload CSV</h3>
            <p class="cat-sub" style="margin-bottom:0.5rem">Auto-detects the format. Upload the original sales CSV to <strong>seed historicals</strong>, or a downloaded <code>sales-history.csv</code> (with Id + Source columns) to <strong>round-trip edits</strong> — rows match by Id and update in place; missing rows are left untouched.</p>

            <div class="bulk-step">
                <strong>1.</strong>
                <input type="file" id="sh-file" accept=".csv,text/csv">
                <button class="btn-secondary btn-sm" id="sh-dryrun-btn">Preview (dry-run)</button>
            </div>

            <div id="sh-results"></div>
        </div>`;

        // Current state at top
        try {
            const resp = await fetch('/api/sales-history');
            if (resp.ok) {
                const data = await resp.json();
                const yrs = Object.keys(data.byYear || {}).sort();
                const stats = document.getElementById('sh-stats');
                if (stats) {
                    stats.innerHTML = data.count
                        ? `<strong>${data.count.toLocaleString('en-NZ')}</strong> rows in the table; years: ${yrs.join(', ') || '(none)'}.`
                        : `Table is empty — seed it below.`;
                }
            }
        } catch (e) { /* stats are nice-to-have */ }

        let lastFile = null;
        const resultsEl = document.getElementById('sh-results');

        document.getElementById('sh-dryrun-btn').addEventListener('click', async () => {
            const file = document.getElementById('sh-file').files[0];
            if (!file) { showToast('Choose a CSV file first'); return; }
            lastFile = file;
            resultsEl.innerHTML = '<p class="bulk-loading">Parsing CSV…</p>';
            try {
                const csv = await file.text();
                const resp = await fetch('/api/sales-history', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/csv' },
                    body: csv,
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                renderShResults(await resp.json(), false);
            } catch (e) {
                resultsEl.innerHTML = `<p class="bulk-error">${escHtml(e.message)}</p>`;
            }
        });

        function renderShResults(result, applied) {
            const s = result.summary;
            const isRoundTrip = s.mode === 'round-trip';
            const skip = s.skipped || {};

            // Mode-specific summary blocks.
            const summaryHtml = isRoundTrip ? `
                <strong>${applied ? 'Applied' : 'Dry run'} (round-trip):</strong>
                ${s.csvRowsParsed.toLocaleString('en-NZ')} row${s.csvRowsParsed === 1 ? '' : 's'} parsed.
                <strong>${s.updates}</strong> update${s.updates === 1 ? '' : 's'},
                <strong>${s.adds}</strong> new row${s.adds === 1 ? '' : 's'},
                ${s.unchanged} unchanged.
                ${applied ? `<br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(s.backupTs)}</code> · Table size: ${s.totalRowsAfter}</span>` : ''}
            ` : `
                <strong>${applied ? 'Applied' : 'Dry run'} (seed):</strong>
                ${s.csvRowsParsed.toLocaleString('en-NZ')} row${s.csvRowsParsed === 1 ? '' : 's'} parsed from CSV.
                ${s.negativeRows ? `<br>${s.negativeRows} row${s.negativeRows === 1 ? '' : 's'} contain negative volumes (credit notes / returns).` : ''}
                ${applied ? `<br><span class="bulk-backup">
                    Backup keys: <code>backup:sales_history:${escHtml(s.backupTs)}</code> + <code>backup:orders_index:${escHtml(s.backupTs)}</code><br>
                    HST orders wiped: ${s.hstOrdersDeleted} · Hub rows preserved: ${s.hubRowsPreserved} · Table size: ${s.totalRowsAfter} rows
                </span>` : ''}
            `;

            const yearTable = !isRoundTrip ? (() => {
                const yearRows = Object.keys(s.byYear || {}).sort().map(y => {
                    const v = s.byYear[y];
                    const totalKg = (v.bundlesKg || 0) + (v.looseKg || 0) + (v.ecoTiesKg || 0);
                    return `<tr>
                        <td>${escHtml(y)}</td>
                        <td class="bulk-num">${v.count.toLocaleString('en-NZ')}</td>
                        <td class="bulk-num">${Math.round(v.bundlesKg).toLocaleString('en-NZ')}</td>
                        <td class="bulk-num">${Math.round(v.looseKg).toLocaleString('en-NZ')}</td>
                        <td class="bulk-num">${Math.round(v.ecoTiesKg).toLocaleString('en-NZ')}</td>
                        <td class="bulk-num">${Math.round(totalKg).toLocaleString('en-NZ')}</td>
                    </tr>`;
                }).join('');
                return `
                <h3 class="bulk-table-title">Breakdown by year</h3>
                <div class="bulk-table-wrap">
                    <table class="bulk-table">
                        <thead><tr>
                            <th>Year</th>
                            <th class="bulk-num">Rows</th>
                            <th class="bulk-num">Bundles kg</th>
                            <th class="bulk-num">Loose kg</th>
                            <th class="bulk-num">eco Ties kg</th>
                            <th class="bulk-num">Total kg</th>
                        </tr></thead>
                        <tbody>${yearRows || '<tr><td colspan="6" class="bulk-empty">(none)</td></tr>'}</tbody>
                    </table>
                </div>`;
            })() : '';

            const sampleList = isRoundTrip
                ? `
                ${s.sampleUpdates?.length ? `<h3 class="bulk-table-title">Sample updates</h3><ul class="bulk-skip-list">${s.sampleUpdates.map(id => `<li><code>${escHtml(id)}</code></li>`).join('')}</ul>` : ''}
                ${s.sampleAdds?.length ? `<h3 class="bulk-table-title">Sample new rows</h3><ul class="bulk-skip-list">${s.sampleAdds.map(id => `<li><code>${escHtml(id)}</code></li>`).join('')}</ul>` : ''}
            ` : '';

            const skipRow = (label, n) => n ? `<li>${escHtml(label)}: ${n}</li>` : '';
            const skippedBlock = (skip.blank || skip.noDate || skip.noCustomer || skip.allZero || skip.cancelled || skip.noId) ? `
            <h3 class="bulk-table-title">Skipped rows</h3>
            <ul class="bulk-skip-list">
                ${skipRow('Blank', skip.blank)}
                ${skipRow('Missing date', skip.noDate)}
                ${skipRow('Missing customer', skip.noCustomer)}
                ${skipRow('All-zero volumes', skip.allZero)}
                ${skipRow('CANCELLED invoice', skip.cancelled)}
                ${skipRow('Missing id', skip.noId)}
            </ul>` : '';

            const changesPending = isRoundTrip
                ? (s.adds + s.updates)
                : s.csvRowsParsed;
            const applyLabel = isRoundTrip
                ? `Apply ${(s.adds + s.updates).toLocaleString('en-NZ')} change${(s.adds + s.updates) === 1 ? '' : 's'}`
                : `Apply seed (${s.csvRowsParsed.toLocaleString('en-NZ')} rows)`;
            const applyHint = isRoundTrip
                ? 'Upserts by Id · missing rows left untouched · backs up before write.'
                : 'Replaces historical rows · preserves Hub rows · wipes HST-* orders · backs up before write.';

            resultsEl.innerHTML = `
            <div class="bulk-summary ${applied ? 'bulk-summary--applied' : ''}">${summaryHtml}</div>
            ${yearTable}
            ${sampleList}
            ${skippedBlock}
            ${!applied && changesPending > 0 ? `
            <div class="bulk-apply-bar">
                <button class="btn-primary" id="sh-apply-btn">${applyLabel}</button>
                <span class="bulk-apply-hint">${applyHint}</span>
            </div>` : ''}`;

            document.getElementById('sh-apply-btn')?.addEventListener('click', async (e) => {
                if (!lastFile) return;
                const confirmMsg = isRoundTrip
                    ? `Apply ${s.adds + s.updates} change(s) to sales history?\n\nUpserts by Id; rows missing from the CSV are left untouched. A backup is taken first.`
                    : `Seed sales history with ${s.csvRowsParsed} historical rows?\n\n  • Replaces all source:historical rows\n  • Preserves source:hub rows\n  • Deletes legacy HST-* orders from ORDERS_KV\n  • Backs up before write`;
                if (!confirm(confirmMsg)) return;
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Applying…';
                try {
                    const csv = await lastFile.text();
                    const resp = await fetch('/api/sales-history?apply=true', {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/csv' },
                        body: csv,
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    renderShResults(await resp.json(), true);
                    showToast(isRoundTrip ? `Applied ${s.adds + s.updates} changes` : `Seeded ${s.csvRowsParsed} rows`);
                } catch (err) {
                    showToast('Apply failed: ' + err.message);
                    btn.disabled = false; btn.textContent = applyLabel;
                }
            });
        }

        // Backfill Hub orders → sales_history.
        document.getElementById('sh-backfill-btn').addEventListener('click', async () => {
            resultsEl.innerHTML = '<p class="bulk-loading">Scanning Hub orders…</p>';
            try {
                const resp = await fetch('/api/sales-history/backfill', { method: 'POST' });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                const result = await resp.json();
                const s = result.summary;
                resultsEl.innerHTML = `
                <div class="bulk-summary">
                    <strong>Dry run (backfill):</strong>
                    Scanned ${s.ordersScanned} Hub order${s.ordersScanned === 1 ? '' : 's'}.
                    <strong>${s.wouldAdd}</strong> would be added,
                    <strong>${s.wouldUpdate}</strong> would be updated.
                    ${s.existingHubRows} Hub row${s.existingHubRows === 1 ? '' : 's'} already in the table.
                    ${s.skipped.noProductKg ? `<br>${s.skipped.noProductKg} order${s.skipped.noProductKg === 1 ? '' : 's'} skipped (no countable product kg — e.g. freight-only).` : ''}
                </div>
                ${s.sampleAdd.length ? `<h3 class="bulk-table-title">Sample to add</h3><ul class="bulk-skip-list">${s.sampleAdd.map(id => `<li><code>${escHtml(id)}</code></li>`).join('')}</ul>` : ''}
                ${s.wouldAdd + s.wouldUpdate > 0 ? `
                <div class="bulk-apply-bar">
                    <button class="btn-primary" id="sh-backfill-apply-btn">Apply (${s.wouldAdd + s.wouldUpdate} rows)</button>
                    <span class="bulk-apply-hint">Adds missing Hub rows + updates changed ones. Existing untouched. Backs up first.</span>
                </div>` : '<p class="bulk-empty">Nothing to backfill — every Hub order already has a row.</p>'}`;

                document.getElementById('sh-backfill-apply-btn')?.addEventListener('click', async (e) => {
                    if (!confirm(`Backfill ${s.wouldAdd + s.wouldUpdate} Hub order rows into sales_history?\n\nA backup is taken before write.`)) return;
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Applying…';
                    try {
                        const apply = await fetch('/api/sales-history/backfill?apply=true', { method: 'POST' });
                        if (!apply.ok) {
                            const err = await apply.json().catch(() => ({ error: apply.statusText }));
                            throw new Error(err.error || apply.statusText);
                        }
                        const r = await apply.json();
                        showToast(`Backfilled ${r.summary.wouldAdd} added · ${r.summary.wouldUpdate} updated`);
                        resultsEl.innerHTML = `<div class="bulk-summary bulk-summary--applied">
                            <strong>Backfill applied.</strong>
                            ${r.summary.wouldAdd} added, ${r.summary.wouldUpdate} updated.
                            Table size now ${r.summary.totalRowsAfter} rows.
                            <br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(r.summary.backupTs)}</code></span>
                        </div>`;
                    } catch (err) {
                        showToast('Apply failed: ' + err.message);
                        btn.disabled = false; btn.textContent = `Apply (${s.wouldAdd + s.wouldUpdate} rows)`;
                    }
                });
            } catch (err) {
                resultsEl.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`;
            }
        });
    }

    // ── (deprecated) Historical Import tab ──
    // Left in place temporarily in case anything else references it. The
    // new "Sales History" tab supersedes it and the underlying endpoint
    // (/api/orders/import-historical) is no longer wired into the UI.
    function renderHistoricalImportTab(body) {
        body.innerHTML = `
        <div class="cat-section">
            <h2 class="cat-title">Historical Sales Import</h2>
            <p class="cat-sub">Upload the Prime Tie sales CSV to populate the database with HST-* orders covering pre-Hub-live history. Each non-empty row becomes one locked order. Re-uploading the same CSV is idempotent — existing HST keys are overwritten in place, not duplicated.</p>

            <div class="bulk-step">
                <strong>1.</strong>
                <input type="file" id="histimport-file" accept=".csv,text/csv">
                <button class="btn-secondary btn-sm" id="histimport-dryrun-btn">Preview (dry-run)</button>
            </div>

            <div id="histimport-results"></div>
        </div>`;

        let lastFile = null;
        const resultsEl = document.getElementById('histimport-results');

        document.getElementById('histimport-dryrun-btn').addEventListener('click', async () => {
            const file = document.getElementById('histimport-file').files[0];
            if (!file) { showToast('Choose a CSV file first'); return; }
            lastFile = file;
            resultsEl.innerHTML = '<p class="bulk-loading">Parsing CSV…</p>';
            try {
                const csv = await file.text();
                const resp = await fetch('/api/orders/import-historical', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/csv' },
                    body: csv,
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                renderHistResults(await resp.json(), false);
            } catch (e) {
                resultsEl.innerHTML = `<p class="bulk-error">${escHtml(e.message)}</p>`;
            }
        });

        function renderHistResults(result, applied) {
            const s = result.summary;
            const skip = s.skipped || {};
            const skipRow = (label, n) => n
                ? `<li>${escHtml(label)}: ${n}</li>`
                : '';
            const yearRows = Object.keys(s.byYear || {}).sort().map(y => {
                const v = s.byYear[y];
                return `<tr>
                    <td>${escHtml(y)}</td>
                    <td class="bulk-num">${v.count.toLocaleString('en-NZ')}</td>
                    <td class="bulk-num">${Math.round(v.kg).toLocaleString('en-NZ')}</td>
                </tr>`;
            }).join('');

            resultsEl.innerHTML = `
            <div class="bulk-summary ${applied ? 'bulk-summary--applied' : ''}">
                <strong>${applied ? 'Applied' : 'Dry run'}:</strong>
                ${s.ordersToImport.toLocaleString('en-NZ')} order${s.ordersToImport === 1 ? '' : 's'} from
                ${s.csvRows.toLocaleString('en-NZ')} CSV row${s.csvRows === 1 ? '' : 's'}.
                ${s.negativeLineOrders ? `<br>${s.negativeLineOrders} order${s.negativeLineOrders === 1 ? '' : 's'} include negative-quantity lines (credit notes / returns).` : ''}
                ${applied ? `<br><span class="bulk-backup">Backup: <code>backup:orders_index:${escHtml(s.backupTs)}</code> · index ${s.indexBefore} → ${s.indexAfter} (added ${s.newlyAdded}, overwrote ${s.overwritten})</span>` : ''}
            </div>

            <h3 class="bulk-table-title">By year</h3>
            <div class="bulk-table-wrap">
                <table class="bulk-table">
                    <thead><tr><th>Year</th><th class="bulk-num">Orders</th><th class="bulk-num">kg</th></tr></thead>
                    <tbody>${yearRows || '<tr><td colspan="3" class="bulk-empty">(none)</td></tr>'}</tbody>
                </table>
            </div>

            ${(skip.blank || skip.noDate || skip.noCustomer || skip.allZero || skip.cancelled) ? `
            <h3 class="bulk-table-title">Skipped rows</h3>
            <ul class="bulk-skip-list">
                ${skipRow('Blank', skip.blank)}
                ${skipRow('Missing date', skip.noDate)}
                ${skipRow('Missing customer', skip.noCustomer)}
                ${skipRow('All-zero volumes', skip.allZero)}
                ${skipRow('CANCELLED invoice', skip.cancelled)}
            </ul>` : ''}

            ${!applied && s.ordersToImport > 0 ? `
            <div class="bulk-apply-bar">
                <button class="btn-primary" id="histimport-apply-btn">Apply ${s.ordersToImport.toLocaleString('en-NZ')} order${s.ordersToImport === 1 ? '' : 's'}</button>
                <span class="bulk-apply-hint">A snapshot of orders_index is saved to a backup key first.</span>
            </div>` : ''}`;

            document.getElementById('histimport-apply-btn')?.addEventListener('click', async (e) => {
                if (!lastFile) return;
                if (!confirm(`Import ${s.ordersToImport} historical orders into ORDERS_KV?\n\nA backup of orders_index will be taken first.\nExisting HST-* keys (if any) will be overwritten in place.`)) return;
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Importing…';
                try {
                    const csv = await lastFile.text();
                    const resp = await fetch('/api/orders/import-historical?apply=true', {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/csv' },
                        body: csv,
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    renderHistResults(await resp.json(), true);
                    showToast(`Imported ${s.ordersToImport} historical orders`);
                } catch (err) {
                    showToast('Import failed: ' + err.message);
                    btn.disabled = false; btn.textContent = `Apply ${s.ordersToImport} orders`;
                }
            });
        }
    }

    return { renderAdmin };
})();
