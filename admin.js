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

    function renderPricesTab(body, items) {
        body.innerHTML = `
        <div class="cat-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Price Matrix</h2>
                    <p class="cat-sub">Read-only. Source: <a href="${ITEMS_SHEET_VIEW_URL}" target="_blank" rel="noopener">Pricing sheet ↗</a> (cached ~60s).</p>
                </div>
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
    }

    // ── Stores tab (read-only, sourced from published Google Sheet) ──
    function renderStoresTab(body, stores) {
        body.innerHTML = `
        <div class="cat-section" id="cat-stores">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Store Locations</h2>
                    <p class="cat-sub">Read-only. Source: <a href="${STORES_SHEET_VIEW_URL}" target="_blank" rel="noopener">Stores sheet ↗</a> (cached ~60s). ${stores.length} store${stores.length !== 1 ? 's' : ''}.</p>
                </div>
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
    }

    async function renderAdmin(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Catalogue</h1>
                <p class="view-subtitle">Manage product pricing, store locations, and printers.</p>
            </div>
        </div>
        <div class="imp-tabs">
            <button class="imp-view-btn active" id="cat-tab-prices">Prices</button>
            <button class="imp-view-btn" id="cat-tab-stores">Stores</button>
            <button class="imp-view-btn" id="cat-tab-printers">Printers</button>
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
            if (tab === 'prices')        renderPricesTab(body, items, updated => { items = updated; });
            else if (tab === 'stores')   renderStoresTab(body, stores, updated => { stores = updated; });
            else if (tab === 'printers') renderPrintersTab(body);
        }

        document.getElementById('cat-tab-prices').addEventListener('click',   () => switchTab('prices'));
        document.getElementById('cat-tab-stores').addEventListener('click',   () => switchTab('stores'));
        document.getElementById('cat-tab-printers').addEventListener('click', () => switchTab('printers'));

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

    return { renderAdmin };
})();
