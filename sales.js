const SalesView = (() => {

    async function api(path, opts = {}) {
        const resp = await fetch(path, opts);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || resp.statusText);
        }
        return resp.json();
    }

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    function fmtKg(n) {
        const v = Math.round(n);
        if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
        if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(v);
    }

    // Historical actuals from FY25/FY26 CSV [Jan..Dec], null = no data that month
    const SALES_HISTORY = {
        2024: [null, null, null, 110, 4740, 2131, 7840, 4214, 972, 80, 80, 990],
        2025: [640, 580, 870, 2560, 2180, 5530, 6690, 8890, 1350, 50, 110, 860],
        2026: [1450, 360, 2700, null, null, null, null, null, null, null, null, null],
    };
    const MO_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Merge static history + order actuals, optionally restricting to visibleYears
    function getMergedData(orderActuals, visibleYears) {
        const data = {};
        for (const [yr, vals] of Object.entries(SALES_HISTORY)) {
            if (!visibleYears || visibleYears.includes(yr)) data[yr] = [...vals];
        }
        for (const [ym, kg] of Object.entries(orderActuals || {})) {
            const yr = ym.slice(0, 4);
            const mo = parseInt(ym.slice(5)) - 1;
            if (visibleYears && !visibleYears.includes(yr)) continue;
            if (!data[yr]) data[yr] = new Array(12).fill(null);
            if (data[yr][mo] === null) data[yr][mo] = kg;
        }
        return data;
    }

    // Chart builders accept pre-computed {yr: [12 values]} data object
    function buildSalesByMonthChart(data) {
        const years = Object.keys(data).sort();
        if (!years.length) return '<p style="color:#94a3b8;font-size:0.875rem;padding:1rem 0">No data for selected filters.</p>';
        const W = 680, H = 210;
        const pad = { l: 46, r: 12, t: 16, b: 36 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;
        const groupW = chartW / 12;
        const nY = years.length;
        const barW = Math.max(Math.floor(groupW / (nY + 1)), 5);
        const COLORS = ['#94a3b8', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];

        const allVals = Object.values(data).flat().filter(v => v !== null && v > 0);
        const maxV = Math.max(...allVals, 1);
        function yOf(v) { return (pad.t + chartH - (v / maxV) * chartH).toFixed(1); }

        const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
            const v = f * maxV, y = yOf(v);
            return `<text x="${pad.l - 4}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="#94a3b8">${fmtKg(v)}</text>
                    <line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`;
        }).join('');

        const bars = years.flatMap((yr, yi) =>
            (data[yr] || []).map((val, mo) => {
                if (!val) return '';
                const x = (pad.l + mo * groupW + (groupW - barW * nY) / 2 + yi * barW).toFixed(1);
                const bh = ((val / maxV) * chartH).toFixed(1);
                return `<rect x="${x}" y="${yOf(val)}" width="${barW - 1}" height="${bh}" fill="${COLORS[yi] || '#94a3b8'}" rx="1" opacity="0.9"/>`;
            })
        ).join('');

        const xLabels = MO_NAMES.map((m, i) =>
            `<text x="${(pad.l + (i + 0.5) * groupW).toFixed(1)}" y="${pad.t + chartH + 14}" text-anchor="middle" font-size="8.5" fill="#64748b">${m}</text>`
        ).join('');

        const legend = years.map((yr, i) =>
            `<rect x="${pad.l + i * 58}" y="${H - 11}" width="10" height="7" fill="${COLORS[i] || '#94a3b8'}" rx="1"/>
             <text x="${pad.l + i * 58 + 13}" y="${H - 4}" font-size="8.5" fill="#475569">${yr}</text>`
        ).join('');

        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">${grid}${bars}${xLabels}${legend}</svg>`;
    }

    function buildCumulativeChart(data) {
        const years = Object.keys(data).sort();
        if (!years.length) return '';
        const W = 680, H = 210;
        const pad = { l: 46, r: 12, t: 16, b: 36 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;
        const COLORS = ['#94a3b8', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];

        const cumData = {};
        for (const yr of years) {
            let run = 0;
            cumData[yr] = (data[yr] || []).map(v => { run += (v || 0); return v !== null ? run : null; });
        }

        const allVals = Object.values(cumData).flat().filter(v => v !== null);
        const maxV = Math.max(...allVals, 1);
        function xOf(mo) { return (pad.l + (mo / 11) * chartW).toFixed(1); }
        function yOf(v) { return (pad.t + chartH - (v / maxV) * chartH).toFixed(1); }

        const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
            const v = f * maxV, y = yOf(v);
            return `<text x="${pad.l - 4}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="#94a3b8">${fmtKg(v)}</text>
                    <line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`;
        }).join('');

        const lines = years.map((yr, yi) => {
            const vals = cumData[yr];
            const pts = vals.map((v, mo) => v !== null ? `${xOf(mo)},${yOf(v)}` : null).filter(Boolean).join(' ');
            return pts ? `<polyline points="${pts}" fill="none" stroke="${COLORS[yi] || '#94a3b8'}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>` : '';
        }).join('');

        const xLabels = MO_NAMES.map((m, i) =>
            `<text x="${xOf(i)}" y="${pad.t + chartH + 14}" text-anchor="middle" font-size="8.5" fill="#64748b">${m}</text>`
        ).join('');

        const legend = years.map((yr, i) =>
            `<line x1="${pad.l + i * 58}" y1="${H - 7}" x2="${pad.l + i * 58 + 16}" y2="${H - 7}" stroke="${COLORS[i] || '#94a3b8'}" stroke-width="2"/>
             <text x="${pad.l + i * 58 + 19}" y="${H - 3}" font-size="8.5" fill="#475569">${yr}</text>`
        ).join('');

        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">${grid}${lines}${xLabels}${legend}</svg>`;
    }

    function buildDataTable(data) {
        const years = Object.keys(data).sort();
        if (!years.length) return '';

        const yearTotals = years.map(yr =>
            (data[yr] || []).reduce((s, v) => s + (v || 0), 0)
        );

        const tableRows = MO_NAMES.map((m, mo) => {
            const cells = years.map(yr => {
                const v = data[yr]?.[mo];
                const display = (v !== null && v !== undefined && v > 0)
                    ? Math.round(v).toLocaleString('en-NZ')
                    : '<span style="color:#e2e8f0">—</span>';
                return `<td class="sales-tbl-num">${display}</td>`;
            }).join('');
            return `<tr><td class="sales-tbl-month">${m}</td>${cells}</tr>`;
        }).join('');

        const totalCells = yearTotals.map(t =>
            `<td class="sales-tbl-num sales-tbl-total">${Math.round(t).toLocaleString('en-NZ')}</td>`
        ).join('');

        return `
        <div class="cat-section" style="margin-bottom:1.5rem;padding-bottom:0">
            <h2 class="cat-title" style="margin-bottom:0.75rem">Annual Summary <span style="font-size:0.78rem;font-weight:400;color:#94a3b8">kg sold</span></h2>
            <div class="sales-table-wrap">
                <table class="sales-table sales-data-tbl">
                    <thead>
                        <tr>
                            <th class="sales-tbl-month">Month</th>
                            ${years.map(yr => `<th class="sales-tbl-num">${yr}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                    <tfoot>
                        <tr>
                            <td style="font-weight:700;padding:0.45rem 0.5rem;border-top:2px solid #e2e8f0">Total</td>
                            ${totalCells}
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>`;
    }

    function parseSalesCsv(csv) {
        const lines = csv.trim().split(/\r?\n/);
        if (lines.length < 2) return { headers: [], rows: [] };
        const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
        const rows = lines.slice(1).map(line => {
            const cells = [];
            let cur = '', inQ = false;
            for (const ch of line) {
                if (ch === '"') { inQ = !inQ; }
                else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
                else { cur += ch; }
            }
            cells.push(cur.trim());
            return cells;
        }).filter(r => r.some(c => c));
        return { headers, rows };
    }

    function renderConnectPanel(config) {
        const currentUrl = config?.sheetUrl || '';
        return `
        <div class="imp-connect-panel">
            <h3 class="imp-connect-title">Connect Sales Sheet</h3>
            <ol class="imp-connect-steps">
                <li>Open your sales spreadsheet in Google Sheets</li>
                <li>File → Share → <strong>Publish to web</strong></li>
                <li>Select the correct sheet tab, choose <strong>CSV</strong>, click Publish</li>
                <li>Copy the URL and paste it below</li>
            </ol>
            <div class="imp-connect-row">
                <input type="url" id="sales-sheet-url" class="imp-url-input"
                    placeholder="https://docs.google.com/spreadsheets/d/…/pub?…&output=csv"
                    value="${escHtml(currentUrl)}">
                <button class="btn-primary btn-sm" id="sales-connect-btn">Connect</button>
                ${currentUrl ? `<button class="btn-secondary btn-sm" id="sales-disconnect-btn">Disconnect</button>` : ''}
            </div>
            ${currentUrl
                ? `<div class="imp-connect-status">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="#059669"><circle cx="5" cy="5" r="5"/></svg>
                    Connected
                   </div>`
                : ''}
            <p class="imp-connect-note">The URL is stored privately and only fetched server-side — your sheet does not need to be public.</p>
        </div>`;
    }

    function wireConnectPanel(config, bodyEl) {
        document.getElementById('sales-connect-btn')?.addEventListener('click', async () => {
            const url = document.getElementById('sales-sheet-url')?.value.trim();
            if (!url || !url.startsWith('https://docs.google.com/spreadsheets/')) {
                showToast('Please paste a valid Google Sheets URL');
                return;
            }
            const btn = document.getElementById('sales-connect-btn');
            btn.disabled = true;
            btn.textContent = 'Connecting…';
            try {
                await api('/api/sales', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sheetUrl: url }),
                });
                const resp = await fetch('/api/sales/fetch');
                if (!resp.ok) throw new Error('Sheet fetch failed — check the URL or sheet permissions.');
                showToast('Sheet connected — loading data…');
                await renderBody(bodyEl);
            } catch (err) {
                showToast('Connection failed: ' + err.message);
                btn.disabled = false;
                btn.textContent = 'Connect';
            }
        });

        document.getElementById('sales-disconnect-btn')?.addEventListener('click', async () => {
            if (!confirm('Remove the connected sheet?')) return;
            await api('/api/sales', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sheetUrl: null }),
            });
            showToast('Sheet disconnected');
            await renderBody(bodyEl);
        });
    }

    function renderDataTable(headers, rows) {
        if (!headers.length) return '';
        const displayRows = rows.slice(0, 500);
        return `
        <div class="cat-section" style="padding-bottom:0;margin-top:1.5rem">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem">
                <h2 class="cat-title" style="margin:0">Sales Data</h2>
                <span style="font-size:0.8125rem;color:#64748b">${rows.length} row${rows.length !== 1 ? 's' : ''}${rows.length > 500 ? ' — showing first 500' : ''}</span>
            </div>
            <div class="sales-table-wrap">
                <table class="sales-table">
                    <thead>
                        <tr>${headers.map(h => `<th>${escHtml(h)}</th>`).join('')}</tr>
                    </thead>
                    <tbody>
                        ${displayRows.map(r =>
                            `<tr>${headers.map((_, i) => `<td>${escHtml(r[i] ?? '')}</td>`).join('')}</tr>`
                        ).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
    }

    async function renderBody(bodyEl) {
        bodyEl.innerHTML = '<div class="orders-loading">Loading…</div>';

        let allOrders = [];
        try { allOrders = (await api('/api/orders')) || []; } catch (e) { /* ok */ }

        let config = null;
        try { config = await api('/api/sales'); } catch (e) { /* ok */ }

        let headers = [], rows = [], fetchError = null;
        if (config?.sheetUrl) {
            try {
                const resp = await fetch('/api/sales/fetch');
                if (resp.ok) {
                    const csv = await resp.text();
                    ({ headers, rows } = parseSalesCsv(csv));
                } else {
                    fetchError = 'Sheet returned an error — check the URL or sheet permissions.';
                }
            } catch (e) {
                fetchError = e.message;
            }
        }

        // ── Extract filter options from orders ──
        const custSet = new Set(), branchSet = new Set(), prodSet = new Set();
        for (const o of allOrders) {
            if (o.customer?.name) custSet.add(o.customer.name);
            if (o.shipTo?.branch) branchSet.add(o.shipTo.branch);
            for (const l of (o.lines || [])) if (l.name) prodSet.add(l.name);
        }

        // ── Top Stores (unfiltered) ──
        const byStore = {};
        for (const o of allOrders) {
            const ym = (o.createdAt || '').slice(0, 7);
            if (!ym) continue;
            const kg = (o.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
            const store = o.shipTo?.branch || o.customer?.name || '—';
            if (!byStore[store]) byStore[store] = { kg: 0, orders: 0, lastOrder: '' };
            byStore[store].kg += kg;
            byStore[store].orders++;
            if ((o.createdAt || '') > byStore[store].lastOrder) byStore[store].lastOrder = o.createdAt || '';
        }
        const storeActuals = Object.entries(byStore)
            .map(([name, d]) => ({ name, ...d }))
            .sort((a, b) => b.kg - a.kg)
            .slice(0, 10);

        // ── Filter state ──
        let filterCustomer = '', filterBranch = '', filterProduct = '';
        let yearRange = 3;
        let salesChartMode = 'monthly';

        function getFilteredActuals() {
            const filtered = allOrders.filter(o => {
                if (filterCustomer && o.customer?.name !== filterCustomer) return false;
                if (filterBranch && o.shipTo?.branch !== filterBranch) return false;
                if (filterProduct && !(o.lines || []).some(l => l.name === filterProduct)) return false;
                return true;
            });

            const actuals = {};
            for (const o of filtered) {
                const ym = (o.createdAt || '').slice(0, 7);
                if (!ym) continue;
                let kg = 0;
                if (filterProduct) {
                    for (const l of (o.lines || [])) {
                        if (l.name === filterProduct) kg += Number(l.quantity) || 0;
                    }
                } else {
                    kg = (o.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
                }
                if (kg > 0) actuals[ym] = (actuals[ym] || 0) + kg;
            }
            return actuals;
        }

        function computeChartData(actuals) {
            const isFiltered = filterCustomer || filterBranch || filterProduct;

            // Determine visible years
            const allYearsSet = new Set([
                ...(!isFiltered ? Object.keys(SALES_HISTORY) : []),
                ...Object.keys(actuals).map(ym => ym.slice(0, 4)),
            ]);
            const visibleYears = [...allYearsSet].sort().slice(-yearRange);

            if (isFiltered) {
                // Orders-only data when filters are active
                const data = {};
                for (const [ym, kg] of Object.entries(actuals)) {
                    const yr = ym.slice(0, 4);
                    const mo = parseInt(ym.slice(5)) - 1;
                    if (!visibleYears.includes(yr)) continue;
                    if (!data[yr]) data[yr] = new Array(12).fill(null);
                    data[yr][mo] = (data[yr][mo] || 0) + kg;
                }
                return data;
            }
            return getMergedData(actuals, visibleYears);
        }

        function rebuildCharts() {
            const actuals = getFilteredActuals();
            const data    = computeChartData(actuals);

            const chartHtml = salesChartMode === 'cumulative'
                ? buildCumulativeChart(data)
                : buildSalesByMonthChart(data);

            const chartArea = document.getElementById('sales-chart-area');
            if (chartArea) chartArea.innerHTML = chartHtml;

            const tableArea = document.getElementById('sales-data-table');
            if (tableArea) tableArea.innerHTML = buildDataTable(data);
        }

        // ── Build filter bar HTML ──
        const makeOpts = (arr, val, allLabel) =>
            `<option value="">All ${allLabel}</option>` +
            arr.map(v => `<option value="${escHtml(v)}"${v === val ? ' selected' : ''}>${escHtml(v)}</option>`).join('');

        const filterBar = `
        <div class="sales-filter-bar">
            <select class="sales-filter-sel" id="sf-customer">
                ${makeOpts([...custSet].sort(), filterCustomer, 'Customers')}
            </select>
            <select class="sales-filter-sel" id="sf-branch">
                ${makeOpts([...branchSet].sort(), filterBranch, 'Branches')}
            </select>
            <select class="sales-filter-sel" id="sf-product">
                ${makeOpts([...prodSet].sort(), filterProduct, 'Products')}
            </select>
            <select class="sales-filter-sel" id="sf-range">
                <option value="3"${yearRange === 3 ? ' selected' : ''}>3 years</option>
                <option value="4"${yearRange === 4 ? ' selected' : ''}>4 years</option>
                <option value="5"${yearRange === 5 ? ' selected' : ''}>5 years</option>
            </select>
            <button class="btn-secondary btn-sm" id="sf-clear">Clear</button>
        </div>`;

        // ── Initial data ──
        const initActuals = getFilteredActuals();
        const initData    = computeChartData(initActuals);

        const hasData = rows.length > 0;

        const chartsPanel = `
        <div id="sales-charts-panel">
            ${filterBar}
            <div class="cat-section" style="margin-bottom:1.5rem">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Sales by Month</h2>
                        <p class="cat-sub">Historical kg by calendar year. Hub orders overlaid automatically.</p>
                    </div>
                    <div class="cat-actions">
                        <button class="imp-view-btn active" id="sales-mode-monthly">Monthly</button>
                        <button class="imp-view-btn" id="sales-mode-cumulative">Cumulative</button>
                    </div>
                </div>
                <div style="margin-top:0.75rem" id="sales-chart-area">${buildSalesByMonthChart(initData)}</div>
            </div>
            <div id="sales-data-table">${buildDataTable(initData)}</div>
            ${storeActuals.length ? `
            <div class="cat-section" style="margin-bottom:1.5rem">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Top Stores</h2>
                        <p class="cat-sub">By kg ordered, all time from Hub orders.</p>
                    </div>
                </div>
                <div class="sales-table-wrap" style="margin-top:0.5rem">
                    <table class="sales-table">
                        <thead><tr><th>#</th><th>Store / Branch</th><th style="text-align:right">kg</th><th style="text-align:right">Orders</th><th style="text-align:right">Last Order</th></tr></thead>
                        <tbody>
                            ${storeActuals.map((s, i) => `<tr>
                                <td style="color:#94a3b8;font-size:0.78rem">${i + 1}</td>
                                <td>${escHtml(s.name)}</td>
                                <td style="text-align:right;font-weight:600">${s.kg.toLocaleString('en-NZ')}</td>
                                <td style="text-align:right;color:#64748b">${s.orders}</td>
                                <td style="text-align:right;color:#94a3b8;font-size:0.8rem">${s.lastOrder ? s.lastOrder.slice(0,10) : '—'}</td>
                            </tr>`).join('')}
                        </tbody>
                    </table>
                </div>
            </div>` : ''}
        </div>`;

        const settingsPanel = `
        <div id="sales-settings-panel" style="display:none">
            <div class="cat-section" style="max-width:640px;margin-bottom:1.5rem">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Connect Sales Sheet</h2>
                        <p class="cat-sub">Publish your Google Sheet as CSV and paste the link below.</p>
                    </div>
                </div>
                ${fetchError ? `<div class="imp-connect-status imp-connect-error">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="#dc2626"><circle cx="5" cy="5" r="5"/></svg>
                    ${escHtml(fetchError)}
                </div>` : ''}
                ${renderConnectPanel(config)}
            </div>
            ${hasData ? renderDataTable(headers, rows) : ''}
            <details class="cat-section sales-webhook-details" style="margin-top:1.5rem">
                <summary class="cat-section-head" style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between">
                    <div>
                        <h2 class="cat-title" style="margin:0">Order Write-back</h2>
                        <p class="cat-sub">Configure a webhook to automatically write new orders to your sales sheet.</p>
                    </div>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </summary>
                <div style="margin-top:1rem">
                    <p style="font-size:0.875rem;color:#64748b;margin-bottom:1rem">
                        When an order is created, the Hub will POST order data to this URL.
                        Configure the receiving end (e.g.&nbsp;Zapier) to write a row to your sheet.
                    </p>
                    <div class="imp-connect-row" style="margin-bottom:0.5rem">
                        <input type="url" id="sales-webhook-url" class="imp-url-input"
                            placeholder="https://hooks.zapier.com/hooks/catch/…"
                            value="${escHtml(config?.webhookUrl || '')}">
                        <button class="btn-primary btn-sm" id="sales-webhook-save-btn">Save</button>
                    </div>
                </div>
            </details>
        </div>`;

        const tabBar = `
        <div style="display:flex;gap:0.4rem;margin-bottom:1.25rem">
            <button class="imp-view-btn active" id="sales-tab-charts">Charts</button>
            <button class="imp-view-btn" id="sales-tab-settings">Settings</button>
        </div>`;

        bodyEl.innerHTML = tabBar + chartsPanel + settingsPanel;

        // ── Tab switching ──
        document.getElementById('sales-tab-charts')?.addEventListener('click', () => {
            document.getElementById('sales-charts-panel').style.display = '';
            document.getElementById('sales-settings-panel').style.display = 'none';
            document.getElementById('sales-tab-charts').classList.add('active');
            document.getElementById('sales-tab-settings').classList.remove('active');
        });
        document.getElementById('sales-tab-settings')?.addEventListener('click', () => {
            document.getElementById('sales-charts-panel').style.display = 'none';
            document.getElementById('sales-settings-panel').style.display = '';
            document.getElementById('sales-tab-settings').classList.add('active');
            document.getElementById('sales-tab-charts').classList.remove('active');
        });

        // ── Chart mode toggle ──
        document.getElementById('sales-mode-monthly')?.addEventListener('click', () => {
            salesChartMode = 'monthly';
            document.getElementById('sales-mode-monthly')?.classList.add('active');
            document.getElementById('sales-mode-cumulative')?.classList.remove('active');
            rebuildCharts();
        });
        document.getElementById('sales-mode-cumulative')?.addEventListener('click', () => {
            salesChartMode = 'cumulative';
            document.getElementById('sales-mode-cumulative')?.classList.add('active');
            document.getElementById('sales-mode-monthly')?.classList.remove('active');
            rebuildCharts();
        });

        // ── Filters ──
        document.getElementById('sf-customer')?.addEventListener('change', e => { filterCustomer = e.target.value; rebuildCharts(); });
        document.getElementById('sf-branch')?.addEventListener('change', e => { filterBranch = e.target.value; rebuildCharts(); });
        document.getElementById('sf-product')?.addEventListener('change', e => { filterProduct = e.target.value; rebuildCharts(); });
        document.getElementById('sf-range')?.addEventListener('change', e => { yearRange = parseInt(e.target.value); rebuildCharts(); });
        document.getElementById('sf-clear')?.addEventListener('click', () => {
            filterCustomer = ''; filterBranch = ''; filterProduct = ''; yearRange = 3;
            document.getElementById('sf-customer').value = '';
            document.getElementById('sf-branch').value = '';
            document.getElementById('sf-product').value = '';
            document.getElementById('sf-range').value = '3';
            rebuildCharts();
        });

        wireConnectPanel(config, bodyEl);

        document.getElementById('sales-webhook-save-btn')?.addEventListener('click', async () => {
            const url = document.getElementById('sales-webhook-url')?.value.trim();
            const btn = document.getElementById('sales-webhook-save-btn');
            btn.disabled = true;
            btn.textContent = 'Saving…';
            try {
                await api('/api/sales', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ webhookUrl: url || null }),
                });
                showToast('Webhook URL saved');
            } catch (err) {
                showToast('Save failed: ' + err.message);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Save';
            }
        });
    }

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Sales History</h1>
                <p class="view-subtitle">Historical sales by month and year.</p>
            </div>
        </div>
        <div id="sales-body"></div>`;

        await renderBody(document.getElementById('sales-body'));
    }

    return { render };
})();
