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

    // (storesTableRows removed — the Stores tab now renders an editable
    // table inline rather than a short read-only preview.)

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

    // ── Stores tab — editable, Hub-owned ──
    // Stores live in the `stores` KV blob; sheet is now only the one-time
    // seed bootstrap (and the optional "Re-seed from Sheet" admin button).
    // Inline edit / add / archive / CSV round-trip are all in one tab.
    async function renderStoresTab(body, _initialStores, onUpdate) {
        body.innerHTML = '<div class="orders-loading">Loading stores…</div>';

        let stores = [];
        let showArchived = false;

        async function reload() {
            const url = '/api/catalog/stores' + (showArchived ? '?archived=true' : '');
            stores = await api(url);
            if (typeof onUpdate === 'function') onUpdate(stores);
            render();
        }

        const STORE_HEADERS = [
            { key: 'customerCode', label: 'Code',     width: '90px' },
            { key: 'customer',     label: 'Customer', width: '140px' },
            { key: 'branch',       label: 'Branch',   width: '140px' },
            { key: 'address',      label: 'Address' },
            { key: 'city',         label: 'City',     width: '110px' },
            { key: 'postcode',     label: 'Postcode', width: '80px' },
            { key: 'phone',        label: 'Phone',    width: '110px' },
        ];

        function rowHtml(s) {
            const cells = STORE_HEADERS.map(h => `
                <td>
                    <input class="store-cell" data-id="${escHtml(s.id)}" data-field="${h.key}"
                        value="${escHtml(s[h.key] || '')}" placeholder="${escHtml(h.label)}">
                </td>`).join('');
            const srcBadge = s.source === 'hub'
                ? '<span class="store-src store-src--hub" title="Manually added in the Hub">hub</span>'
                : '<span class="store-src" title="Seeded from the sheet">sheet</span>';
            return `
            <tr class="store-row${s.archived ? ' store-row--archived' : ''}" data-id="${escHtml(s.id)}">
                <td class="store-id-cell">
                    <span class="cat-mono">${escHtml(s.id)}</span>
                    ${srcBadge}
                </td>
                ${cells}
                <td class="store-actions-cell">
                    ${s.archived
                        ? `<button class="btn-secondary btn-sm" data-action="restore" data-id="${escHtml(s.id)}">Restore</button>`
                        : `<button class="btn-secondary btn-sm" data-action="archive" data-id="${escHtml(s.id)}">Archive</button>`}
                </td>
            </tr>`;
        }

        function render() {
            const visible = stores.filter(s => showArchived || !s.archived);
            body.innerHTML = `
            <div class="cat-section" id="cat-stores">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Store Locations</h2>
                        <p class="cat-sub">Hub-owned. ${visible.length} store${visible.length === 1 ? '' : 's'}${showArchived ? ' (incl. archived)' : ''}. Edit any cell and click outside to save. Use Archive to soft-delete (data is preserved for historical references).</p>
                    </div>
                    <div class="cat-header-actions">
                        <a class="btn-secondary btn-sm" href="/api/catalog/stores?format=csv" download="stores.csv">Export CSV ↓</a>
                        <button class="btn-secondary btn-sm" id="stores-add-btn">+ Add store</button>
                        <label class="store-toggle-archived">
                            <input type="checkbox" id="stores-show-archived" ${showArchived ? 'checked' : ''}> Show archived
                        </label>
                    </div>
                </div>

                <div class="store-table-wrap">
                    <table class="store-table">
                        <thead>
                            <tr>
                                <th style="width:120px">Id</th>
                                ${STORE_HEADERS.map(h => `<th${h.width ? ` style="width:${h.width}"` : ''}>${h.label}</th>`).join('')}
                                <th style="width:80px"></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${visible.length
                                ? visible.map(rowHtml).join('')
                                : '<tr><td colspan="9" class="cat-empty">No stores. Click "+ Add store" to create one.</td></tr>'}
                        </tbody>
                    </table>
                </div>

                <details class="cat-section" style="margin-top:1rem">
                    <summary style="cursor:pointer;list-style:none;padding:0.5rem 0">
                        <strong>Upload CSV</strong> &nbsp;<span class="cat-sub">— round-trip an edited stores.csv, or re-seed from the sheet</span>
                    </summary>
                    <div style="margin-top:0.75rem">
                        <div class="bulk-step">
                            <input type="file" id="stores-upload-file" accept=".csv,text/csv">
                            <button class="btn-secondary btn-sm" id="stores-upload-dryrun-btn">Preview (dry-run)</button>
                            <span class="bulk-step-hint">Auto-detects round-trip (Id column) vs seed (sheet format).</span>
                        </div>
                        <div id="stores-upload-results"></div>
                        <div style="margin-top:1rem;border-top:1px solid #f1f5f9;padding-top:0.75rem">
                            <button class="btn-secondary btn-sm" id="stores-reseed-btn"
                                title="Refetch the published Google Sheet and replace all sheet-sourced rows. Hub-added stores are preserved.">Re-seed from Sheet</button>
                            <span class="cat-sub" style="margin-left:0.5rem">Backs up the current table first.</span>
                        </div>
                    </div>
                </details>
            </div>`;

            wireRow();
        }

        function wireRow() {
            // Save-on-blur for every editable cell.
            body.querySelectorAll('.store-cell').forEach(input => {
                let originalValue = input.value;
                input.addEventListener('focus', () => { originalValue = input.value; });
                input.addEventListener('blur', async () => {
                    if (input.value === originalValue) return;
                    const id    = input.dataset.id;
                    const field = input.dataset.field;
                    input.disabled = true;
                    try {
                        await api(`/api/catalog/stores/${encodeURIComponent(id)}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ [field]: input.value }),
                        });
                        const local = stores.find(s => s.id === id);
                        if (local) local[field] = input.value;
                    } catch (err) {
                        showToast('Save failed: ' + err.message);
                        input.value = originalValue;
                    } finally {
                        input.disabled = false;
                    }
                });
            });

            body.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const id = e.currentTarget.dataset.id;
                    const action = e.currentTarget.dataset.action;
                    if (action === 'archive') {
                        if (!confirm(`Archive store ${id}?\n\nIt'll be hidden but kept in KV for historical references.`)) return;
                        try {
                            await api(`/api/catalog/stores/${encodeURIComponent(id)}`, { method: 'DELETE' });
                            await reload();
                            showToast('Archived');
                        } catch (err) { showToast('Archive failed: ' + err.message); }
                    } else if (action === 'restore') {
                        try {
                            await api(`/api/catalog/stores/${encodeURIComponent(id)}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ archived: false }),
                            });
                            await reload();
                            showToast('Restored');
                        } catch (err) { showToast('Restore failed: ' + err.message); }
                    }
                });
            });

            // Show / hide archived rows.
            document.getElementById('stores-show-archived')?.addEventListener('change', async (e) => {
                showArchived = e.target.checked;
                await reload();
            });

            // Add a new store inline — minimal flow: prompt for customer + branch,
            // then the user can edit the other fields in the table.
            document.getElementById('stores-add-btn')?.addEventListener('click', async () => {
                const customer = prompt('Customer name (e.g. Farmlands):');
                if (customer == null) return;
                const branch = prompt('Branch (e.g. Te Puke):');
                if (branch == null) return;
                if (!customer.trim() && !branch.trim()) {
                    showToast('Customer or Branch is required');
                    return;
                }
                try {
                    await api('/api/catalog/stores', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'add', store: { customer: customer.trim(), branch: branch.trim() } }),
                    });
                    await reload();
                    showToast('Store added — fill in the remaining columns inline');
                } catch (err) { showToast('Add failed: ' + err.message); }
            });

            // CSV upload — dry-run + apply.
            let lastFile = null;
            const resultsEl = document.getElementById('stores-upload-results');
            document.getElementById('stores-upload-dryrun-btn')?.addEventListener('click', async () => {
                const file = document.getElementById('stores-upload-file').files[0];
                if (!file) { showToast('Choose a CSV file first'); return; }
                lastFile = file;
                resultsEl.innerHTML = '<p class="bulk-loading">Parsing CSV…</p>';
                try {
                    const csv = await file.text();
                    const resp = await fetch('/api/catalog/stores', {
                        method: 'POST',
                        headers: { 'Content-Type': 'text/csv' },
                        body: csv,
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    const result = await resp.json();
                    renderUploadResults(result);
                } catch (err) {
                    resultsEl.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`;
                }
            });

            function renderUploadResults(result) {
                const s = result.summary;
                const summaryText = s.mode === 'round-trip'
                    ? `<strong>Dry run (round-trip):</strong> ${s.csvRowsParsed} parsed · ${s.adds} new · ${s.updates} updated · ${s.unchanged} unchanged.`
                    : `<strong>Dry run (seed):</strong> ${s.csvRowsParsed} rows parsed. Apply replaces sheet-sourced rows; hub-added stores are preserved.`;
                resultsEl.innerHTML = `
                <div class="bulk-summary">${summaryText}</div>
                ${(s.adds + s.updates > 0) || s.mode === 'seed' ? `
                <div class="bulk-apply-bar">
                    <button class="btn-primary" id="stores-upload-apply-btn">Apply</button>
                    <span class="bulk-apply-hint">Backs up the current stores table first.</span>
                </div>` : '<p class="bulk-empty">Nothing to apply — the CSV matches what is already stored.</p>'}`;

                document.getElementById('stores-upload-apply-btn')?.addEventListener('click', async (e) => {
                    if (!confirm('Apply this upload to the stores table?\n\nA backup is taken first.')) return;
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Applying…';
                    try {
                        const csv = await lastFile.text();
                        const resp = await fetch('/api/catalog/stores?apply=true', {
                            method: 'POST',
                            headers: { 'Content-Type': 'text/csv' },
                            body: csv,
                        });
                        if (!resp.ok) {
                            const err = await resp.json().catch(() => ({ error: resp.statusText }));
                            throw new Error(err.error || resp.statusText);
                        }
                        const r = await resp.json();
                        showToast(`Applied · table size: ${r.summary.totalRowsAfter}`);
                        await reload();
                    } catch (err) {
                        showToast('Apply failed: ' + err.message);
                        btn.disabled = false; btn.textContent = 'Apply';
                    }
                });
            }

            // Re-seed from the published sheet (admin action — wipes sheet-sourced rows).
            document.getElementById('stores-reseed-btn')?.addEventListener('click', async (e) => {
                if (!confirm('Re-seed from the published sheet?\n\nThis fetches the latest sheet, replaces all sheet-sourced rows, and preserves hub-added stores. A backup of the current table is taken first.')) return;
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Re-seeding…';
                try {
                    const resp = await fetch('/api/catalog/stores', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'reseed-from-sheet' }),
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    const r = await resp.json();
                    showToast(`Re-seeded ${r.seeded} stores from sheet`);
                    await reload();
                } catch (err) {
                    showToast('Re-seed failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Re-seed from Sheet';
                }
            });
        }

        await reload();
    }

    async function renderAdmin(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Catalogue</h1>
                <p class="view-subtitle">Manage product pricing, store locations, printers, and sales data exports.</p>
            </div>
        </div>
        <div class="imp-tabs">
            <button class="imp-view-btn active" id="cat-tab-prices">Prices</button>
            <button class="imp-view-btn" id="cat-tab-stores">Stores</button>
            <button class="imp-view-btn" id="cat-tab-printers">Printers</button>
            <button class="imp-view-btn" id="cat-tab-salesdata">Sales Data</button>
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
            document.getElementById('cat-tab-salesdata').classList.toggle('active', tab === 'salesdata');
            if (tab === 'prices')         renderPricesTab(body, items, updated => { items = updated; });
            else if (tab === 'stores')    renderStoresTab(body, stores, updated => { stores = updated; });
            else if (tab === 'printers')  renderPrintersTab(body);
            else if (tab === 'salesdata') renderSalesDataTab(body);
        }

        document.getElementById('cat-tab-prices').addEventListener('click',     () => switchTab('prices'));
        document.getElementById('cat-tab-stores').addEventListener('click',     () => switchTab('stores'));
        document.getElementById('cat-tab-printers').addEventListener('click',   () => switchTab('printers'));
        document.getElementById('cat-tab-salesdata').addEventListener('click',  () => switchTab('salesdata'));

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



    // ── Sales Data tab ──
    // One tab for all sales-related data ops. Two prominent downloads at
    // top; admin actions (seed historical, backfill Hub orders, upload
    // round-trip CSV) collapsed in a details section below.
    async function renderSalesDataTab(body) {
        body.innerHTML = `
        <div class="cat-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Sales Data</h2>
                    <p class="cat-sub">All exports + historical data management.</p>
                </div>
            </div>
            <div id="sd-stats" class="cat-sub" style="margin:0.75rem 0 1rem">Loading current state…</div>

            <div class="sd-download-grid">
                <a class="sd-download-card" href="/api/orders/export-summary" download="orders-summary.csv">
                    <div class="sd-download-title">Detailed Hub Orders ↓</div>
                    <div class="sd-download-desc">One row per Hub order. Operational view — created/dispatched timestamps, who dispatched, status, customer, branch, PO, Xero invoice + product-kg totals. Hub orders only (no historicals). Freight excluded from kg.</div>
                </a>
                <a class="sd-download-card" href="/api/sales-history?format=csv" download="sales-history.csv">
                    <div class="sd-download-title">Historical &amp; Hub orders (combined) ↓</div>
                    <div class="sd-download-desc">One row per sale, historical seed + live Hub rows in the same shape. Three product columns (PT Bundles · PT Loose · eco Ties). Round-trips cleanly via the upload section below.</div>
                </a>
            </div>

            <details class="cat-section sd-admin">
                <summary>
                    <strong>Admin actions</strong>
                    <span class="cat-sub">— seed historical CSV · backfill Hub orders · round-trip edits</span>
                </summary>

                <div class="sd-admin-body">
                    <h3 class="bulk-table-title">Repair dates</h3>
                    <p class="cat-sub">Re-parses every row's date column and rebuilds month/year/fy. Run this if a round-trip upload landed dates in a format the parser couldn't read (symptom: byYear in /api/sales-history shows 1–31 instead of actual years).</p>
                    <div class="bulk-step">
                        <button class="btn-secondary btn-sm" id="sd-repair-btn">Repair dates</button>
                    </div>
                    <div id="sd-repair-results"></div>

                    <h3 class="bulk-table-title" style="margin-top:1.5rem">Backfill Hub orders</h3>
                    <p class="cat-sub">Walks orders_index and adds a row for every Hub order missing one. Existing rows untouched. Run this once if Hub orders aren't appearing in the combined export.</p>
                    <div class="bulk-step">
                        <button class="btn-secondary btn-sm" id="sd-backfill-btn">Backfill Hub orders</button>
                    </div>
                    <div id="sd-backfill-results"></div>

                    <h3 class="bulk-table-title" style="margin-top:1.5rem">Upload CSV</h3>
                    <p class="cat-sub">Auto-detects the format. Upload the original Prime Tie sales CSV to <strong>seed historicals</strong>, or a downloaded <code>sales-history.csv</code> (with Id + Source columns) to <strong>round-trip edits</strong> — rows match by Id and update in place; missing rows are left untouched.</p>
                    <div class="bulk-step">
                        <input type="file" id="sd-file" accept=".csv,text/csv">
                        <button class="btn-secondary btn-sm" id="sd-dryrun-btn">Preview (dry-run)</button>
                    </div>
                    <div id="sd-upload-results"></div>
                </div>
            </details>
        </div>`;

        // Current-state line
        try {
            const resp = await fetch('/api/sales-history');
            if (resp.ok) {
                const data = await resp.json();
                const yrs = Object.keys(data.byYear || {}).sort();
                const stats = document.getElementById('sd-stats');
                if (stats) {
                    stats.innerHTML = data.count
                        ? `<strong>${data.count.toLocaleString('en-NZ')}</strong> rows in the sales history table; years: ${yrs.join(', ') || '(none)'}.`
                        : `Sales history is empty — seed it from the Admin actions section below.`;
                }
            }
        } catch (e) { /* nice-to-have */ }

        let lastFile = null;
        const uploadResults = document.getElementById('sd-upload-results');
        const backfillResults = document.getElementById('sd-backfill-results');
        const repairResults = document.getElementById('sd-repair-results');

        // ── Repair dates ──
        // Re-parses every row's date column and rebuilds month/year/fy.
        // Two-step: dry-run preview, then apply with backup.
        document.getElementById('sd-repair-btn').addEventListener('click', async () => {
            repairResults.innerHTML = '<p class="bulk-loading">Re-parsing dates…</p>';
            try {
                const resp = await fetch('/api/sales-history/repair-dates', { method: 'POST' });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                const r = await resp.json();
                const s = r.summary;
                const samples = (s.sampleRepaired || []).map(x =>
                    `<li><code>${escHtml(x.id)}</code> → ${escHtml(x.date)} (yr ${x.year}, mo ${x.month})</li>`
                ).join('');
                repairResults.innerHTML = `
                <div class="bulk-summary">
                    <strong>Dry run:</strong>
                    ${s.total} row${s.total === 1 ? '' : 's'} scanned.
                    <strong>${s.repaired}</strong> need repair · ${s.unchanged} already correct · ${s.unparseable} unparseable.
                    ${samples ? `<br><span class="bulk-backup">Sample fixes:<ul style="margin:0.3rem 0 0;padding-left:1.25rem">${samples}</ul></span>` : ''}
                    ${s.sampleUnparseable?.length ? `<br><span class="bulk-error">Unparseable ids (will be left alone): ${s.sampleUnparseable.map(escHtml).join(', ')}</span>` : ''}
                </div>
                ${s.repaired > 0 ? `
                <div class="bulk-apply-bar">
                    <button class="btn-primary" id="sd-repair-apply-btn">Apply repair (${s.repaired} rows)</button>
                    <span class="bulk-apply-hint">Backs up sales_history before writing.</span>
                </div>` : '<p class="bulk-empty">Nothing to repair.</p>'}`;
                document.getElementById('sd-repair-apply-btn')?.addEventListener('click', async (e) => {
                    if (!confirm(`Repair ${s.repaired} row date(s)?\n\nA backup of sales_history is taken first.`)) return;
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Applying…';
                    try {
                        const apply = await fetch('/api/sales-history/repair-dates?apply=true', { method: 'POST' });
                        if (!apply.ok) {
                            const err = await apply.json().catch(() => ({ error: apply.statusText }));
                            throw new Error(err.error || apply.statusText);
                        }
                        const ar = await apply.json();
                        showToast(`Repaired ${ar.summary.repaired} rows`);
                        repairResults.innerHTML = `<div class="bulk-summary bulk-summary--applied">
                            <strong>Repair applied.</strong> ${ar.summary.repaired} rows updated.
                            <br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(ar.summary.backupTs)}</code></span>
                        </div>`;
                    } catch (err) {
                        showToast('Apply failed: ' + err.message);
                        btn.disabled = false; btn.textContent = `Apply repair (${s.repaired} rows)`;
                    }
                });
            } catch (err) {
                repairResults.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`;
            }
        });

        // ── Upload (seed or round-trip, auto-detected) ──
        document.getElementById('sd-dryrun-btn').addEventListener('click', async () => {
            const file = document.getElementById('sd-file').files[0];
            if (!file) { showToast('Choose a CSV file first'); return; }
            lastFile = file;
            uploadResults.innerHTML = '<p class="bulk-loading">Parsing CSV…</p>';
            try {
                const csv = await file.text();
                const resp = await fetch('/api/sales-history', {
                    method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                renderUploadResults(await resp.json(), false);
            } catch (e) {
                uploadResults.innerHTML = `<p class="bulk-error">${escHtml(e.message)}</p>`;
            }
        });

        function renderUploadResults(result, applied) {
            const s = result.summary;
            const isRoundTrip = s.mode === 'round-trip';
            const summaryHtml = isRoundTrip
                ? `<strong>${applied ? 'Applied' : 'Dry run'} (round-trip):</strong> ${s.csvRowsParsed} parsed · ${s.adds} new · ${s.updates} updated · ${s.unchanged} unchanged.${applied ? `<br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(s.backupTs)}</code></span>` : ''}`
                : `<strong>${applied ? 'Applied' : 'Dry run'} (seed):</strong> ${s.csvRowsParsed} rows parsed.${applied ? `<br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(s.backupTs)}</code> · ${s.hstOrdersDeleted} HST orders wiped · ${s.hubRowsPreserved} hub rows preserved</span>` : ''}`;
            const changesPending = isRoundTrip ? (s.adds + s.updates) : s.csvRowsParsed;
            const applyLabel = isRoundTrip
                ? `Apply ${(s.adds + s.updates)} change${(s.adds + s.updates) === 1 ? '' : 's'}`
                : `Apply seed (${s.csvRowsParsed} rows)`;
            uploadResults.innerHTML = `
            <div class="bulk-summary ${applied ? 'bulk-summary--applied' : ''}">${summaryHtml}</div>
            ${!applied && changesPending > 0 ? `
            <div class="bulk-apply-bar">
                <button class="btn-primary" id="sd-apply-btn">${applyLabel}</button>
                <span class="bulk-apply-hint">${isRoundTrip ? 'Upserts by Id · missing rows left untouched · backs up first.' : 'Replaces source:historical rows · preserves source:hub rows · backs up first.'}</span>
            </div>` : ''}`;

            document.getElementById('sd-apply-btn')?.addEventListener('click', async (e) => {
                if (!lastFile) return;
                if (!confirm(isRoundTrip
                    ? `Apply ${s.adds + s.updates} change(s)?\n\nUpserts by Id; missing rows left alone. Backup taken first.`
                    : `Seed ${s.csvRowsParsed} historical rows?\n\nReplaces source:historical rows. Preserves source:hub rows. Backup taken first.`)) return;
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Applying…';
                try {
                    const csv = await lastFile.text();
                    const resp = await fetch('/api/sales-history?apply=true', {
                        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    renderUploadResults(await resp.json(), true);
                    showToast(isRoundTrip ? `Applied ${s.adds + s.updates} changes` : `Seeded ${s.csvRowsParsed} rows`);
                } catch (err) {
                    showToast('Apply failed: ' + err.message);
                    btn.disabled = false; btn.textContent = applyLabel;
                }
            });
        }

        // ── Backfill Hub orders ──
        document.getElementById('sd-backfill-btn').addEventListener('click', async () => {
            backfillResults.innerHTML = '<p class="bulk-loading">Scanning Hub orders…</p>';
            try {
                const resp = await fetch('/api/sales-history/backfill', { method: 'POST' });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({ error: resp.statusText }));
                    throw new Error(err.error || resp.statusText);
                }
                const r = await resp.json();
                const s = r.summary;
                backfillResults.innerHTML = `
                <div class="bulk-summary">
                    <strong>Dry run:</strong> Scanned ${s.ordersScanned} Hub order${s.ordersScanned === 1 ? '' : 's'}.
                    <strong>${s.wouldAdd}</strong> to add, <strong>${s.wouldUpdate}</strong> to update.
                    ${s.existingHubRows} hub row${s.existingHubRows === 1 ? '' : 's'} already in the table.
                </div>
                ${s.wouldAdd + s.wouldUpdate > 0 ? `
                <div class="bulk-apply-bar">
                    <button class="btn-primary" id="sd-backfill-apply-btn">Apply (${s.wouldAdd + s.wouldUpdate} rows)</button>
                    <span class="bulk-apply-hint">Backs up sales_history first.</span>
                </div>` : '<p class="bulk-empty">Nothing to backfill — every Hub order is already in the table.</p>'}`;
                document.getElementById('sd-backfill-apply-btn')?.addEventListener('click', async (e) => {
                    if (!confirm(`Backfill ${s.wouldAdd + s.wouldUpdate} Hub-order row(s) into sales_history?\n\nBackup taken first.`)) return;
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Applying…';
                    try {
                        const apply = await fetch('/api/sales-history/backfill?apply=true', { method: 'POST' });
                        if (!apply.ok) {
                            const err = await apply.json().catch(() => ({ error: apply.statusText }));
                            throw new Error(err.error || apply.statusText);
                        }
                        const ar = await apply.json();
                        showToast(`Backfilled · table size: ${ar.summary.totalRowsAfter}`);
                        backfillResults.innerHTML = `<div class="bulk-summary bulk-summary--applied">
                            <strong>Backfill applied.</strong> ${ar.summary.wouldAdd} added · ${ar.summary.wouldUpdate} updated · table size ${ar.summary.totalRowsAfter}.
                            <br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(ar.summary.backupTs)}</code></span>
                        </div>`;
                    } catch (err) {
                        showToast('Apply failed: ' + err.message);
                        btn.disabled = false; btn.textContent = `Apply (${s.wouldAdd + s.wouldUpdate} rows)`;
                    }
                });
            } catch (err) {
                backfillResults.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`;
            }
        });
    }

    return { renderAdmin };
})();
