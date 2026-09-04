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

    // Layout: three columns — Sales/Stock charts (widest), Xero data, and the
    // calendar. Notification banners were removed (they duplicated the calendar);
    // the Notifications view + nav badge still surface them.
    el.innerHTML = `
        ${topRow}
        <div class="db-cols">
            <div class="db-col db-col--charts">
                <section class="db-mod db-mod--chart" id="db-stock-trajectory">
                    <div class="db-mod-hd"><h3 class="db-mod-title">Stock Trajectory <span class="chart-info" title="Projected kg-on-hand 18 months forward from the stocktake date. Bold line = active scenario (Average / Good / Great); faded lines are the other two for reference. Triangle markers are shipment arrivals. A red fill means stock goes below zero.">&#9432;</span></h3><a class="db-mod-link" href="#imports">Open Imports →</a></div>
                    <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
                </section>
                <section class="db-mod db-mod--chart" id="db-cumulative-sales">
                    <div class="db-mod-hd"><h3 class="db-mod-title">Cumulative Sales <span class="db-mod-sub">last 3 years</span> <span class="chart-info" title="Running total of kg sold within each year, up to the latest month with sales. Toggle Calendar (Jan→Dec, last 3 calendar years) vs Financial (NZ FY Apr→Mar, last 3 financial years). Compare year-on-year pace at a glance — the current line should sit on or above the prior years' curves at the same point if you're tracking ahead.">&#9432;</span></h3><a class="db-mod-link" href="#sales">Open Sales →</a></div>
                    <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
                </section>
            </div>
            <div class="db-col db-col--xero">
                <section class="db-mod db-mod--chart" id="db-xero-pnl">
                    <div class="db-mod-hd"><h3 class="db-mod-title">Profit &amp; Loss <span class="db-mod-sub">FY to date · Xero</span> <span class="chart-info" title="Income, expenses and net profit for the current NZ financial year to date (from Xero's Profit &amp; Loss report), compared with the same period last year. Bars = net profit by month across the financial year to date (Apr → Mar). Refreshed hourly.">&#9432;</span></h3><a class="db-mod-link" href="https://go.xero.com/app/!8QbL4/reports/profit-and-loss" target="_blank" rel="noopener">Open in Xero ↗</a></div>
                    <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
                </section>
            </div>
            <aside class="db-col db-col--cal">
                <section class="db-mod db-mod--cal" id="db-calendar-module">
                    <div class="db-mod-hd"><h3 class="db-mod-title" id="db-cal-title">Next ${DB_STRIP_DAYS} days <span class="chart-info" title="Timeline of the next ${DB_STRIP_DAYS} days. Dot colours: red = public holiday · amber = tax due date · green = shipment arrival or milestone · blue = Google Calendar event. Click a day for its events; the list underneath shows the next 10 events beyond that.">&#9432;</span></h3><a class="db-mod-link" href="#calendar">Open Calendar →</a></div>
                    <div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>
                </section>
            </aside>
        </div>`;

    // Delegate the two priority charts to the views that own them —
    // identical chart code, identical toggles (scenario for the
    // forecast; Cal/FY for cumulative sales).
    Warehouse.renderDashboardForecast(document.querySelector('#db-stock-trajectory .db-mod-body'));
    SalesView.renderDashboardCumulative(document.querySelector('#db-cumulative-sales .db-mod-body'));
    loadDashboardCalendar();
    loadDashboardPnl();
    loadDashboardAlerts();
}

// ── Xero P&L widget ──────────────────────────────────────────────────────
// Reads /api/xero/pnl (FY-to-date vs prior FY, plus 12 monthly net-profit
// bars). Degrades to a connect / reconnect prompt when Xero isn't linked
// or the token predates the reports scope.

const _pnlMoney = n => {
    const v = Math.round(Number(n) || 0);
    const abs = Math.abs(v);
    const s = abs >= 100000 ? (abs / 1000).toFixed(0) + 'k' : abs.toLocaleString('en-NZ');
    return (v < 0 ? '−$' : '$') + s;
};

