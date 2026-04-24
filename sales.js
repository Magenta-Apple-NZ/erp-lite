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

    function getMergedData(orderActuals) {
        const data = {};
        for (const [yr, vals] of Object.entries(SALES_HISTORY)) data[yr] = [...vals];
        for (const [ym, kg] of Object.entries(orderActuals || {})) {
            const yr = ym.slice(0, 4);
            const mo = parseInt(ym.slice(5)) - 1;
            if (!data[yr]) data[yr] = new Array(12).fill(null);
            if (data[yr][mo] === null) data[yr][mo] = kg;
        }
        return data;
    }

    function buildSalesByMonthChart(orderActuals) {
        const data = getMergedData(orderActuals);
        const years = Object.keys(data).sort();
        const W = 680, H = 210;
        const pad = { l: 46, r: 12, t: 16, b: 36 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;
        const groupW = chartW / 12;
        const nY = years.length;
        const barW = Math.max(Math.floor(groupW / (nY + 1)), 5);
        const COLORS = ['#94a3b8', '#3b82f6', '#10b981'];

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

    function buildCumulativeChart(orderActuals) {
        const data = getMergedData(orderActuals);
        const years = Object.keys(data).sort();
        const W = 680, H = 210;
        const pad = { l: 46, r: 12, t: 16, b: 36 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;
        const COLORS = ['#94a3b8', '#3b82f6', '#10b981'];

        // Running total per year, Jan-start
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

    function wireConnectPanel(config) {
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
                await renderBody(document.getElementById('sales-body'));
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
            await renderBody(document.getElementById('sales-body'));
        });
    }

    function renderChartPlaceholders() {
        const charts = [
            {
                title: 'Sales by Customer',
                icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="12" width="4" height="9"/><rect x="10" y="7" width="4" height="14"/><rect x="17" y="3" width="4" height="18"/>
                </svg>`,
            },
            {
                title: 'Monthly Sales Trend',
                icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 17 9 11 13 15 21 7"/>
                    <polyline points="17 7 21 7 21 11"/>
                </svg>`,
            },
            {
                title: 'Product Volume',
                icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>
                </svg>`,
            },
            {
                title: 'Dispatch Summary',
                icon: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="10" width="4" height="11"/><rect x="10" y="6" width="4" height="15"/><rect x="17" y="2" width="4" height="19"/>
                    <polyline points="3 7 9 4 15 7 21 4"/>
                </svg>`,
            },
        ];

        const cards = charts.map(c => `
        <div class="sales-chart-card">
            <div class="cat-title" style="margin-bottom:0.75rem">${escHtml(c.title)}</div>
            <div class="sales-chart-placeholder">
                <div style="color:#cbd5e1;margin-bottom:0.5rem">${c.icon}</div>
                <span style="font-size:0.8125rem;color:#94a3b8">${escHtml(c.title)}</span>
            </div>
        </div>`).join('');

        return `
        <div class="sales-charts-grid">
            ${cards}
        </div>
        <p style="margin-top:0.75rem;font-size:0.8125rem;color:#94a3b8;text-align:center">
            Connect your sales Google Sheet to populate these charts.
        </p>`;
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

        let orderActuals = {}, storeActuals = [];
        try {
            const orders = await api('/api/orders');
            const byStore = {};
            for (const o of (orders || [])) {
                const ym = (o.createdAt || '').slice(0, 7);
                if (!ym) continue;
                const kg = (o.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
                if (kg > 0) orderActuals[ym] = (orderActuals[ym] || 0) + kg;
                const store = o.shipTo?.branch || o.customer?.name || '—';
                if (!byStore[store]) byStore[store] = { kg: 0, orders: 0, lastOrder: '' };
                byStore[store].kg += kg;
                byStore[store].orders++;
                if ((o.createdAt || '') > byStore[store].lastOrder) byStore[store].lastOrder = o.createdAt || '';
            }
            storeActuals = Object.entries(byStore)
                .map(([name, d]) => ({ name, ...d }))
                .sort((a, b) => b.kg - a.kg)
                .slice(0, 10);
        } catch (e) { /* ok */ }

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

        const isConnected = !!config?.sheetUrl;
        const hasData = rows.length > 0;

        let salesChartMode = 'monthly';
        const chartsPanel = `
        <div id="sales-charts-panel">
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
                <div style="margin-top:0.75rem" id="sales-chart-area">${buildSalesByMonthChart(orderActuals)}</div>
            </div>
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

        wireConnectPanel(config);

        document.getElementById('sales-mode-monthly')?.addEventListener('click', () => {
            salesChartMode = 'monthly';
            document.getElementById('sales-chart-area').innerHTML = buildSalesByMonthChart(orderActuals);
            document.getElementById('sales-mode-monthly')?.classList.add('active');
            document.getElementById('sales-mode-cumulative')?.classList.remove('active');
        });
        document.getElementById('sales-mode-cumulative')?.addEventListener('click', () => {
            salesChartMode = 'cumulative';
            document.getElementById('sales-chart-area').innerHTML = buildCumulativeChart(orderActuals);
            document.getElementById('sales-mode-cumulative')?.classList.add('active');
            document.getElementById('sales-mode-monthly')?.classList.remove('active');
        });

        document.getElementById('sales-refresh-btn')?.addEventListener('click', () => renderBody(bodyEl));

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
