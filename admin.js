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

    const ITEM_HEADERS  = ['Id', 'Name', 'Default Price', 'PB1 Quantity', 'PB1 Price', 'PB2 Quantity', 'PB2 Price', 'PB3 Quantity', 'PB3 Price'];
    const ITEM_EXAMPLE  = ['PT-I-10', 'Prime Vine Tie Loose 10kg', '119.00', '50', '109.00', '100', '99.00', '', ''];
    const STORE_HEADERS = ['Account ID', 'Customer', 'Branch', 'Street Address', 'City', 'Postcode', 'Phone'];
    const STORE_EXAMPLE = ['ACC001', 'Farmlands Co-operative', 'New Plymouth', '35 Hudson Road', 'New Plymouth', '4312', '06 759 0000'];

    function downloadTemplate(headers, example, filename) {
        const csv = [headers.join(','), example.join(',')].join('\n');
        downloadCsv(csv, filename);
    }

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
        const headers = ['Id', 'Name', 'Default Price', 'PB1 Quantity', 'PB1 Price', 'PB2 Quantity', 'PB2 Price', 'PB3 Quantity', 'PB3 Price'];
        const rows = items.map(i => [
            i.id || '', i.name || '', i.defaultPrice ?? '', i.pb1Quantity ?? '', i.pb1Price ?? '',
            i.pb2Quantity ?? '', i.pb2Price ?? '', i.pb3Quantity ?? '', i.pb3Price ?? '',
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

    function pbCell(qty, price) {
        if (!qty && !price) return '<td class="cat-num cat-dim">—</td>';
        return `<td class="cat-num">${qty ? qty + ' × ' : ''}$${Number(price || 0).toFixed(2)}</td>`;
    }

    function itemsTableRows(items) {
        return items.slice(0, 15).map(i => `
            <tr>
                <td class="cat-mono">${escHtml(i.id || i.sku || '')}</td>
                <td>${escHtml(i.name || i.description || '')}</td>
                <td class="cat-num">$${Number(i.defaultPrice || i.unitPrice || 0).toFixed(2)}</td>
                ${pbCell(i.pb1Quantity, i.pb1Price)}
                ${pbCell(i.pb2Quantity, i.pb2Price)}
                ${pbCell(i.pb3Quantity, i.pb3Price)}
            </tr>`).join('') +
            (items.length > 15 ? `<tr><td colspan="6" class="cat-more">…and ${items.length - 15} more</td></tr>` : '');
    }

    function storesTableRows(stores) {
        return stores.slice(0, 15).map(s => `
            <tr>
                <td class="cat-mono">${escHtml(s.accountId || '')}</td>
                <td>${escHtml(s.customer || s.name || '')}</td>
                <td>${escHtml(s.branch || '')}</td>
                <td>${escHtml(s.city || '')}</td>
                <td>${escHtml(s.postcode || '')}</td>
            </tr>`).join('') +
            (stores.length > 15 ? `<tr><td colspan="5" class="cat-more">…and ${stores.length - 15} more</td></tr>` : '');
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
                    <button class="btn-secondary btn-sm" id="items-dl-btn" ${items.length ? '' : 'disabled'}>Download current CSV</button>
                    <label class="btn-primary btn-sm cat-upload-lbl">
                        Upload CSV
                        <input type="file" id="items-file" accept=".csv" style="display:none">
                    </label>
                </div>
            </div>
            <div id="items-preview" style="display:${items.length ? '' : 'none'}">
                <table class="cat-table">
                    <thead><tr><th>ID</th><th>Name</th><th class="cat-num">Default</th><th class="cat-num">PB1</th><th class="cat-num">PB2</th><th class="cat-num">PB3</th></tr></thead>
                    <tbody id="items-tbody">${itemsTableRows(items)}</tbody>
                </table>
                <div class="cat-save-row">
                    <button class="btn-primary btn-sm" id="items-save-btn" style="display:none">Save to Hub</button>
                </div>
            </div>
            <p class="cat-format">Expected columns: <code>Id, Name, Default Price, PB1 Quantity, PB1 Price, PB2 Quantity, PB2 Price, PB3 Quantity, PB3 Price</code></p>
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

        // ── Template downloads ──
        document.getElementById('items-tpl-btn').addEventListener('click', () =>
            downloadTemplate(ITEM_HEADERS, ITEM_EXAMPLE, 'items-template.csv'));
        document.getElementById('stores-tpl-btn').addEventListener('click', () =>
            downloadTemplate(STORE_HEADERS, STORE_EXAMPLE, 'stores-template.csv'));

        // ── Current data downloads ──
        document.getElementById('items-dl-btn').addEventListener('click', () => {
            if (!items.length) return;
            downloadCsv(itemsToCsv(items), `items-${new Date().toISOString().slice(0,10)}.csv`);
        });
        document.getElementById('stores-dl-btn').addEventListener('click', () => {
            if (!stores.length) return;
            downloadCsv(storesToCsv(stores), `stores-${new Date().toISOString().slice(0,10)}.csv`);
        });

        // ── Items CSV upload ──
        document.getElementById('items-file').addEventListener('change', async e => {
            const file = e.target.files[0];
            if (!file) return;
            e.target.value = ''; // reset so same file can be re-selected
            const rows = parseCsv(await file.text());
            const parsed = rows.map(r => ({
                id:           r.id || r.sku || r.item_id || r.itemid || '',
                name:         r.name || r.description || r.product || '',
                defaultPrice: parseFloat(r.default_price || r.defaultprice || r.unit_price || r.unitprice || r.price || 0),
                pb1Quantity:  parseFloat(r.pb1_quantity || r.pb1quantity || '') || null,
                pb1Price:     parseFloat(r.pb1_price || r.pb1price || '') || null,
                pb2Quantity:  parseFloat(r.pb2_quantity || r.pb2quantity || '') || null,
                pb2Price:     parseFloat(r.pb2_price || r.pb2price || '') || null,
                pb3Quantity:  parseFloat(r.pb3_quantity || r.pb3quantity || '') || null,
                pb3Price:     parseFloat(r.pb3_price || r.pb3price || '') || null,
            })).filter(i => i.name);

            if (!parsed.length) { showToast('No valid rows — check CSV headers match: Id, Name, Default Price…'); return; }
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
                accountId:     r.account_id || r.accountid || r.id || '',
                customer:      r.customer || r.customer_name || r.company || '',
                branch:        r.branch || r.branch_name || r.store || r.name || '',
                streetAddress: r.street_address || r.streetaddress || r.address || r.street || '',
                city:          r.city || r.town || '',
                postcode:      r.postcode || r.post_code || r.zip || '',
                phone:         r.phone || r.telephone || r.tel || '',
            })).filter(s => s.customer || s.branch);

            if (!parsed.length) { showToast('No valid rows — check CSV headers match: Account ID, Customer, Branch…'); return; }
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