// Accounts-receivable line for the Xero module (folded in from notifications).
function pnlArLine(xero) {
    if (!xero || !xero.unpaidCount) return '';
    const overdue = xero.overdueCount > 0
        ? `<span class="db-alert-badge db-alert-badge--red">${xero.overdueCount} overdue · ${_pnlMoney(xero.overdueTotal)}</span>` : '';
    return `<a class="db-pnl-ar${xero.overdueCount > 0 ? ' db-pnl-ar--overdue' : ''}" href="https://go.xero.com/AccountsReceivable/Search.aspx" target="_blank" rel="noopener">
        <span class="db-pnl-ar-label">Accounts receivable</span>
        <span class="db-pnl-ar-value"><strong>${xero.unpaidCount} unpaid</strong> · ${_pnlMoney(xero.unpaidTotal)} owed ${overdue}<span class="db-pnl-ar-arrow">↗</span></span>
    </a>`;
}

async function loadDashboardPnl() {
    const body = document.querySelector('#db-xero-pnl .db-mod-body');
    if (!body) return;
    let resp, data = {}, xeroAlerts = null;
    try {
        const [pnlR, alertsR] = await Promise.all([
            fetch('/api/xero/pnl'),
            fetch('/api/xero/alerts').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        resp = pnlR;
        data = await pnlR.json().catch(() => ({}));
        xeroAlerts = alertsR;
    } catch (e) {
        body.innerHTML = `<p class="db-mod-empty">Could not reach the Hub API.</p>`;
        return;
    }
    if (resp.status === 401) {
        body.innerHTML = `<p class="db-mod-empty">Xero not connected. <a href="/api/xero/auth">Connect Xero →</a></p>`;
        return;
    }
    if (data.needsReauth) {
        body.innerHTML = `<p class="db-mod-empty">Xero needs the <strong>Reports</strong> permission for this widget — <a href="/api/xero/auth">reconnect Xero →</a> (one-off).</p>`;
        return;
    }
    if (!resp.ok || !data.fy) {
        body.innerHTML = `<p class="db-mod-empty">P&amp;L unavailable${data.error ? ': ' + _notifEsc(data.error) : ''}.</p>`;
        return;
    }

    const fy = data.fy, prior = data.priorFy || {};
    const delta = (cur, prev) => {
        if (!prev) return '';
        const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
        const up = pct >= 0;
        return `<span class="db-pnl-delta ${up ? 'db-pnl-delta--up' : 'db-pnl-delta--down'}" title="vs same period ${_notifEsc(prior.label || 'last FY')}: ${_pnlMoney(prev)}">${up ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
    };
    const tile = (label, cur, prev, cls = '') => `
        <div class="db-pnl-tile ${cls}">
            <div class="db-pnl-label">${label}</div>
            <div class="db-pnl-value">${_pnlMoney(cur)}</div>
            <div class="db-pnl-sub">${delta(cur, prev)}</div>
        </div>`;

    const m = data.monthly || { labels: [], netProfit: [] };
    const chartId = 'db-pnl-chart';
    window._chartQ[chartId] = {
        type: 'bar',
        data: {
            labels: m.labels,
            datasets: [{
                label: 'Net profit',
                data: m.netProfit,
                backgroundColor: (m.netProfit || []).map(v => v >= 0 ? '#10b981' : '#ef4444'),
                borderRadius: 2, borderSkipped: false,
            }],
        },
        options: {
            animation: false, responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` Net profit: ${_pnlMoney(ctx.parsed.y)}` } },
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#64748b' } },
                y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10 }, color: '#94a3b8', callback: v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : v } },
            },
        },
    };

    body.innerHTML = `
        <div class="db-pnl-period">${_notifEsc(fy.label || 'FY to date')} · ${_notifEsc(fy.from || '')} → ${_notifEsc(fy.to || '')}</div>
        <div class="db-pnl-tiles${fy.cogs ? ' db-pnl-tiles--four' : ''}">
            ${tile('Income', fy.income, prior.income)}
            ${fy.cogs ? tile('Cost of sales', fy.cogs, prior.cogs, 'db-pnl-tile--exp') : ''}
            ${tile('Expenses', fy.expenses, prior.expenses, 'db-pnl-tile--exp')}
            ${tile('Net profit', fy.netProfit, prior.netProfit, fy.netProfit >= 0 ? 'db-pnl-tile--pos' : 'db-pnl-tile--neg')}
        </div>
        <div style="position:relative;height:150px;width:100%"><canvas data-chart-id="${chartId}"></canvas></div>
        ${pnlArLine(xeroAlerts)}`;
    initCharts(body);
}

// ── Notification system ──────────────────────────────────────────────────
// Shared data fetch + dismiss persistence for dashboard banner and #notifications view.

const _notifEsc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const NOTIF_DISMISS_KEY = 'hub-notif-dismissed';
const NOTIF_TTL = 86400000;            // 24h — ordinary notifications come back tomorrow
const NOTIF_STICKY_TTL = 180 * 86400000; // sticky ones stay dismissed (per occurrence) ~6 months

// Dismissals: { id: timestamp } for 24h items, { id: { ts, sticky: true } }
// for sticky reminders (calendar events like "Pay Suppliers" / tax dates)
// that must be dismissed by hand and never auto-return.
function notifGetDismissed() {
    try {
        const raw = JSON.parse(localStorage.getItem(NOTIF_DISMISS_KEY) || '{}');
        const now = Date.now();
        const clean = {};
        for (const [k, v] of Object.entries(raw)) {
            const sticky = v && typeof v === 'object' && v.sticky;
            const ts = typeof v === 'number' ? v : Number(v && v.ts) || 0;
            if (now - ts < (sticky ? NOTIF_STICKY_TTL : NOTIF_TTL)) clean[k] = v;
        }
        return clean;
    } catch { return {}; }
}
function notifDismiss(id, sticky = false) {
    const d = notifGetDismissed();
    d[id] = sticky ? { ts: Date.now(), sticky: true } : Date.now();
    localStorage.setItem(NOTIF_DISMISS_KEY, JSON.stringify(d));
}

// Local YYYY-MM-DD (toISOString would shift NZ evenings to the next UTC day).
const _ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function notifRestoreAll() {
    localStorage.removeItem(NOTIF_DISMISS_KEY);
}

async function confirmShipmentArrival(shipId) {
    try {
        const forecast  = await fetch('/api/import/forecast').then(r => r.json());
        const today     = new Date().toISOString().slice(0, 10);
        const shipments = (forecast.shipments || []).map(s => {
            if (s.id !== shipId) return s;
            // Mark the last milestone as done (that's what triggered the notification)
            const milestones = (s.milestones || []).map((m, i, arr) =>
                i === arr.length - 1 && !m.done
                    ? { ...m, done: true, date: m.date || today, confirmedAt: today }
                    : m
            );
            return { ...s, milestones };
        });
        const res = await fetch('/api/import/forecast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shipments }),
        });
        const j = await res.json();
        return j.ok === true;
    } catch { return false; }
}

async function fetchNotificationItems() {
    const [ordersRes, forecastRes] = await Promise.allSettled([
        fetch('/api/orders').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch('/api/import/forecast').then(r => r.ok ? r.json() : {}).catch(() => ({})),
    ]);
    const orders   = ordersRes.status   === 'fulfilled' ? ordersRes.value   : [];
    const forecast = forecastRes.status === 'fulfilled' ? forecastRes.value : {};

    const items = [];

    // 1. Orders pending Xero push
    const pendingPush = (orders || []).filter(o => !o.xeroInvoiceId && o.status !== 'cancelled');
    if (pendingPush.length) {
        items.push({
            id: 'orders-pending-xero',
            type: 'push',
            severity: 'info',
            icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>`,
            text: `<strong>${pendingPush.length} order${pendingPush.length === 1 ? '' : 's'}</strong> not yet sent to Xero`,
            link: '#orders',
            linkLabel: 'Open Orders →',
        });
    }

    // 2. Shipments — overdue and upcoming (≤60 days)
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + 60);
    const overdueShips = [], arrivingShips = [];
    for (const s of (forecast.shipments || [])) {
        const ms = s.milestones || [];
        const last = ms[ms.length - 1];
        if (last && last.date && !last.done) {
            const d = new Date(last.date + 'T00:00:00');
            const days = Math.round((d - today) / 86400000);
            if (days < 0) overdueShips.push({ seq: s.seq, id: s.id, label: last.label, days });
            else if (d <= cutoff) arrivingShips.push({ seq: s.seq, id: s.id, label: last.label, days });
        }
    }
    overdueShips.sort((a, b) => a.days - b.days);
    arrivingShips.sort((a, b) => a.days - b.days);

    for (const s of overdueShips) {
        const daysAgo = Math.abs(s.days);
        const when = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
        items.push({
            id: `shipment-overdue-${s.id}`,
            type: 'ship',
            severity: 'critical',
            icon: '🚢',
            text: `<strong>Shipment #${_notifEsc(s.seq)}</strong> ${_notifEsc(s.label)} was due ${when}`,
            link: `#imports/ship/${encodeURIComponent(s.id || '')}`,
            linkLabel: 'Open shipment →',
            confirmable: true,
            shipId: s.id,
        });
    }
    for (const s of arrivingShips) {
        const when = s.days === 0 ? 'today' : s.days === 1 ? 'tomorrow' : `in ${s.days} days`;
        items.push({
            id: `shipment-arriving-${s.id}`,
            type: 'ship',
            severity: 'warning',
            icon: '🚢',
            text: `<strong>Shipment #${_notifEsc(s.seq)}</strong> ${_notifEsc(s.label)} arriving ${when}`,
            link: `#imports/ship/${encodeURIComponent(s.id || '')}`,
            linkLabel: 'Open shipment →',
        });
    }

    // (Xero AR unpaid/overdue invoices now live in the dashboard Xero P&L
    //  module — see loadDashboardPnl — rather than as a notification.)

    // 3. Sticky calendar reminders — tax due dates and keyword-matched
    //    Google Calendar events (e.g. "Pay Suppliers"). Unlike the items
    //    above these persist until dismissed by hand, and a dismissal only
    //    covers that occurrence (next month's "Pay Suppliers" shows again).
    //    Keywords/lookahead live in config.json → notifications.
    try {
        const cfgN = (typeof currentConfig !== 'undefined' && currentConfig && currentConfig.notifications) || {};
        const keywords  = (cfgN.stickyEventKeywords || ['pay suppliers']).map(k => String(k).toLowerCase());
        const stickyTax = cfgN.stickyTaxDates !== false;
        const ahead = Number(cfgN.lookaheadDays) || 7;
        const back  = Number(cfgN.lookbackDays)  || 30;
        if (typeof CalendarView !== 'undefined' && CalendarView.loadEvents) {
            const { eventsByDate } = await CalendarView.loadEvents({ rangeDays: ahead + 1 });
            const todayStr = _ymd(today);
            const from = new Date(today); from.setDate(from.getDate() - back);
            const to   = new Date(today); to.setDate(to.getDate() + ahead);
            const fromStr = _ymd(from), toStr = _ymd(to);
            const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
            for (const date of Object.keys(eventsByDate).sort()) {
                if (date < fromStr || date > toStr) continue;
                for (const ev of eventsByDate[date]) {
                    const label = String(ev.label || '');
                    const isSticky = (ev.type === 'tax' && stickyTax) ||
                        (ev.type === 'gcal' && keywords.some(k => k && label.toLowerCase().includes(k)));
                    if (!isSticky) continue;
                    const d = new Date(date + 'T00:00:00');
                    const days = Math.round((d - today) / 86400000);
                    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow'
                        : days > 1 ? `in ${days} days`
                        : days === -1 ? 'yesterday' : `${Math.abs(days)} days ago`;
                    const dateLbl = d.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
                    items.push({
                        id: `cal-${ev.type}-${date}-${slug(label)}`,
                        type: 'cal',
                        sticky: true,
                        severity: days < 0 ? 'critical' : days <= 1 ? 'warning' : 'info',
                        icon: '📌',
                        text: `<strong>${_notifEsc(label)}</strong> · ${dateLbl} (${when})${days < 0 ? ' <span class="db-alert-badge db-alert-badge--red">overdue</span>' : ''}`,
                        link: ev.url || '#calendar',
                        linkLabel: ev.url ? 'Open event ↗' : 'Open Calendar →',
                        external: !!ev.url,
                    });
                }
            }
        }
    } catch (_) { /* calendar is optional — never block other notifications */ }

    return items;
}

