// ── State ──
let currentConfig = {};

// ── Chart.js registry ──
window._chartQ    = {};
window._chartInst = {};

function initCharts(container) {
    if (typeof Chart === 'undefined') return;
    (container || document).querySelectorAll('canvas[data-chart-id]').forEach(canvas => {
        const id = canvas.dataset.chartId;
        const cfg = window._chartQ[id];
        if (!cfg) return;
        if (window._chartInst[id]) {
            try { window._chartInst[id].destroy(); } catch (_) {}
            delete window._chartInst[id];
        }
        window._chartInst[id] = new Chart(canvas, cfg);
        delete window._chartQ[id];
    });
}

// ── Config load ──
function loadConfig() {
    fetch('config.json?_=' + Date.now())
        .then(r => r.json())
        .then(applyConfig)
        .catch(err => {
            console.error('Error loading config:', err);
            const el = document.getElementById('db-widgets');
            if (el) el.innerHTML = '<p style="padding:2rem;color:#ef4444;">Error loading config.json — check the console.</p>';
        });
}

function applyConfig(config) {
    currentConfig = config;
    renderDashboardWidgets(config);
    updateTimestamp();
}

function updateTimestamp() {
    const el = document.getElementById('last-updated');
    if (!el) return;
    const now = new Date();
    el.textContent = 'Loaded ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Dashboard ────────────────────────────────────────────────────────────
// New fixed layout: a button row up top, two priority charts (Stock
// Trajectory + Cumulative Sales), and a unified calendar module that
// merges the old "next 14 days" list with a clickable month grid.

const DB_ICONS = {
    orders:    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h16M4 19h10"/></svg>',
    shipments: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11" rx="1"/><path d="M15 9h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>',
    sales:     '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>',
    xero:      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l2.5 2.5L16 9"/></svg>',
    plus:      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
};

function renderDashboardWidgets(config) {
    const el = document.getElementById('db-widgets');
    if (!el) return;

    const topRow = `
        <div class="db-top-bar">
            <div class="db-top-buttons">
                <a class="db-top-btn" href="#orders">${DB_ICONS.orders}<span>Orders</span></a>
                <a class="db-top-btn" href="#imports">${DB_ICONS.shipments}<span>Shipments</span></a>
                <a class="db-top-btn" href="#sales">${DB_ICONS.sales}<span>Sales History</span></a>
                <a class="db-top-btn" href="https://go.xero.com" target="_blank" rel="noopener">${DB_ICONS.xero}<span>Xero ↗</span></a>
            </div>
            <a class="db-top-btn db-top-btn--primary" href="#orders/new">${DB_ICONS.plus}<span>Add Order</span></a>
        </div>`;

    el.innerHTML = `
        ${topRow}
        <section class="db-mod db-mod--chart" id="db-stock-trajectory">
            <div class="db-mod-hd"><h3 class="db-mod-title">Stock Trajectory</h3><a class="db-mod-link" href="#imports">Open Imports →</a></div>
            <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
        </section>
        <section class="db-mod db-mod--chart" id="db-cumulative-sales">
            <div class="db-mod-hd"><h3 class="db-mod-title">Cumulative Sales <span class="db-mod-sub">last 3 FYs</span></h3><a class="db-mod-link" href="#sales">Open Sales →</a></div>
            <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
        </section>
        <section class="db-mod" id="db-calendar-module">
            <div class="db-mod-hd"><h3 class="db-mod-title" id="db-cal-title">Calendar</h3><a class="db-mod-link" href="#calendar">Open Calendar →</a></div>
            <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
        </section>`;

    loadStockTrajectory();
    loadCumulativeSales();
    loadDashboardCalendar(config);
}

// ── Stock Trajectory chart ───────────────────────────────────────────────
// Projects kg-on-hand forward from /api/import/forecast — startingKg minus
// monthlyAvg demand each month plus shipments arriving in that month.
async function loadStockTrajectory() {
    const body = document.querySelector('#db-stock-trajectory .db-mod-body');
    if (!body) return;
    let cfg;
    try { cfg = await fetch('/api/import/forecast').then(r => r.ok ? r.json() : null); }
    catch { cfg = null; }
    if (!cfg) { body.innerHTML = '<p class="db-mod-empty">No forecast data.</p>'; return; }

    const monthlyAvg = Array.isArray(cfg.monthlyAvg) && cfg.monthlyAvg.length === 12
        ? cfg.monthlyAvg : new Array(12).fill(0);
    const shipments = Array.isArray(cfg.shipments) ? cfg.shipments : [];

    const HORIZON = 18; // months
    const now = new Date();
    const startYear  = now.getFullYear();
    const startMonth = now.getMonth();
    const labels = [];
    const stock  = [];
    const shipMarkers = {}; // ym → kg arriving

    for (const s of shipments) {
        const ym = String(s.ym || '');
        if (!ym) continue;
        shipMarkers[ym] = (shipMarkers[ym] || 0) + (Number(s.kg) || 0);
    }

    let kg = Number(cfg.startingKg) || 0;
    for (let i = 0; i < HORIZON; i++) {
        const d = new Date(startYear, startMonth + i, 1);
        const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        kg += (shipMarkers[ym] || 0);
        kg -= (monthlyAvg[d.getMonth()] || 0);
        labels.push(d.toLocaleString('en-NZ', { month: 'short', year: '2-digit' }));
        stock.push(Math.round(kg));
    }

    // Build shipment annotation points: x = month index, y = stock that month.
    const shipPoints = [];
    for (let i = 0; i < HORIZON; i++) {
        const d = new Date(startYear, startMonth + i, 1);
        const ym = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        if (shipMarkers[ym]) shipPoints.push({ x: labels[i], y: stock[i], kg: shipMarkers[ym] });
    }

    const id = 'db-stock-chart';
    window._chartQ[id] = {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Projected kg on hand',
                    data: stock,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.08)',
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 5,
                    tension: 0.25,
                    fill: true,
                },
                {
                    label: 'Shipment arrival',
                    data: labels.map(l => {
                        const m = shipPoints.find(p => p.x === l);
                        return m ? m.y : null;
                    }),
                    borderColor: 'transparent',
                    backgroundColor: '#10b981',
                    pointRadius: 7,
                    pointHoverRadius: 9,
                    pointStyle: 'triangle',
                    showLine: false,
                },
            ],
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'bottom', labels: { font: { size: 11 }, boxWidth: 14, padding: 10 } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            if (ctx.datasetIndex === 1 && ctx.parsed.y != null) {
                                const m = shipPoints.find(p => p.x === ctx.label);
                                return ` Shipment: +${(m?.kg || 0).toLocaleString('en-NZ')} kg`;
                            }
                            return ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString('en-NZ')} kg`;
                        },
                    },
                },
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#64748b' } },
                y: {
                    grid: { color: '#f1f5f9' },
                    ticks: { font: { size: 10 }, color: '#94a3b8', callback: v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v },
                },
            },
        },
    };
    body.innerHTML = `<div style="position:relative;height:280px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
    initCharts(body);
}

