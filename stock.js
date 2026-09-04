// ── Stock module ──
// Warehouse → Dashboard + Counts, and Admin → Stock (items, packaging recipes,
// engine settings). Everything reads /api/stock/* — see Stock-Rebuild.md.
// The one dashboard call is /api/stock/levels; nothing here does stock maths.

const Stock = (() => {

    async function api(path, opts = {}) {
        const { timeout = 25000, ...rest } = opts;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        let resp;
        try {
            resp = await fetch(path, { ...rest, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', ...(rest.headers || {}) } });
        } catch (e) {
            clearTimeout(t);
            throw new Error(e.name === 'AbortError' ? 'Request timed out' : 'Network error');
        }
        clearTimeout(t);
        const data = await resp.json().catch(() => ({ error: resp.statusText }));
        if (!resp.ok) { const err = new Error(data.error || resp.statusText); err.data = data; throw err; }
        return data;
    }
    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg; t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }
    const nzToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
    function fmtDate(ymd) {
        if (!ymd) return '—';
        const [y, m, d] = String(ymd).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    function fmtNum(n, dp = 0) {
        if (n == null || n === '' || isNaN(Number(n))) return '—';
        return Number(n).toLocaleString('en-NZ', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
    }
    function fmtQty(n, unit, dp) {
        if (n == null) return '—';
        const v = Number(n);
        const d = dp != null ? dp : (Number.isInteger(v) ? 0 : 1);
        return fmtNum(v, d) + (unit === 'kg' ? ' kg' : '');
    }
    const unitWord = (u, n) => u === 'kg' ? 'kg' : (Math.abs(Number(n)) === 1 ? 'unit' : 'units');

    // Reserved status palette — icon + label always, never colour alone.
    const STATUS = {
        ok:       { label: 'OK',       icon: '✓' },
        watch:    { label: 'Watch',    icon: '◔' },
        low:      { label: 'Low',      icon: '▲' },
        critical: { label: 'Critical', icon: '‼' },
        out:      { label: 'Out',      icon: '✕' },
        unknown:  { label: 'Unknown',  icon: '?' },
    };
    function statusChip(lv) {
        const s = STATUS[lv.status] || STATUS.unknown;
        const covered = lv.covered && lv.coveredBy
            ? ` <span class="stk2-covered" title="${escHtml(lv.coveredBy.note)} · ${fmtQty(lv.coveredBy.kg, 'kg')} due ${fmtDate(lv.coveredBy.eta)}">· ${fmtNum(lv.coveredBy.kg)} arriving ${fmtDate(lv.coveredBy.eta)}</span>`
            : '';
        const why = lv.status === 'unknown'
            ? (lv.onHand == null ? 'No committed count for this item yet' : 'No usage in the window and no manual reorder point')
            : '';
        return `<span class="stk2-chip stk2-chip--${escHtml(lv.status)}" title="${escHtml(why)}"><span class="stk2-chip-ico" aria-hidden="true">${s.icon}</span>${s.label}</span>${covered}`;
    }

    const isDark = () => document.documentElement.dataset.theme === 'dark'
        || (!document.documentElement.dataset.theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const palette = () => isDark()
        ? { accent: '#3987e5', dim: '#5a5a57', ink: '#c3c2b7', grid: '#2c2c2a', base: '#383835', warn: '#fab219', annot: '#9085e9' }
        : { accent: '#2a78d6', dim: '#c3c2b7', ink: '#52514e', grid: '#e1e0d9', base: '#c3c2b7', warn: '#fab219', annot: '#4a3aa7' };

    // ════════════════════════════════════════════════════════════════════
    //  WAREHOUSE — Dashboard + Counts
    // ════════════════════════════════════════════════════════════════════
    async function renderWarehouse(container, initialTab = 'dashboard') {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Warehouse</h1>
                <p class="view-subtitle">Stock on hand per item, reorder alerts, and physical counts. Items, packaging recipes and settings live in <a href="#admin">Catalogue → Stock</a>.</p>
            </div>
        </div>
        <div class="imp-tabs">
            <button class="imp-view-btn" data-stk-tab="dashboard">Dashboard</button>
            <button class="imp-view-btn" data-stk-tab="counts">Counts</button>
        </div>
        <div id="stk2-body"><div class="orders-loading">Loading…</div></div>`;
        const body = container.querySelector('#stk2-body');
        const switchTab = tab => {
            container.querySelectorAll('[data-stk-tab]').forEach(b => b.classList.toggle('active', b.dataset.stkTab === tab));
            if (tab === 'counts') renderCounts(body); else renderDashboard(body);
        };
        container.querySelectorAll('[data-stk-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.stkTab)));
        switchTab(initialTab);
    }

    // ── Dashboard ──
    let trajectoryChart = null;
    async function renderDashboard(body) {
        body.innerHTML = '<div class="orders-loading">Loading stock levels…</div>';
        let lv;
        try { lv = await api('/api/stock/levels'); }
        catch (e) { body.innerHTML = `<p class="cat-sub" style="padding:1rem">Could not load stock levels: ${escHtml(e.message)}</p>`; return; }

        if (lv.beforeEpoch) {
            body.innerHTML = `<div class="cat-section"><h2 class="cat-title">Before the stock epoch</h2>
                <p class="cat-sub">The stock engine starts on <strong>${fmtDate(lv.stockEpoch)}</strong>. Take and commit the opening count on that date under <strong>Counts</strong>.</p></div>`;
            return;
        }
        const key = lv.items.filter(i => i.key);
        const rest = lv.items.filter(i => !i.key);
        const products = rest.filter(i => i.class === 'product');
        const consumables = rest.filter(i => i.class === 'consumable');
        const noCount = lv.items.every(i => i.onHand == null);

        body.innerHTML = `
        ${noCount ? `<div class="stk2-notice">No committed count yet — every item reads <strong>Unknown</strong> until you commit one under <strong>Counts</strong>.</div>` : ''}
        ${lv.rowsWithoutXkg ? `<div class="stk2-notice stk2-notice--warn">${lv.rowsWithoutXkg} sales row${lv.rowsWithoutXkg === 1 ? '' : 's'} in the last ${lv.windowDays} days carry no type×size split, so packaging burn is understated for them.</div>` : ''}
        <div class="stk2-kpis">${key.map(kpiTile).join('')}</div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Trajectory <span class="cat-sub" style="font-weight:400">· on hand, last 90 days</span></h2>
                    <p class="cat-sub" style="margin:0">Selected product in blue; others dimmed. Dashed line is the reorder point. Incoming shipments are listed, not stacked.</p>
                </div>
                <div class="stk2-traj-ctl">
                    ${key.map((k, i) => `<button class="imp-view-btn${i === 0 ? ' active' : ''}" data-traj="${escHtml(k.id)}">${escHtml(k.name)}</button>`).join('')}
                    <button class="imp-view-btn" id="stk2-traj-table-btn" title="Show the numbers">Table</button>
                </div>
            </div>
            <div class="stk2-traj-wrap"><canvas id="stk2-traj" height="220"></canvas></div>
            <div id="stk2-traj-table" hidden></div>
            <div id="stk2-traj-foot" class="cat-sub"></div>
        </div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Consumables</h2>
                    <p class="cat-sub" style="margin:0">Packaging burnt through the recipes on each order. Sorted worst first. Meter shows on hand against the reorder point.</p>
                </div>
                <div class="cat-sub">As at ${fmtDate(lv.asOf)} · usage over ${lv.windowDays} days</div>
            </div>
            ${levelsTable(consumables.concat(products), lv)}
        </div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Adjustments &amp; wastage</h2>
                    <p class="cat-sub" style="margin:0">Append-only ledger. To undo one, post a correction that offsets it.</p>
                </div>
            </div>
            <form id="stk2-mov-form" class="stk2-form-row">
                <select name="itemId" required>${lv.items.map(i => `<option value="${escHtml(i.id)}">${escHtml(i.name)} (${i.unit})</option>`).join('')}</select>
                <select name="type"><option value="wastage">Wastage (−)</option><option value="adjustment">Adjustment (±)</option><option value="correction">Correction (±)</option></select>
                <input name="qty" type="number" step="any" placeholder="Qty" required style="width:110px">
                <input name="date" type="date" value="${nzToday()}" min="${escHtml(lv.stockEpoch)}" required>
                <input name="reason" type="text" placeholder="Reason" style="flex:1;min-width:160px">
                <button class="btn-primary btn-sm" type="submit">Post</button>
            </form>
            <div id="stk2-movs"></div>
        </div>`;

        // KPI sparklines + trajectory: one history call per key product.
        const histories = {};
        await Promise.all(key.map(async k => {
            try { histories[k.id] = await api(`/api/stock/items/${encodeURIComponent(k.id)}/history`); } catch { histories[k.id] = null; }
        }));
        for (const k of key) {
            const el = body.querySelector(`.stk2-tile[data-item="${CSS.escape(k.id)}"] .stk2-spark`);
            if (el && histories[k.id]?.series) el.innerHTML = sparklineSvg(histories[k.id].series);
        }
        let selected = key[0]?.id || null;
        const drawTraj = () => {
            const k = key.find(x => x.id === selected);
            drawTrajectory(body.querySelector('#stk2-traj'), key, histories, selected, lv);
            const foot = body.querySelector('#stk2-traj-foot');
            const pend = lv.pendingShipments.filter(p => p.itemId === selected);
            foot.innerHTML = pend.length
                ? `Incoming for ${escHtml(k?.name || '')}: ` + pend.map(p => `<strong>${escHtml(p.note)}</strong> ${fmtQty(p.kg, 'kg')} · ${escHtml(p.status)} · due ${fmtDate(p.eta)}`).join(' &nbsp;·&nbsp; ')
                : (k ? `No shipments on order for ${escHtml(k.name)}.` : '');
            body.querySelector('#stk2-traj-table').innerHTML = trajectoryTable(key, histories);
        };
        body.querySelectorAll('[data-traj]').forEach(b => b.addEventListener('click', () => {
            selected = b.dataset.traj;
            body.querySelectorAll('[data-traj]').forEach(x => x.classList.toggle('active', x === b));
            drawTraj();
        }));
        body.querySelector('#stk2-traj-table-btn').addEventListener('click', e => {
            const t = body.querySelector('#stk2-traj-table');
            t.hidden = !t.hidden; e.currentTarget.classList.toggle('active', !t.hidden);
        });
        drawTraj();

        // Movements
        const loadMovs = async () => {
            const wrap = body.querySelector('#stk2-movs');
            try {
                const rows = (await api('/api/stock/movements')).slice(0, 15);
                const names = Object.fromEntries(lv.items.map(i => [i.id, i]));
                wrap.innerHTML = rows.length ? `
                <table class="stk-table stk2-table" style="margin-top:0.75rem">
                    <thead><tr><th>Date</th><th>Item</th><th>Type</th><th style="text-align:right">Qty</th><th>Reason</th><th>By</th></tr></thead>
                    <tbody>${rows.map(m => `<tr>
                        <td>${fmtDate(m.date)}</td><td>${escHtml(names[m.itemId]?.name || m.itemId)}</td><td>${escHtml(m.type)}</td>
                        <td style="text-align:right;font-variant-numeric:tabular-nums">${m.qty > 0 ? '+' : ''}${fmtQty(m.qty, m.unit)}</td>
                        <td>${escHtml(m.reason)}</td><td class="cat-sub">${escHtml(String(m.createdBy || '').split('@')[0])}</td></tr>`).join('')}</tbody>
                </table>` : '<p class="cat-sub" style="margin-top:0.75rem">No movements yet.</p>';
            } catch (e) { wrap.innerHTML = `<p class="cat-sub">${escHtml(e.message)}</p>`; }
        };
        loadMovs();
        body.querySelector('#stk2-mov-form').addEventListener('submit', async e => {
            e.preventDefault();
            const f = e.currentTarget;
            const payload = { itemId: f.itemId.value, type: f.type.value, qty: Number(f.qty.value), date: f.date.value, reason: f.reason.value };
            try {
                await api('/api/stock/movements', { method: 'POST', body: JSON.stringify(payload) });
                showToast('Movement posted');
                renderDashboard(body);
            } catch (err) { showToast('Could not post: ' + err.message); }
        });
    }

    function kpiTile(lv) {
        const unknown = lv.onHand == null;
        const cover = lv.daysCover == null ? (unknown ? 'No committed count yet' : 'No usage in window') : `${fmtNum(lv.daysCover / 7, 1)} wk cover · ${fmtNum(lv.avgDaily, 1)} ${lv.unit}/day`;
        return `
        <div class="stk2-tile" data-item="${escHtml(lv.id)}">
            <div class="stk2-tile-label">${escHtml(lv.name)}</div>
            <div class="stk2-tile-value">${unknown ? '<span class="stk2-tile-unknown">—</span>' : `${fmtNum(lv.onHand)}<span class="stk2-tile-unit">${lv.unit}</span>`}</div>
            <div class="stk2-tile-sub">${escHtml(cover)}${lv.onOrder ? ` · <span title="On order — not included in on hand">${fmtNum(lv.onOrder)} ${lv.unit} on order</span>` : ''}</div>
            <div class="stk2-tile-foot">${statusChip(lv)}<div class="stk2-spark" aria-hidden="true"></div></div>
            ${lv.baselineDate ? `<div class="stk2-tile-base">Counted ${fmtDate(lv.baselineDate)}${lv.reorderPoint != null ? ` · reorder at ${fmtNum(lv.reorderPoint)}` : ''}</div>` : ''}
        </div>`;
    }

    // 90-point sparkline: de-emphasis line, current point in the accent.
    function sparklineSvg(series) {
        const pts = series.filter(p => p.onHand != null);
        if (pts.length < 2) return '';
        const W = 120, H = 32, pad = 3;
        const vals = pts.map(p => p.onHand);
        const min = Math.min(...vals), max = Math.max(...vals);
        const span = max - min || 1;
        const x = i => pad + (i / (pts.length - 1)) * (W - pad * 2);
        const y = v => H - pad - ((v - min) / span) * (H - pad * 2);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.onHand).toFixed(1)}`).join('');
        const last = pts[pts.length - 1];
        return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.45"/><circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.onHand).toFixed(1)}" r="3" class="stk2-spark-dot"/></svg>`;
    }

    function drawTrajectory(canvas, key, histories, selectedId, lv) {
        if (!canvas || typeof Chart === 'undefined') return;
        const p = palette();
        const base = histories[selectedId]?.series || Object.values(histories).find(h => h?.series)?.series || [];
        const labels = base.map(s => s.date);
        const sel = lv.items.find(i => i.id === selectedId);
        const datasets = key.map(k => {
            const h = histories[k.id];
            const on = k.id === selectedId;
            return {
                label: k.name,
                data: labels.map(d => h?.series?.find(s => s.date === d)?.onHand ?? null),
                borderColor: on ? p.accent : p.dim, borderWidth: on ? 2 : 1.5,
                pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: on ? p.accent : p.dim,
                tension: 0, spanGaps: false, order: on ? 0 : 1,
            };
        });
        const annotations = {};
        if (sel && sel.reorderPoint != null && sel.reorderPoint > 0) {
            annotations.reorder = { type: 'line', yMin: sel.reorderPoint, yMax: sel.reorderPoint, borderColor: p.warn, borderDash: [6, 4], borderWidth: 1.5,
                label: { display: true, content: 'Reorder ' + fmtNum(sel.reorderPoint), position: 'start', backgroundColor: 'transparent', color: p.ink, font: { size: 11 } } };
        }
        (histories[selectedId]?.events || []).forEach((ev, i) => {
            if (!labels.includes(ev.date) || ev.kind === 'count') return;
            annotations['ev' + i] = { type: 'line', xMin: ev.date, xMax: ev.date, borderColor: p.annot, borderWidth: 1, borderDash: [2, 3],
                label: { display: true, content: `${ev.kind === 'receipt' ? 'Received' : ev.kind} ${ev.qty > 0 ? '+' : ''}${fmtNum(ev.qty)}`, position: 'end', backgroundColor: 'transparent', color: p.ink, font: { size: 10 }, rotation: -90 } };
        });
        if (trajectoryChart) { trajectoryChart.destroy(); trajectoryChart = null; }
        trajectoryChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { boxWidth: 10, boxHeight: 2, color: p.ink, font: { size: 11 }, usePointStyle: false } },
                    tooltip: { callbacks: { title: it => fmtDate(it[0].label), label: it => ` ${it.dataset.label}: ${it.raw == null ? '—' : fmtNum(it.raw) + ' ' + (sel?.unit || 'kg')}` } },
                    annotation: { annotations },
                },
                scales: {
                    x: { grid: { display: false }, border: { color: p.base }, ticks: { color: p.ink, maxTicksLimit: 7, callback: (v, i) => { const d = labels[i]; return d ? fmtDate(d).replace(/ \d{4}$/, '') : ''; } } },
                    y: { beginAtZero: true, grid: { color: p.grid }, border: { display: false }, ticks: { color: p.ink, callback: v => fmtNum(v) }, title: { display: true, text: sel?.unit || 'kg', color: p.ink } },
                },
            },
        });
    }

    function trajectoryTable(key, histories) {
        const any = Object.values(histories).find(h => h?.series);
        if (!any) return '';
        const dates = any.series.map(s => s.date);
        const step = Math.max(1, Math.floor(dates.length / 15));
        const rows = dates.filter((_, i) => i % step === 0 || i === dates.length - 1);
        return `<div class="stk-table-wrap"><table class="stk-table stk2-table"><thead><tr><th>Date</th>${key.map(k => `<th style="text-align:right">${escHtml(k.name)} (${k.unit})</th>`).join('')}</tr></thead>
        <tbody>${rows.map(d => `<tr><td>${fmtDate(d)}</td>${key.map(k => `<td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(histories[k.id]?.series?.find(s => s.date === d)?.onHand)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }

    function meter(lv) {
        if (lv.onHand == null) return '<div class="stk2-meter stk2-meter--na" title="No count yet"></div>';
        const rp = lv.reorderPoint;
        const max = Math.max(lv.onHand, rp != null ? rp * 2 : 0, 1);
        const fill = Math.max(0, Math.min(100, (lv.onHand / max) * 100));
        const mark = rp != null ? Math.min(100, (rp / max) * 100) : null;
        return `<div class="stk2-meter" title="${fmtQty(lv.onHand, lv.unit)} on hand${rp != null ? ' · reorder at ' + fmtQty(rp, lv.unit) : ''}">
            <div class="stk2-meter-fill stk2-meter--${escHtml(lv.status)}" style="width:${fill.toFixed(1)}%"></div>
            ${mark != null ? `<div class="stk2-meter-mark" style="left:${mark.toFixed(1)}%"></div>` : ''}
        </div>`;
    }

    function levelsTable(items, lv) {
        if (!items.length) return '<p class="cat-sub">No consumables yet — add them under Catalogue → Stock.</p>';
        return `<div class="stk-table-wrap"><table class="stk-table stk2-table stk2-levels">
            <thead><tr><th>Item</th><th style="min-width:160px">On hand</th><th style="text-align:right">Qty</th><th style="text-align:right">Cover</th><th style="text-align:right">Reorder at</th><th style="text-align:right">Lead</th><th>Status</th><th style="text-align:right">On order</th></tr></thead>
            <tbody>${items.map(i => `<tr class="stk2-row--${escHtml(i.status)}">
                <td><strong>${escHtml(i.name)}</strong><div class="cat-sub" style="margin:0">${i.baselineDate ? 'counted ' + fmtDate(i.baselineDate) : 'not counted'}</div></td>
                <td>${meter(i)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtQty(i.onHand, i.unit)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${i.daysCover == null ? '—' : fmtNum(i.daysCover) + ' d'}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums" title="${i.reorderMode === 'manual' ? 'Manual reorder point' : 'Auto: avg daily × (lead time + safety days)'}">${i.reorderPoint == null ? '—' : fmtNum(i.reorderPoint)}${i.reorderMode === 'manual' ? '' : ' <span class="cat-sub">auto</span>'}</td>
                <td style="text-align:right">${i.leadTimeDays ? i.leadTimeDays + ' d' : '—'}</td>
                <td>${statusChip(i)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${i.onOrder ? fmtQty(i.onOrder, i.unit) : '—'}</td>
            </tr>`).join('')}</tbody></table></div>`;
    }

    // ── Counts ──
    async function renderCounts(body) {
        body.innerHTML = '<div class="orders-loading">Loading counts…</div>';
        let counts = [], legacy = [], settings = {};
        try { [counts, settings] = await Promise.all([api('/api/stock/counts'), api('/api/stock/settings')]); }
        catch (e) { body.innerHTML = `<p class="cat-sub" style="padding:1rem">${escHtml(e.message)}</p>`; return; }
        try { legacy = await api('/api/stocktake'); } catch { legacy = []; }

        body.innerHTML = `
        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Counts</h2>
                    <p class="cat-sub" style="margin:0">A committed count is the baseline every item runs from. Counts are as-at end of day; sales that day are already inside them.</p>
                </div>
                <form id="stk2-new-count" class="stk2-form-row">
                    <input name="date" type="date" value="${nzToday()}" min="${escHtml(settings.stockEpoch || '')}" required>
                    <input name="label" type="text" placeholder="Label, e.g. Opening count" style="width:200px">
                    <button class="btn-primary btn-sm" type="submit">New count</button>
                </form>
            </div>
            ${counts.length ? `<table class="stk-table stk2-table"><thead><tr><th>Date</th><th>Label</th><th>Status</th><th></th></tr></thead><tbody>
                ${counts.map(c => `<tr>
                    <td>${fmtDate(c.date)}</td><td>${escHtml(c.label)}</td>
                    <td>${c.status === 'committed' ? `<span class="stk2-chip stk2-chip--ok"><span class="stk2-chip-ico">✓</span>Committed</span>` : `<span class="stk2-chip stk2-chip--unknown"><span class="stk2-chip-ico">✎</span>Draft</span>`}</td>
                    <td style="text-align:right;white-space:nowrap">
                        <button class="btn-secondary btn-sm" data-open="${escHtml(c.id)}">${c.status === 'committed' ? 'View' : 'Continue'}</button>
                        ${c.status === 'committed' ? `<a class="btn-secondary btn-sm" href="/api/stock/counts/${encodeURIComponent(c.id)}/valuation?format=csv" download>Valuation CSV</a>` : `<button class="btn-secondary btn-sm stk2-danger" data-del="${escHtml(c.id)}">Delete</button>`}
                    </td></tr>`).join('')}</tbody></table>` : '<p class="cat-sub">No counts yet. Create the opening count for the epoch date and commit it.</p>'}
        </div>
        <div id="stk2-count-editor"></div>
        ${legacy.length ? `<details class="cat-section stk2-section stk2-archive"><summary class="cat-title">Archive · legacy stocktakes (${legacy.length})</summary>
            <p class="cat-sub">Read-only dollar snapshots from the old module, kept for prior-year valuations. They don't feed the stock engine.</p>
            <table class="stk-table stk2-table"><thead><tr><th>Date</th><th>Label</th><th style="text-align:right">Total (ex GST)</th><th></th></tr></thead><tbody>
            ${legacy.map(s => `<tr><td>${fmtDate((s.date || '').slice(0, 10))}</td><td>${escHtml(s.label)}</td><td style="text-align:right">$${fmtNum(s.total, 2)}</td><td style="text-align:right"><button class="btn-secondary btn-sm" data-legacy="${escHtml(s.id)}">View</button></td></tr>`).join('')}
            </tbody></table><div id="stk2-legacy-view"></div></details>` : ''}`;

        body.querySelector('#stk2-new-count').addEventListener('submit', async e => {
            e.preventDefault();
            const f = e.currentTarget;
            try {
                const c = await api('/api/stock/counts', { method: 'POST', body: JSON.stringify({ date: f.date.value, label: f.label.value }) });
                await renderCounts(body);
                openCount(body, c.id);
            } catch (err) { showToast('Could not create count: ' + err.message); }
        });
        body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openCount(body, b.dataset.open)));
        body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Delete this draft count?')) return;
            try { await api('/api/stock/counts/' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); renderCounts(body); }
            catch (err) { showToast(err.message); }
        }));
        body.querySelectorAll('[data-legacy]').forEach(b => b.addEventListener('click', async () => {
            const view = body.querySelector('#stk2-legacy-view');
            try {
                const s = await api('/api/stocktake/' + encodeURIComponent(b.dataset.legacy));
                view.innerHTML = `<h3 class="cat-sub" style="margin:1rem 0 0.25rem"><strong>${escHtml(s.label)}</strong> · ${fmtDate((s.date || '').slice(0, 10))}</h3>
                <table class="stk-table stk2-table"><thead><tr><th>Description</th><th>Acct</th><th style="text-align:right">Units</th><th style="text-align:right">Unit value</th><th style="text-align:right">Net</th></tr></thead>
                <tbody>${(s.items || []).filter(i => i.active !== false).map(i => `<tr><td>${escHtml(i.description)}</td><td>${escHtml(i.accountCode)}</td><td style="text-align:right">${fmtNum(i.units, 2)}</td><td style="text-align:right">$${fmtNum(i.unitValue, 2)}</td><td style="text-align:right">$${fmtNum(i.net, 2)}</td></tr>`).join('')}</tbody></table>`;
            } catch (err) { view.innerHTML = `<p class="cat-sub">${escHtml(err.message)}</p>`; }
        }));
    }

    async function openCount(body, id) {
        const wrap = body.querySelector('#stk2-count-editor');
        wrap.innerHTML = '<div class="orders-loading">Loading count…</div>';
        let c, items;
        try { [c, items] = await Promise.all([api('/api/stock/counts/' + encodeURIComponent(id)), api('/api/stock/items')]); }
        catch (e) { wrap.innerHTML = `<p class="cat-sub">${escHtml(e.message)}</p>`; return; }
        const byId = Object.fromEntries(items.map(i => [i.id, i]));
        const committed = c.status === 'committed';
        const expected = c.expected || {};

        const varianceCell = (l, item) => {
            const exp = committed ? l.expectedQty : expected[l.itemId];
            if (l.counted === false || l.countedQty == null || l.countedQty === '' || exp == null) return '<span class="cat-sub">—</span>';
            const v = Math.round((Number(l.countedQty) - exp) * 100) / 100;
            const pct = exp ? Math.round((v / exp) * 1000) / 10 : null;
            const cls = v === 0 ? '' : (v < 0 ? 'stk2-var--neg' : 'stk2-var--pos');
            return `<span class="${cls}">${v > 0 ? '+' : ''}${fmtQty(v, item.unit)}${pct != null ? ` <span class="cat-sub">(${pct > 0 ? '+' : ''}${pct}%)</span>` : ''}</span>`;
        };

        wrap.innerHTML = `
        <div class="cat-section stk2-section" id="stk2-count">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">${escHtml(c.label)} <span class="cat-sub" style="font-weight:400">· ${fmtDate(c.date)} · ${committed ? 'committed ' + fmtDate((c.committedAt || '').slice(0, 10)) + (c.committedBy ? ' by ' + escHtml(String(c.committedBy).split('@')[0]) : '') : 'draft'}</span></h2>
                    <p class="cat-sub" style="margin:0">${committed ? 'Frozen: expected, variance and valuation were snapshotted at commit.' : 'Expected is the engine\'s figure at end of this date. Enter what you physically counted; tick <em>Not counted</em> for anything skipped (it keeps its old baseline).'}</p>
                </div>
                <div class="stk2-form-row">
                    ${committed
                        ? `<a class="btn-secondary btn-sm" href="/api/stock/counts/${encodeURIComponent(c.id)}/valuation?format=csv" download>Valuation CSV</a>`
                        : `<button class="btn-secondary btn-sm" id="stk2-save-draft">Save draft</button><button class="btn-primary btn-sm" id="stk2-commit">Commit count</button>`}
                    <button class="btn-secondary btn-sm" id="stk2-close-count">Close</button>
                </div>
            </div>
            <div class="stk-table-wrap"><table class="stk-table stk2-table stk2-count-table">
                <thead><tr><th>Item</th><th>Unit</th><th style="text-align:right">Expected</th><th style="text-align:right">Counted</th><th style="text-align:right">Variance</th><th>Reason</th><th>Not counted</th></tr></thead>
                <tbody>${(c.lines || []).map(l => {
                    const item = byId[l.itemId] || { name: l.itemId, unit: '' };
                    const exp = committed ? l.expectedQty : expected[l.itemId];
                    return `<tr data-item="${escHtml(l.itemId)}" class="${l.counted === false ? 'stk2-line--skip' : ''}">
                        <td><strong>${escHtml(item.name)}</strong>${item.key ? ' <span class="cat-sub">key</span>' : ''}</td>
                        <td class="cat-sub">${escHtml(item.unit)}</td>
                        <td style="text-align:right;font-variant-numeric:tabular-nums" title="${exp == null ? 'No earlier committed count for this item' : ''}">${exp == null ? '<span class="cat-sub">—</span>' : fmtQty(exp, item.unit)}</td>
                        <td style="text-align:right">${committed ? `<span style="font-variant-numeric:tabular-nums">${l.counted === false ? '—' : fmtQty(l.countedQty, item.unit)}</span>` : `<input type="number" step="any" min="0" class="stk2-counted" value="${l.countedQty ?? ''}" ${l.counted === false ? 'disabled' : ''} style="width:110px;text-align:right">`}</td>
                        <td style="text-align:right;font-variant-numeric:tabular-nums" class="stk2-var">${varianceCell(l, item)}</td>
                        <td>${committed ? escHtml(l.varianceReason || '') : `<input type="text" class="stk2-reason" value="${escHtml(l.varianceReason || '')}" placeholder="e.g. yield loss" style="width:100%">`}</td>
                        <td style="text-align:center">${committed ? (l.counted === false ? '✓' : '') : `<input type="checkbox" class="stk2-skip" ${l.counted === false ? 'checked' : ''}>`}</td>
                    </tr>`; }).join('')}</tbody>
            </table></div>
            <div id="stk2-count-msg" class="cat-sub" style="margin-top:0.5rem"></div>
        </div>`;
        wrap.querySelector('#stk2-count').scrollIntoView({ behavior: 'smooth', block: 'start' });
        wrap.querySelector('#stk2-close-count').addEventListener('click', () => { wrap.innerHTML = ''; });
        if (committed) return;

        const readLines = () => [...wrap.querySelectorAll('tr[data-item]')].map(tr => ({
            itemId: tr.dataset.item,
            counted: !tr.querySelector('.stk2-skip').checked,
            countedQty: tr.querySelector('.stk2-counted').value === '' ? null : Number(tr.querySelector('.stk2-counted').value),
            varianceReason: tr.querySelector('.stk2-reason').value,
        }));
        wrap.querySelectorAll('tr[data-item]').forEach(tr => {
            const refresh = () => {
                const l = { itemId: tr.dataset.item, counted: !tr.querySelector('.stk2-skip').checked, countedQty: tr.querySelector('.stk2-counted').value };
                tr.querySelector('.stk2-var').innerHTML = varianceCell(l, byId[l.itemId] || {});
            };
            tr.querySelector('.stk2-counted').addEventListener('input', refresh);
            tr.querySelector('.stk2-skip').addEventListener('change', e => {
                tr.classList.toggle('stk2-line--skip', e.target.checked);
                tr.querySelector('.stk2-counted').disabled = e.target.checked;
                refresh();
            });
        });
        const save = async () => api('/api/stock/counts/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify({ lines: readLines() }) });
        wrap.querySelector('#stk2-save-draft').addEventListener('click', async () => {
            try { await save(); showToast('Draft saved'); } catch (e) { showToast('Could not save: ' + e.message); }
        });
        wrap.querySelector('#stk2-commit').addEventListener('click', async () => {
            const msg = wrap.querySelector('#stk2-count-msg');
            const lines = readLines();
            const missing = lines.filter(l => l.counted && l.countedQty == null);
            if (missing.length) {
                msg.innerHTML = `<span class="stk2-var--neg">Enter a quantity or tick Not counted for: ${missing.map(l => escHtml(byId[l.itemId]?.name || l.itemId)).join(', ')}</span>`;
                return;
            }
            if (!confirm(`Commit "${c.label}" as at ${fmtDate(c.date)}? This freezes the variances and makes it the baseline. It cannot be edited afterwards.`)) return;
            try {
                await save();
                await api('/api/stock/counts/' + encodeURIComponent(c.id) + '/commit', { method: 'POST' });
                showToast('Count committed');
                await renderCounts(body);
                openCount(body, c.id);
            } catch (e) {
                msg.innerHTML = `<span class="stk2-var--neg">${escHtml(e.message)}</span>`;
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════
    //  ADMIN → STOCK — items, packaging recipes, engine settings
    // ════════════════════════════════════════════════════════════════════
    async function renderSettingsTab(body) {
        body.innerHTML = '<div class="orders-loading">Loading stock settings…</div>';
        let items, settings, bom;
        try { [items, settings, bom] = await Promise.all([api('/api/stock/items'), api('/api/stock/settings'), api('/api/stock/bom')]); }
        catch (e) { body.innerHTML = `<p class="cat-sub" style="padding:1rem">${escHtml(e.message)}</p>`; return; }
        const products = items.filter(i => i.class === 'product');
        const consumables = items.filter(i => i.class === 'consumable');

        body.innerHTML = `
        <div class="cat-section stk2-section">
            <div class="cat-section-head"><div><h2 class="cat-title">Products</h2><p class="cat-sub" style="margin:0">The three key lines. Each depletes from its Sales History bucket. Set a manual reorder point in kg — shipment lead times are months, so auto mode isn't meaningful here.</p></div></div>
            <table class="stk-table stk2-table"><thead><tr><th>Name</th><th>Sales bucket</th><th style="text-align:right">Reorder at (kg)</th><th style="text-align:right">Unit value $</th><th>Account</th><th>Active</th><th></th></tr></thead>
            <tbody>${products.map(i => `<tr>
                <td><strong>${escHtml(i.name)}</strong>${i.key ? ' <span class="cat-sub">key</span>' : ''}</td><td class="cat-sub">${escHtml(i.salesKey || '—')}</td>
                <td style="text-align:right">${i.reorder?.manualPoint != null ? fmtNum(i.reorder.manualPoint) : '—'}</td>
                <td style="text-align:right">${i.unitValue != null ? fmtNum(i.unitValue, 2) : '—'}</td><td>${escHtml(i.accountCode || '')}</td>
                <td>${i.active === false ? 'No' : 'Yes'}</td>
                <td style="text-align:right"><button class="btn-secondary btn-sm" data-edit="${escHtml(i.id)}">Edit</button></td></tr>`).join('')}</tbody></table>
        </div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div><h2 class="cat-title">Consumables</h2><p class="cat-sub" style="margin:0">Packaging counted in units. Lead time drives the reorder point; the profile is reference for whoever places the order.</p></div>
                <button class="btn-primary btn-sm" id="stk2-add-consumable">+ Add consumable</button>
            </div>
            ${consumables.length ? `<table class="stk-table stk2-table"><thead><tr><th>Name</th><th>Retailer</th><th style="text-align:right">Lead (d)</th><th>Reorder</th><th style="text-align:right">Unit value $</th><th>Active</th><th></th></tr></thead>
            <tbody>${consumables.map(i => `<tr>
                <td><strong>${escHtml(i.name)}</strong>${i.profile?.supplierSku ? ` <span class="cat-sub">${escHtml(i.profile.supplierSku)}</span>` : ''}</td>
                <td>${i.profile?.retailerUrl ? `<a href="${escHtml(i.profile.retailerUrl)}" target="_blank" rel="noopener">${escHtml(i.profile.retailer || 'link')} ↗</a>` : escHtml(i.profile?.retailer || '—')}</td>
                <td style="text-align:right">${i.profile?.leadTimeDays ?? '—'}</td>
                <td>${i.reorder?.mode === 'manual' ? 'Manual · ' + (i.reorder.manualPoint != null ? fmtNum(i.reorder.manualPoint) : '—') : 'Auto · +' + (i.reorder?.safetyDays ?? settings.defaultSafetyDays) + 'd safety'}</td>
                <td style="text-align:right">${i.unitValue != null ? fmtNum(i.unitValue, 2) : '—'}</td>
                <td>${i.active === false ? 'No' : 'Yes'}</td>
                <td style="text-align:right"><button class="btn-secondary btn-sm" data-edit="${escHtml(i.id)}">Edit</button></td></tr>`).join('')}</tbody></table>` : '<p class="cat-sub">None yet. Add boxes, bags, labels, staples, tape…</p>'}
        </div>
        <div id="stk2-item-editor"></div>

        <div class="cat-section stk2-section" id="stk2-bom">
            <div class="cat-section-head">
                <div><h2 class="cat-title">Packaging recipes</h2><p class="cat-sub" style="margin:0">What one sales unit of each SKU consumes. Fractions are fine (a 1kg bag uses 0.1 of a box). The <em>Per order</em> row is consumed once per despatch. Versions apply from their effective date.</p></div>
                <div class="stk2-form-row">
                    <select id="stk2-bom-version">${bom.versions.map((v, i) => `<option value="${i}">From ${fmtDate(v.effectiveFrom)}</option>`).join('')}</select>
                    <input type="date" id="stk2-bom-newdate" value="${escHtml(settings.stockEpoch)}" title="Effective date for a new version">
                    <button class="btn-secondary btn-sm" id="stk2-bom-addver">+ New version</button>
                    <button class="btn-primary btn-sm" id="stk2-bom-save">Save recipes</button>
                </div>
            </div>
            <div id="stk2-bom-grid"></div>
        </div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head"><div><h2 class="cat-title">Engine settings</h2><p class="cat-sub" style="margin:0">Values the engine reads that don't belong to any one item.</p></div></div>
            <form id="stk2-settings" class="stk2-grid-form">
                <label>Stock epoch<input name="stockEpoch" type="date" value="${escHtml(settings.stockEpoch)}"><small>Opening count date. Nothing is computed before it.</small></label>
                <label>Usage window (days)<input name="consumptionWindowDays" type="number" min="1" value="${settings.consumptionWindowDays}"><small>Trailing window for average daily usage (from Sales History).</small></label>
                <label>Default safety days<input name="defaultSafetyDays" type="number" min="0" value="${settings.defaultSafetyDays}"><small>Added to lead time for auto reorder points.</small></label>
                <label>Watch multiplier<input name="watchMultiplier" type="number" min="1" step="0.05" value="${settings.watchMultiplier}"><small>"Watch" when on hand ≤ reorder point × this.</small></label>
                <label>Default account code<input name="defaultAccountCode" type="text" value="${escHtml(settings.valuation?.defaultAccountCode || '')}"><small>Used on valuation rows when an item has none.</small></label>
                <div style="align-self:end"><button class="btn-primary btn-sm" type="submit">Save settings</button></div>
            </form>
        </div>`;

        // Item editor
        const editorEl = body.querySelector('#stk2-item-editor');
        const openEditor = (item) => {
            const isNew = !item;
            const it = item || { class: 'consumable', unit: 'each', active: true, profile: {}, reorder: { mode: 'auto' } };
            const p = it.profile || {}, r = it.reorder || {};
            const prod = it.class === 'product';
            editorEl.innerHTML = `
            <div class="cat-section stk2-section" id="stk2-item-form-wrap">
                <div class="cat-section-head"><div><h2 class="cat-title">${isNew ? 'New consumable' : 'Edit · ' + escHtml(it.name)}</h2>${!isNew ? `<p class="cat-sub" style="margin:0">id <code>${escHtml(it.id)}</code> · ${escHtml(it.class)} · ${escHtml(it.unit)}</p>` : ''}</div>
                    <button class="btn-secondary btn-sm" id="stk2-item-cancel">Cancel</button></div>
                <form id="stk2-item-form" class="stk2-grid-form">
                    <label>Name<input name="name" type="text" required value="${escHtml(it.name || '')}"></label>
                    ${isNew ? `<label>Unit<select name="unit"><option value="each">each</option><option value="kg">kg</option></select><small>Locked once counted.</small></label>` : ''}
                    <label>Sort order<input name="sortOrder" type="number" value="${it.sortOrder ?? 100}"></label>
                    <label>Active<select name="active"><option value="true" ${it.active !== false ? 'selected' : ''}>Yes</option><option value="false" ${it.active === false ? 'selected' : ''}>No (hidden)</option></select></label>
                    <label>Account code<input name="accountCode" type="text" value="${escHtml(it.accountCode || '')}"></label>
                    <label>Unit value $ (ex GST)<input name="unitValue" type="number" step="0.01" value="${it.unitValue ?? ''}"><small>Valuation report only.</small></label>
                    <label>Valued as at<input name="unitValueAsAt" type="date" value="${escHtml(it.unitValueAsAt || '')}"></label>
                    <label>Reorder mode<select name="reorderMode"><option value="auto" ${r.mode !== 'manual' ? 'selected' : ''}>Auto (usage × lead + safety)</option><option value="manual" ${r.mode === 'manual' ? 'selected' : ''}>Manual point</option></select></label>
                    <label>Manual reorder point<input name="manualPoint" type="number" step="any" value="${r.manualPoint ?? ''}"></label>
                    <label>Safety days<input name="safetyDays" type="number" value="${r.safetyDays ?? ''}" placeholder="${settings.defaultSafetyDays}"></label>
                    <label>Suggested order qty<input name="reorderQty" type="number" step="any" value="${r.reorderQty ?? ''}"><small>Informational.</small></label>
                    <label>Aliases<input name="aliases" type="text" value="${escHtml((it.aliases || []).join(', '))}"><small>Comma-separated names a CSV import may use for this item.</small></label>
                    ${prod ? '' : `
                    <div class="stk2-grid-span"><h3 class="cat-sub" style="margin:0.5rem 0 0"><strong>Supplier profile</strong></h3></div>
                    <label>Retailer<input name="retailer" type="text" value="${escHtml(p.retailer || '')}"></label>
                    <label>Product URL<input name="retailerUrl" type="url" value="${escHtml(p.retailerUrl || '')}"></label>
                    <label>Supplier SKU<input name="supplierSku" type="text" value="${escHtml(p.supplierSku || '')}"></label>
                    <label>Image URL<input name="imageUrl" type="url" value="${escHtml(p.imageUrl || '')}"><small>Link to the supplier's photo.</small></label>
                    <label>Lead time (days)<input name="leadTimeDays" type="number" min="0" value="${p.leadTimeDays ?? ''}"><small>Drives the reorder point.</small></label>
                    <label>Typical cost $ / unit<input name="typicalCost" type="number" step="0.0001" value="${p.typicalCost ?? ''}"></label>
                    <label>Pack size<input name="packSize" type="number" value="${p.packSize ?? ''}"><small>Units per supplier pack.</small></label>
                    <label>Min order (packs)<input name="minOrderQty" type="number" value="${p.minOrderQty ?? ''}"></label>
                    <label class="stk2-grid-span">Notes<input name="notes" type="text" value="${escHtml(p.notes || '')}"></label>`}
                    <div class="stk2-grid-span"><button class="btn-primary btn-sm" type="submit">${isNew ? 'Create' : 'Save'}</button></div>
                </form>
            </div>`;
            editorEl.querySelector('#stk2-item-form-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
            editorEl.querySelector('#stk2-item-cancel').addEventListener('click', () => { editorEl.innerHTML = ''; });
            editorEl.querySelector('#stk2-item-form').addEventListener('submit', async e => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const g = k => { const v = f.get(k); return v == null || v === '' ? null : v; };
                const payload = {
                    name: g('name'), sortOrder: g('sortOrder'), active: g('active') !== 'false',
                    accountCode: g('accountCode') || '', unitValue: g('unitValue'), unitValueAsAt: g('unitValueAsAt'),
                    aliases: String(g('aliases') || '').split(',').map(s => s.trim()).filter(Boolean),
                    reorder: { mode: g('reorderMode'), manualPoint: g('manualPoint'), safetyDays: g('safetyDays'), reorderQty: g('reorderQty') },
                };
                if (!prod) payload.profile = { retailer: g('retailer'), retailerUrl: g('retailerUrl'), supplierSku: g('supplierSku'), imageUrl: g('imageUrl'), leadTimeDays: g('leadTimeDays'), typicalCost: g('typicalCost'), packSize: g('packSize'), minOrderQty: g('minOrderQty'), notes: g('notes') };
                try {
                    if (isNew) await api('/api/stock/items', { method: 'POST', body: JSON.stringify({ ...payload, class: 'consumable', unit: g('unit') || 'each' }) });
                    else await api('/api/stock/items/' + encodeURIComponent(it.id), { method: 'PATCH', body: JSON.stringify(payload) });
                    showToast(isNew ? 'Consumable added' : 'Saved');
                    renderSettingsTab(body);
                } catch (err) { showToast('Could not save: ' + err.message); }
            });
        };
        body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditor(items.find(i => i.id === b.dataset.edit))));
        body.querySelector('#stk2-add-consumable').addEventListener('click', () => openEditor(null));

        // BOM grid — rows: SKUs + per-order; columns: active consumables.
        const activeCons = consumables.filter(c => c.active !== false);
        const versions = bom.versions.map(v => ({ effectiveFrom: v.effectiveFrom, recipes: JSON.parse(JSON.stringify(v.recipes || {})) }));
        let perDespatch = (settings.perDespatch || []).map(e => ({ ...e }));
        let vi = Math.max(0, versions.length - 1);
        const grid = body.querySelector('#stk2-bom-grid');
        const verSel = body.querySelector('#stk2-bom-version');
        const qtyOf = (list, cid) => { const e = (list || []).find(x => x.consumableId === cid); return e ? e.qty : ''; };
        const setQty = (list, cid, qty) => {
            const i = list.findIndex(x => x.consumableId === cid);
            if (qty === '' || qty == null || Number(qty) === 0) { if (i >= 0) list.splice(i, 1); }
            else if (i >= 0) list[i].qty = Number(qty); else list.push({ consumableId: cid, qty: Number(qty) });
        };
        const drawGrid = () => {
            verSel.innerHTML = versions.map((v, i) => `<option value="${i}" ${i === vi ? 'selected' : ''}>From ${fmtDate(v.effectiveFrom)}</option>`).join('') || '<option>No versions</option>';
            if (!activeCons.length) { grid.innerHTML = '<p class="cat-sub">Add consumables first, then define what each SKU uses.</p>'; return; }
            if (!versions.length) { grid.innerHTML = '<p class="cat-sub">No recipe version yet — pick an effective date and click <strong>New version</strong>.</p>'; return; }
            const v = versions[vi];
            const rows = bom.skus.map(sku => `<tr><td><strong>${escHtml(sku)}</strong></td>${activeCons.map(c => `<td><input type="number" step="any" min="0" data-sku="${escHtml(sku)}" data-cid="${escHtml(c.id)}" value="${qtyOf(v.recipes[sku], c.id)}"></td>`).join('')}</tr>`).join('');
            const per = `<tr class="stk2-bom-per"><td><strong>Per order</strong><div class="cat-sub" style="margin:0">once per despatch</div></td>${activeCons.map(c => `<td><input type="number" step="any" min="0" data-per="1" data-cid="${escHtml(c.id)}" value="${qtyOf(perDespatch, c.id)}"></td>`).join('')}</tr>`;
            grid.innerHTML = `<div class="stk-table-wrap"><table class="stk-table stk2-table stk2-bom-table"><thead><tr><th>SKU</th>${activeCons.map(c => `<th>${escHtml(c.name)}</th>`).join('')}</tr></thead><tbody>${rows}${per}</tbody></table></div>`;
            grid.querySelectorAll('input[data-sku]').forEach(inp => inp.addEventListener('input', () => {
                v.recipes[inp.dataset.sku] = v.recipes[inp.dataset.sku] || [];
                setQty(v.recipes[inp.dataset.sku], inp.dataset.cid, inp.value);
            }));
            grid.querySelectorAll('input[data-per]').forEach(inp => inp.addEventListener('input', () => setQty(perDespatch, inp.dataset.cid, inp.value)));
        };
        verSel.addEventListener('change', () => { vi = Number(verSel.value); drawGrid(); });
        body.querySelector('#stk2-bom-addver').addEventListener('click', () => {
            const d = body.querySelector('#stk2-bom-newdate').value;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { showToast('Pick an effective date'); return; }
            if (versions.some(v => v.effectiveFrom === d)) { showToast('A version already starts on that date'); return; }
            const src = versions[vi] ? JSON.parse(JSON.stringify(versions[vi].recipes)) : {};
            versions.push({ effectiveFrom: d, recipes: src });
            versions.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
            vi = versions.findIndex(v => v.effectiveFrom === d);
            drawGrid();
        });
        body.querySelector('#stk2-bom-save').addEventListener('click', async () => {
            try {
                await api('/api/stock/bom', { method: 'PUT', body: JSON.stringify({ versions }) });
                await api('/api/stock/settings', { method: 'PUT', body: JSON.stringify({ perDespatch }) });
                showToast('Recipes saved');
            } catch (e) { showToast('Could not save: ' + e.message); }
        });
        drawGrid();

        // Settings
        body.querySelector('#stk2-settings').addEventListener('submit', async e => {
            e.preventDefault();
            const f = e.currentTarget;
            try {
                await api('/api/stock/settings', { method: 'PUT', body: JSON.stringify({
                    stockEpoch: f.stockEpoch.value, consumptionWindowDays: Number(f.consumptionWindowDays.value),
                    defaultSafetyDays: Number(f.defaultSafetyDays.value), watchMultiplier: Number(f.watchMultiplier.value),
                    valuation: { defaultAccountCode: f.defaultAccountCode.value.trim() },
                }) });
                showToast('Settings saved');
            } catch (err) { showToast('Could not save: ' + err.message); }
        });
    }

    return { renderWarehouse, renderDashboard, renderCounts, renderSettingsTab };
})();