function notifUpdateBadge(activeCount) {
    const badge = document.getElementById('notif-nav-badge');
    if (!badge) return;
    badge.textContent = activeCount || '';
    badge.hidden = !activeCount;
}

// Dashboard no longer renders notification banners (they duplicated the
// calendar). We still tally active notifications to keep the nav badge current;
// the full list lives in the Notifications view.
async function loadDashboardAlerts() {
    const [items, dismissed] = [await fetchNotificationItems(), notifGetDismissed()];
    const active = items.filter(n => !dismissed[n.id]);
    notifUpdateBadge(active.length);
}

async function loadNotificationsView(container) {
    container.innerHTML = '<div class="notif-loading">Loading…</div>';
    const [items, dismissed] = [await fetchNotificationItems(), notifGetDismissed()];

    const active = items.filter(n => !dismissed[n.id]);
    const dimCount = items.filter(n => dismissed[n.id]).length;
    notifUpdateBadge(active.length);

    if (!items.length) {
        container.innerHTML = `
            <div class="notif-page">
                <h2 class="notif-page-title">Notifications</h2>
                <div class="notif-empty">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                    <p>No active notifications</p>
                </div>
            </div>`;
        return;
    }

    const rows = active.map(n => `
        <div class="notif-row notif-row--${n.severity}" data-id="${_notifEsc(n.id)}">
            <span class="notif-row-icon">${n.icon}</span>
            <span class="notif-row-body">
                <span class="notif-row-text">${n.text}</span>
                <a class="notif-row-link" href="${n.link}"${n.external ? ' target="_blank" rel="noopener"' : ''}>${n.linkLabel}</a>
            </span>
            <span class="notif-row-actions">
                ${n.confirmable ? `<button class="notif-confirm-btn" data-ship-id="${_notifEsc(n.shipId)}" data-notif-id="${_notifEsc(n.id)}">✓ Confirm arrival</button>` : ''}
                <button class="notif-dismiss-btn" data-id="${_notifEsc(n.id)}" data-sticky="${n.sticky ? '1' : ''}" title="${n.sticky ? 'Dismiss (stays gone until the next occurrence)' : 'Dismiss for 24h'}">✕</button>
            </span>
        </div>`).join('');

    const footer = dimCount > 0
        ? `<div class="notif-footer"><button class="notif-restore-btn">${dimCount} dismissed — restore all</button></div>` : '';

    container.innerHTML = `
        <div class="notif-page">
            <h2 class="notif-page-title">Notifications</h2>
            <div class="notif-list">${rows}</div>
            ${footer}
        </div>`;

    container.querySelectorAll('.notif-confirm-btn').forEach(btn => {
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            btn.disabled = true;
            btn.textContent = 'Confirming…';
            const ok = await confirmShipmentArrival(btn.dataset.shipId);
            if (ok) {
                notifDismiss(btn.dataset.notifId);
                btn.closest('.notif-row').remove();
                notifUpdateBadge(container.querySelectorAll('.notif-row').length);
                if (!container.querySelectorAll('.notif-row').length) loadNotificationsView(container);
            } else {
                btn.disabled = false;
                btn.textContent = '✓ Confirm arrival';
            }
        });
    });

    container.querySelectorAll('.notif-dismiss-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            notifDismiss(btn.dataset.id, btn.dataset.sticky === '1');
            btn.closest('.notif-row').remove();
            const remaining = container.querySelectorAll('.notif-row').length;
            notifUpdateBadge(remaining);
            if (!remaining) loadNotificationsView(container);
        });
    });

    container.querySelector('.notif-restore-btn')?.addEventListener('click', () => {
        notifRestoreAll();
        loadNotificationsView(container);
    });
}