// ── Cumulative Sales chart ───────────────────────────────────────────────
// Reads /api/sales-history?rows=true → buckets each row's kg into its
// fiscal-year month (NZ FY ends 31 Mar) → cumulative running total per FY.
// Shows the current FY plus the two prior FYs.
async function loadCumulativeSales() {
    const body = document.querySelector('#db-cumulative-sales .db-mod-body');
    if (!body) return;
    let resp;
    try { resp = await fetch('/api/sales-history?rows=true').then(r => r.ok ? r.json() : null); }
    catch { resp = null; }
    const rows = (resp && resp.rows) || [];
    if (!rows.length) { body.innerHTML = '<p class="db-mod-empty">No sales history yet.</p>'; return; }

    // Bucket kg by (fyEndYear, fyMonthIdx 0..11 where 0=Apr).
    const fy = {};
    for (const r of rows) {
        const date = r.date || r.iso || '';
        if (!date) continue;
        const d = new Date(date);
        if (isNaN(d)) continue;
        const m = d.getMonth(); // 0..11 = Jan..Dec
        const fyEnd = m >= 3 ? d.getFullYear() + 1 : d.getFullYear();
        const idx   = m >= 3 ? m - 3 : m + 9;
        const kg = (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
        if (!fy[fyEnd]) fy[fyEnd] = new Array(12).fill(null);
        fy[fyEnd][idx] = (fy[fyEnd][idx] || 0) + kg;
    }

    // Pick the latest 3 FYs that have any data, oldest → newest.
    const fyYears = Object.keys(fy).map(Number).sort((a, b) => a - b);
    const recent  = fyYears.slice(-3);
    if (!recent.length) { body.innerHTML = '<p class="db-mod-empty">No sales history yet.</p>'; return; }

    const FY_MO = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
    const COLOURS = ['#cbd5e1', '#60a5fa', '#1d4ed8']; // oldest → newest

    // Cumulative running total, carry through null months (matches sales.js).
    const cumData = {};
    for (const yr of recent) {
        let run = 0;
        let started = false;
        cumData[yr] = (fy[yr] || []).map(v => {
            if (v != null) { run += v; started = true; return run; }
            return started ? run : null;
        });
    }

    const id = 'db-cumulative-chart';
    window._chartQ[id] = {
        type: 'line',
        data: {
            labels: FY_MO,
            datasets: recent.map((yr, i) => ({
                label: 'FY' + String(yr).slice(-2),
                data: cumData[yr],
                borderColor: COLOURS[i] || '#94a3b8',
                backgroundColor: 'transparent',
                borderWidth: i === recent.length - 1 ? 3 : 2,
                pointRadius: 3,
                pointHoverRadius: 6,
                pointBackgroundColor: COLOURS[i] || '#94a3b8',
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
    body.innerHTML = `<div style="position:relative;height:280px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
    initCharts(body);
}

// ── Calendar module ──────────────────────────────────────────────────────
// A month grid with clickable days. Clicking a day reveals its events in
// a side panel. Events come from /api/calendar/events (Google Calendar),
// shipments from /api/import/forecast, and statutory holidays/tax dates
// from config.json. Replaces the old "Next 14 days" list + "Next 28 days"
// strip with a single, more useful widget.

const _cal = { year: null, month: null, eventsByDate: {} };

function _calAddEvent(date, ev) {
    if (!_cal.eventsByDate[date]) _cal.eventsByDate[date] = [];
    _cal.eventsByDate[date].push(ev);
}

async function loadDashboardCalendar(config) {
    const body = document.querySelector('#db-calendar-module .db-mod-body');
    if (!body) return;
    const today = new Date();
    if (_cal.year === null) {
        _cal.year  = today.getFullYear();
        _cal.month = today.getMonth();
    }
    _cal.eventsByDate = {};

    // Pull events for the current month ± 1 day padding (grid extends).
    const monthStart = new Date(_cal.year, _cal.month, 1);
    const monthEnd   = new Date(_cal.year, _cal.month + 1, 0);
    const tMin = new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate() - 7).toISOString();
    const tMax = new Date(monthEnd.getFullYear(),   monthEnd.getMonth(),   monthEnd.getDate()   + 7).toISOString();

    const [forecast, gcalRes] = await Promise.all([
        fetch('/api/import/forecast').then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`/api/calendar/events?timeMin=${encodeURIComponent(tMin)}&timeMax=${encodeURIComponent(tMax)}`)
            .then(r => r.ok ? r.json() : { items: [] })
            .catch(() => ({ items: [] })),
    ]);

    // Statutory holidays / tax dates from config.json.
    (config?.calendar?.holidays || []).forEach(([date, label]) =>
        _calAddEvent(date, { type: 'holiday', label }));
    (config?.calendar?.taxDates || []).forEach(([date, labels]) => {
        for (const label of labels) _calAddEvent(date, { type: 'tax', label });
    });

    // Shipments from forecast + their milestones.
    (forecast?.shipments || []).forEach(s => {
        for (const m of (s.milestones || [])) {
            if (m.date) _calAddEvent(m.date.slice(0, 10), {
                type: 'shipment',
                label: `${s.note || s.id}: ${m.label}`,
            });
        }
        const ym = s.ym;
        if (ym && /^\d{4}-\d{2}$/.test(ym)) {
            // No specific date → put on the 1st of that month as "ETA".
            _calAddEvent(ym + '-01', { type: 'shipment', label: `${s.note || s.id} ETA (${(s.kg || 0).toLocaleString('en-NZ')} kg)` });
        }
    });

    // Google Calendar events.
    for (const ev of (gcalRes?.items || [])) {
        const dt = ev.start?.date || ev.start?.dateTime;
        if (!dt) continue;
        _calAddEvent(dt.slice(0, 10), { type: 'gcal', label: ev.summary || 'Event' });
    }

    _renderCalendarModule();
}

function _renderCalendarModule() {
    const body = document.querySelector('#db-calendar-module .db-mod-body');
    const title = document.getElementById('db-cal-title');
    if (!body) return;

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const monthLabel = `${MONTHS[_cal.month]} ${_cal.year}`;
    if (title) title.textContent = 'Calendar — ' + monthLabel;

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Build a Sun-start grid covering the whole month.
    const first = new Date(_cal.year, _cal.month, 1);
    const startDow = first.getDay(); // 0 = Sun
    const daysInMonth = new Date(_cal.year, _cal.month + 1, 0).getDate();
    const cells = [];

    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
        const date = `${_cal.year}-${String(_cal.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        cells.push({ d, date });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const dowHtml = DOW.map(d => `<div class="db-cal-dow">${d}</div>`).join('');

    const cellHtml = cells.map(c => {
        if (!c) return `<div class="db-cal-cell db-cal-cell--blank"></div>`;
        const events = _cal.eventsByDate[c.date] || [];
        const isToday = c.date === todayStr;
        const isWeekend = new Date(c.date).getDay() % 6 === 0;
        // Up to 3 type-coloured dots, then "+N" if more.
        const types = events.slice(0, 3).map(e => `<span class="db-cal-dot db-cal-dot--${e.type}"></span>`).join('');
        const extra = events.length > 3 ? `<span class="db-cal-more">+${events.length - 3}</span>` : '';
        const cls = [
            'db-cal-cell',
            isToday ? 'db-cal-cell--today' : '',
            isWeekend ? 'db-cal-cell--weekend' : '',
            events.length ? 'db-cal-cell--has' : '',
        ].filter(Boolean).join(' ');
        return `<div class="${cls}" data-date="${c.date}">
            <span class="db-cal-d">${c.d}</span>
            <div class="db-cal-dots">${types}${extra}</div>
        </div>`;
    }).join('');

    // Sidebar: events for the currently-selected day (defaults to today).
    const selDate = _cal.selectedDate || todayStr;
    const selEvents = _cal.eventsByDate[selDate] || [];
    const selLabel = new Date(selDate + 'T00:00').toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' });
    const sidebarHtml = selEvents.length
        ? selEvents.map(e => `<li class="db-cal-ev db-cal-ev--${e.type}"><span class="db-cal-ev-type">${e.type}</span><span class="db-cal-ev-label">${_ehDb(e.label)}</span></li>`).join('')
        : '<li class="db-cal-ev db-cal-ev--empty">Nothing scheduled.</li>';

    body.innerHTML = `
        <div class="db-cal-grid-wrap">
            <div class="db-cal-toolbar">
                <button type="button" class="db-cal-nav" id="db-cal-prev" title="Previous month">‹</button>
                <span class="db-cal-toolbar-label">${monthLabel}</span>
                <button type="button" class="db-cal-nav" id="db-cal-next" title="Next month">›</button>
                <button type="button" class="db-cal-today" id="db-cal-today">Today</button>
            </div>
            <div class="db-cal-grid">
                <div class="db-cal-dows">${dowHtml}</div>
                <div class="db-cal-cells">${cellHtml}</div>
            </div>
        </div>
        <aside class="db-cal-side">
            <div class="db-cal-side-hd">${selLabel}</div>
            <ul class="db-cal-list">${sidebarHtml}</ul>
        </aside>`;

    document.getElementById('db-cal-prev')?.addEventListener('click', () => {
        _cal.month--; if (_cal.month < 0) { _cal.month = 11; _cal.year--; }
        _cal.selectedDate = null;
        loadDashboardCalendar(currentConfig);
    });
    document.getElementById('db-cal-next')?.addEventListener('click', () => {
        _cal.month++; if (_cal.month > 11) { _cal.month = 0; _cal.year++; }
        _cal.selectedDate = null;
        loadDashboardCalendar(currentConfig);
    });
    document.getElementById('db-cal-today')?.addEventListener('click', () => {
        const t = new Date();
        _cal.year = t.getFullYear(); _cal.month = t.getMonth();
        _cal.selectedDate = todayStr;
        loadDashboardCalendar(currentConfig);
    });
    body.querySelectorAll('.db-cal-cell[data-date]').forEach(c => {
        c.addEventListener('click', () => {
            _cal.selectedDate = c.dataset.date;
            _renderCalendarModule();
        });
    });
}

function _ehDb(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Helpers ──
function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

// ── Reload button — hard reload to pick up new JS/CSS deployments ──
document.getElementById('reload-btn').addEventListener('click', () => { location.reload(); });

// ── Hash router ──
const VIEWS = ['view-dashboard', 'view-orders', 'view-orders-new', 'view-orders-detail', 'view-orders-edit', 'view-warehouse', 'view-admin', 'view-imports', 'view-dispatch-log', 'view-sales', 'view-calendar'];

function setActiveView(viewId) {
    VIEWS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === viewId ? '' : 'none';
    });
    // Remove slip-view class from detail container when navigating away
    if (viewId !== 'view-orders-detail') {
        document.getElementById('orders-detail-container')?.classList.remove('slip-view');
    }
    const topbar = document.getElementById('dashboard-topbar');
    if (topbar) topbar.style.display = viewId === 'view-dashboard' ? '' : 'none';
}

function setActiveNav(navId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const el = document.getElementById(navId);
    if (el) el.classList.add('active');
}

// Worker mode: a sticky UI restriction (not a security boundary — Cloudflare
// Access still gates the site). Set by visiting #worker once, cleared via
// #worker-exit. Persists across reloads so Andrew can share #worker with Jake
// and Jake never needs to navigate sidebar tabs again.
function applyWorkerModeClass() {
    const on = localStorage.getItem('hub-worker-mode') === '1';
    document.body.classList.toggle('body--worker', on);
}
applyWorkerModeClass();

// Role-based UI hiding. Cloudflare Access verifies identity at the edge;
// /api/me reads that and returns a role. Anything tagged .nav-item--admin-only
// is hidden when the user's role is not 'admin'.
let currentRole = 'admin';
async function applyRole() {
    try {
        const me = await fetch('/api/me').then(r => r.json());
        currentRole = me?.role || 'admin';
        document.body.classList.toggle('role-warehouse', currentRole === 'warehouse');
        // Warehouse role lands on orders, not dashboard.
        if (currentRole === 'warehouse' && (!location.hash || location.hash === '#dashboard')) {
            location.hash = 'orders';
        }
    } catch (_) { /* default admin */ }
}

async function handleRoute() {
    const hash = location.hash.replace(/^#\/?/, '');

    // Worker-mode toggles. These set the flag and bounce to the orders list
    // so the URL the user actually lands on is #orders (cleaner share link).
    if (hash === 'worker') {
        localStorage.setItem('hub-worker-mode', '1');
        applyWorkerModeClass();
        location.hash = 'orders';
        return;
    }
    if (hash === 'worker-exit') {
        localStorage.removeItem('hub-worker-mode');
        applyWorkerModeClass();
        location.hash = '';
        return;
    }

    // In worker mode (or warehouse role), only orders/* and dispatch-log are
    // reachable; any other hash bounces to orders. UI restriction only;
    // Cloudflare Access remains the actual security boundary at email level.
    const inWorkerMode = localStorage.getItem('hub-worker-mode') === '1';
    const restrictedRole = currentRole === 'warehouse';
    const allowedForRestricted = (h) => h.startsWith('orders') || h === 'dispatch-log';
    if ((inWorkerMode || restrictedRole) && hash && !allowedForRestricted(hash)) {
        location.hash = 'orders';
        return;
    }

    if (!hash || hash === 'dashboard') {
        if (inWorkerMode || restrictedRole) {
            location.hash = 'orders';
            return;
        }
        setActiveView('view-dashboard');
        setActiveNav('nav-dashboard');
        // Silently prefetch data-heavy tabs so they open instantly
        SalesView?.prefetch?.();
        Warehouse?.prefetchImports?.();
        return;
    }

    if (hash === 'orders') {
        setActiveView('view-orders');
        setActiveNav('nav-orders');
        await Orders.renderList(document.getElementById('orders-list-container'));
        Orders.handleXeroQueryParams();
        return;
    }

    if (hash === 'orders/new') {
        setActiveView('view-orders-new');
        setActiveNav('nav-orders');
        await Orders.renderNew(document.getElementById('orders-new-container'));
        return;
    }

    const editMatch = hash.match(/^orders\/([^/]+)\/edit$/);
    if (editMatch) {
        setActiveView('view-orders-edit');
        setActiveNav('nav-orders');
        await Orders.renderEdit(document.getElementById('orders-edit-container'), editMatch[1]);
        return;
    }

    if (hash.startsWith('orders/')) {
        const orderId = hash.slice('orders/'.length);
        // Admin's home for an order is the merged edit/preview view.
        // Warehouse stays on the slip-only view (no form, no admin actions).
        if (currentRole !== 'warehouse') {
            location.hash = 'orders/' + orderId + '/edit';
            return;
        }
        setActiveView('view-orders-detail');
        setActiveNav('nav-orders');
        await Orders.renderDetail(document.getElementById('orders-detail-container'), orderId);
        return;
    }

    if (hash === 'warehouse') {
        setActiveView('view-warehouse');
        setActiveNav('nav-warehouse');
        await Warehouse.render(document.getElementById('warehouse-container'));
        return;
    }

    if (hash === 'admin') {
        setActiveView('view-admin');
        setActiveNav('nav-admin');
        await Admin.renderAdmin(document.getElementById('admin-container'));
        return;
    }

    if (hash === 'imports') {
        setActiveView('view-imports');
        setActiveNav('nav-imports');
        await ImportsView.render(document.getElementById('imports-container'));
        return;
    }

    if (hash === 'dispatch-log') {
        setActiveView('view-dispatch-log');
        setActiveNav('nav-dispatch-log');
        await DispatchLog.render(document.getElementById('dispatch-log-container'));
        return;
    }

    if (hash === 'sales') {
        setActiveView('view-sales');
        setActiveNav('nav-sales');
        await SalesView.render(document.getElementById('sales-container'));
        return;
    }

    if (hash === 'calendar') {
        setActiveView('view-calendar');
        setActiveNav('nav-calendar');
        await CalendarView.render(document.getElementById('calendar-container'));
        return;
    }

    // Unknown hash — fall back to dashboard
    location.hash = '';
}

window.addEventListener('hashchange', handleRoute);

// ── Nav items ──
document.getElementById('nav-dashboard').addEventListener('click', e => {
    e.preventDefault();
    location.hash = '';
});

// Make Orders nav item active (it was nav-item--soon)
const ordersNavItem = document.querySelector('.nav-item--soon[data-phase="Phase 1"]');
if (ordersNavItem) {
    ordersNavItem.classList.remove('nav-item--soon');
    ordersNavItem.id = 'nav-orders';
    ordersNavItem.querySelector('.nav-soon-badge')?.remove();
    const ordersBadge = document.createElement('span');
    ordersBadge.className = 'nav-badge';
    ordersBadge.id = 'nav-orders-badge';
    ordersBadge.style.display = 'none';
    ordersNavItem.appendChild(ordersBadge);
    ordersNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'orders';
    });
}

// Make Warehouse nav item active (it was nav-item--soon Phase 2)
const warehouseNavItem = document.querySelector('.nav-item--soon[data-phase="Phase 2"]');
if (warehouseNavItem) {
    warehouseNavItem.classList.remove('nav-item--soon');
    warehouseNavItem.id = 'nav-warehouse';
    warehouseNavItem.querySelector('.nav-soon-badge')?.remove();
    warehouseNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'warehouse';
    });
}

document.getElementById('nav-admin')?.addEventListener('click', e => {
    e.preventDefault();
    location.hash = 'admin';
});

// Make Imports nav item active (Phase 5)
const importsNavItem = document.querySelector('.nav-item--soon[data-phase="Phase 5"]');
if (importsNavItem) {
    importsNavItem.classList.remove('nav-item--soon');
    importsNavItem.id = 'nav-imports';
    importsNavItem.querySelector('.nav-soon-badge')?.remove();
    importsNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'imports';
    });
}

// Make Sales History nav item active
const salesNavItem = document.querySelector('.nav-item--soon[data-phase="Sales"]');
if (salesNavItem) {
    salesNavItem.classList.remove('nav-item--soon');
    salesNavItem.id = 'nav-sales';
    salesNavItem.querySelector('.nav-soon-badge')?.remove();
    salesNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'sales';
    });
}

