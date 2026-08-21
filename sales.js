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

    function buildSalesByMonthChart(data, mode = 'cal') {
        const useFy = mode === 'fy';
        const source = useFy ? toFinancialYear(data) : data;
        const years = Object.keys(source).sort();
        if (!years.length) return '<p style="color:#94a3b8;font-size:0.875rem;padding:1rem 0">No data for selected filters.</p>';
        const id = 'monthly-sales-chart';
        const labels  = useFy ? FY_MO_NAMES : MO_NAMES;
        const yrLabel = yr => useFy ? `FY${String(yr).slice(-2)}` : yr;
        window._chartQ[id] = {
            type: 'bar',
            data: {
                labels,
                datasets: years.map((yr, yi) => ({
                    label: yrLabel(yr),
                    data: (source[yr] || new Array(12).fill(null)).map(v => v ?? null),
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

    // maxYears > 0 keeps only the most recent N years *after* the Cal/FY
    // reshape — so "last 3" means 3 financial years in FY mode, not 3
    // calendar years squeezed into 4 partial FYs.
    function buildCumulativeChart(data, mode = 'cal', maxYears = 0) {
        const useFy = mode === 'fy';
        const source = useFy ? toFinancialYear(data) : data;
        let years = Object.keys(source).sort();
        if (maxYears > 0) years = years.slice(-maxYears);
        if (!years.length) return '';
        const id = 'cumulative-chart';
        const labels = useFy ? FY_MO_NAMES : MO_NAMES;
        const yrLabel = yr => useFy ? `FY${String(yr).slice(-2)}` : yr;
        // Cumulative line: carry the running total forward through null
        // months *between* data points so the chart shows a flat segment
        // instead of a gap. Leading null months (before the first sale of
        // the year) stay null, and so do months after the LAST data point —
        // otherwise the current year's line runs flat out to December as if
        // the rest of the year had already happened.
        const cumData = {};
        for (const yr of years) {
            const vals = source[yr] || [];
            let lastIdx = -1;
            vals.forEach((v, i) => { if (v != null) lastIdx = i; });
            let run = 0;
            let started = false;
            cumData[yr] = vals.map((v, i) => {
                if (i > lastIdx) return null;
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

    const TYPE_SERIES = [
        { key: 'bundles', label: 'Prime Tie Bundles', color: '#3b82f6' },
        { key: 'loose',   label: 'Prime Tie Loose',   color: '#10b981' },
        { key: 'eco',     label: 'eco Ties',          color: '#f59e0b' },
    ];

    // Stacked area — sales by product type across one year's months.
    function buildProductTypeChart(td, year) {
        const any = TYPE_SERIES.some(s => (td[s.key] || []).some(v => v > 0));
        if (!any) return `<p style="color:#94a3b8;font-size:0.875rem;padding:1rem 0">No sales for ${escHtml(String(year))}.</p>`;
        const id = 'product-type-chart';
        window._chartQ[id] = {
            type: 'line',
            data: {
                labels: MO_NAMES,
                datasets: TYPE_SERIES.map(s => ({
                    label: s.label,
                    data: (td[s.key] || new Array(12).fill(0)).map(v => Math.round(v)),
                    backgroundColor: s.color + '55',
                    borderColor: s.color,
                    borderWidth: 1.5,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 0,
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
                    y: { stacked: true, grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', callback: v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } },
                },
            },
        };
        return `<div style="position:relative;height:210px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
    }

    // Grouped bars — sales by product size (1kg vs 10kg) across one year's months.
    // Dormant until the seed data carries the size split.
    function buildProductSizeChart(sd, year, sizeFilter) {
        if (!sd.hasData) {
            return `<p style="color:#94a3b8;font-size:0.85rem;padding:1rem 0;line-height:1.5">
                No size data yet. Add <strong>1kg</strong> and <strong>10kg</strong> volume columns to the
                sales-history seed (see <a href="#admin">Catalogue → Sales History</a>) and re-seed, and this
                chart will populate.</p>`;
        }
        const id = 'product-size-chart';
        const SIZE_SERIES = [
            { key: 'tenKg', label: '10kg', color: '#6366f1' },
            { key: 'oneKg', label: '1kg',  color: '#f59e0b' },
        ].filter(s => !sizeFilter || sizeFilter === 'both' || sizeFilter === s.key);
        window._chartQ[id] = {
            type: 'bar',
            data: {
                labels: MO_NAMES,
                datasets: SIZE_SERIES.map(s => ({
                    label: s.label,
                    data: (sd[s.key] || new Array(12).fill(0)).map(v => Math.round(v)),
                    backgroundColor: s.color,
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
        return `<div style="position:relative;height:210px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
    }

    function buildDataTable(data, mode = 'cal') {
        const useFy = mode === 'fy';
        const source = useFy ? toFinancialYear(data) : data;
        const years = Object.keys(source).sort();
        if (!years.length) return '';

        const months  = useFy ? FY_MO_NAMES : MO_NAMES;
        const yrLabel = yr => useFy ? `FY${String(yr).slice(-2)}` : yr;
        const yearTotals = years.map(yr =>
            (source[yr] || []).reduce((s, v) => s + (v || 0), 0)
        );

        const tableRows = months.map((m, mo) => {
            const cells = years.map(yr => {
                const v = source[yr]?.[mo];
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
                            ${years.map(yr => `<th class="sales-tbl-num">${yrLabel(yr)}</th>`).join('')}
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

    const PRODUCT_TYPE = {
        'Prime Tie Bundles': 'bundles',
        'Prime Tie Loose':   'loose',
        'eco Ties':          'ecoTies',
    };

    // kg of one product TYPE at one SIZE for a row. Prefers the type×size cross
    // (xkg) when present; otherwise, if the row is a single type, its whole
    // size total belongs to that type. Mixed-type rows without a cross can't be
    // split and return 0 (re-seed to add the cross).
    function typeSizeKg(r, type, sizeFilter) {
        const sfx    = sizeFilter === 'tenKg' ? '10' : '1';
        const letter = type === 'bundles' ? 'b' : type === 'loose' ? 'l' : 'e';
        const x = r.xkg;
        if (x) return Number(x[letter + sfx]) || 0;
        const totals = {
            bundles: Number(r.bundlesKg) || 0,
            loose:   Number(r.looseKg)   || 0,
            ecoTies: Number(r.ecoTiesKg) || 0,
        };
        const nonzero = (totals.bundles > 0) + (totals.loose > 0) + (totals.ecoTies > 0);
        if (nonzero === 1 && totals[type] > 0) return Number(r[sizeFilter]) || 0;
        return 0;
    }

    function rowKg(r, productFilter, sizeFilter) {
        if (!sizeFilter || sizeFilter === 'both') {
            if (productFilter === 'Prime Tie Bundles') return Number(r.bundlesKg) || 0;
            if (productFilter === 'Prime Tie Loose')   return Number(r.looseKg)   || 0;
            if (productFilter === 'eco Ties')          return Number(r.ecoTiesKg) || 0;
            return (Number(r.bundlesKg) || 0)
                 + (Number(r.looseKg)   || 0)
                 + (Number(r.ecoTiesKg) || 0);
        }
        // Size-specific. All-products at a size is just the stored size total,
        // present on every row — no cross needed.
        const sizeKey = sizeFilter === 'tenKg' ? 'tenKg' : 'oneKg';
        const type = PRODUCT_TYPE[productFilter];
        if (!type) return Number(r[sizeKey]) || 0;
        // Product + size needs the type×size split.
        return typeSizeKg(r, type, sizeFilter);
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
        let filterSize = 'both'; // page-wide size filter: 'both' | 'oneKg' | 'tenKg'
        let selectedYears = new Set(defaultYears);
        let cumMode = localStorage.getItem('sales-cum-mode') === 'fy' ? 'fy' : 'cal';
        // Single-year scope for the type/size breakdown charts (default current
        // calendar year, else the latest year with data).
        const nowYr = new Date().getFullYear().toString();
        let chartYear = allAvailableYears.includes(nowYr) ? nowYr : (allAvailableYears[allAvailableYears.length - 1] || nowYr);
        // Top Stores: date range (default this calendar year) + grouping.
        let storeFrom  = nowYr + '-01-01';
        let storeTo    = new Date().toISOString().slice(0, 10);
        let storeGroup = localStorage.getItem('sales-store-group') || 'branch'; // 'customer' | 'customerBranch' | 'branch'

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
                const kg = rowKg(r, filterProduct, filterSize);
                if (!kg) continue;
                data[yr][mo] = (data[yr][mo] || 0) + kg;
            }
            return data;
        }

        // Customer/branch-filtered rows (ignores the product filter — the
        // type/size charts break down by product themselves).
        function getCustBranchRows() {
            return rows.filter(r =>
                (!filterCustomer || r.customer === filterCustomer) &&
                (!filterBranch   || r.branch   === filterBranch));
        }

        // Monthly type + size breakdown for the selected chart year.
        function computeTypeSize() {
            const t = { bundles: new Array(12).fill(0), loose: new Array(12).fill(0), eco: new Array(12).fill(0) };
            const s = { oneKg: new Array(12).fill(0), tenKg: new Array(12).fill(0), hasData: false };
            for (const r of getCustBranchRows()) {
                if (String(r.year) !== String(chartYear)) continue;
                const mo = r.month - 1;
                if (mo < 0 || mo > 11) continue;
                // Type breakdown — all sizes, or one size (cross or fallback).
                if (filterSize === 'both') {
                    t.bundles[mo] += Number(r.bundlesKg) || 0;
                    t.loose[mo]   += Number(r.looseKg)   || 0;
                    t.eco[mo]     += Number(r.ecoTiesKg) || 0;
                } else {
                    t.bundles[mo] += typeSizeKg(r, 'bundles', filterSize);
                    t.loose[mo]   += typeSizeKg(r, 'loose',   filterSize);
                    t.eco[mo]     += typeSizeKg(r, 'ecoTies', filterSize);
                }
                // Size chart tracks both series; the page filter just hides the
                // unselected one at render time.
                const one = Number(r.oneKg) || 0, ten = Number(r.tenKg) || 0;
                s.oneKg[mo] += one; s.tenKg[mo] += ten;
                if (one || ten) s.hasData = true;
            }
            return { t, s };
        }

        // Top Stores for the selected date range + grouping, with same-range
        // last-year comparison for the LY% column.
        function shiftYr(iso, d) { const p = iso.split('-'); return (Number(p[0]) + d) + '-' + p[1] + '-' + p[2]; }
        function computeStores() {
            const pf = shiftYr(storeFrom, -1), pt = shiftYr(storeTo, -1);
            const keyOf = r => storeGroup === 'customer' ? (r.customer || '—')
                : storeGroup === 'customerBranch' ? ((r.customer || '—') + '|||' + (r.branch || ''))
                : (r.branch || r.customer || '—');
            const map = {};
            for (const r of rows) {
                const d = (r.date || '').slice(0, 10);
                const inCur = d >= storeFrom && d <= storeTo;
                const inPrev = d >= pf && d <= pt;
                if (!inCur && !inPrev) continue;
                const k = keyOf(r);
                if (!map[k]) map[k] = { customer: r.customer || '', branch: r.branch || '', kg: 0, orders: 0, lastOrder: '', cur: 0, prev: 0 };
                const m = map[k];
                const kg = rowKg(r, '', filterSize);
                if (inCur)  { m.kg += kg; m.orders++; if (d > m.lastOrder) m.lastOrder = d; m.cur += kg; }
                if (inPrev) m.prev += kg;
            }
            return Object.values(map).filter(m => m.orders > 0).sort((a, b) => b.kg - a.kg).slice(0, 10);
        }

        function rebuildCharts() {
            const data = computeChartData();

            const monthlyArea = document.getElementById('sales-chart-area');
            if (monthlyArea) {
                monthlyArea.innerHTML = buildSalesByMonthChart(data, cumMode);
                if (typeof initCharts === 'function') initCharts(monthlyArea);
            }

            const cumulativeArea = document.getElementById('sales-chart-area-cumulative');
            if (cumulativeArea) {
                cumulativeArea.innerHTML = buildCumulativeChart(data, cumMode);
                if (typeof initCharts === 'function') initCharts(cumulativeArea);
            }

            const tableArea = document.getElementById('sales-data-table');
            if (tableArea) tableArea.innerHTML = buildDataTable(data, cumMode);

            rebuildTypeSize();
        }

        // Redraw the type (area) + size (bar) charts for the current chart year.
        function rebuildTypeSize() {
            const { t, s } = computeTypeSize();
            const typeArea = document.getElementById('sales-chart-area-type');
            if (typeArea) {
                typeArea.innerHTML = buildProductTypeChart(t, chartYear);
                if (typeof initCharts === 'function') initCharts(typeArea);
            }
            const sizeArea = document.getElementById('sales-chart-area-size');
            if (sizeArea) {
                sizeArea.innerHTML = buildProductSizeChart(s, chartYear, filterSize);
                if (typeof initCharts === 'function') initCharts(sizeArea);
            }
        }

        // ── Top Stores table (date-ranged + grouped) ──
        function renderTopStores() {
            const el = document.getElementById('top-stores-area');
            if (!el) return;
            const list = computeStores();
            const showCust   = storeGroup === 'customer' || storeGroup === 'customerBranch';
            const showBranch = storeGroup === 'branch'   || storeGroup === 'customerBranch';
            const idCols = (storeGroup === 'customer' ? '<th>Customer</th>'
                : storeGroup === 'branch' ? '<th>Branch</th>'
                : '<th>Customer</th><th>Branch</th>');
            const bodyRows = list.length ? list.map((s, i) => {
                const pct = s.prev > 0 ? Math.round((s.cur / s.prev - 1) * 100) : null;
                const pctBadge = pct !== null
                    ? `<span class="sales-ytd-pct ${pct >= 0 ? 'sales-ytd-up' : 'sales-ytd-dn'}">${pct >= 0 ? '+' : ''}${pct}%</span>`
                    : `<span style="color:#e2e8f0">—</span>`;
                const idCells = (showCust ? `<td>${escHtml(s.customer || '—')}</td>` : '')
                              + (showBranch ? `<td>${escHtml(s.branch || (storeGroup === 'branch' ? s.customer : '') || '—')}</td>` : '');
                return `<tr>
                    <td style="color:#94a3b8;font-size:0.78rem">${i + 1}</td>
                    ${idCells}
                    <td style="text-align:right;font-weight:600">${Math.round(s.kg).toLocaleString('en-NZ')}</td>
                    <td style="text-align:right;color:#64748b">${s.orders}</td>
                    <td style="text-align:right">${pctBadge}</td>
                    <td style="text-align:right;color:#94a3b8;font-size:0.8rem">${s.lastOrder ? s.lastOrder.slice(0, 10) : '—'}</td>
                </tr>`;
            }).join('') : `<tr><td colspan="${3 + (showCust ? 1 : 0) + (showBranch ? 1 : 0) + 1}" style="text-align:center;color:#94a3b8;padding:1rem">No sales in this date range.</td></tr>`;

            el.innerHTML = `
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Top Stores</h2>
                    <p class="cat-sub">By kg ordered in the selected range. LY% = this range vs the same range last year.</p>
                </div>
                <div class="sales-store-controls">
                    <label class="sales-store-dates">From <input type="date" id="ts-from" value="${escHtml(storeFrom)}"></label>
                    <label class="sales-store-dates">To <input type="date" id="ts-to" value="${escHtml(storeTo)}"></label>
                    <div class="sales-mode-toggle" role="tablist" aria-label="Group stores by">
                        <button class="sales-grp-btn${storeGroup === 'customer' ? ' active' : ''}" data-group="customer" role="tab">Customer</button>
                        <button class="sales-grp-btn${storeGroup === 'customerBranch' ? ' active' : ''}" data-group="customerBranch" role="tab">Customer › Branch</button>
                        <button class="sales-grp-btn${storeGroup === 'branch' ? ' active' : ''}" data-group="branch" role="tab">Branch</button>
                    </div>
                </div>
            </div>
            <div class="sales-table-wrap" style="margin-top:0.5rem">
                <table class="sales-table">
                    <thead><tr><th>#</th>${idCols}<th style="text-align:right">kg</th><th style="text-align:right">Orders</th><th style="text-align:right">LY%</th><th style="text-align:right">Last Order</th></tr></thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>`;

            // Wire the controls (re-render on change)
            el.querySelector('#ts-from')?.addEventListener('change', e => { storeFrom = e.target.value || storeFrom; renderTopStores(); });
            el.querySelector('#ts-to')?.addEventListener('change',   e => { storeTo   = e.target.value || storeTo;   renderTopStores(); });
            el.querySelectorAll('[data-group]').forEach(btn => btn.addEventListener('click', () => {
                storeGroup = btn.dataset.group;
                localStorage.setItem('sales-store-group', storeGroup);
                renderTopStores();
            }));
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
            <select class="sales-filter-sel" id="sf-size" title="Filter every view to 1kg or 10kg product">
                <option value="both"${filterSize === 'both' ? ' selected' : ''}>All Sizes</option>
                <option value="tenKg"${filterSize === 'tenKg' ? ' selected' : ''}>10kg</option>
                <option value="oneKg"${filterSize === 'oneKg' ? ' selected' : ''}>1kg</option>
            </select>
            <div id="sf-years" style="display:flex;gap:0.25rem;flex-wrap:wrap">
                ${allAvailableYears.map(yr =>
                    `<button class="imp-view-btn${selectedYears.has(yr) ? ' active' : ''}" data-year="${escHtml(yr)}">${escHtml(yr)}</button>`
                ).join('')}
            </div>
            <button class="btn-secondary btn-sm" id="sf-clear">Clear</button>
            <div class="sales-mode-toggle" role="tablist" aria-label="Calendar or financial year" style="margin-left:auto">
                <button class="sales-mode-btn${cumMode === 'cal' ? ' active' : ''}" data-mode="cal" role="tab" aria-selected="${cumMode === 'cal'}">Calendar</button>
                <button class="sales-mode-btn${cumMode === 'fy' ? ' active' : ''}" data-mode="fy" role="tab" aria-selected="${cumMode === 'fy'}">Financial</button>
            </div>
        </div>`;

        const initData = computeChartData();

        bodyEl.innerHTML = `
        ${filterBar}
        <div class="sales-charts-row">
            <div class="cat-section sales-chart-block">
                <h2 class="cat-title" style="margin-bottom:0.4rem">Sales by Month
                    <span class="chart-info" title="Bars are kg sold per month. One bar per selected year — pick years in the filter row above. The Calendar / Financial toggle switches Jan→Dec vs Apr→Mar (NZ FY). Filter by customer / branch / product / size narrows what's counted across the whole chart. Pre-Hub-live months come from the seeded sales history; later months from dispatched orders.">&#9432;</span>
                </h2>
                <p class="cat-sub" style="margin-bottom:0.75rem">kg sold per month by year.</p>
                <div id="sales-chart-area">${buildSalesByMonthChart(initData, cumMode)}</div>
            </div>
            <div class="cat-section sales-chart-block">
                <div class="sales-chart-head">
                    <div>
                        <h2 class="cat-title" style="margin-bottom:0.4rem">Cumulative Sales
                            <span class="chart-info" title="Each line is the running total of kg sold within one year, from the start of the period to date. The Calendar / Financial toggle in the filter row switches Jan→Dec vs Apr→Mar (NZ FY) for this chart, Sales by Month, and the Annual Summary. When a month has no data the line carries the running total forward as a flat segment rather than dropping out.">&#9432;</span>
                        </h2>
                        <p class="cat-sub" style="margin-bottom:0">Running total kg by year.</p>
                    </div>
                </div>
                <div id="sales-chart-area-cumulative">${buildCumulativeChart(initData, cumMode)}</div>
            </div>
        </div>
        <div id="sales-data-table">${buildDataTable(initData, cumMode)}</div>
        <div class="sales-charts-row">
            <div class="cat-section sales-chart-block">
                <div class="sales-chart-head">
                    <div>
                        <h2 class="cat-title" style="margin-bottom:0.4rem">Sales by Product Type</h2>
                        <p class="cat-sub" style="margin-bottom:0">kg by type per month · one year.</p>
                    </div>
                    <select class="sales-filter-sel" id="sf-chart-year" title="Year for the type and size charts" style="flex-shrink:0">
                        ${allAvailableYears.map(yr => `<option value="${escHtml(yr)}"${yr === chartYear ? ' selected' : ''}>${escHtml(yr)}</option>`).join('')}
                    </select>
                </div>
                <div id="sales-chart-area-type"></div>
            </div>
            <div class="cat-section sales-chart-block">
                <h2 class="cat-title" style="margin-bottom:0.4rem">Sales by Product Size
                    <span class="chart-info" title="1kg vs 10kg volumes per month for the selected year. Needs 1kg/10kg columns in the sales-history seed data.">&#9432;</span>
                </h2>
                <p class="cat-sub" style="margin-bottom:0.75rem">1kg vs 10kg per month · one year.</p>
                <div id="sales-chart-area-size"></div>
            </div>
        </div>
        <div class="cat-section" style="margin-bottom:1.5rem" id="top-stores-area"></div>`;

        if (typeof initCharts === 'function') initCharts(bodyEl);
        rebuildTypeSize();
        renderTopStores();

        document.getElementById('sf-chart-year')?.addEventListener('change', e => {
            chartYear = e.target.value; rebuildTypeSize();
        });

        document.getElementById('sf-size')?.addEventListener('change', e => {
            filterSize = e.target.value;
            rebuildCharts();      // monthly + cumulative + table + type/size charts
            renderTopStores();    // top stores tally by size too
        });

        // ── Page-level Calendar / Financial year toggle (drives Sales by
        //    Month, Cumulative, and the Annual Summary table) ──
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
            filterCustomer = ''; filterBranch = ''; filterProduct = ''; filterSize = 'both';
            selectedYears = new Set(defaultYears);
            // Restore the customer + branch dropdowns to their full option
            // sets so prior cross-filter narrowing doesn't linger.
            rebuildFilterOptions();
            document.getElementById('sf-product').value = '';
            const sizeEl = document.getElementById('sf-size');
            if (sizeEl) sizeEl.value = 'both';
            document.querySelectorAll('#sf-years [data-year]').forEach(btn => {
                btn.classList.toggle('active', selectedYears.has(btn.dataset.year));
            });
            rebuildCharts();
            renderTopStores();
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
        <div class="order-detail-tabs no-print" role="tablist">
            <button class="order-detail-tab order-detail-tab--active" data-panel="sales" role="tab">Sales</button>
            <button class="order-detail-tab" data-panel="stocktake" role="tab">Stocktake</button>
        </div>
        <div id="sales-body"></div>
        <div id="sales-stocktake" hidden></div>`;

        await renderBody(document.getElementById('sales-body'));

        // Sales charts vs the Stocktake editor (embedded from the Warehouse
        // module). Stocktake renders lazily the first time it's opened.
        let stocktakeLoaded = false;
        container.querySelectorAll('.order-detail-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const showStk = tab.dataset.panel === 'stocktake';
                container.querySelectorAll('.order-detail-tab').forEach(t =>
                    t.classList.toggle('order-detail-tab--active', t === tab));
                document.getElementById('sales-body').hidden = showStk;
                const stkEl = document.getElementById('sales-stocktake');
                stkEl.hidden = !showStk;
                if (showStk && !stocktakeLoaded) {
                    stocktakeLoaded = true;
                    if (typeof Warehouse !== 'undefined' && Warehouse.renderStocktakeInto) {
                        Warehouse.renderStocktakeInto(stkEl);
                    } else {
                        stkEl.innerHTML = '<p class="cat-sub" style="padding:1rem">Stocktake module unavailable.</p>';
                    }
                }
            });
        });
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

        // Aggregate ALL years → { year: [12 monthly kg or null] }; the chart
        // builder keeps the latest 3 after the Cal/FY reshape, so the widget
        // shows the last 3 calendar years or the last 3 financial years
        // depending on the toggle.
        const allYears = [...new Set(rows.map(r => String(r.year)))].sort();

        function computeData() {
            const data = {};
            for (const yr of allYears) data[yr] = new Array(12).fill(null);
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
                <div class="db-cumulative-chart-wrap">${buildCumulativeChart(data, cumMode, 3)}</div>`;
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