// ── Calendar module ──────────────────────────────────────────────────────
// A month grid with clickable days. Clicking a day reveals its events in
// a side panel. Events come from /api/calendar/events (Google Calendar),
// shipments from /api/import/forecast, and statutory holidays/tax dates
// from config.json. Replaces the old "Next 14 days" list + "Next 28 days"
// strip with a single, more useful widget.

// Dashboard calendar state. Events are loaded by CalendarView.loadEvents
// so the dedicated /calendar tab and this widget show identical data.
const _cal = {
    selectedDate: null,
    eventsByDate: {},
    availableTypes: ['holiday', 'tax', 'shipment'],
    toggles: null,  // initialised on first load to all availableTypes
};
// Days shown on the dashboard timeline strip. 14 fits the right-hand
// column without horizontal scrolling; the "next 10 events" list covers
// what lies beyond.
const DB_STRIP_DAYS = 14;

async function loadDashboardCalendar() {
    const body = document.querySelector('#db-calendar-module .db-mod-body');
    if (!body) return;
    if (typeof CalendarView === 'undefined' || !CalendarView.loadEvents) return;

    const { eventsByDate, availableTypes } = await CalendarView.loadEvents({ rangeDays: 60 });
    _cal.eventsByDate   = eventsByDate;
    _cal.availableTypes = availableTypes;
    if (!_cal.toggles) _cal.toggles = new Set(availableTypes);

    _renderCalendarModule();
}

