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

    const MO_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const FY_MO_NAMES = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];

    // Reshape { calYear: [12 Jan..Dec] } → { fyEndYear: [12 Apr..Mar] }.
    // NZ FY ends 31 Mar, named by end year: FY26 = Apr 2025 → Mar 2026.
    function toFinancialYear(calData) {
        const fy = {};
        for (const [yrStr, vals] of Object.entries(calData)) {
            const yr = parseInt(yrStr, 10);
            if (!yr || !Array.isArray(vals)) continue;
            for (let mo = 0; mo < 12; mo++) {
                const v = vals[mo];
                if (v == null) continue;
                const fyEnd = mo >= 3 ? yr + 1 : yr;
                const idx   = mo >= 3 ? mo - 3 : mo + 9;
                if (!fy[fyEnd]) fy[fyEnd] = new Array(12).fill(null);
                fy[fyEnd][idx] = (fy[fyEnd][idx] || 0) + v;
            }
        }
        return fy;
    }

    // ── Prefetch — populate cache on dashboard load, consume on first render ──
    let _prefetchP = null;
    function prefetch() {
        if (_prefetchP) return;
        _prefetchP = fetch('/api/sales-history?rows=true')
            .then(r => r.ok ? r.json() : { rows: [] })
            .catch(() => ({ rows: [] }));
    }

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

    function buildCumulativeChart(data, mode = 'cal') {
        const useFy = mode === 'fy';
        const source = useFy ? toFinancialYear(data) : data;
        const years = Object.keys(source).sort();
        if (!years.length) return '';
        const id = 'cumulative-chart';
        const labels = useFy ? FY_MO_NAMES : MO_NAMES;
        const yrLabel = yr => useFy ? `FY${String(yr).slice(-2)}` : yr;
        // Cumulative line: carry the running total forward through null
        // months so the chart shows a flat segment instead of a gap. We
        // still leave leading null months (before the first data point of
        // a year) as null so the line doesn't start at zero before the
        // year has actually started selling.
        const cumData = {};
        for (const yr of years) {
            let run = 0;
            let started = false;
            cumData[yr] = (source[yr] || []).map(v => {
                if (v != null) { run += v; started = true; return run; }
                return started ? run : null;
            });
        }
        window._chartQ[id] = {
            type: 'line',
            data: {
                labels,
                datasets: years.map((yr, yi) => ({
                    label: yrLabel(yr),
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

    // Available products in the filter dropdown. Stable list — the seed
    // and Xero hook both classify into these three buckets.
    const PRODUCTS = ['Prime Tie Bundles', 'Prime Tie Loose', 'eco Ties'];

    function rowKg(r, productFilter) {
        if (productFilter === 'Prime Tie Bundles') return Number(r.bundlesKg) || 0;
        if (productFilter === 'Prime Tie Loose')   return Number(r.looseKg)   || 0;
        if (productFilter === 'eco Ties')          return Number(r.ecoTiesKg) || 0;
        return (Number(r.bundlesKg) || 0)
             + (Number(r.looseKg)   || 0)
             + (Number(r.ecoTiesKg) || 0);
    }

    async function renderBody(bodyEl) {
        bodyEl.innerHTML = '<div class="orders-loading">Loading…</div>';

        let rows = [];
        try {
            const resp = _prefetchP
                ? await _prefetchP
                : await api('/api/sales-history?rows=true');
            _prefetchP = null;
            rows = (resp && resp.rows) || [];
        } catch (e) {
            bodyEl.innerHTML = `<div class="orders-error">Could not load sales history: ${escHtml(e.message)}</div>`;
            return;
        }

        if (!rows.length) {
            bodyEl.innerHTML = `
            <div class="cat-section" style="text-align:center;padding:2rem">
                <p class="cat-sub">Sales history is empty.</p>
                <p class="cat-sub">Seed the table from <a href="#admin">Catalogue → Sales History</a> with the historical CSV.</p>
            </div>`;
            return;
        }

        // ── Filter options from the rows themselves ──
        const custSet   = new Set(rows.map(r => r.customer).filter(Boolean));
        const branchSet = new Set(rows.map(r => r.branch).filter(Boolean));
        const allAvailableYears = [...new Set(rows.map(r => String(r.year)))].sort();
        const defaultYears = new Set(allAvailableYears.slice(-3));

        // ── State ──
        let filterCustomer = '', filterBranch = '', filterProduct = '';
        let selectedYears = new Set(defaultYears);
        let cumMode = localStorage.getItem('sales-cum-mode') === 'fy' ? 'fy' : 'cal';

        // ── Apply filters → returns filtered rows ──
        function getFilteredRows() {
            return rows.filter(r => {
                if (filterCustomer && r.customer !== filterCustomer) return false;
                if (filterBranch   && r.branch   !== filterBranch)   return false;
                if (filterProduct === 'Prime Tie Bundles' && !(Number(r.bundlesKg) > 0)) return false;
                if (filterProduct === 'Prime Tie Loose'   && !(Number(r.looseKg)   > 0)) return false;
                if (filterProduct === 'eco Ties'          && !(Number(r.ecoTiesKg) > 0)) return false;
                return true;
            });
        }

        // ── Aggregate filtered rows to { year: [12 monthly kg or null] } ──
        function computeChartData() {
            const filtered = getFilteredRows();
            const visibleYears = [...selectedYears].sort();
            const data = {};
            for (const yr of visibleYears) data[yr] = new Array(12).fill(null);
            for (const r of filtered) {
                const yr = String(r.year);
                if (!data[yr]) continue;
                const mo = r.month - 1;
                if (mo < 0 || mo > 11) continue;
                const kg = rowKg(r, filterProduct);
                if (!kg) continue;
                data[yr][mo] = (data[yr][mo] || 0) + kg;
            }
            return data;
        }

        // ── Top Stores (always all-time, unfiltered) + LY YTD comparison ──
        const today = new Date();
        const curYr  = today.getFullYear().toString();
        const prevYr = (today.getFullYear() - 1).toString();
        const todayMd = (today.getMonth() + 1).toString().padStart(2, '0') + '-' + today.getDate().toString().padStart(2, '0');
        const cutCur  = curYr  + '-' + todayMd;
        const cutPrev = prevYr + '-' + todayMd;

        const byStore = {};
        for (const r of rows) {
            const store = r.branch || r.customer || '—';
            const kg = (Number(r.bundlesKg) || 0)
                     + (Number(r.looseKg)   || 0)
                     + (Number(r.ecoTiesKg) || 0);
            if (!byStore[store]) byStore[store] = { kg: 0, orders: 0, lastOrder: '', curYtd: 0, prevYtd: 0 };
            const s = byStore[store];
            s.kg += kg;
            s.orders++;
            if (r.date > s.lastOrder) s.lastOrder = r.date;
            if (r.date.startsWith(curYr)  && r.date <= cutCur)  s.curYtd  += kg;
            if (r.date.startsWith(prevYr) && r.date <= cutPrev) s.prevYtd += kg;
        }
        const storeActuals = Object.entries(byStore)
            .map(([name, d]) => ({ name, ...d }))
            .sort((a, b) => b.kg - a.kg)
            .slice(0, 10);

        function rebuildCharts() {
            const data = computeChartData();

            const monthlyArea = document.getElementById('sales-chart-area');
            if (monthlyArea) {
                monthlyArea.innerHTML = buildSalesByMonthChart(data);
                if (typeof initCharts === 'function') initCharts(monthlyArea);
            }

            const cumulativeArea = document.getElementById('sales-chart-area-cumulative');
            if (cumulativeArea) {
                cumulativeArea.innerHTML = buildCumulativeChart(data, cumMode);
                if (typeof initCharts === 'function') initCharts(cumulativeArea);
            }

            const tableArea = document.getElementById('sales-data-table');
            if (tableArea) tableArea.innerHTML = buildDataTable(data);
        }

        // ── Filter bar HTML ──
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
                ${makeOpts(PRODUCTS, filterProduct, 'Products')}
            </select>
            <div id="sf-years" style="display:flex;gap:0.25rem;flex-wrap:wrap">
                ${allAvailableYears.map(yr =>
                    `<button class="imp-view-btn${selectedYears.has(yr) ? ' active' : ''}" data-year="${escHtml(yr)}">${escHtml(yr)}</button>`
                ).join('')}
            </div>
            <button class="btn-secondary btn-sm" id="sf-clear">Clear</button>
        </div>`;

        const initData = computeChartData();

        bodyEl.innerHTML = `
        ${filterBar}
        <div class="sales-charts-row">
            <div class="cat-section sales-chart-block">
                <h2 class="cat-title" style="margin-bottom:0.4rem">Sales by Month</h2>
                <p class="cat-sub" style="margin-bottom:0.75rem">kg sold per month by year.</p>
                <div id="sales-chart-area">${buildSalesByMonthChart(initData)}</div>
            </div>
            <div class="cat-section sales-chart-block">
                <div class="sales-chart-head">
                    <div>
                        <h2 class="cat-title" style="margin-bottom:0.4rem">Cumulative Sales</h2>
                        <p class="cat-sub" style="margin-bottom:0">Running total kg by year.</p>
                    </div>
                    <div class="sales-mode-toggle" role="tablist" aria-label="Year mode">
                        <button class="sales-mode-btn${cumMode === 'cal' ? ' active' : ''}" data-mode="cal" role="tab" aria-selected="${cumMode === 'cal'}">Calendar</button>
                        <button class="sales-mode-btn${cumMode === 'fy' ? ' active' : ''}" data-mode="fy" role="tab" aria-selected="${cumMode === 'fy'}">Financial</button>
                    </div>
                </div>
                <div id="sales-chart-area-cumulative">${buildCumulativeChart(initData, cumMode)}</div>
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
                                <td style="text-align:right;font-weight:600">${Math.round(s.kg).toLocaleString('en-NZ')}</td>
                                <td style="text-align:right;color:#64748b">${s.orders}</td>
                                <td style="text-align:right">${pctBadge}</td>
                                <td style="text-align:right;color:#94a3b8;font-size:0.8rem">${s.lastOrder ? s.lastOrder.slice(0, 10) : '—'}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>` : ''}`;

        if (typeof initCharts === 'function') initCharts(bodyEl);

        // ── Cumulative chart Cal/FY toggle ──
        bodyEl.querySelectorAll('.sales-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                if (mode === cumMode) return;
                cumMode = mode;
                localStorage.setItem('sales-cum-mode', cumMode);
                bodyEl.querySelectorAll('.sales-mode-btn').forEach(b => {
                    const on = b.dataset.mode === cumMode;
                    b.classList.toggle('active', on);
                    b.setAttribute('aria-selected', on);
                });
                rebuildCharts();
            });
        });

        // Cross-aware filter options: each select rebuilds its options from
        // the rows that match the OTHER filters. Picking Customer = Horticentre
        // shrinks the Branch dropdown to Horticentre's three branches; the
        // reverse holds for Branch → Customer. If a currently-selected value
        // no longer matches (e.g. you pick Branch then change Customer to one
        // that doesn't have it), the orphaned filter resets to "all".
        function rebuildFilterOptions() {
            const branchesForCustomer = filterCustomer
                ? [...new Set(rows.filter(r => r.customer === filterCustomer).map(r => r.branch).filter(Boolean))].sort()
                : [...branchSet].sort();
            if (filterBranch && !branchesForCustomer.includes(filterBranch)) filterBranch = '';
            const branchEl = document.getElementById('sf-branch');
            if (branchEl) branchEl.innerHTML = makeOpts(branchesForCustomer, filterBranch, 'Branches');

            const customersForBranch = filterBranch
                ? [...new Set(rows.filter(r => r.branch === filterBranch).map(r => r.customer).filter(Boolean))].sort()
                : [...custSet].sort();
            if (filterCustomer && !customersForBranch.includes(filterCustomer)) filterCustomer = '';
            const customerEl = document.getElementById('sf-customer');
            if (customerEl) customerEl.innerHTML = makeOpts(customersForBranch, filterCustomer, 'Customers');
        }

        // ── Filter event handlers ──
        document.getElementById('sf-customer')?.addEventListener('change', e => {
            filterCustomer = e.target.value; rebuildFilterOptions(); rebuildCharts();
        });
        document.getElementById('sf-branch')?.addEventListener('change',   e => {
            filterBranch   = e.target.value; rebuildFilterOptions(); rebuildCharts();
        });
        document.getElementById('sf-product')?.addEventListener('change',  e => { filterProduct  = e.target.value; rebuildCharts(); });

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
            // Restore the customer + branch dropdowns to their full option
            // sets so prior cross-filter narrowing doesn't linger.
            rebuildFilterOptions();
            document.getElementById('sf-product').value = '';
            document.querySelectorAll('#sf-years [data-year]').forEach(btn => {
                btn.classList.toggle('active', selectedYears.has(btn.dataset.year));
            });
            rebuildCharts();
        });
    }

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Sales History</h1>
                <p class="view-subtitle">Historical sales by month and year. Seeded from the legacy CSV; live Hub orders append on Xero push. Manage from <a href="#admin">Catalogue → Sales History</a>.</p>
            </div>
        </div>
        <div id="sales-body"></div>`;

        await renderBody(document.getElementById('sales-body'));
    }

    // ── Public: render the same Cumulative Sales chart shown on the
    // Sales History page (with the Calendar / Financial Year toggle)
    // into a given dashboard container. Reuses buildCumulativeChart so
    // there's no second copy of the chart code.
    async function renderDashboardCumulative(container) {
        if (!container) return;
        container.innerHTML = '<span class="db-mod-loading">Loading…</span>';

        let rows = [];
        try {
            const resp = _prefetchP
                ? await _prefetchP
                : await api('/api/sales-history?rows=true');
            _prefetchP = null;
            rows = (resp && resp.rows) || [];
        } catch (e) {
            container.innerHTML = `<p class="db-mod-empty">Could not load sales: ${escHtml(e.message)}</p>`;
            return;
        }
        if (!rows.length) { container.innerHTML = '<p class="db-mod-empty">No sales history yet.</p>'; return; }

        // Latest 3 calendar years that have any data — same logic the full
        // page applies as a default. The Cal/FY toggle then flips between
        // calendar and fiscal-year framing of that data.
        const allYears = [...new Set(rows.map(r => String(r.year)))].sort();
        const recent  = new Set(allYears.slice(-3));

        // Aggregate rows → { year: [12 monthly kg or null] } for the recent years.
        function computeData() {
            const data = {};
            for (const yr of recent) data[yr] = new Array(12).fill(null);
            for (const r of rows) {
                const yr = String(r.year);
                if (!data[yr]) continue;
                const mo = r.month - 1;
                if (mo < 0 || mo > 11) continue;
                const kg = (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
                if (!kg) continue;
                data[yr][mo] = (data[yr][mo] || 0) + kg;
            }
            return data;
        }

        let cumMode = localStorage.getItem('sales-cum-mode') === 'fy' ? 'fy' : 'cal';
        const data  = computeData();

        const rebuild = () => {
            container.innerHTML = `
                <div class="db-sales-toolbar">
                    <div class="sales-mode-toggle" role="tablist" aria-label="Year mode">
                        <button class="sales-mode-btn${cumMode === 'cal' ? ' active' : ''}" data-mode="cal" role="tab" aria-selected="${cumMode === 'cal'}">Calendar</button>
                        <button class="sales-mode-btn${cumMode === 'fy' ? ' active' : ''}" data-mode="fy" role="tab" aria-selected="${cumMode === 'fy'}">Financial</button>
                    </div>
                </div>
                <div class="db-cumulative-chart-wrap">${buildCumulativeChart(data, cumMode)}</div>`;
            if (typeof initCharts === 'function') initCharts(container);
            container.querySelectorAll('.sales-mode-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    cumMode = btn.dataset.mode;
                    localStorage.setItem('sales-cum-mode', cumMode);
                    rebuild();
                });
            });
        };
        rebuild();
    }

    return { render, prefetch, renderDashboardCumulative };
})();
