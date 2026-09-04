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

    const STORE_HEADERS = ['Customer Code', 'Customer', 'Branch', 'City', 'Street Address', 'Postcode', 'Phone', 'Zone_courier', 'Zone_freight'];
    const STORE_EXAMPLE = ['FF-Te-Puke', 'Fruitfed', 'Fruitfed - Te Puke', 'Te Puke', '1 Jellicoe Street', '3119', '07 533 1234', 'Local', 'Tauranga / Te Puke'];

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
        const headers = ['Customer Code', 'Customer', 'Branch', 'City', 'Street Address', 'Postcode', 'Phone', 'Zone_courier', 'Zone_freight'];
        const rows = stores.map(s => [
            s.customerCode || '', s.customer || '', s.branch || '',
            s.city || '', s.streetAddress || '', s.postcode || '', s.phone || '',
            s.zoneCourier || '', s.zoneFreight || '',
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

        // Fixed option lists for the zone columns, from /api/catalog/zones:
        // courier zones are the four fixed FR-01..04 zones; freight zones are
        // the rate rows on the published freight tab (current pricing year).
        // Values must match exactly for auto-freight to resolve — free text is
        // how "inner" vs "Inner Island" mismatches crept in.
        let zoneOpts = { courier: [], freight: [], loaded: false };
        async function loadZones() {
            try {
                const z = await api('/api/catalog/zones');
                zoneOpts = {
                    courier: z.courierZones || [],
                    freight: (z.freightZones || []).map(f => f.label),
                    loaded:  true,
                };
            } catch (_) {
                zoneOpts = {
                    courier: ['Local', 'Inner Island', 'Outer Island', 'Inter Island'],
                    freight: [...new Set(stores.map(s => s.zoneFreight).filter(Boolean))].sort(),
                    loaded:  true,
                };
            }
        }

        async function reload() {
            // Always fetch archived too — they render in their own section below.
            stores = await api('/api/catalog/stores?archived=true');
            if (!zoneOpts.loaded) await loadZones();
            if (typeof onUpdate === 'function') onUpdate(stores.filter(s => !s.archived));
            render();
        }

        // ── Sales by Month for one store ─────────────────────────────────
        // Sales rows (sales_history) name stores loosely — "PGG"/"Katikati",
        // "PGG Wrightson"/"Fruitfed Supplies Katikati", "Farmlands"/"Farmlands
        // Retail - Te Puna" — so match on customer family + branch containment.
        let salesRowsP = null;
        function loadSalesRows() {
            if (!salesRowsP) {
                salesRowsP = fetch('/api/sales-history?rows=true')
                    .then(r => r.ok ? r.json() : { rows: [] })
                    .then(d => d.rows || [])
                    .catch(() => []);
            }
            return salesRowsP;
        }
        const normTxt = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        function customerFamily(s) {
            const n = normTxt(s);
            if (!n) return '';
            if (/fruitfed|^pgg/.test(n)) return 'pgg';
            if (n.includes('farmlands')) return 'farmlands';
            if (n.includes('horticentre') || n.includes('hortcentre')) return 'horticentre';
            return n;
        }
        function rowMatchesStore(row, store) {
            const sb = normTxt(store.branch);
            if (!sb) return false;
            const rb = normTxt(row.branch);
            if (!(rb === sb || rb.includes(sb))) return false;
            const sf = customerFamily(store.customer);
            const rf = customerFamily(row.customer) || customerFamily(row.branch);
            return !sf || !rf || sf === rf;
        }

        const MO_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const CHART_COLORS = ['#94a3b8', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

        async function openStoreSales(store) {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            const title = [store.customer, store.branch].filter(Boolean).map(escHtml).join(' — ');
            overlay.innerHTML = `
                <div class="modal-box modal-box--wide">
                    <h3 class="modal-title">Sales by Month · ${title || escHtml(store.id)}</h3>
                    <div id="store-sales-body"><p class="modal-hint">Loading sales history…</p></div>
                    <div class="modal-actions"><button class="btn-secondary" id="store-sales-close">Close</button></div>
                </div>`;
            document.body.appendChild(overlay);
            const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
            const onKey = e => { if (e.key === 'Escape') close(); };
            overlay.querySelector('#store-sales-close').addEventListener('click', close);
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            document.addEventListener('keydown', onKey);

            const rows = (await loadSalesRows()).filter(r => rowMatchesStore(r, store));
            if (!overlay.isConnected) return;
            const bodyEl = overlay.querySelector('#store-sales-body');
            if (!rows.length) {
                bodyEl.innerHTML = '<p class="modal-hint">No sales rows found for this store.</p>';
                return;
            }

            // kg per calendar month, one dataset per year
            const byYear = {};
            let totalKg = 0, lastDate = '';
            rows.forEach(r => {
                const kg = (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
                const y = r.year, m = Math.min(11, Math.max(0, (Number(r.month) || 1) - 1));
                if (!y) return;
                if (!byYear[y]) byYear[y] = new Array(12).fill(0);
                byYear[y][m] += kg;
                totalKg += kg;
                if ((r.date || '') > lastDate) lastDate = r.date || '';
            });
            const allYears = Object.keys(byYear).sort();
            const chartId = 'store-sales-chart';

            function drawChart(years) {
                window._chartQ[chartId] = {
                    type: 'bar',
                    data: {
                        labels: MO_SHORT,
                        datasets: years.map((y, i) => ({
                            label: String(y),
                            data: byYear[y],
                            backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                            borderRadius: 2, borderSkipped: false,
                        })),
                    },
                    options: {
                        animation: false, responsive: true, maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: {
                            legend: { display: true, position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10, padding: 8 } },
                            tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString('en-NZ')} kg` } },
                        },
                        scales: {
                            x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#64748b' } },
                            y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', callback: v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } },
                        },
                    },
                };
                if (typeof initCharts === 'function') initCharts(overlay);
            }

            const recent = allYears.slice(-3);
            bodyEl.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;margin:-0.35rem 0 0.75rem">
                    <span class="modal-hint">${rows.length} sales row${rows.length === 1 ? '' : 's'} · ${Math.round(totalKg).toLocaleString('en-NZ')} kg total${lastDate ? ' · last sale ' + escHtml(lastDate) : ''}</span>
                    ${allYears.length > 3 ? `<label class="modal-hint" style="white-space:nowrap">Years
                        <select id="store-sales-years" style="margin-left:0.35rem;font-size:0.85rem">
                            <option value="recent">Last 3</option>
                            <option value="all">All (${allYears.length})</option>
                        </select></label>` : ''}
                </div>
                <div style="position:relative;height:260px;width:100%"><canvas data-chart-id="${chartId}"></canvas></div>`;
            drawChart(recent);
            overlay.querySelector('#store-sales-years')?.addEventListener('change', e => {
                drawChart(e.target.value === 'all' ? allYears : recent);
            });
        }

        const STORE_HEADERS = [
            { key: 'customerCode', label: 'Code',     width: '90px' },
            { key: 'customer',     label: 'Customer', width: '140px' },
            { key: 'branch',       label: 'Branch',   width: '140px' },
            { key: 'address',      label: 'Address' },
            { key: 'city',         label: 'City',     width: '110px' },
            { key: 'postcode',     label: 'Postcode', width: '80px' },
            { key: 'phone',        label: 'Phone',    width: '110px' },
            { key: 'zoneCourier',  label: 'Zone (courier)', width: '135px', select: () => zoneOpts.courier },
            { key: 'zoneFreight',  label: 'Zone (freight)', width: '175px', select: () => zoneOpts.freight },
            { key: 'pickup',       label: 'Pickup',   width: '64px', check: true },
        ];

        // Fixed-choice cell. A current value that isn't in the option list is
        // kept as a flagged "⚠ … (not in list)" option so nothing is silently
        // blanked — it just needs re-picking.
        function selectCellHtml(s, h) {
            const cur  = s[h.key] || '';
            const opts = h.select();
            const known = opts.some(o => o.toLowerCase() === cur.toLowerCase());
            const optHtml = ['<option value="">—</option>'].concat(opts.map(o =>
                `<option value="${escHtml(o)}"${o.toLowerCase() === cur.toLowerCase() ? ' selected' : ''}>${escHtml(o)}</option>`));
            if (cur && !known) {
                optHtml.push(`<option value="${escHtml(cur)}" selected>⚠ ${escHtml(cur)} (not in list)</option>`);
            }
            const warn = cur && !known;
            return `
                <td>
                    <select class="store-cell${warn ? ' store-cell--warn' : ''}" data-id="${escHtml(s.id)}" data-field="${h.key}"
                        title="${warn ? 'Not a recognised zone — auto-freight can\'t resolve it. Pick a value from the list.' : escHtml(h.label)}">${optHtml.join('')}</select>
                </td>`;
        }

        function rowHtml(s) {
            const cells = STORE_HEADERS.map(h =>
                h.check ? `
                <td class="store-check-cell">
                    <input type="checkbox" class="store-check" data-id="${escHtml(s.id)}" data-field="${h.key}"${s[h.key] ? ' checked' : ''} title="Pick-up store — excluded from auto-freight">
                </td>`
                : h.select ? selectCellHtml(s, h) : `
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
                    <a href="#" class="cat-mono store-id-link" data-action="sales" data-id="${escHtml(s.id)}" title="Sales by month for this store">${escHtml(s.id)}</a>
                    ${srcBadge}
                </td>
                ${cells}
                <td class="store-actions-cell">
                    <button class="btn-secondary btn-sm" data-action="sales" data-id="${escHtml(s.id)}" title="Sales by month">📊</button>
                    ${s.archived
                        ? `<button class="btn-secondary btn-sm" data-action="restore" data-id="${escHtml(s.id)}">Restore</button>`
                        : `<button class="btn-secondary btn-sm" data-action="archive" data-id="${escHtml(s.id)}">Archive</button>`}
                    <button class="btn-secondary btn-sm store-delete-btn" data-action="delete" data-id="${escHtml(s.id)}" title="Delete permanently">✕</button>
                </td>
            </tr>`;
        }

        function tableHtml(rows, emptyText) {
            return `
                <div class="store-table-wrap">
                    <table class="store-table">
                        <thead>
                            <tr>
                                <th style="width:120px">Id</th>
                                ${STORE_HEADERS.map(h => `<th${h.width ? ` style="width:${h.width}"` : ''}>${h.label}</th>`).join('')}
                                <th style="width:120px"></th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rows.length
                                ? rows.map(rowHtml).join('')
                                : `<tr><td colspan="${STORE_HEADERS.length + 2}" class="cat-empty">${emptyText}</td></tr>`}
                        </tbody>
                    </table>
                </div>`;
        }

        function render() {
            const active   = stores.filter(s => !s.archived);
            const archived = stores.filter(s => s.archived);
            body.innerHTML = `
            <div class="cat-section" id="cat-stores">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Store Locations</h2>
                        <p class="cat-sub">Hub-owned. ${active.length} store${active.length === 1 ? '' : 's'}. Edit any cell and click outside to save. Click a store's Id (or 📊) for its sales by month. Archive soft-deletes — archived stores are listed below.</p>
                    </div>
                    <div class="cat-header-actions">
                        <a class="btn-secondary btn-sm" href="/api/catalog/stores?format=csv" download="stores.csv">Export CSV ↓</a>
                        <button class="btn-secondary btn-sm" id="stores-add-btn">+ Add store</button>
                        <button class="btn-secondary btn-sm" id="stores-delete-ids-btn" title="Permanently remove stores by Id or Id range (e.g. store-0070 to store-0132). Backs up first.">Delete IDs…</button>
                    </div>
                </div>

                ${tableHtml(active, 'No stores. Click "+ Add store" to create one.')}

                <details class="cat-section store-archived" style="margin-top:1rem${archived.length ? '' : ';display:none'}">
                    <summary style="cursor:pointer;list-style:none;padding:0.5rem 0">
                        <strong>Archived stores</strong> &nbsp;<span class="cat-sub">— ${archived.length} hidden from order forms and auto-freight; kept for historical references. Restore to bring one back.</span>
                    </summary>
                    <div style="margin-top:0.5rem">
                        ${tableHtml(archived, 'No archived stores.')}
                    </div>
                </details>

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
                        <label class="cat-sub" style="display:flex;align-items:flex-start;gap:0.45rem;margin-top:0.5rem;cursor:pointer">
                            <input type="checkbox" id="stores-upload-prune" style="margin-top:0.15rem">
                            <span><strong>Make this file authoritative</strong> — remove any store not in it (deletes rows you removed, and clears leftover duplicates). Round-trip uploads only; backs up first.</span>
                        </label>
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
            // Save-on-blur (text inputs) / save-on-change (zone selects).
            async function saveCell(input, originalValue) {
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
                    if (input.tagName === 'SELECT') {
                        // A valid pick clears the warning and its placeholder option.
                        input.classList.remove('store-cell--warn');
                        input.title = '';
                        input.querySelectorAll('option').forEach(o => {
                            if (o.textContent.startsWith('⚠') && !o.selected) o.remove();
                        });
                    }
                    return true;
                } catch (err) {
                    showToast('Save failed: ' + err.message);
                    input.value = originalValue;
                    return false;
                } finally {
                    input.disabled = false;
                }
            }
            body.querySelectorAll('.store-cell').forEach(input => {
                let originalValue = input.value;
                input.addEventListener('focus', () => { originalValue = input.value; });
                const evt = input.tagName === 'SELECT' ? 'change' : 'blur';
                input.addEventListener(evt, async () => {
                    if (input.value === originalValue) return;
                    if (await saveCell(input, originalValue)) originalValue = input.value;
                });
            });
            // Pickup checkbox — excludes the store from auto-freight.
            body.querySelectorAll('.store-check').forEach(cb => {
                cb.addEventListener('change', async () => {
                    const id = cb.dataset.id, field = cb.dataset.field;
                    cb.disabled = true;
                    try {
                        await api(`/api/catalog/stores/${encodeURIComponent(id)}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ [field]: cb.checked }),
                        });
                        const local = stores.find(s => s.id === id);
                        if (local) local[field] = cb.checked;
                        showToast(cb.checked ? 'Marked as pickup — no auto-freight' : 'Pickup removed');
                    } catch (err) {
                        showToast('Save failed: ' + err.message);
                        cb.checked = !cb.checked;
                    } finally {
                        cb.disabled = false;
                    }
                });
            });

            body.querySelectorAll('[data-action]').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const id = e.currentTarget.dataset.id;
                    const action = e.currentTarget.dataset.action;
                    if (action === 'sales') {
                        e.preventDefault();
                        const store = stores.find(s => s.id === id);
                        if (store) openStoreSales(store);
                    } else if (action === 'archive') {
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
                    } else if (action === 'delete') {
                        const store = stores.find(s => s.id === id);
                        const nm = store ? [store.customer, store.branch].filter(Boolean).join(' — ') : id;
                        if (!confirm(`Permanently delete ${id}${nm ? ` (${nm})` : ''}?\n\nThis removes it from KV — unlike Archive it is NOT kept. Backs up first. Historical sales rows linked by storeId are unaffected.`)) return;
                        try {
                            const res = await api('/api/catalog/stores', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'delete-ids', ids: [id] }),
                            });
                            await reload();
                            showToast(res.removed ? 'Deleted' : 'Nothing removed');
                        } catch (err) { showToast('Delete failed: ' + err.message); }
                    }
                });
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

            // Permanent bulk delete by Id — accepts a range ("store-0070 to
            // store-0132", "70-132", "0070–0132") or a comma/space list of ids.
            document.getElementById('stores-delete-ids-btn')?.addEventListener('click', async () => {
                const raw = prompt('Delete stores by Id — permanent.\n\nEnter a range ("store-0070 to store-0132" or "70-132") or a comma-separated list of ids:');
                if (raw == null || !raw.trim()) return;
                const pad = n => 'store-' + String(n).padStart(4, '0');
                const numOf = tok => {
                    const m = String(tok).match(/(\d+)/);
                    return m ? parseInt(m[1], 10) : null;
                };
                let ids = [];
                const rangeMatch = raw.match(/(\d+)\s*(?:to|-|–|—|\.\.)\s*(\d+)/i);
                if (rangeMatch) {
                    let a = parseInt(rangeMatch[1], 10), b = parseInt(rangeMatch[2], 10);
                    if (a > b) [a, b] = [b, a];
                    for (let n = a; n <= b; n++) ids.push(pad(n));
                } else {
                    ids = raw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean).map(t => {
                        if (/^store-\d+$/i.test(t)) return 'store-' + t.replace(/\D/g, '').padStart(4, '0');
                        const n = numOf(t);
                        return n != null ? pad(n) : null;
                    }).filter(Boolean);
                }
                if (!ids.length) { showToast('Could not parse any ids'); return; }
                const preview = ids.length <= 6 ? ids.join(', ') : `${ids[0]} … ${ids[ids.length - 1]} (${ids.length} ids)`;
                if (!confirm(`Permanently delete ${ids.length} store(s)?\n\n${preview}\n\nThis removes them from KV (a backup is taken first). It cannot be undone from the UI.`)) return;
                try {
                    const res = await api('/api/catalog/stores', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'delete-ids', ids }),
                    });
                    await reload();
                    const missTxt = res.missing && res.missing.length ? ` · ${res.missing.length} not found` : '';
                    showToast(`Deleted ${res.removed} store(s)${missTxt}`);
                } catch (err) { showToast('Delete failed: ' + err.message); }
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
                    const prune = document.getElementById('stores-upload-prune')?.checked;
                    const resp = await fetch('/api/catalog/stores' + (prune ? '?prune=true' : ''), {
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
                const prunedTxt = s.pruned ? ` · <strong style="color:#dc2626">${s.pruned} removed</strong>` : '';
                const skipTxt = s.skippedNoId ? ` · <strong style="color:#dc2626">${s.skippedNoId} skipped (no Store ID)</strong>` : '';
                const summaryText = s.mode === 'round-trip'
                    ? `<strong>Dry run (round-trip):</strong> ${s.csvRowsParsed} parsed · ${s.adds} new · ${s.updates} updated · ${s.unchanged} unchanged${prunedTxt}.`
                    : `<strong>Dry run (seed):</strong> ${s.csvRowsParsed} rows parsed${skipTxt}. Apply replaces sheet-sourced rows; hub-added stores are preserved.`;
                const hasChanges = (s.adds + s.updates + (s.pruned || 0) > 0) || s.mode === 'seed';
                resultsEl.innerHTML = `
                <div class="bulk-summary">${summaryText}</div>
                ${hasChanges ? `
                <div class="bulk-apply-bar">
                    <button class="btn-primary" id="stores-upload-apply-btn">Apply</button>
                    <span class="bulk-apply-hint">${s.pruned ? `Removes ${s.pruned} store(s) not in the file. ` : ''}Backs up the current stores table first.</span>
                </div>` : '<p class="bulk-empty">Nothing to apply — the CSV matches what is already stored.</p>'}`;

                document.getElementById('stores-upload-apply-btn')?.addEventListener('click', async (e) => {
                    const prune = document.getElementById('stores-upload-prune')?.checked;
                    const confirmMsg = prune
                        ? `Apply and REMOVE ${s.pruned} store(s) not in this file?\n\nA backup is taken first (restorable).`
                        : 'Apply this upload to the stores table?\n\nA backup is taken first.';
                    if (!confirm(confirmMsg)) return;
                    const btn = e.currentTarget;
                    btn.disabled = true; btn.textContent = 'Applying…';
                    try {
                        const csv = await lastFile.text();
                        const resp = await fetch('/api/catalog/stores?apply=true' + (prune ? '&prune=true' : ''), {
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
                <p class="view-subtitle">Manage product pricing, store locations, printers, sales data exports, and stock items.</p>
            </div>
        </div>
        <div class="imp-tabs">
            <button class="imp-view-btn active" id="cat-tab-prices">Prices</button>
            <button class="imp-view-btn" id="cat-tab-stores">Stores</button>
            <button class="imp-view-btn" id="cat-tab-printers">Printers</button>
            <button class="imp-view-btn" id="cat-tab-salesdata">Sales Data</button>
            <button class="imp-view-btn" id="cat-tab-payroll">Payroll</button>
            <button class="imp-view-btn" id="cat-tab-stock">Stock</button>
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
            document.getElementById('cat-tab-payroll').classList.toggle('active', tab === 'payroll');
            document.getElementById('cat-tab-stock').classList.toggle('active', tab === 'stock');
            if (tab === 'prices')         renderPricesTab(body, items, updated => { items = updated; });
            else if (tab === 'stores')    renderStoresTab(body, stores, updated => { stores = updated; });
            else if (tab === 'printers')  renderPrintersTab(body);
            else if (tab === 'salesdata') renderSalesDataTab(body);
            else if (tab === 'payroll')   renderPayrollTab(body);
            else if (tab === 'stock')     Stock.renderSettingsTab(body);
        }

        document.getElementById('cat-tab-prices').addEventListener('click',     () => switchTab('prices'));
        document.getElementById('cat-tab-stores').addEventListener('click',     () => switchTab('stores'));
        document.getElementById('cat-tab-printers').addEventListener('click',   () => switchTab('printers'));
        document.getElementById('cat-tab-salesdata').addEventListener('click',  () => switchTab('salesdata'));
        document.getElementById('cat-tab-payroll').addEventListener('click',    () => switchTab('payroll'));
        document.getElementById('cat-tab-stock').addEventListener('click',      () => switchTab('stock'));

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
                    <h3 class="bulk-table-title">Backfill Hub orders</h3>
                    <p class="cat-sub">Walks orders_index and adds a row for every Hub order missing one. Existing rows untouched. Run this once if Hub orders aren't appearing in the combined export.</p>
                    <div class="bulk-step">
                        <button class="btn-secondary btn-sm" id="sd-backfill-btn">Backfill Hub orders</button>
                        <button class="btn-secondary btn-sm" id="sd-audit-btn">Audit orders</button>
                    </div>
                    <div id="sd-backfill-results"></div>
                    <div id="sd-audit-results"></div>

                    <h3 class="bulk-table-title" style="margin-top:1.5rem">Upload CSV</h3>
                    <p class="cat-sub">Auto-detects the format. Upload the original Prime Tie sales CSV to <strong>seed historicals</strong>, or a downloaded <code>sales-history.csv</code> (with Id + Source columns) to <strong>round-trip edits</strong> — rows match by Id and update in place; missing rows are left untouched.</p>
                    <div class="bulk-step">
                        <input type="file" id="sd-file" accept=".csv,text/csv">
                        <button class="btn-secondary btn-sm" id="sd-dryrun-btn">Preview (dry-run)</button>
                    </div>
                    <label class="cat-sub" style="display:flex;align-items:flex-start;gap:0.45rem;margin-top:0.5rem;cursor:pointer">
                        <input type="checkbox" id="sd-replace-hist" style="margin-top:0.15rem">
                        <span><strong>Replace ALL historical rows</strong> — wholesale rebuild from this file, so deleted rows disappear and edits take. Hub orders are kept. Use this for an edited <code>sales-history.csv</code> export (it also rescues rows whose date drifted into the wrong column).</span>
                    </label>
                    <div id="sd-upload-results"></div>

                    <h3 class="bulk-table-title" style="margin-top:1.5rem">Map to stores</h3>
                    <p class="cat-sub">Give each historical customer/branch a stable store link so renamed stores stay aligned with Hub orders (which carry the store id natively). The suggested store is auto-matched — adjust any row, then Apply. Only the store link is written; the original names are left as-is.</p>
                    <div class="bulk-step">
                        <button class="btn-secondary btn-sm" id="sd-map-load-btn">Load store mapping</button>
                    </div>
                    <div id="sd-map-results"></div>
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

        // ── Audit orders: find untracked / pre-Xero strays (read-only) ──
        document.getElementById('sd-audit-btn')?.addEventListener('click', async () => {
            const el = document.getElementById('sd-audit-results');
            el.innerHTML = '<p class="cat-sub">Scanning every order in KV…</p>';
            let data;
            try { data = await api('/api/orders/audit'); }
            catch (e) { el.innerHTML = `<p class="cat-sub">Audit failed: ${escHtml(e.message)}</p>`; return; }

            const t = data.totals || {};
            const problems = data.problems || [];
            const strays = problems.filter(p => p.dispatched && !p.hasSales);
            const badge = (txt, cls) => `<span class="paid-badge${cls ? ' ' + cls : ''}">${escHtml(txt)}</span>`;
            const issueLabel = { 'no-sales-row': 'no sales row', 'not-in-index': 'not indexed', 'no-xero-invoice': 'no invoice', 'unclassified-lines': 'lines don’t classify', 'sku-size-mismatch': 'SKU ≠ size' };

            if (!problems.length) {
                el.innerHTML = `<p class="cat-sub" style="margin-top:0.6rem">✓ Scanned <strong>${t.total || 0}</strong> orders — no gaps found. Nothing dispatched is missing from sales history.</p>`;
                return;
            }
            el.innerHTML = `
                <p class="cat-sub" style="margin-top:0.6rem">
                    Scanned <strong>${t.total || 0}</strong> orders · <strong style="color:#dc2626">${strays.length}</strong> dispatched but missing a sales row ·
                    ${t.missingSales || 0} missing sales row · ${t.orphanIndex || 0} not indexed · ${t.noInvoice || 0} no Xero invoice · <strong style="color:#b45309">${t.sizeMismatch || 0} SKU≠size</strong>.
                </p>
                <div class="store-table-wrap" style="margin-top:0.5rem">
                    <table class="store-table">
                        <thead><tr><th>Id</th><th>Customer / Branch</th><th>PO</th><th>Invoice</th><th>Status</th><th>kg</th><th>Issues</th></tr></thead>
                        <tbody>
                            ${problems.map(p => `<tr${(p.dispatched && !p.hasSales) ? ' style="background:#fef2f2"' : ''}>
                                <td class="cat-mono">${escHtml(p.id)}${p.legacy ? ' ' + badge('legacy') : ''}</td>
                                <td>${escHtml([p.customer, p.branch].filter(Boolean).join(' — ') || '—')}</td>
                                <td>${escHtml(p.poNumber || '—')}</td>
                                <td>${escHtml(p.invoice || '—')}</td>
                                <td>${escHtml(p.status || '—')}${p.dispatched ? ' ' + badge('dispatched') : ''}</td>
                                <td style="text-align:right">${p.kg || 0}</td>
                                <td>${p.issues.map(i => badge(issueLabel[i] || i, i === 'no-sales-row' ? 'paid-badge' : '')).join(' ')}${(p.mismatches && p.mismatches.length) ? `<div class="cat-sub" style="margin-top:0.2rem;color:#b45309">${p.mismatches.map(m => escHtml(m)).join('<br>')}</div>` : ''}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
                <p class="cat-sub" style="margin-top:0.6rem"><strong>SKU ≠ size</strong> = a line's SKU implies a different size than its description (e.g. a 1kg SKU on a 10kg line) — sales kg is computed from the SKU, so fix the SKU on the order then it re-syncs. Indexed orders missing a sales row are fixed by <strong>Backfill Hub orders</strong>. Rows flagged <em>not indexed</em> are orphaned — recover those via the round-trip CSV.</p>`;
        });

        // ── Store mapping: assign a stable storeId to historical name-pairs ──
        document.getElementById('sd-map-load-btn')?.addEventListener('click', async () => {
            const el = document.getElementById('sd-map-results');
            el.innerHTML = '<p class="cat-sub">Loading…</p>';
            let rows = [], stores = [];
            try {
                const [rd, sd] = await Promise.all([
                    fetch('/api/sales-history?rows=true').then(r => r.json()),
                    fetch('/api/catalog/stores').then(r => r.json()),
                ]);
                rows = rd.rows || []; stores = sd || [];
            } catch (e) { el.innerHTML = `<p class="cat-sub">Could not load: ${escHtml(e.message)}</p>`; return; }

            const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const active = stores.filter(s => s.branch && !s.archived);
            const fam = s => { const n = norm(s); if (!n) return ''; if (/fruitfed|^pgg/.test(n)) return 'pgg'; if (n.includes('farmlands')) return 'farmlands'; if (n.includes('horticentre') || n.includes('hortcentre')) return 'horticentre'; return n; };
            const suggest = (customer, branch) => {
                const rb = norm(branch); if (!rb) return null;
                const rf = fam(customer) || fam(branch);
                const famOk = s => { const sf = fam(s.customer); return !sf || !rf || sf === rf; };
                return active.find(s => famOk(s) && norm(s.branch) === rb)
                    || active.find(s => { const sb = norm(s.branch); return sb && famOk(s) && (rb.includes(sb) || sb.includes(rb)); })
                    || null;
            };

            const pairs = new Map();
            for (const r of rows) {
                const k = norm(r.customer) + '|||' + norm(r.branch);
                if (!pairs.has(k)) pairs.set(k, { customer: r.customer || '', branch: r.branch || '', count: 0, storeIds: new Set() });
                const p = pairs.get(k); p.count++; if (r.storeId) p.storeIds.add(r.storeId);
            }
            const list = [...pairs.values()].sort((a, b) => b.count - a.count);
            const optionsHtml = sid => ['<option value="">— none —</option>'].concat(
                active.map(s => `<option value="${escHtml(s.id)}"${s.id === sid ? ' selected' : ''}>${escHtml([s.customer, s.branch].filter(Boolean).join(' — '))} (${escHtml(s.id)})</option>`)
            ).join('');

            el.innerHTML = `
                <div class="store-table-wrap" style="margin-top:0.5rem">
                    <table class="store-table">
                        <thead><tr><th>Customer</th><th>Branch</th><th>Rows</th><th style="width:320px">Store</th></tr></thead>
                        <tbody>
                            ${list.map(p => {
                                const cur = p.storeIds.size === 1 ? [...p.storeIds][0] : (suggest(p.customer, p.branch)?.id || '');
                                const auto = !p.storeIds.size && cur ? ' <span class="store-src" title="Auto-matched suggestion">auto</span>' : '';
                                return `<tr>
                                    <td>${escHtml(p.customer || '—')}</td>
                                    <td>${escHtml(p.branch || '—')}${auto}</td>
                                    <td>${p.count}</td>
                                    <td><select class="store-cell sd-map-sel" data-customer="${escHtml(p.customer)}" data-branch="${escHtml(p.branch)}">${optionsHtml(cur)}</select></td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="bulk-apply-bar">
                    <button class="btn-primary" id="sd-map-apply-btn">Apply mapping</button>
                    <span class="bulk-apply-hint">Writes the store link to matching rows (names untouched). Backs up first.</span>
                </div>`;

            document.getElementById('sd-map-apply-btn')?.addEventListener('click', async () => {
                const mappings = [...document.querySelectorAll('.sd-map-sel')]
                    .map(sel => ({ customer: sel.dataset.customer, branch: sel.dataset.branch, storeId: sel.value }));
                if (!confirm(`Apply store mapping to ${mappings.length} customer/branch group(s)?\n\nA backup is taken first.`)) return;
                try {
                    const res = await api('/api/sales-history', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'assign-stores', mappings }),
                    });
                    showToast(`Linked ${res.updated} row(s)${res.cleared ? `, cleared ${res.cleared}` : ''}`);
                } catch (e) { showToast('Apply failed: ' + e.message); }
            });
        });

        let lastFile = null;
        const uploadResults = document.getElementById('sd-upload-results');
        const backfillResults = document.getElementById('sd-backfill-results');
        // ── Upload (seed or round-trip, auto-detected) ──
        document.getElementById('sd-dryrun-btn').addEventListener('click', async () => {
            const file = document.getElementById('sd-file').files[0];
            if (!file) { showToast('Choose a CSV file first'); return; }
            lastFile = file;
            uploadResults.innerHTML = '<p class="bulk-loading">Parsing CSV…</p>';
            try {
                const csv = await file.text();
                const replaceHist = document.getElementById('sd-replace-hist')?.checked;
                const resp = await fetch('/api/sales-history' + (replaceHist ? '?replace=historical' : ''), {
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
            const isReplace   = s.mode === 'replace-historical';
            const backupLine = ts => `<br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(ts)}</code></span>`;
            const summaryHtml = isRoundTrip
                ? `<strong>${applied ? 'Applied' : 'Dry run'} (round-trip):</strong> ${s.csvRowsParsed} parsed · ${s.adds} new · ${s.updates} updated · ${s.unchanged} unchanged.${applied ? backupLine(s.backupTs) : ''}`
                : isReplace
                ? `<strong>${applied ? 'Applied' : 'Dry run'} (replace historical):</strong> ${s.csvRowsParsed} parsed · ${s.historicalRows} historical rebuilt · ${s.hubRowsPreserved} hub kept.${applied ? backupLine(s.backupTs) : ''}`
                : `<strong>${applied ? 'Applied' : 'Dry run'} (seed):</strong> ${s.csvRowsParsed} rows parsed.${applied ? `<br><span class="bulk-backup">Backup: <code>backup:sales_history:${escHtml(s.backupTs)}</code> · ${s.hstOrdersDeleted} HST orders wiped · ${s.hubRowsPreserved} hub rows preserved</span>` : ''}`;
            const changesPending = isRoundTrip ? (s.adds + s.updates) : isReplace ? s.historicalRows : s.csvRowsParsed;
            const applyLabel = isRoundTrip
                ? `Apply ${(s.adds + s.updates)} change${(s.adds + s.updates) === 1 ? '' : 's'}`
                : isReplace
                ? `Replace ${s.historicalRows} historical rows`
                : `Apply seed (${s.csvRowsParsed} rows)`;
            const applyHint = isRoundTrip
                ? 'Upserts by Id · missing rows left untouched · backs up first.'
                : isReplace
                ? 'Rebuilds source:historical from this file · preserves source:hub · backs up first.'
                : 'Replaces source:historical rows · preserves source:hub rows · backs up first.';
            uploadResults.innerHTML = `
            <div class="bulk-summary ${applied ? 'bulk-summary--applied' : ''}">${summaryHtml}</div>
            ${!applied && changesPending > 0 ? `
            <div class="bulk-apply-bar">
                <button class="btn-primary" id="sd-apply-btn">${applyLabel}</button>
                <span class="bulk-apply-hint">${applyHint}</span>
            </div>` : ''}`;

            document.getElementById('sd-apply-btn')?.addEventListener('click', async (e) => {
                if (!lastFile) return;
                const confirmMsg = isRoundTrip
                    ? `Apply ${s.adds + s.updates} change(s)?\n\nUpserts by Id; missing rows left alone. Backup taken first.`
                    : isReplace
                    ? `Rebuild ${s.historicalRows} historical rows from this file?\n\nReplaces ALL source:historical rows (deletions take effect). Preserves source:hub rows. Backup taken first.`
                    : `Seed ${s.csvRowsParsed} historical rows?\n\nReplaces source:historical rows. Preserves source:hub rows. Backup taken first.`;
                if (!confirm(confirmMsg)) return;
                const btn = e.currentTarget;
                btn.disabled = true; btn.textContent = 'Applying…';
                try {
                    const csv = await lastFile.text();
                    const url = '/api/sales-history?apply=true' + (isReplace ? '&replace=historical' : '');
                    const resp = await fetch(url, {
                        method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv,
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({ error: resp.statusText }));
                        throw new Error(err.error || resp.statusText);
                    }
                    renderUploadResults(await resp.json(), true);
                    showToast(isRoundTrip ? `Applied ${s.adds + s.updates} changes` : isReplace ? `Rebuilt ${s.historicalRows} historical rows` : `Seeded ${s.csvRowsParsed} rows`);
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

    // ── Payroll tab ──
    // Rates configuration and bulk CSV import/export.
    // Daily tally entry and payslip generation live in the Payslips view.
    async function renderPayrollTab(body) {
        body.innerHTML = '<div class="orders-loading">Loading payroll…</div>';

        let config = { employees: [] };
        try { config = await api('/api/payroll/config'); }
        catch (e) { showToast('Could not load config: ' + e.message); }
        const employees = (config.employees || []).filter(e => !e.archived);
        if (!employees.length) { body.innerHTML = '<p class="cat-sub">No employees configured.</p>'; return; }

        body.innerHTML = `
        <div class="cat-section">
            <h2 class="cat-title">Payroll config</h2>
            <p class="cat-sub">Rates and CSV tools. Tally entry and payslip generation are in the <a href="#payslips">Payslips</a> view.</p>

            <h3 class="bulk-table-title" style="margin-top:1.5rem">Rates</h3>
            <p class="cat-sub">NZD per unit. Applied to all payslip calculations.</p>
            <div id="payroll-rates"></div>

            <details class="payroll-csv-details" style="margin-top:1.25rem">
                <summary>Import / Export CSV</summary>
                <div class="payroll-csv-grid">
                    <div class="payroll-csv-card">
                        <div class="payroll-csv-title">Packing log</div>
                        <p class="cat-sub">Columns: Id, Date, Employee, Boxes 10kg, Boxes 1kg, Notes.</p>
                        <div class="bulk-step">
                            <a class="btn-secondary btn-sm" href="/api/payroll/packing-log?format=csv" download="packing-log.csv">Export ↓</a>
                            <input type="file" id="pack-file" accept=".csv,text/csv">
                            <button class="btn-secondary btn-sm" id="pack-dryrun-btn">Preview upload</button>
                        </div>
                        <div id="pack-results"></div>
                    </div>
                    <div class="payroll-csv-card">
                        <div class="payroll-csv-title">Timesheets</div>
                        <p class="cat-sub">Columns: Id, Date, Employee, Hours, Expenses, Notes.</p>
                        <div class="bulk-step">
                            <a class="btn-secondary btn-sm" href="/api/payroll/timesheets?format=csv" download="timesheets.csv">Export ↓</a>
                            <input type="file" id="ts-file" accept=".csv,text/csv">
                            <button class="btn-secondary btn-sm" id="ts-dryrun-btn">Preview upload</button>
                        </div>
                        <div id="ts-results"></div>
                    </div>
                </div>
            </details>
        </div>`;

        renderRates();
        wireUpload('pack', '/api/payroll/packing-log');
        wireUpload('ts',   '/api/payroll/timesheets');

        // ── Rates section ──
        function renderRates() {
            const ratesEl = document.getElementById('payroll-rates');
            ratesEl.innerHTML = employees.map(e => `
                <div class="payroll-rates-row" data-emp="${escHtml(e.id)}">
                    <span class="payroll-rates-name">${escHtml(e.name)}</span>
                    <label>$ / box dispatched
                        <input type="number" step="0.01" min="0" class="payroll-rate-input" data-field="perBoxDispatched" value="${e.rates?.perBoxDispatched ?? 0}">
                    </label>
                    <label>$ / box packed (10kg)
                        <input type="number" step="0.01" min="0" class="payroll-rate-input" data-field="perBox10kgPacked" value="${e.rates?.perBox10kgPacked ?? 0}">
                    </label>
                    <label>$ / box packed (1kg)
                        <input type="number" step="0.01" min="0" class="payroll-rate-input" data-field="perBox1kgPacked" value="${e.rates?.perBox1kgPacked ?? 0}">
                    </label>
                    <label>$ / hour
                        <input type="number" step="0.01" min="0" class="payroll-rate-input" data-field="perHour" value="${e.rates?.perHour ?? 0}">
                    </label>
                    <label>Base rate ($/month)
                        <input type="number" step="0.01" min="0" class="payroll-rate-input" data-field="baseRate" value="${e.rates?.baseRate ?? 0}">
                    </label>
                    <label>Petrol ($/month)
                        <input type="number" step="0.01" min="0" class="payroll-rate-input" data-field="petrol" value="${e.rates?.petrol ?? 0}">
                    </label>
                    <button class="btn-secondary btn-sm payroll-rates-save" data-emp="${escHtml(e.id)}">Save</button>
                </div>`).join('');
            ratesEl.querySelectorAll('.payroll-rates-save').forEach(btn => {
                btn.addEventListener('click', async (ev) => {
                    const empId = ev.currentTarget.dataset.emp;
                    const row = ratesEl.querySelector(`.payroll-rates-row[data-emp="${empId}"]`);
                    const newRates = {};
                    row.querySelectorAll('.payroll-rate-input').forEach(inp => { newRates[inp.dataset.field] = Number(inp.value) || 0; });
                    const next = employees.map(emp => emp.id === empId ? { ...emp, rates: newRates } : emp);
                    btn.disabled = true; btn.textContent = 'Saving…';
                    try {
                        await api('/api/payroll/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employees: next }) });
                        for (let i = 0; i < employees.length; i++) if (employees[i].id === empId) employees[i] = next.find(e => e.id === empId);
                        showToast('Rates saved');
                    } catch (err) { showToast('Save failed: ' + err.message); }
                    finally { btn.disabled = false; btn.textContent = 'Save'; }
                });
            });
        }

        // ── CSV import/export (kept as backup workflow) ──
        function wireUpload(prefix, endpoint) {
            let lastFile = null;
            const resultsEl = document.getElementById(`${prefix}-results`);
            document.getElementById(`${prefix}-dryrun-btn`).addEventListener('click', async () => {
                const file = document.getElementById(`${prefix}-file`).files[0];
                if (!file) { showToast('Choose a CSV file first'); return; }
                lastFile = file;
                resultsEl.innerHTML = '<p class="bulk-loading">Parsing CSV…</p>';
                try {
                    const csv = await file.text();
                    const resp = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv });
                    if (!resp.ok) { const err = await resp.json().catch(() => ({ error: resp.statusText })); throw new Error(err.error || resp.statusText); }
                    const r = await resp.json();
                    const s = r.summary;
                    resultsEl.innerHTML = `
                    <div class="bulk-summary">
                        <strong>Dry run:</strong> ${s.csvRowsParsed} parsed · ${s.adds} new · ${s.updates} updated · ${s.unchanged} unchanged.
                    </div>
                    ${(s.adds + s.updates) > 0 ? `<div class="bulk-apply-bar"><button class="btn-primary" id="${prefix}-apply-btn">Apply ${s.adds + s.updates} change${(s.adds + s.updates) === 1 ? '' : 's'}</button></div>` : ''}`;
                    document.getElementById(`${prefix}-apply-btn`)?.addEventListener('click', async (ev) => {
                        if (!confirm(`Apply ${s.adds + s.updates} change(s)? A backup is taken first.`)) return;
                        const applyBtn = ev.currentTarget;
                        applyBtn.disabled = true; applyBtn.textContent = 'Applying…';
                        try {
                            const csv2 = await lastFile.text();
                            const resp2 = await fetch(endpoint + '?apply=true', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv2 });
                            if (!resp2.ok) { const err = await resp2.json().catch(() => ({ error: resp2.statusText })); throw new Error(err.error || resp2.statusText); }
                            const ar = await resp2.json();
                            resultsEl.innerHTML = `<div class="bulk-summary bulk-summary--applied"><strong>Applied.</strong> Table size: ${ar.summary.totalRowsAfter} · backup: <code>${escHtml(ar.summary.backupTs)}</code></div>`;
                            showToast('Applied');
                        } catch (err) {
                            showToast('Apply failed: ' + err.message);
                            applyBtn.disabled = false; applyBtn.textContent = `Apply ${s.adds + s.updates} change${(s.adds + s.updates) === 1 ? '' : 's'}`;
                        }
                    });
                } catch (err) { resultsEl.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`; }
            });
        }

    }

    return { renderAdmin };
})();