function _renderCalendarModule() {
    const body = document.querySelector('#db-calendar-module .db-mod-body');
    if (!body) return;

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const selDate = _cal.selectedDate || todayStr;
    const visible = ev => _cal.toggles.has(ev.type);

    // Category-toggle bar — matches the dedicated /calendar view so a user
    // can hide e.g. shipments and just see holidays + GCal here too.
    const TYPE_LABELS = {
        holiday:  'Holidays',
        tax:      'Tax',
        shipment: 'Shipments',
        gcal:     'Google Cal',
    };
    const togglesHtml = _cal.availableTypes.map(t =>
        `<button type="button" class="db-cal-toggle${_cal.toggles.has(t) ? ' db-cal-toggle--on' : ''}" data-toggle="${t}">
            <span class="db-cal-toggle-dot db-cal-toggle-dot--${t}"></span>${TYPE_LABELS[t] || t}
        </button>`
    ).join('');

    // Primary: horizontal strip of the next DB_STRIP_DAYS days starting
    // today. Each cell shows the weekday + date and stacks event dots.
    const stripCells = [];
    for (let i = 0; i < DB_STRIP_DAYS; i++) {
        const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const events = (_cal.eventsByDate[date] || []).filter(visible);
        const dow = d.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const isToday = date === todayStr;
        const isSel = date === selDate;
        const dots = events.slice(0, 4).map(e => `<span class="db-strip-dot db-strip-dot--${e.type}"></span>`).join('');
        const extra = events.length > 4 ? `<span class="db-strip-more">+${events.length - 4}</span>` : '';
        const cls = [
            'db-strip-cell',
            isToday ? 'db-strip-cell--today' : '',
            isSel ? 'db-strip-cell--selected' : '',
            isWeekend ? 'db-strip-cell--weekend' : '',
            events.length ? 'db-strip-cell--has' : '',
        ].filter(Boolean).join(' ');
        stripCells.push(`<button type="button" class="${cls}" data-date="${date}">
            <span class="db-strip-dow">${'SMTWTFS'[dow]}</span>
            <span class="db-strip-dom">${d.getDate()}</span>
            <span class="db-strip-dots">${dots}${extra}</span>
        </button>`);
    }

    // Render one event as a clickable row when there's somewhere to go
    // (a shipment id → Imports detail, or a Google Calendar htmlLink).
    function evRow(e, dateLbl) {
        const inner = (dateLbl ? `<span class="db-cal-ev-date">${dateLbl}</span>` : '') +
            `<span class="db-cal-ev-label">${_ehDb(e.label)}</span>` +
            (!dateLbl ? `<span class="db-cal-ev-type">${e.type}</span>` : '');
        const cls = `db-cal-ev db-cal-ev--${e.type}`;
        if (e.shipId) {
            return `<li class="${cls} db-cal-ev--link"><a href="#imports/ship/${encodeURIComponent(e.shipId)}">${inner}</a></li>`;
        }
        if (e.url) {
            return `<li class="${cls} db-cal-ev--link"><a href="${_ehDb(e.url)}" target="_blank" rel="noopener">${inner} ↗</a></li>`;
        }
        return `<li class="${cls}">${inner}</li>`;
    }

    // Events list for the selected day (filtered by active toggles).
    const selEvents = (_cal.eventsByDate[selDate] || []).filter(visible);
    const selLabel = new Date(selDate + 'T00:00').toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' });
    const eventsHtml = selEvents.length
        ? selEvents.map(e => evRow(e, null)).join('')
        : '<li class="db-cal-ev db-cal-ev--empty">Nothing scheduled.</li>';

    // Next 10 events from today onwards (filtered), ordered chronologically.
    const upcoming = Object.keys(_cal.eventsByDate)
        .filter(d => d >= todayStr)
        .sort()
        .flatMap(d => _cal.eventsByDate[d].filter(visible).map(ev => ({ date: d, ...ev })))
        .slice(0, 10);
    const upcomingHtml = upcoming.length
        ? upcoming.map(e => {
            const d = new Date(e.date + 'T00:00');
            const dayLbl = e.date === todayStr
                ? 'Today'
                : d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
            return evRow(e, dayLbl);
        }).join('')
        : '<li class="db-cal-ev db-cal-ev--empty">No events in range.</li>';

    body.innerHTML = `
        <div class="db-cal-toggles">${togglesHtml}</div>
        <div class="db-strip-scroller">${stripCells.join('')}</div>
        <div class="db-cal-panels">
            <div class="db-cal-events">
                <div class="db-cal-events-hd">${selLabel}</div>
                <ul class="db-cal-list">${eventsHtml}</ul>
            </div>
            <div class="db-cal-events">
                <div class="db-cal-events-hd">Next 10 events</div>
                <ul class="db-cal-list">${upcomingHtml}</ul>
            </div>
        </div>`;

    body.querySelectorAll('.db-strip-cell[data-date]').forEach(c => {
        c.addEventListener('click', () => {
            _cal.selectedDate = c.dataset.date;
            _renderCalendarModule();
        });
    });
    body.querySelectorAll('.db-cal-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const t = btn.dataset.toggle;
            if (_cal.toggles.has(t)) _cal.toggles.delete(t);
            else _cal.toggles.add(t);
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
const VIEWS = ['view-dashboard', 'view-orders', 'view-orders-new', 'view-orders-detail', 'view-orders-edit', 'view-warehouse', 'view-admin', 'view-imports', 'view-payslips', 'view-sales', 'view-calendar', 'view-notifications'];

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

    // In worker mode (or warehouse role), only orders/* and payslips are
    // reachable; any other hash bounces to orders. UI restriction only;
    // Cloudflare Access remains the actual security boundary at email level.
    const inWorkerMode = localStorage.getItem('hub-worker-mode') === '1';
    const restrictedRole = currentRole === 'warehouse';
    const allowedForRestricted = (h) => h.startsWith('orders') || h === 'payslips';
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

    const shipMatch = hash.match(/^imports\/ship\/(.+)$/);
    if (hash === 'imports' || shipMatch) {
        setActiveView('view-imports');
        setActiveNav('nav-imports');
        document.getElementById('imports-container').style.display = '';
        document.getElementById('lc-container').style.display = 'none';
        if (shipMatch && typeof Warehouse !== 'undefined') {
            Warehouse._pendingShipId = decodeURIComponent(shipMatch[1]);
        }
        await ImportsView.render(document.getElementById('imports-container'));
        return;
    }

    if (hash === 'lc' || hash.startsWith('lc/')) {
        setActiveView('view-imports');
        setActiveNav('nav-imports');
        document.getElementById('imports-container').style.display = 'none';
        document.getElementById('lc-container').style.display = '';
        const subpath = hash.startsWith('lc/') ? hash.slice(3) : '';
        await LC.render(document.getElementById('lc-container'), subpath);
        return;
    }

    if (hash === 'payslips' || hash === 'dispatch-log') {
        setActiveView('view-payslips');
        setActiveNav('nav-payslips');
        await Payslips.render(document.getElementById('payslips-container'));
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

    if (hash === 'notifications') {
        setActiveView('view-notifications');
        setActiveNav('nav-notifications');
        await loadNotificationsView(document.getElementById('notifications-container'));
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

document.getElementById('nav-warehouse')?.addEventListener('click', e => {
    e.preventDefault();
    location.hash = 'warehouse';
});

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
