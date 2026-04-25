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

    // Background prefetch cache — populated on dashboard load, consumed once on first render
    let _prefetchP = null;

    function prefetch() {
        if (_prefetchP) return;
        _prefetchP = (async () => {
            let allOrders = [], config = null, headers = [], rows = [], fetchError = null;
            try {
                [allOrders, config] = await Promise.all([
                    fetch('/api/orders').then(r => r.ok ? r.json() : []).catch(() => []),
                    fetch('/api/sales').then(r => r.ok ? r.json() : null).catch(() => null),
                ]);
                if (config?.sheetUrl) {
                    try {
                        const resp = await fetch('/api/sales/fetch');
                        if (resp.ok) {
                            const csv = await resp.text();
                            ({ headers, rows } = parseSalesCsv(csv));
                        } else {
                            fetchError = 'Sheet returned an error — check the URL or sheet permissions.';
                        }
                    } catch (e) { fetchError = e.message; }
                }
            } catch (e) { /* prefetch optional */ }
            return { allOrders: allOrders || [], config, headers, rows, fetchError };
        })();
    }

    // Merge history + order actuals, optionally restricting to visibleYears
    function getMergedData(orderActuals, visibleYears, historyData = SALES_HISTORY) {
        const data = {};
        for (const [yr, vals] of Object.entries(historyData)) {
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

    // Normalise a raw date string to YYYY-MM (returns '' if unrecognised)
    function parseDateToYm(rawDate) {
        const s = rawDate.trim();
        if (!s) return '';
        const MO_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        // YYYY-MM-DD or YYYY-MM (ISO)
        if (s.match(/^20\d\d-\d\d/)) return s.slice(0, 7);
        // DD/MM/YYYY or D/M/YYYY (NZ/AU)
        const dmy4 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (dmy4) return `${dmy4[3]}-${dmy4[2].padStart(2, '0')}`;
        // DD/MM/YY (2-digit year, NZ)
        const dmy2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
        if (dmy2) return `20${dmy2[3]}-${dmy2[2].padStart(2, '0')}`;
        // MM/YYYY or M/YYYY
        const my = s.match(/^(\d{1,2})\/(\d{4})$/);
        if (my) return `${my[2]}-${my[1].padStart(2, '0')}`;
        // YYYY/MM
        const ym = s.match(/^(20\d\d)\/(\d{1,2})$/);
        if (ym) return `${ym[1]}-${ym[2].padStart(2, '0')}`;
        // "Apr 2025", "April 2025", "Apr-2025", "Apr-25"
        const moYr = s.match(/^([a-zA-Z]{3,9})[.\s\-,]+(\d{2,4})$/);
        if (moYr) {
            const mi = MO_ABBR.indexOf(moYr[1].toLowerCase().slice(0, 3));
            if (mi >= 0) {
                const yr = moYr[2].length === 2 ? '20' + moYr[2] : moYr[2];
                return `${yr}-${String(mi + 1).padStart(2, '0')}`;
            }
        }
        // "2025 Apr" or "2025-Apr"
        const yrMo = s.match(/^(20\d\d)[.\s\-]+([a-zA-Z]{3,9})$/);
        if (yrMo) {
            const mi = MO_ABBR.indexOf(yrMo[2].toLowerCase().slice(0, 3));
            if (mi >= 0) return `${yrMo[1]}-${String(mi + 1).padStart(2, '0')}`;
        }
        return '';
    }

    // Maps volume/kg column indices to clean product labels using the original (un-normalised) header text.
    // e.g. "Prime Tie Bundles Volume" → { idx: 8, label: "Prime Tie Bundles" }
    function labelKgCols(origHeaders, normHeaders) {
        const exact = [], partial = [];
        normHeaders.forEach((c, i) => {
            if (c === 'kg' || c === 'qty_kg' || c === 'quantity_kg' || c === 'total_kg' ||
                c === 'net_kg' || c === 'gross_kg' || c === 'weight' || c === 'volume' ||
                c === 'qty' || c === 'quantity' || c === 'units' || c === 'sold' ||
                c === 'amount' || c === 'ordered') {
                exact.push(i);
            } else if (c.includes('volume') || c.includes('kg') || c.includes('kilo') ||
                       c.includes('weight') || c.includes('quantity')) {
                partial.push(i);
            }
        });
        const idxs = exact.length ? exact : partial;
        return idxs.map(i => {
            let label = origHeaders[i]
                .replace(/\b(volumes?|kilo(gram)?s?|weights?|quantit(y|ies)|qty|units?|sold|amounts?|kg)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim() || origHeaders[i].trim();
            return { idx: i, label };
        });
    }

    // Returns ALL column indices that look like a kg/volume/quantity field (for sumKgCols compatibility).
    function findKgCols(h) {
        return labelKgCols(h, h).map(x => x.idx);
    }

    function sumKgCols(row, idxs) {
        return idxs.reduce((sum, i) => {
            const v = parseFloat(String(row[i] || '').replace(/[,$\s]/g, ''));
            return sum + (isNaN(v) ? 0 : v);
        }, 0);
    }

    // Prefer an actual date column over a month-name column
    function findDateCol(h) {
        const specific = h.findIndex(c =>
            c === 'date' || c === 'order_date' || c === 'invoice_date' ||
            c === 'delivery_date' || c === 'dispatch_date' || c === 'ship_date'
        );
        if (specific >= 0) return specific;
        const period = h.findIndex(c => c === 'year_month' || c === 'period');
        if (period >= 0) return period;
        // month-name column — only useful when paired with a year column (handled below)
        const month = h.findIndex(c => c === 'month' || c === 'created' || c === 'shipped');
        if (month >= 0) return month;
        return h.findIndex(c => c.includes('date') || c.includes('period'));
    }

    // When the sheet has separate Month (name) + Year columns, combine them into YYYY-MM
    function parseDateFromMonthYear(monthVal, yearVal) {
        const MO = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        const month = String(monthVal || '').toLowerCase().trim();
        const year  = String(yearVal  || '').trim();
        if (!year.match(/^20\d\d$/)) return '';
        const mi = MO.findIndex((abbr, i) =>
            month === abbr ||
            month === ['january','february','march','april','may','june','july','august','september','october','november','december'][i] ||
            month.startsWith(abbr)
        );
        return mi >= 0 ? `${year}-${String(mi + 1).padStart(2, '0')}` : '';
    }

    // Try to extract { total: {year: [12]}, products: {name: {year: [12]}} | null } from a connected Google Sheet.
    // products is non-null when multiple named volume columns are detected (e.g. per-product breakdown).
    function extractMonthlyFromSheet(headers, rows) {
        if (!headers.length || !rows.length) return null;
        const h = headers.map(s => s.toLowerCase().trim().replace(/[\s\-\/]+/g, '_'));

        // Format A: wide table with Year column + month columns (Jan, February, jan, etc.)
        const yearIdx = h.findIndex(c => c === 'year' || c === 'yr' || c === 'financial_year' || c === 'fy');
        const MO_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
        const MO_FULL = ['january','february','march','april','may','june','july','august','september','october','november','december'];
        const monthIdxs = MO_ABBR.map((abbr, i) =>
            h.findIndex(c => c === abbr || c === MO_FULL[i] || c.startsWith(abbr + '_') || c.startsWith(abbr + '-'))
        );

        if (yearIdx >= 0 && monthIdxs.filter(i => i >= 0).length >= 6) {
            const result = {};
            for (const row of rows) {
                const yr = String(row[yearIdx] || '').trim().replace(/^fy ?/i, '');
                if (!yr.match(/^20\d\d$/)) continue;
                result[yr] = monthIdxs.map(mi => {
                    if (mi < 0) return null;
                    const v = parseFloat(String(row[mi] || '').replace(/[,$\s]/g, ''));
                    return isNaN(v) ? null : v;
                });
            }
            return Object.keys(result).length ? { total: result, products: null } : null;
        }

        // Format B: long format — date column + one or more named volume/kg columns
        const kgCols  = labelKgCols(headers, h);
        const dateIdx = findDateCol(h);

        if (kgCols.length > 0) {
            const byYmTotal = {};
            const byYmProduct = {};
            for (const { label } of kgCols) byYmProduct[label] = {};

            function processRow(row, ym) {
                for (const { idx, label } of kgCols) {
                    const v = parseFloat(String(row[idx] || '').replace(/[,$\s]/g, ''));
                    const kg = isNaN(v) ? 0 : v;
                    if (kg <= 0) continue;
                    byYmTotal[ym] = (byYmTotal[ym] || 0) + kg;
                    byYmProduct[label][ym] = (byYmProduct[label][ym] || 0) + kg;
                }
            }

            // Try Date column first
            if (dateIdx >= 0) {
                for (const row of rows) {
                    const ym = parseDateToYm(String(row[dateIdx] || ''));
                    if (ym) processRow(row, ym);
                }
            }

            // Fallback: Month-name + Year columns (e.g. "April" + "2025")
            if (!Object.keys(byYmTotal).length) {
                const monthNameIdx = h.findIndex(c => c === 'month');
                const yearNumIdx   = h.findIndex(c => c === 'year' || c === 'yr');
                if (monthNameIdx >= 0 && yearNumIdx >= 0) {
                    for (const row of rows) {
                        const ym = parseDateFromMonthYear(row[monthNameIdx], row[yearNumIdx]);
                        if (ym) processRow(row, ym);
                    }
                }
            }

            if (!Object.keys(byYmTotal).length) return null;

            function ymMapToYearly(byYm) {
                const result = {};
                for (const [ym, kg] of Object.entries(byYm)) {
                    const yr = ym.slice(0, 4);
                    const mo = parseInt(ym.slice(5)) - 1;
                    if (!result[yr]) result[yr] = new Array(12).fill(null);
                    result[yr][mo] = (result[yr][mo] || 0) + kg;
                }
                return result;
            }

            const total = ymMapToYearly(byYmTotal);
            const multiProduct = kgCols.length > 1;
            const products = multiProduct
                ? Object.fromEntries(
                    Object.entries(byYmProduct)
                        .filter(([, byYm]) => Object.keys(byYm).length > 0)
                        .map(([label, byYm]) => [label, ymMapToYearly(byYm)])
                  )
                : null;

            return { total, products };
        }
        return null;
    }

    // Extract per-customer rows from sheet for filter support (Format B long-form sheets only).
    // Each row carries a product label when multiple volume columns exist; null otherwise.
    function extractCustomerRowsFromSheet(headers, rows) {
        if (!headers.length || !rows.length) return null;
        const h = headers.map(s => s.toLowerCase().trim().replace(/[\s\-\/]+/g, '_'));

        const custIdx = h.findIndex(c =>
            c === 'customer' || c === 'client' || c === 'account' ||
            c === 'customer_name' || c === 'store' || c === 'branch' ||
            c === 'company' || c === 'organisation' || c === 'organization' ||
            c.includes('customer') || c.includes('client') || c.includes('store') || c.includes('account')
        );
        const dateIdx    = findDateCol(h);
        const kgCols     = labelKgCols(headers, h);

        if (custIdx < 0 || kgCols.length === 0) return null;

        const monthNameIdx = dateIdx < 0 ? h.findIndex(c => c === 'month') : -1;
        const yearNumIdx   = dateIdx < 0 ? h.findIndex(c => c === 'year' || c === 'yr') : -1;
        const multiProduct = kgCols.length > 1;

        const result = [];
        for (const row of rows) {
            const customer = String(row[custIdx] || '').trim();
            const ym = dateIdx >= 0
                ? parseDateToYm(String(row[dateIdx] || ''))
                : parseDateFromMonthYear(row[monthNameIdx], row[yearNumIdx]);
            if (!customer || !ym) continue;
            for (const { idx, label } of kgCols) {
                const v = parseFloat(String(row[idx] || '').replace(/[,$\s]/g, ''));
                const kg = isNaN(v) ? 0 : v;
                if (kg <= 0) continue;
                result.push({ customer, product: multiProduct ? label : null, ym, kg });
            }
        }
        return result.length ? result : null;
    }

    // Chart builders accept pre-computed {yr: [12 values]} data object
    const CHART_COLORS = ['#94a3b8', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];

    function buildSalesByMonthChart(data) {
        const years = Object.keys(data).sort();
        if (!years.length) return '<p style="color:#94a3b8;font-size:0.875rem;padding:1rem 0">No data for selected filters.</p>';
        const id = 'monthly-sales-chart';
        window._chartQ[id] = {
            type: 'bar',
            data: {
                labels: MO_NAMES,
                datasets: years.map((yr, yi) => ({
                    label: yr,
                    data: (data[yr] || new Array(12).fill(null)).map(v => v ?? null),
                    backgroundColor: CHART_COLORS[yi] || '#94a3b8',
                    borderRadius: 2,
                    borderSkipped: false,
                })),
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
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
        return `<div style="position:relative;height:210px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
    }

    function buildCumulativeChart(data) {
        const years = Object.keys(data).sort();
        if (!years.length) return '';
        const id = 'cumulative-chart';
        const cumData = {};
        for (const yr of years) {
            let run = 0;
            cumData[yr] = (data[yr] || []).map(v => { run += (v || 0); return v !== null ? run : null; });
        }
        window._chartQ[id] = {
            type: 'line',
            data: {
                labels: MO_NAMES,
                datasets: years.map((yr, yi) => ({
                    label: yr,
                    data: cumData[yr],
                    borderColor: CHART_COLORS[yi] || '#94a3b8',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 3.5,
                    pointHoverRadius: 6,
                    pointBackgroundColor: CHART_COLORS[yi] || '#94a3b8',
                    pointBorderColor: 'white',
                    pointBorderWidth: 1.5,
                    fill: false,
                    tension: 0.3,
                    spanGaps: false,
                })),
            },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { font: { size: 11 }, boxWidth: 16, padding: 8 } },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString('en-NZ')} kg` } },
                },
                scales: {
                    x: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#64748b' } },
                    y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', callback: v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } },
                },
            },
        };
        return `<div style="position:relative;height:210px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
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

        let allOrders = [], config = null, headers = [], rows = [], fetchError = null;

        if (_prefetchP) {
            try { ({ allOrders, config, headers, rows, fetchError } = await _prefetchP); } catch (e) {}
            _prefetchP = null; // consume once — next visit fetches fresh
        } else {
            try { allOrders = (await api('/api/orders')) || []; } catch (e) { /* ok */ }
            try { config = await api('/api/sales'); } catch (e) { /* ok */ }
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
        }

        // ── Derive history from sheet CSV (replaces hardcoded SALES_HISTORY when possible) ──
        const sheetHistory = extractMonthlyFromSheet(headers, rows);
        const sheetCustomerRows = extractCustomerRowsFromSheet(headers, rows);
        const effectiveHistory = sheetHistory?.total || SALES_HISTORY;
        const sheetProducts = sheetHistory?.products || null; // { productName: {yr: [12]} } | null

        // ── Extract filter options from orders AND sheet (so historical customers appear) ──
        const custSet = new Set(), branchSet = new Set(), prodSet = new Set();
        for (const o of allOrders) {
            if (o.customer?.name) custSet.add(o.customer.name);
            if (o.shipTo?.branch) branchSet.add(o.shipTo.branch);
            for (const l of (o.lines || [])) if (l.name) prodSet.add(l.name);
        }
        if (sheetCustomerRows) {
            for (const r of sheetCustomerRows) if (r.customer) custSet.add(r.customer);
        }
        if (sheetProducts) {
            for (const name of Object.keys(sheetProducts)) prodSet.add(name);
        }

        // ── Top Stores (unfiltered) + LY-to-date ──
        const today = new Date();
        const curYr  = today.getFullYear().toString();
        const prevYr = (today.getFullYear() - 1).toString();
        const todayMd = (today.getMonth() + 1).toString().padStart(2, '0') + '-' + today.getDate().toString().padStart(2, '0');
        const cutCur  = curYr  + '-' + todayMd;
        const cutPrev = prevYr + '-' + todayMd;

        const byStore = {};
        for (const o of allOrders) {
            const created = o.createdAt || '';
            if (!created) continue;
            const kg = (o.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
            const store = o.shipTo?.branch || o.customer?.name || '—';
            if (!byStore[store]) byStore[store] = { kg: 0, orders: 0, lastOrder: '', curYtd: 0, prevYtd: 0 };
            byStore[store].kg += kg;
            byStore[store].orders++;
            if (created > byStore[store].lastOrder) byStore[store].lastOrder = created;
            const d10 = created.slice(0, 10);
            if (created.startsWith(curYr)  && d10 <= cutCur)  byStore[store].curYtd  += kg;
            if (created.startsWith(prevYr) && d10 <= cutPrev) byStore[store].prevYtd += kg;
        }
        const storeActuals = Object.entries(byStore)
            .map(([name, d]) => ({ name, ...d }))
            .sort((a, b) => b.kg - a.kg)
            .slice(0, 10);

        // ── Available years (union of sheet history + order years), sorted ascending ──
        const orderYears = allOrders.map(o => (o.createdAt || '').slice(0, 4)).filter(y => /^20\d\d$/.test(y));
        const allAvailableYears = [...new Set([...Object.keys(effectiveHistory), ...orderYears])].sort();
        const defaultYears = new Set(allAvailableYears.slice(-3)); // latest 3 by default

        // ── Filter state ──
        let filterCustomer = '', filterBranch = '', filterProduct = '';
        let selectedYears = new Set(defaultYears);

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

            // Include filtered historical sheet rows (customer-filterable long-form sheets only)
            if (sheetCustomerRows) {
                for (const r of sheetCustomerRows) {
                    if (filterCustomer && r.customer !== filterCustomer) continue;
                    if (filterProduct && r.product !== filterProduct) continue;
                    actuals[r.ym] = (actuals[r.ym] || 0) + r.kg;
                }
            }

            return actuals;
        }

        function computeChartData(actuals) {
            const isFiltered = filterCustomer || filterBranch || filterProduct;
            // When a sheet product is selected, use its per-product history as the baseline
            const productHistory = filterProduct && sheetProducts?.[filterProduct]
                ? sheetProducts[filterProduct] : null;
            const historyBase = productHistory || effectiveHistory;

            const allYearsSet = new Set([
                ...Object.keys(historyBase),
                ...Object.keys(actuals).map(ym => ym.slice(0, 4)),
            ]);
            const visibleYears = [...allYearsSet].filter(yr => selectedYears.has(yr)).sort();

            if (isFiltered) {
                if (productHistory) {
                    // Sheet product selected — merge its historical data with order actuals
                    return getMergedData(actuals, visibleYears, productHistory);
                }
                // Other filter active — orders-only data seeded with null year arrays
                const data = {};
                for (const yr of visibleYears) data[yr] = new Array(12).fill(null);
                for (const [ym, kg] of Object.entries(actuals)) {
                    const yr = ym.slice(0, 4);
                    const mo = parseInt(ym.slice(5)) - 1;
                    if (data[yr]) data[yr][mo] = (data[yr][mo] || 0) + kg;
                }
                return data;
            }
            return getMergedData(actuals, visibleYears, effectiveHistory);
        }

        function rebuildCharts() {
            const actuals = getFilteredActuals();
            const data    = computeChartData(actuals);

            const monthlyArea = document.getElementById('sales-chart-area');
            if (monthlyArea) {
                monthlyArea.innerHTML = buildSalesByMonthChart(data);
                if (typeof initCharts === 'function') initCharts(monthlyArea);
            }

            const cumulativeArea = document.getElementById('sales-chart-area-cumulative');
            if (cumulativeArea) {
                cumulativeArea.innerHTML = buildCumulativeChart(data);
                if (typeof initCharts === 'function') initCharts(cumulativeArea);
            }

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
            <div id="sf-years" style="display:flex;gap:0.25rem;flex-wrap:wrap">
                ${allAvailableYears.map(yr =>
                    `<button class="imp-view-btn${selectedYears.has(yr) ? ' active' : ''}" data-year="${escHtml(yr)}">${escHtml(yr)}</button>`
                ).join('')}
            </div>
            <button class="btn-secondary btn-sm" id="sf-clear">Clear</button>
        </div>`;

        // ── Initial data ──
        const initActuals = getFilteredActuals();
        const initData    = computeChartData(initActuals);

        const hasData = rows.length > 0;

        const chartsPanel = `
        <div id="sales-charts-panel">
            ${filterBar}
            <div class="sales-charts-row">
                <div class="cat-section sales-chart-block">
                    <h2 class="cat-title" style="margin-bottom:0.4rem">Sales by Month</h2>
                    <p class="cat-sub" style="margin-bottom:0.75rem">kg sold per month by year.</p>
                    <div id="sales-chart-area">${buildSalesByMonthChart(initData)}</div>
                </div>
                <div class="cat-section sales-chart-block">
                    <h2 class="cat-title" style="margin-bottom:0.4rem">Cumulative Sales</h2>
                    <p class="cat-sub" style="margin-bottom:0.75rem">Running total kg by year.</p>
                    <div id="sales-chart-area-cumulative">${buildCumulativeChart(initData)}</div>
                </div>
            </div>
            <div id="sales-data-table">${buildDataTable(initData)}</div>
            ${storeActuals.length ? `
            <div class="cat-section" style="margin-bottom:1.5rem">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Top Stores</h2>
                        <p class="cat-sub">By kg ordered, all time. LY% = current year vs same period last year.</p>
                    </div>
                </div>
                <div class="sales-table-wrap" style="margin-top:0.5rem">
                    <table class="sales-table">
                        <thead><tr><th>#</th><th>Store / Branch</th><th style="text-align:right">kg</th><th style="text-align:right">Orders</th><th style="text-align:right">LY%</th><th style="text-align:right">Last Order</th></tr></thead>
                        <tbody>
                            ${storeActuals.map((s, i) => {
                                const pct = s.prevYtd > 0 ? Math.round((s.curYtd / s.prevYtd - 1) * 100) : null;
                                const pctBadge = pct !== null
                                    ? `<span class="sales-ytd-pct ${pct >= 0 ? 'sales-ytd-up' : 'sales-ytd-dn'}">${pct >= 0 ? '+' : ''}${pct}%</span>`
                                    : `<span style="color:#e2e8f0">—</span>`;
                                return `<tr>
                                    <td style="color:#94a3b8;font-size:0.78rem">${i + 1}</td>
                                    <td>${escHtml(s.name)}</td>
                                    <td style="text-align:right;font-weight:600">${s.kg.toLocaleString('en-NZ')}</td>
                                    <td style="text-align:right;color:#64748b">${s.orders}</td>
                                    <td style="text-align:right">${pctBadge}</td>
                                    <td style="text-align:right;color:#94a3b8;font-size:0.8rem">${s.lastOrder ? s.lastOrder.slice(0,10) : '—'}</td>
                                </tr>`;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>` : ''}
        </div>`;

        const sheetYears = sheetHistory ? Object.keys(sheetHistory.total || {}).sort() : [];
        const settingsPanel = `
        <div id="sales-settings-panel" style="display:none">
            <div class="cat-section" style="max-width:640px;margin-bottom:1.5rem">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Connect Sales Sheet</h2>
                        <p class="cat-sub">Publish your Google Sheet as CSV and paste the link below. Monthly kg totals feed directly into the charts.</p>
                    </div>
                </div>
                ${fetchError ? `<div class="imp-connect-status imp-connect-error">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="#dc2626"><circle cx="5" cy="5" r="5"/></svg>
                    ${escHtml(fetchError)}
                </div>` : ''}
                ${sheetHistory ? `<div class="imp-connect-status" style="margin-bottom:0.75rem">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="#10b981"><circle cx="5" cy="5" r="5"/></svg>
                    Sheet data merged — ${sheetYears.length} year${sheetYears.length !== 1 ? 's' : ''} detected (${sheetYears.join(', ')}), ${rows.length} rows${sheetProducts ? `, ${Object.keys(sheetProducts).length} products (${Object.keys(sheetProducts).join(', ')})` : ''}
                </div>` : config?.sheetUrl && !fetchError && rows.length ? `<div style="font-size:0.8125rem;color:#f59e0b;margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:#fffbeb;border-radius:6px;border:1px solid #fde68a">
                    ⚠ Sheet loaded (${rows.length} rows) but column format not recognised.<br>
                    <strong>Columns found:</strong> ${headers.map(h => `<code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:0.78rem">${escHtml(h)}</code>`).join(' ')}<br>
                    <span style="color:#92400e">Expected either: <code>Year, Jan, Feb…Dec</code> (wide format) or columns containing a date and a kg/quantity value (long format).</span>
                </div>` : config?.sheetUrl && !fetchError && !rows.length ? `<div style="font-size:0.8125rem;color:#ef4444;margin-bottom:0.75rem">
                    Sheet returned no rows — check the URL points to the correct tab and that it is published as CSV.
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
        if (typeof initCharts === 'function') initCharts(bodyEl);

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

        // ── Filters ──
        document.getElementById('sf-customer')?.addEventListener('change', e => { filterCustomer = e.target.value; rebuildCharts(); });
        document.getElementById('sf-branch')?.addEventListener('change', e => { filterBranch = e.target.value; rebuildCharts(); });
        document.getElementById('sf-product')?.addEventListener('change', e => { filterProduct = e.target.value; rebuildCharts(); });

        document.getElementById('sf-years')?.querySelectorAll('[data-year]').forEach(btn => {
            btn.addEventListener('click', () => {
                const yr = btn.dataset.year;
                if (selectedYears.has(yr)) {
                    if (selectedYears.size > 1) { selectedYears.delete(yr); btn.classList.remove('active'); }
                } else {
                    selectedYears.add(yr); btn.classList.add('active');
                }
                rebuildCharts();
            });
        });

        document.getElementById('sf-clear')?.addEventListener('click', () => {
            filterCustomer = ''; filterBranch = ''; filterProduct = '';
            selectedYears = new Set(defaultYears);
            document.getElementById('sf-customer').value = '';
            document.getElementById('sf-branch').value = '';
            document.getElementById('sf-product').value = '';
            document.querySelectorAll('#sf-years [data-year]').forEach(btn => {
                btn.classList.toggle('active', selectedYears.has(btn.dataset.year));
            });
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

    return { render, prefetch };
})();