// Make Calendar nav item active
const calendarNavItem = document.querySelector('.nav-item--soon[data-phase="Calendar"]');
if (calendarNavItem) {
    calendarNavItem.classList.remove('nav-item--soon');
    calendarNavItem.id = 'nav-calendar';
    calendarNavItem.querySelector('.nav-soon-badge')?.remove();
    calendarNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'calendar';
    });
}

// Remaining coming-soon nav items
document.querySelectorAll('.nav-item--soon').forEach(el => {
    el.addEventListener('click', e => {
        e.preventDefault();
        const label = el.textContent.replace(/\s*Soon\s*/gi, '').trim();
        showToast(label + ' — ' + el.dataset.phase + ', coming soon');
    });
});

// ── GitHub version ──
async function fetchGitHubVersion() {
    const el = document.querySelector('.sidebar-version');
    if (!el) return;
    try {
        const d = await fetch('https://api.github.com/repos/Magenta-Apple-NZ/erp-lite/commits/main',
            { headers: { Accept: 'application/vnd.github.v3+json' } }).then(r => r.ok ? r.json() : null);
        if (!d?.sha) return;
        const sha  = d.sha.slice(0, 7);
        const date = (d.commit?.committer?.date || d.commit?.author?.date || '').slice(0, 10);
        el.textContent = date ? date + ' · ' + sha : sha;
    } catch (_) {}
}

// ── Init ──
loadConfig();
applyRole().then(handleRoute);
fetchGitHubVersion();
setTimeout(() => {
    SalesView?.prefetch?.();
    Warehouse?.prefetchImports?.();
}, 400);
