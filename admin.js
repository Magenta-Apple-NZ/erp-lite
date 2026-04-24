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

    const STORE_HEADERS = ['Account ID', 'Customer', 'Branch', 'Street Address', 'City', 'Postcode', 'Phone'];
    const STORE_EXAMPLE = ['ACC001', 'Farmlands Co-operative', 'New Plymouth', '35 Hudson Road', 'New Plymouth', '4312', '06 759 0000'];

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
        const headers = ['Id', 'Name', 'Loose', 'Unit Price', '150+ kg', '500+ kg', '2000+ kg'];
        const rows = items.map(i => [
            i.id || '', i.name || '', i.isLoose ? 'TRUE' : 'FALSE',
            i.defaultPrice ?? '', i.pb1Price ?? '', i.pb2Price ?? '', i.pb3Price ?? '',
        ].map(quoteField).join(','));
        return [headers.join(','), ...rows].join('\n');
    }

    function storesToCsv(stores) {
        const headers = ['Account ID', 'Customer', 'Branch', 'Street Address', 'City', 'Postcode', 'Phone'];
        const rows = stores.map(s => [
            s.accountId || '', s.customer || '', s.branch || '',
            s.streetAddress || '', s.city || '', s.postcode || '', s.phone || '',
        ].map(quoteField).join(','));
        return [headers.join(','), ...rows].join('\n');
    }

    function storesTableRows(stores) {
        return stores.slice(0, 20).map(s => `
            <tr>
                <td class="cat-mono">${escHtml(s.accountId || '')}</td>
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
            <td class="matrix-td-center" title="Loose = 1kg units, min order 10kg, +10kg increments">
                <input type="checkbox" class="matrix-loose" ${item.isLoose ? 'checked' : ''}>
            </td>
            <td><input type="number" class="matrix-p0 matrix-cell-input matrix-price-input" value="${p(item.defaultPrice)}" placeholder="0.00" min="0" step="0.01"></td>
            <td><input type="number" class="matrix-p150 matrix-cell-input matrix-price-input" value="${p(item.pb1Price)}" placeholder="—" min="0" step="0.01"></td>
            <td><input type="number" class="matrix-p500 matrix-cell-input matrix-price-input" value="${p(item.pb2Price)}" placeholder="—" min="0" step="0.01"></td>
            <td><input type="number" class="matrix-p2000 matrix-cell-input matrix-price-input" value="${p(item.pb3Price)}" placeholder="—" min="0" step="0.01"></td>
            <td><button class="matrix-del" title="Remove row">×</button></td>
        </tr>`;
    }

    // ── Prices tab (pricing matrix) ──
    function renderPricesTab(body, items, onSave) {
        body.innerHTML = `
        <div class="cat-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Price Matrix</h2>
                    <p class="cat-sub">Prices per kg at each quantity break point. <strong>Loose</strong> = 1kg units (min order 10 kg, +10 kg steps).</p>
                </div>
                <div class="cat-actions">
                    <button class="btn-secondary btn-sm" id="matrix-add-btn">+ Add Product</button>
                    <button class="btn-secondary btn-sm" id="matrix-dl-btn" ${items.length ? '' : 'disabled'}>Download CSV</button>
                    <button class="btn-primary btn-sm" id="matrix-save-btn">Save Changes</button>
                </div>
            </div>
            <div class="matrix-wrap">
                <table class="matrix-table">
                    <thead>
                        <tr>
                            <th class="matrix-th-id">ID</th>
                            <th class="matrix-th-name">Product Name</th>
                            <th class="matrix-th-center" title="1kg units — min 10kg, +10kg steps">Loose</th>
                            <th class="matrix-th-price">&lt; 150 kg</th>
                            <th class="matrix-th-price">150+ kg</th>
                            <th class="matrix-th-price">500+ kg</th>
                            <th class="matrix-th-price">2,000+ kg</th>
                            <th style="width:32px"></th>
                        </tr>
                    </thead>
                    <tbody id="matrix-tbody">
                        ${items.map(item => matrixRow(item)).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;

        document.getElementById('matrix-add-btn').addEventListener('click', () => {
            const tbody = document.getElementById('matrix-tbody');
            tbody.insertAdjacentHTML('beforeend', matrixRow({ id: '', name: '', defaultPrice: null, pb1Price: null, pb2Price: null, pb3Price: null, isLoose: false }));
            tbody.lastElementChild.querySelector('.matrix-id').focus();
        });

        document.getElementById('matrix-dl-btn').addEventListener('click', () => {
            if (!items.length) return;
            downloadCsv(itemsToCsv(items), `prices-${new Date().toISOString().slice(0, 10)}.csv`);
        });

        document.getElementById('matrix-save-btn').addEventListener('click', async () => {
            const rows = [...document.querySelectorAll('#matrix-tbody .matrix-row')];
            const updated = rows.map(tr => ({
                id:           tr.querySelector('.matrix-id').value.trim(),
                name:         tr.querySelector('.matrix-name').value.trim(),
                isLoose:      tr.querySelector('.matrix-loose').checked,
                defaultPrice: parseFloat(tr.querySelector('.matrix-p0').value) || 0,
                pb1Quantity:  150,
                pb1Price:     parseFloat(tr.querySelector('.matrix-p150').value) || null,
                pb2Quantity:  500,
                pb2Price:     parseFloat(tr.querySelector('.matrix-p500').value) || null,
                pb3Quantity:  2000,
                pb3Price:     parseFloat(tr.querySelector('.matrix-p2000').value) || null,
            })).filter(i => i.name);

            const btn = document.getElementById('matrix-save-btn');
            btn.disabled = true; btn.textContent = 'Saving…';
            try {
                const r = await api('/api/catalog/items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: updated }),
                });
                onSave(updated);
                document.getElementById('matrix-dl-btn').disabled = false;
                showToast(`Saved ${r.count} products`);
            } catch (e) {
                showToast('Save failed: ' + e.message);
            } finally {
                btn.disabled = false; btn.textContent = 'Save Changes';
            }
        });

        document.getElementById('matrix-tbody').addEventListener('click', e => {
            if (e.target.closest('.matrix-del')) e.target.closest('.matrix-row').remove();
        });
    }

    // ── Stores tab ──
    function renderStoresTab(body, stores, onSave) {
        body.innerHTML = `
        <div class="cat-section" id="cat-stores">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Store Locations</h2>
                    <p class="cat-sub" id="stores-sub">${stores.length} store${stores.length !== 1 ? 's' : ''}</p>
                </div>
                <div class="cat-actions">
                    <button class="btn-secondary btn-sm" id="stores-tpl-btn">Download template</button>
                    <button class="btn-secondary btn-sm" id="stores-dl-btn" ${stores.length ? '' : 'disabled'}>Download current CSV</button>
                    <label class="btn-primary btn-sm cat-upload-lbl">
                        Upload CSV
                        <input type="file" id="stores-file" accept=".csv" style="display:none">
                    </label>
                </div>
            </div>
            <div id="stores-preview" style="display:${stores.length ? '' : 'none'}">
                <table class="cat-table">
                    <thead><tr><th>Account ID</th><th>Customer</th><th>Branch</th><th>City</th><th>Postcode</th></tr></thead>
                    <tbody id="stores-tbody">${storesTableRows(stores)}</tbody>
                </table>
                <div class="cat-save-row">
                    <button class="btn-primary btn-sm" id="stores-save-btn" style="display:none">Save to Hub</button>
                </div>
            </div>
            <p class="cat-format">Expected columns: <code>Account ID, Customer, Branch, Street Address, City, Postcode, Phone</code></p>
        </div>`;

        document.getElementById('stores-tpl-btn').addEventListener('click', () => {
            const csv = [STORE_HEADERS.join(','), STORE_EXAMPLE.join(',')].join('\n');
            downloadCsv(csv, 'stores-template.csv');
        });
        document.getElementById('stores-dl-btn').addEventListener('click', () => {
            if (!stores.length) return;
            downloadCsv(storesToCsv(stores), `stores-${new Date().toISOString().slice(0, 10)}.csv`);
        });

        document.getElementById('stores-file').addEventListener('change', async e => {
            const file = e.target.files[0];
            if (!file) return;
            e.target.value = '';
            const rows = parseCsv(await file.text());
            const parsed = rows.map(r => ({
                accountId:     r.account_id || r.accountid || r.id || '',
                customer:      r.customer || r.customer_name || r.company || '',
                branch:        r.branch || r.branch_name || r.store || r.name || '',
                streetAddress: r.street_address || r.streetaddress || r.address || r.street || '',
                city:          r.city || r.town || '',
                postcode:      r.postcode || r.post_code || r.zip || '',
                phone:         r.phone || r.telephone || r.tel || '',
            })).filter(s => s.customer || s.branch);

            if (!parsed.length) { showToast('No valid rows — check headers match: Account ID, Customer, Branch…'); return; }
            document.getElementById('stores-tbody').innerHTML = storesTableRows(parsed);
            document.getElementById('stores-preview').style.display = '';
            const existing = stores.length;
            document.getElementById('stores-sub').textContent = existing
                ? `${parsed.length} stores ready to save — will replace ${existing} existing`
                : `${parsed.length} stores ready to save`;
            const btn = document.getElementById('stores-save-btn');
            btn.style.display = '';
            btn._data = parsed;
        });

        document.getElementById('stores-save-btn').addEventListener('click', async function () {
            this.disabled = true; this.textContent = 'Saving…';
            try {
                const r = await api('/api/catalog/stores', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ stores: this._data }),
                });
                onSave(this._data);
                showToast(`Saved ${r.count} stores`);
                document.getElementById('stores-sub').textContent = `${r.count} store${r.count !== 1 ? 's' : ''}`;
                this.style.display = 'none';
            } catch (e) {
                showToast('Save failed: ' + e.message);
                this.disabled = false; this.textContent = 'Save to Hub';
            }
        });
    }

    async function renderAdmin(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Catalogue</h1>
                <p class="view-subtitle">Manage product pricing and store locations.</p>
            </div>
        </div>
        <div class="imp-tabs">
            <button class="imp-view-btn active" id="cat-tab-prices">Prices</button>
            <button class="imp-view-btn" id="cat-tab-stores">Stores</button>
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
        let activeTab = 'prices';

        function switchTab(tab) {
            activeTab = tab;
            document.getElementById('cat-tab-prices').classList.toggle('active', tab === 'prices');
            document.getElementById('cat-tab-stores').classList.toggle('active', tab === 'stores');
            if (tab === 'prices') renderPricesTab(body, items, updated => { items = updated; });
            else renderStoresTab(body, stores, updated => { stores = updated; });
        }

        document.getElementById('cat-tab-prices').addEventListener('click', () => switchTab('prices'));
        document.getElementById('cat-tab-stores').addEventListener('click', () => switchTab('stores'));

        switchTab('prices');
    }

    return { renderAdmin };
})();
