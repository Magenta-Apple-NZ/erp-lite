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

        const connectSection = `
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
        </div>`;

        const chartsSection = `
        <div class="cat-section" style="margin-bottom:1.5rem">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Charts</h2>
                    <p class="cat-sub">Visual summaries of your sales data.</p>
                </div>
                ${hasData ? `<div class="cat-actions">
                    <button class="btn-secondary btn-sm" id="sales-refresh-btn">↻ Refresh</button>
                </div>` : ''}
            </div>
            ${hasData
                ? renderChartPlaceholders()
                : `<p class="wh-empty">Connect your sales Google Sheet to populate these charts.</p>`}
        </div>`;

        const webhookSection = `
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
        </details>`;

        bodyEl.innerHTML = connectSection + chartsSection + (hasData ? renderDataTable(headers, rows) : '') + webhookSection;

        wireConnectPanel(config);

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
                <p class="view-subtitle">Track sales data from your Google Sheet.</p>
            </div>
        </div>
        <div id="sales-body"></div>`;

        await renderBody(document.getElementById('sales-body'));
    }

    return { render };
})();
