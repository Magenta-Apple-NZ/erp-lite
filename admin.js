// ── Admin / Catalogue module ──
// Handles #admin view — CSV upload for product catalogue and store locations

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

    // CSV parser — handles quoted fields and Excel BOM
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

    const ITEM_EXAMPLE  = ['PT-I-10', 'Prime Vine Tie Loose 10kg', '119.00', '200'];
    const STORE_EXAMPLE = ['Farmlands Retail - New Plymouth', '35 Hudson Road', 'Bell Block', 'New Plymouth', '4312'];

    function downloadTemplate(headers, example, filename) {
        const csv = [headers.join(','), example.join(',')].join('\n');
        const a = document.createElement('a');
        a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    function itemsTableRows(items) {
        return items.slice(0, 15).map(i => `
            <tr>
                <td>${escHtml(i.sku)}</td>
                <td>${escHtml(i.description)}</td>
                <td class="cat-num">$${Number(i.unitPrice || 0).toFixed(2)}</td>
                <td class="cat-num">${escHtml(i.accountCode || '200')}</td>
            </tr>`).join('') +
            (items.length > 15 ? `<tr><td colspan="4" class="cat-more">…and ${items.length - 15} more</td></tr>` : '');
    }

    function storesTableRows(stores) {
        return stores.slice(0, 15).map(s => `
            <tr>
                <td>${escHtml(s.name)}</td>
                <td>${escHtml([s.addressLine1, s.addressLine2].filter(Boolean).join(', '))}</td>
                <td>${escHtml(s.city)}</td>
                <td>${escHtml(s.postcode)}</td>
            </tr>`).join('') +
            (stores.length > 15 ? `<tr><td colspan="4" class="cat-more">…and ${stores.length - 15} more</td></tr>` : '');
    }

    async function renderAdmin(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Catalogue</h1>
                <p class="view-subtitle">Upload CSV files to update product items and store locations.</p>
            </div>
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
        body.innerHTML = `

        <!-- ── Product Catalogue ── -->
        <div class="cat-section" id="cat-items">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Product Catalogue</h2>
                    <p class="cat-sub" id="items-sub">${items.length} item${items.length !== 1 ? 's' : ''}</p>
                </div>
                <div class="cat-actions">
                    <button class="btn-secondary btn-sm" id="items-tpl-btn">Download template</button>
                    <label class="btn-primary btn-sm cat-upload-lbl">
                        Upload CSV
                        <input type="file" id="items-file" accept=".csv" style="display:none">
                    </label>
                </div>
            </div>
            <div id="items-preview" style="display:${items.length ? '' : 'none'}">
                <table class="cat-table">
                    <thead><tr><th>SKU</th><th>Description</th><th class="cat-num">Unit Price</th><th class="cat-num">Account</th></tr></thead>
                    <tbody id="items-tbody">${itemsTableRows(items)}</tbody>
                </table>
                <div class="cat-save-row">
                    <button class="btn-primary btn-sm" id="items-save-btn" style="display:none">Save to Hub</button>
                </div>
            </div>
            <p class="cat-format">Expected columns: <code>SKU, Description, UnitPrice, AccountCode</code></p>
        </div>

        <!-- ── Store Locations ── -->
        <div class="cat-section" id="cat-stores">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Store Locations</h2>
                    <p class="cat-sub" id="stores-sub">${stores.length} store${stores.length !== 1 ? 's' : ''}</p>
                </div>
                <div class="cat-actions">
                    <button class="btn-secondary btn-sm" id="stores-tpl-btn">Download template</button>
                    <label class="btn-primary btn-sm cat-upload-lbl">
                        Upload CSV
                        <input type="file" id="stores-file" accept=".csv" style="display:none">
                    </label>
                </div>
            </div>
            <div id="stores-preview" style="display:${stores.length ? '' : 'none'}">
                <table class="cat-table">
                    <thead><tr><th>Name</th><th>Address</th><th>City</th><th>Postcode</th></tr></thead>
                    <tbody id="stores-tbody">${storesTableRows(stores)}</tbody>
                </table>
                <div class="cat-save-row">
                    <button class="btn-primary btn-sm" id="stores-save-btn" style="display:none">Save to Hub</button>
                </div>
            </div>
            <p class="cat-format">Expected columns: <code>Name, AddressLine1, AddressLine2, City, Postcode</code></p>
        </div>`;

        // ── Template downloads ──
        document.getElementById('items-tpl-btn').addEventListener('click', () =>
            downloadTemplate(['SKU', 'Description', 'UnitPrice', 'AccountCode'], ITEM_EXAMPLE, 'items-template.csv'));
        document.getElementById('stores-tpl-btn').addEventListener('click', () =>
            downloadTemplate(['Name', 'AddressLine1', 'AddressLine2', 'City', 'Postcode'], STORE_EXAMPLE, 'stores-template.csv'));

        // ── Items CSV upload ──
        document.getElementById('items-file').addEventListener('change', async e => {
            const file = e.target.files[0];
            if (!file) return;
            e.target.value = ''; // reset so same file can be re-selected
            const rows = parseCsv(await file.text());
            const parsed = rows.map(r => ({
                sku:         r.sku || r.item_code || r.itemcode || r.code || '',
                description: r.description || r.name || r.product || '',
                unitPrice:   parseFloat(r.unitprice || r.unit_price || r.price || 0),
                accountCode: r.accountcode || r.account_code || r.account || '200',
            })).filter(i => i.description);

            if (!parsed.length) { showToast('No valid rows — check CSV headers match: SKU, Description, UnitPrice, AccountCode'); return; }
            document.getElementById('items-tbody').innerHTML = itemsTableRows(parsed);
            document.getElementById('items-preview').style.display = '';
            const existing = items.length;
            document.getElementById('items-sub').textContent = existing
                ? `${parsed.length} items ready to save — will replace ${existing} existing`
                : `${parsed.length} items ready to save`;
            const btn = document.getElementById('items-save-btn');
            btn.style.display = '';
            btn._data = parsed;
        });

        document.getElementById('items-save-btn').addEventListener('click', async function () {
            this.disabled = true; this.textContent = 'Saving…';
            try {
                const r = await api('/api/catalog/items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: this._data }),
                });
                items = this._data; // keep local copy current
                showToast(`Saved ${r.count} items`);
                document.getElementById('items-sub').textContent = `${r.count} item${r.count !== 1 ? 's' : ''}`;
                this.style.display = 'none';
            } catch (e) {
                showToast('Save failed: ' + e.message);
                this.disabled = false; this.textContent = 'Save to Hub';
            }
        });

        // ── Stores CSV upload ──
        document.getElementById('stores-file').addEventListener('change', async e => {
            const file = e.target.files[0];
            if (!file) return;
            e.target.value = ''; // reset so same file can be re-selected
            const rows = parseCsv(await file.text());
            const parsed = rows.map(r => ({
                name:         r.name || r.store_name || r.storename || r.store || '',
                addressLine1: r.addressline1 || r.address_line1 || r.address1 || r.address || r.street || '',
                addressLine2: r.addressline2 || r.address_line2 || r.address2 || r.suburb || '',
                city:         r.city || r.town || '',
                postcode:     r.postcode || r.post_code || r.zip || '',
            })).filter(s => s.name);

            if (!parsed.length) { showToast('No valid rows — check CSV headers match: Name, AddressLine1, AddressLine2, City, Postcode'); return; }
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
                stores = this._data; // keep local copy current
                showToast(`Saved ${r.count} stores`);
                document.getElementById('stores-sub').textContent = `${r.count} store${r.count !== 1 ? 's' : ''}`;
                this.style.display = 'none';
            } catch (e) {
                showToast('Save failed: ' + e.message);
                this.disabled = false; this.textContent = 'Save to Hub';
            }
        });
    }

    return { renderAdmin };
})();
