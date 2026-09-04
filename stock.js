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
    // The product fed by shipments (FIFO lots, per-shipment sub-count).
    const SHIPMENT_PRODUCT_ID = 'prime-tie-bundled';

    // Shrink a photo to a thumbnail before upload (stored in KV, no blob
    // storage here). Returns { data: base64, mediaType } or throws.
    function resizeImage(file, max = 320, quality = 0.82) {
        return new Promise((resolve, reject) => {
            if (!/^image\//.test(file.type)) return reject(new Error('Choose an image file'));
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, max / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // flatten transparency
                ctx.drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve({ data: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl });
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
            img.src = url;
        });
    }
    function fmtDate(ymd) {
        if (!ymd) return '—';
        const [y, m, d] = String(ymd).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    }
    function fmtNum(n, dp = 0) {
        if (n == null || n === '' || isNaN(Number(n))) return '—';
        return Number(n).toLocaleString('en-NZ', { maximumFractionDigits: dp, minimumFractionDigits: 0 });
    }
    // "1,250 kg" / "500 boxes" / "1 roll" — label is the item's unit type for
    // "each" items (box, roll, bag…), pluralised naively.
    function fmtQty(n, unit, dp, label) {
        if (n == null) return '—';
        const v = Number(n);
        const d = dp != null ? dp : (Number.isInteger(v) ? 0 : 1);
        if (unit === 'kg') return fmtNum(v, d) + ' kg';
        if (label) return fmtNum(v, d) + ' ' + (Math.abs(v) === 1 || /s$/.test(label) ? label : label + (/(x|ch|sh)$/.test(label) ? 'es' : 's'));
        return fmtNum(v, d);
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

    // The Hub is light-only; only an explicit data-theme="dark" flips the chart palette.
    const isDark = () => document.documentElement.dataset.theme === 'dark';
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
                <p class="view-subtitle">Stock on hand per item, reorder alerts, and physical counts. Items, packaging recipes and settings live in <a href="#admin">Settings → Stock</a>.</p>
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

        <div id="stk2-cf"></div>

        ${key.filter(k => Array.isArray(k.lots)).map(lotsSection).join('')}

        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Recent movements</h2>
                    <p class="cat-sub" style="margin:0">Use <strong>In</strong> (stock arrived), <strong>Out</strong> (used, wasted, removed) or <strong>Adjust</strong> (set on hand to what's actually there) on any item above. Append-only: a mistake is undone by an opposite entry, never by editing.</p>
                </div>
            </div>
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
        renderConsumablesForecast(body.querySelector('#stk2-cf'));
        // In / Out / Adjust on any item → a small popover that posts the movement.
        body.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
            const item = lv.items.find(i => i.id === b.dataset.item);
            if (item) openMovement({ item, mode: b.dataset.move, stockEpoch: lv.stockEpoch, onDone: () => renderDashboard(body) });
        }));
        // Item name → its ledger (audit trail with running balance).
        body.querySelectorAll('[data-ledger]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openLedger(a.dataset.ledger); }));
    }

    function kpiTile(lv) {
        const unknown = lv.onHand == null;
        const cover = lv.daysCover == null ? (unknown ? 'No committed count yet' : 'No usage in window') : `${fmtNum(lv.daysCover / 7, 1)} wk cover · ${fmtNum(lv.avgDaily, 1)} ${lv.unit}/day`;
        return `
        <div class="stk2-tile" data-item="${escHtml(lv.id)}">
            <div class="stk2-tile-label"><a href="#" class="stk2-ledger-link" data-ledger="${escHtml(lv.id)}" title="Open the ledger — every in and out behind this figure">${escHtml(lv.name)}</a></div>
            <div class="stk2-tile-value">${unknown ? '<span class="stk2-tile-unknown">—</span>' : `${fmtNum(lv.onHand)}<span class="stk2-tile-unit">${lv.unit}</span>`}</div>
            <div class="stk2-tile-sub">${escHtml(cover)}${lv.onOrder ? ` · <span title="On order — not included in on hand">${fmtNum(lv.onOrder)} ${lv.unit} on order</span>` : ''}</div>
            <div class="stk2-tile-foot">${statusChip(lv)}<div class="stk2-spark" aria-hidden="true"></div></div>
            ${lv.value != null ? `<div class="stk2-tile-sub" title="FIFO: oldest shipment lot sold first">Value <strong>$${fmtNum(lv.value)}</strong>${lv.avgCost != null ? ` · avg $${fmtNum(lv.avgCost, 2)}/kg` : ''} <span class="cat-sub">FIFO</span></div>` : ''}
            ${lv.baselineDate ? `<div class="stk2-tile-base">Counted ${fmtDate(lv.baselineDate)}${lv.reorderPoint != null ? ` · reorder at ${fmtNum(lv.reorderPoint)}` : ''}</div>` : ''}
            <div class="stk2-io stk2-tile-io"><button class="btn-secondary btn-sm" data-move="in" data-item="${escHtml(lv.id)}" title="Stock arrived (a landed shipment is added automatically)">In</button><button class="btn-secondary btn-sm" data-move="out" data-item="${escHtml(lv.id)}" title="Wasted or removed">Out</button><button class="btn-secondary btn-sm" data-move="adjust" data-item="${escHtml(lv.id)}" title="Set on hand to what's actually there">Adjust</button></div>
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

    // FIFO cost lots for the shipment-fed product (Prime Tie Bundled).
    function lotsSection(lv) {
        const lots = lv.lots || [];
        return `
        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">${escHtml(lv.name)} · shipment lots <span class="cat-sub" style="font-weight:400">· FIFO</span></h2>
                    <p class="cat-sub" style="margin:0">Each received shipment is a lot at its $/kg. Sales and wastage take from the oldest lot first, so on-hand value is what's left in the newest lots.</p>
                </div>
                <div style="text-align:right">
                    <div class="cat-sub" style="margin:0">On hand value</div>
                    <strong style="font-size:1.15rem">${lv.value != null ? '$' + fmtNum(lv.value) : '—'}</strong>
                    ${lv.avgCost != null ? `<div class="cat-sub" style="margin:0">avg $${fmtNum(lv.avgCost, 2)}/kg</div>` : ''}
                </div>
            </div>
            ${lots.length ? `<div class="stk-table-wrap"><table class="stk-table stk2-table">
                <thead><tr><th>Lot</th><th>Received</th><th style="text-align:right">Received kg</th><th style="text-align:right">Remaining kg</th><th style="text-align:right">$/kg</th><th style="text-align:right">Value</th></tr></thead>
                <tbody>${lots.map(l => `<tr class="${l.remaining <= 0 ? 'stk2-lot--done' : ''}">
                    <td><strong>${escHtml(l.note)}</strong></td><td>${fmtDate(l.date)}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(l.qty)}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(l.remaining)}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums" title="${l.basis === 'landed' ? 'Landed cost: all cost lines ÷ yield kg' : l.basis === 'listed' ? 'Listed $/kg on the shipment (no cost lines yet)' : 'Carried from the previous lot'}">${l.unitCost != null ? '$' + fmtNum(l.unitCost, 2) : '—'}${l.basis && l.basis !== 'landed' ? ` <span class="cat-sub">${escHtml(l.basis)}</span>` : ''}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${l.remaining > 0 ? '$' + fmtNum(l.value) : '—'}</td></tr>`).join('')}</tbody>
            </table></div>
            ${lv.shortfall ? `<p class="cat-sub stk2-var--neg" style="margin-top:0.5rem">${fmtNum(lv.shortfall)} kg sold beyond what the lots hold — the next shipment to land covers it first.</p>` : ''}`
            : '<p class="cat-sub">No lots yet — commit the opening count, then received shipments appear here.</p>'}
            ${(lv.onOrder ? `<p class="cat-sub" style="margin-top:0.5rem">${fmtNum(lv.onOrder)} kg on order (not in on hand).</p>` : '')}
        </div>`;
    }

    // Consumables forecast — next 12 months on the shared seasonal sales
    // forecast; when each consumable runs out and when it must be ordered.
    async function renderConsumablesForecast(el) {
        if (!el) return;
        el.innerHTML = '<div class="cat-section stk2-section"><div class="orders-loading">Forecasting consumables…</div></div>';
        let cf;
        try { cf = await api('/api/stock/consumables-forecast?months=12'); }
        catch (e) { el.innerHTML = `<div class="cat-section stk2-section"><p class="cat-sub">Consumables forecast unavailable: ${escHtml(e.message)}</p></div>`; return; }
        if (cf.beforeEpoch || !cf.items) { el.innerHTML = ''; return; }
        let scenario = 'avg';
        const SC = { avg: 'Average', good: 'Good +10%', great: 'Great +20%' };
        const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-NZ', { month: 'short', timeZone: 'UTC' }) + (m === 1 ? ` '${String(y).slice(2)}` : ''); };
        const draw = () => {
            const rows = cf.items.map(it => ({ it, sc: it.scenarios[scenario] }))
                .sort((a, b) => {
                    const ra = a.sc.reorderBy || (a.it.onHand == null ? '0000' : '9999'), rb = b.sc.reorderBy || (b.it.onHand == null ? '0000' : '9999');
                    return ra.localeCompare(rb) || a.it.name.localeCompare(b.it.name);
                });
            const orderNow = rows.filter(r => r.sc.orderNow).length;
            el.innerHTML = `
            <div class="cat-section stk2-section">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Consumables forecast <span class="cat-sub" style="font-weight:400">· next 12 months</span></h2>
                        <p class="cat-sub" style="margin:0">Same seasonal sales curve as the Stock Trajectory, turned into units through the last year's product mix and the matrix. <strong>Order by</strong> = run-out less lead time and safety days.${cf.mix.source !== 'sales-history' ? ' <span class="stk2-var--neg">No type×size sales split yet — assuming 10 kg bundled.</span>' : ''}</p>
                    </div>
                    <div class="stk2-traj-ctl">${Object.entries(SC).map(([k, l]) => `<button class="imp-view-btn${k === scenario ? ' active' : ''}" data-cf-sc="${k}">${l}</button>`).join('')}</div>
                </div>
                ${orderNow ? `<div class="stk2-notice stk2-notice--warn">${orderNow} consumable${orderNow === 1 ? '' : 's'} should be ordered now to land before running out (${SC[scenario]}).</div>` : ''}
                <div class="stk-table-wrap"><table class="stk-table stk2-table stk2-cf-table">
                    <thead><tr><th>Consumable</th><th style="text-align:right">On hand</th><th style="text-align:right">12-mo usage</th><th>Runs out</th><th>Order by</th><th style="text-align:right">Lead</th><th>${cf.months.map(m => `<span class="stk2-cf-m">${monthLabel(m.ym)}</span>`).join('')}</th></tr></thead>
                    <tbody>${rows.map(({ it, sc }) => {
                        const unknown = it.onHand == null;
                        const orderCell = unknown ? '<span class="cat-sub">no count</span>'
                            : !sc.reorderBy ? '<span class="stk2-chip stk2-chip--ok"><span class="stk2-chip-ico">✓</span>12 months+</span>'
                            : sc.orderNow ? `<span class="stk2-chip stk2-chip--critical"><span class="stk2-chip-ico">‼</span>Order now</span> <span class="cat-sub">(by ${fmtDate(sc.reorderBy)})</span>`
                            : `<strong>${fmtDate(sc.reorderBy)}</strong>`;
                        const maxAbs = Math.max(1, ...sc.months.map(m => Math.abs(m.closing ?? 0)), it.onHand || 0);
                        const strip = sc.months.map(m => {
                            const v = m.closing;
                            const h = v == null ? 0 : Math.max(2, Math.round((Math.min(Math.abs(v), maxAbs) / maxAbs) * 22));
                            return `<span class="stk2-cf-bar ${v != null && v <= 0 ? 'stk2-cf-bar--out' : ''}" style="height:${h}px" title="${monthLabel(m.ym)}: use ${fmtQty(m.usage, it.unit, null, it.unitLabel)} → ${v == null ? '—' : fmtQty(v, it.unit, null, it.unitLabel)} left"></span>`;
                        }).join('');
                        return `<tr class="${sc.orderNow ? 'stk2-row--critical' : ''}">
                            <td><strong>${escHtml(it.name)}</strong>${it.usagePerKg ? '' : '<div class="cat-sub" style="margin:0">not in the matrix — no usage</div>'}</td>
                            <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtQty(it.onHand, it.unit, null, it.unitLabel)}${it.onOrder ? ` <span class="cat-sub">+${fmtNum(it.onOrder)} on order</span>` : ''}</td>
                            <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtQty(sc.usage12, it.unit, 0, it.unitLabel)}</td>
                            <td>${unknown ? '<span class="cat-sub">—</span>' : sc.runOutDate ? `<span class="${sc.orderNow ? 'stk2-var--neg' : ''}">${fmtDate(sc.runOutDate)}</span>` : '<span class="cat-sub">not within 12 months</span>'}</td>
                            <td>${orderCell}</td>
                            <td style="text-align:right">${it.leadTimeDays ? it.leadTimeDays + ' d' : '—'}${it.safetyDays ? ` <span class="cat-sub">+${it.safetyDays}</span>` : ''}</td>
                            <td><div class="stk2-cf-strip">${strip}</div></td>
                        </tr>`; }).join('')}</tbody>
                </table></div>
                <p class="cat-sub" style="margin-top:0.5rem">Mix from ${fmtDate(cf.mix.from)} → ${fmtDate(cf.mix.to)}: ${Object.entries(cf.mix.share).map(([sku, sh]) => `${escHtml(sku)} ${Math.round(sh * 100)}%`).join(' · ')}${cf.mix.ordersPerKg ? ` · ${fmtNum(1 / cf.mix.ordersPerKg)} kg per order` : ''}. Bars show month-end stock; red = out.</p>
            </div>`;
            el.querySelectorAll('[data-cf-sc]').forEach(b => b.addEventListener('click', () => { scenario = b.dataset.cfSc; draw(); }));
        };
        draw();
    }

    // Audit trail for one item: every debit / credit behind its on hand since
    // the baseline count, with a running balance. Opens as a popover.
    async function openLedger(itemId) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal-box modal-box--wide stk2-modal stk2-ledger" role="dialog" aria-modal="true"><h3 class="modal-title">Loading ledger…</h3></div>`;
        document.body.appendChild(overlay);
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        let lg;
        try { lg = await api('/api/stock/items/' + encodeURIComponent(itemId) + '/ledger'); }
        catch (e) { overlay.querySelector('.modal-box').innerHTML = `<h3 class="modal-title">Ledger</h3><p class="cat-sub">${escHtml(e.message)}</p><div class="modal-actions"><button class="btn-secondary" id="stk2-ledger-close">Close</button></div>`; overlay.querySelector('#stk2-ledger-close').addEventListener('click', close); return; }
        const q = n => fmtQty(Math.abs(n), lg.unit, null, lg.unitLabel);
        const KIND = { count: 'Count', receipt: 'Received', sale: 'Order', wastage: 'Wastage', adjustment: 'Adjustment', correction: 'Correction' };
        const rows = (lg.entries || []).slice().reverse();
        overlay.querySelector('.modal-box').innerHTML = `
            <h3 class="modal-title">${escHtml(lg.name)} <span class="modal-hint">ledger · since ${lg.baseline ? fmtDate(lg.baseline.date) : '—'} · as at ${fmtDate(lg.asOf)}</span></h3>
            ${lg.baseline ? `
            <div class="stk2-ledger-sum"><span>Baseline <strong>${q(lg.baseline.qty)}</strong></span><span>Closing <strong>${lg.closing != null ? fmtQty(lg.closing, lg.unit, null, lg.unitLabel) : '—'}</strong></span><span class="cat-sub">${rows.length} entries · newest first</span></div>
            <div class="stk-table-wrap stk2-ledger-wrap"><table class="stk-table stk2-table">
                <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Balance</th></tr></thead>
                <tbody>${rows.map(e => `<tr class="stk2-ledger--${escHtml(e.kind)}">
                    <td style="white-space:nowrap">${fmtDate(e.date)}</td>
                    <td>${escHtml(KIND[e.kind] || e.kind)}</td>
                    <td>${e.kind === 'sale' ? `<a href="#orders/${encodeURIComponent(e.ref)}" onclick="document.querySelector('.modal-overlay')?.remove()">${escHtml(e.label)}</a>` : `<strong>${escHtml(e.label || e.ref || '')}</strong>`}${e.note ? `<div class="cat-sub" style="margin:0">${escHtml(e.note)}${e.by ? ' · ' + escHtml(String(e.by).split('@')[0]) : ''}</div>` : ''}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums" class="stk2-var--pos">${e.qty > 0 ? '+' + q(e.qty) : ''}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums" class="stk2-var--neg">${e.qty < 0 ? '−' + q(e.qty) : ''}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums"><strong>${fmtQty(e.balance, lg.unit, null, lg.unitLabel)}</strong></td>
                </tr>`).join('')}</tbody>
            </table></div>`
            : `<p class="cat-sub">No committed count yet — the ledger starts from a baseline count.</p>`}
            <div class="modal-actions"><button class="btn-secondary" id="stk2-ledger-close">Close</button></div>`;
        overlay.querySelector('#stk2-ledger-close').addEventListener('click', close);
    }

    // In / Out / Adjust for one item — posts a movement without a full count.
    //   in     → receipt (+qty)      out → wastage (−qty)
    //   adjust → adjustment of (target − on hand), i.e. "set on hand to X"
    function openMovement({ item, mode, stockEpoch, onDone }) {
        const TITLE = { in: 'In', out: 'Out', adjust: 'Adjust' }[mode] || 'Movement';
        const unitTxt = item.unit === 'kg' ? 'kg' : (item.unitLabel || 'units');
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
        <div class="modal-box stk2-move" role="dialog" aria-modal="true">
            <h3 class="modal-title">${TITLE} · ${escHtml(item.name)} <span class="modal-hint">on hand ${item.onHand == null ? 'unknown' : fmtQty(item.onHand, item.unit, null, item.unitLabel)}</span></h3>
            <form id="stk2-move-form">
                ${mode === 'adjust'
                    ? `<div class="modal-field"><label>Set on hand to <span class="modal-hint">${escHtml(unitTxt)} actually there</span></label><input name="target" type="number" step="any" min="0" required autofocus value="${item.onHand ?? ''}"><span class="cat-sub" id="stk2-move-delta" style="display:block;margin-top:0.3rem"></span></div>`
                    : `<div class="modal-field"><label>${mode === 'in' ? 'Quantity arrived' : 'Quantity out'} <span class="modal-hint">${escHtml(unitTxt)}</span></label><input name="qty" type="number" step="any" min="0" required autofocus placeholder="0"></div>`}
                <div class="modal-field"><label>Date</label><input name="date" type="date" value="${nzToday()}" min="${escHtml(stockEpoch || '')}" required></div>
                <div class="modal-field"><label>Note <span class="modal-hint">optional</span></label><input name="reason" type="text" placeholder="${mode === 'in' ? 'e.g. Delivery from Attwoods' : mode === 'out' ? 'e.g. Damaged / used for samples' : 'e.g. Recount'}"></div>
                <div class="modal-actions"><button type="button" class="btn-secondary" id="stk2-move-cancel">Cancel</button><button type="submit" class="btn-primary">${mode === 'adjust' ? 'Set on hand' : 'Post ' + TITLE.toLowerCase()}</button></div>
            </form>
        </div>`;
        document.body.appendChild(overlay);
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('#stk2-move-cancel').addEventListener('click', close);
        const form = overlay.querySelector('#stk2-move-form');
        if (mode === 'adjust') {
            const tgt = form.querySelector('input[name="target"]'), delta = overlay.querySelector('#stk2-move-delta');
            const upd = () => { const v = Number(tgt.value); if (tgt.value === '' || item.onHand == null || isNaN(v)) { delta.textContent = item.onHand == null ? 'No count yet — this will be the first figure (post via a count instead).' : ''; return; } const d = Math.round((v - item.onHand) * 100) / 100; delta.textContent = d === 0 ? 'No change' : `${d > 0 ? '+' : '−'}${fmtQty(Math.abs(d), item.unit, null, item.unitLabel)} adjustment`; };
            tgt.addEventListener('input', upd); upd();
        }
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const fd = new FormData(form);
            let type, qty;
            if (mode === 'adjust') {
                if (item.onHand == null) { showToast('No count yet — commit a count first'); return; }
                type = 'adjustment'; qty = Math.round((Number(fd.get('target')) - item.onHand) * 100) / 100;
                if (qty === 0) { showToast('No change'); close(); return; }
            } else {
                type = mode === 'in' ? 'receipt' : 'wastage'; qty = Number(fd.get('qty'));
                if (!(qty > 0)) { showToast('Enter a quantity'); return; }
            }
            try {
                await api('/api/stock/movements', { method: 'POST', body: JSON.stringify({ itemId: item.id, type, qty, date: fd.get('date'), reason: String(fd.get('reason') || '').trim() || (mode === 'adjust' ? 'Set on hand' : '') }) });
                showToast(mode === 'adjust' ? 'On hand set' : TITLE + ' posted');
                close(); onDone && onDone();
            } catch (err) { showToast('Could not post: ' + err.message); }
        });
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
        if (!items.length) return '<p class="cat-sub">No consumables yet — add them under Settings → Stock.</p>';
        return `<div class="stk-table-wrap"><table class="stk-table stk2-table stk2-levels">
            <thead><tr><th>Item</th><th style="min-width:160px">On hand</th><th style="text-align:right">Qty</th><th style="text-align:right">Cover</th><th style="text-align:right">Reorder at</th><th style="text-align:right">Lead</th><th>Status</th><th style="text-align:right">On order</th><th></th></tr></thead>
            <tbody>${items.map(i => `<tr class="stk2-row--${escHtml(i.status)}">
                <td><a href="#" class="stk2-ledger-link" data-ledger="${escHtml(i.id)}" title="Open the ledger — every in and out behind this figure"><strong>${escHtml(i.name)}</strong></a><div class="cat-sub" style="margin:0">${i.baselineDate ? 'counted ' + fmtDate(i.baselineDate) : 'not counted'}</div></td>
                <td>${meter(i)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtQty(i.onHand, i.unit, null, i.unitLabel)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${i.daysCover == null ? '—' : fmtNum(i.daysCover) + ' d'}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums" title="${i.reorderMode === 'manual' ? 'Manual reorder point' : 'Auto: avg daily × (lead time + safety days)'}">${i.reorderPoint == null ? '—' : fmtNum(i.reorderPoint)}${i.reorderMode === 'manual' ? '' : ' <span class="cat-sub">auto</span>'}</td>
                <td style="text-align:right">${i.leadTimeDays ? i.leadTimeDays + ' d' : '—'}</td>
                <td>${statusChip(i)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${i.onOrder ? fmtQty(i.onOrder, i.unit) : '—'}</td>
                <td style="text-align:right;white-space:nowrap"><span class="stk2-io"><button class="btn-secondary btn-sm" data-move="in" data-item="${escHtml(i.id)}" title="Stock arrived">In</button><button class="btn-secondary btn-sm" data-move="out" data-item="${escHtml(i.id)}" title="Used, wasted or removed">Out</button><button class="btn-secondary btn-sm" data-move="adjust" data-item="${escHtml(i.id)}" title="Set on hand to what's actually there">Adjust</button></span></td>
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
                    <input name="date" type="date" value="${nzToday()}" min="${escHtml(settings.stockEpoch || '')}" required title="Counts start at the stock epoch (${escHtml(settings.stockEpoch || '')})">
                    <input name="label" type="text" placeholder="Label, e.g. Opening count" style="width:200px">
                    <button class="btn-primary btn-sm" type="submit">New count</button>
                    <span class="cat-sub" style="flex-basis:100%;margin:0">Counts from <strong>${fmtDate(settings.stockEpoch)}</strong> (the stock epoch) — change it under <a href="#admin">Settings → Stock → Engine settings</a>.</span>
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
        let c, items, ships = [];
        try { [c, items, ships] = await Promise.all([api('/api/stock/counts/' + encodeURIComponent(id)), api('/api/stock/items'), api('/api/stock/shipments').catch(() => [])]); }
        catch (e) { wrap.innerHTML = `<p class="cat-sub">${escHtml(e.message)}</p>`; return; }
        const byId = Object.fromEntries(items.map(i => [i.id, i]));
        const committed = c.status === 'committed';
        const expected = c.expected || {};
        const shipById = Object.fromEntries(ships.map(s => [s.id, s]));

        // Sub-count by shipment (Prime Tie Bundled): kg on hand from each
        // shipment at its $/kg. Each line becomes an opening FIFO lot.
        const subcountRow = (l, item) => {
            if (item.id !== SHIPMENT_PRODUCT_ID) return '';
            const lots = Array.isArray(l.lots) ? l.lots : [];
            const total = lots.reduce((s, x) => s + (Number(x.kg) || 0), 0);
            const value = lots.reduce((s, x) => { const cost = x.unitCost != null ? Number(x.unitCost) : (shipById[x.shipmentId]?.unitCost ?? null); return s + (cost != null ? (Number(x.kg) || 0) * cost : 0); }, 0);
            if (committed) {
                if (!lots.length) return '';
                return `<tr class="stk2-sublot" data-parent="${escHtml(item.id)}"><td colspan="7"><div class="stk2-sub">
                    ${lots.map(x => `<div class="stk2-sub-line"><span>${fmtNum(x.kg)} kg of <strong>${escHtml(x.label || shipById[x.shipmentId]?.label || 'Shipment')}</strong></span><span>${x.unitCost != null ? '@ $' + fmtNum(x.unitCost, 2) + '/kg = $' + fmtNum(x.kg * x.unitCost) : ''}</span></div>`).join('')}
                    <div class="stk2-sub-line stk2-sub-total"><span>Total</span><span><strong>${fmtNum(total)} kg</strong> · $${fmtNum(value)}</span></div>
                </div></td></tr>`;
            }
            const shipOpts = sel => ships.map(s => `<option value="${escHtml(s.id)}" data-cost="${s.unitCost ?? ''}" ${s.id === sel ? 'selected' : ''}>${escHtml(s.label)}${s.unitCost != null ? ` · $${fmtNum(s.unitCost, 2)}/kg ${s.costBasis || ''}` : ' · no cost yet'} · ${escHtml(s.status)}</option>`).join('');
            const row = x => `<tr class="stk2-sub-row">
                <td><select class="stk2-sub-ship">${shipOpts(x.shipmentId)}</select></td>
                <td><input type="number" step="any" min="0" class="stk2-sub-kg" value="${x.kg ?? ''}" placeholder="kg" style="width:100px;text-align:right"></td>
                <td><input type="number" step="0.01" min="0" class="stk2-sub-cost" value="${x.unitCost ?? ''}" placeholder="${x.shipmentId && shipById[x.shipmentId]?.unitCost != null ? fmtNum(shipById[x.shipmentId].unitCost, 2) : 'derived'}" ${x.unitCost == null ? 'data-auto="1"' : ''} style="width:90px;text-align:right"></td>
                <td><button type="button" class="stk2-sub-del" title="Remove">×</button></td></tr>`;
            return `<tr class="stk2-sublot" data-parent="${escHtml(item.id)}"><td colspan="7"><div class="stk2-sub">
                <div class="cat-sub" style="margin:0 0 0.35rem">Sub-count by shipment — kg on hand from each shipment at its $/kg (leave $/kg blank to use the shipment's landed cost). The total feeds <em>Counted</em>.</div>
                <table class="stk2-sub-table"><thead><tr><th>Shipment</th><th style="text-align:right">kg</th><th style="text-align:right">$/kg</th><th></th></tr></thead>
                <tbody>${lots.map(row).join('')}</tbody></table>
                <div class="stk2-form-row" style="margin-top:0.4rem">
                    <button type="button" class="btn-secondary btn-sm stk2-sub-add">+ Add shipment</button>
                    <span class="cat-sub stk2-sub-total-live">Total <strong>${fmtNum(total)} kg</strong>${value ? ` · $${fmtNum(value)}` : ''}</span>
                </div>
            </div></td></tr>`;
        };

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
                    <label class="cat-sub" style="margin:0;display:flex;align-items:center;gap:0.35rem" title="${committed ? 'Move this count to another date. Frozen figures stay as committed; the baseline moves with the date.' : 'Count date (as at end of day)'}">Date <input type="date" id="stk2-count-date" value="${escHtml(c.date)}"></label>
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
                        <td class="cat-sub">${escHtml(item.unit === 'kg' ? 'kg' : (item.unitLabel || 'each'))}</td>
                        <td style="text-align:right;font-variant-numeric:tabular-nums" title="${exp == null ? 'No earlier committed count for this item — this line sets its baseline' : ''}">${exp == null ? '<span class="cat-sub">—</span>' : fmtQty(exp, item.unit, null, item.unitLabel)}</td>
                        <td style="text-align:right">${committed ? `<span style="font-variant-numeric:tabular-nums">${l.counted === false ? '—' : fmtQty(l.countedQty, item.unit, null, item.unitLabel)}</span>` : `<input type="number" step="any" min="0" class="stk2-counted" value="${l.countedQty ?? ''}" ${l.counted === false ? 'disabled' : ''} style="width:110px;text-align:right">`}</td>
                        <td style="text-align:right;font-variant-numeric:tabular-nums" class="stk2-var">${varianceCell(l, item)}</td>
                        <td>${exp == null
                            ? `<span class="cat-sub" title="Nothing to explain — there is no expected figure to vary from">—</span><input type="hidden" class="stk2-reason" value="${escHtml(l.varianceReason || '')}">`
                            : (committed ? escHtml(l.varianceReason || '') : `<input type="text" class="stk2-reason" value="${escHtml(l.varianceReason || '')}" placeholder="e.g. yield loss" style="width:100%">`)}</td>
                        <td style="text-align:center">${committed ? (l.counted === false ? '✓' : '') : `<input type="checkbox" class="stk2-skip" ${l.counted === false ? 'checked' : ''}>`}</td>
                    </tr>${subcountRow(l, item)}`; }).join('')}</tbody>
            </table></div>
            <div id="stk2-count-msg" class="cat-sub" style="margin-top:0.5rem"></div>
        </div>`;
        wrap.querySelector('#stk2-count').scrollIntoView({ behavior: 'smooth', block: 'start' });
        wrap.querySelector('#stk2-close-count').addEventListener('click', () => { wrap.innerHTML = ''; });
        if (committed) {
            // Only the date (and label) can change on a committed count.
            wrap.querySelector('#stk2-count-date').addEventListener('change', async e => {
                const date = e.target.value;
                if (!date || date === c.date) return;
                if (!confirm(`Move "${c.label}" from ${fmtDate(c.date)} to ${fmtDate(date)}? The baseline moves with it; the frozen figures stay as committed.`)) { e.target.value = c.date; return; }
                try {
                    await api('/api/stock/counts/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify({ date }) });
                    showToast('Count date changed');
                    await renderCounts(body);
                    openCount(body, c.id);
                } catch (err) { showToast('Could not change date: ' + err.message); e.target.value = c.date; }
            });
            return;
        }

        const readSub = itemId => {
            const sub = wrap.querySelector(`tr.stk2-sublot[data-parent="${CSS.escape(itemId)}"]`);
            if (!sub) return null;
            return [...sub.querySelectorAll('tr.stk2-sub-row')].map(r => {
                const sel = r.querySelector('.stk2-sub-ship');
                const costEl = r.querySelector('.stk2-sub-cost');
                return {
                    shipmentId: sel.value || null,
                    label: sel.selectedOptions[0] ? sel.selectedOptions[0].textContent.split(' · ')[0].trim() : '',
                    kg: r.querySelector('.stk2-sub-kg').value === '' ? 0 : Number(r.querySelector('.stk2-sub-kg').value),
                    unitCost: costEl.value === '' ? null : Number(costEl.value),
                };
            });
        };
        const readLines = () => [...wrap.querySelectorAll('tr[data-item]')].map(tr => {
            const lots = readSub(tr.dataset.item);
            const hasLots = lots && lots.length;
            return {
                itemId: tr.dataset.item,
                counted: !tr.querySelector('.stk2-skip').checked,
                countedQty: hasLots ? Math.round(lots.reduce((s, x) => s + x.kg, 0) * 100) / 100
                          : (tr.querySelector('.stk2-counted').value === '' ? null : Number(tr.querySelector('.stk2-counted').value)),
                varianceReason: tr.querySelector('.stk2-reason').value,
                lots: hasLots ? lots : null,
            };
        });
        // Sub-count wiring: add/remove rows, auto-fill $/kg from the shipment,
        // and push the total into the parent line's Counted box.
        wrap.querySelectorAll('tr.stk2-sublot').forEach(sub => {
            const parent = wrap.querySelector(`tr[data-item="${CSS.escape(sub.dataset.parent)}"]`);
            const countedInp = parent.querySelector('.stk2-counted');
            const tbody = sub.querySelector('tbody');
            const sync = () => {
                const lots = readSub(sub.dataset.parent) || [];
                const total = lots.reduce((s, x) => s + x.kg, 0);
                const value = lots.reduce((s, x) => { const cost = x.unitCost != null ? x.unitCost : (shipById[x.shipmentId]?.unitCost ?? null); return s + (cost != null ? x.kg * cost : 0); }, 0);
                sub.querySelector('.stk2-sub-total-live').innerHTML = `Total <strong>${fmtNum(total)} kg</strong>${value ? ` · $${fmtNum(value)}` : ''}`;
                if (lots.length) { countedInp.value = Math.round(total * 100) / 100; countedInp.readOnly = true; countedInp.title = 'From the sub-count below'; }
                else { countedInp.readOnly = false; countedInp.title = ''; }
                countedInp.dispatchEvent(new Event('input'));
            };
            const wireRow = r => {
                const sel = r.querySelector('.stk2-sub-ship'), cost = r.querySelector('.stk2-sub-cost');
                const fillCost = () => {
                    const derived = sel.selectedOptions[0]?.dataset.cost;
                    cost.placeholder = derived ? fmtNum(derived, 2) : 'derived';
                    if (cost.dataset.auto === '1') cost.value = '';
                };
                sel.addEventListener('change', () => { fillCost(); sync(); });
                cost.addEventListener('input', () => { delete cost.dataset.auto; sync(); });
                r.querySelector('.stk2-sub-kg').addEventListener('input', sync);
                r.querySelector('.stk2-sub-del').addEventListener('click', () => { r.remove(); sync(); });
            };
            tbody.querySelectorAll('tr.stk2-sub-row').forEach(wireRow);
            sub.querySelector('.stk2-sub-add').addEventListener('click', () => {
                const tpl = document.createElement('tbody');
                const first = ships[0];
                tpl.innerHTML = `<tr class="stk2-sub-row">
                    <td><select class="stk2-sub-ship">${ships.map(s => `<option value="${escHtml(s.id)}" data-cost="${s.unitCost ?? ''}">${escHtml(s.label)}${s.unitCost != null ? ` · $${fmtNum(s.unitCost, 2)}/kg ${s.costBasis || ''}` : ' · no cost yet'} · ${escHtml(s.status)}</option>`).join('')}</select></td>
                    <td><input type="number" step="any" min="0" class="stk2-sub-kg" placeholder="kg" style="width:100px;text-align:right"></td>
                    <td><input type="number" step="0.01" min="0" class="stk2-sub-cost" placeholder="${first && first.unitCost != null ? fmtNum(first.unitCost, 2) : 'derived'}" data-auto="1" style="width:90px;text-align:right"></td>
                    <td><button type="button" class="stk2-sub-del" title="Remove">×</button></td></tr>`;
                const r = tpl.firstElementChild;
                tbody.appendChild(r); wireRow(r); r.querySelector('.stk2-sub-kg').focus(); sync();
            });
            if (readSub(sub.dataset.parent)?.length) sync();
        });
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
        const save = async () => api('/api/stock/counts/' + encodeURIComponent(c.id), { method: 'PATCH', body: JSON.stringify({ lines: readLines(), date: wrap.querySelector('#stk2-count-date').value }) });
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
        const money = v => v == null || v === '' ? '—' : '$' + fmtNum(v, 2);

        body.innerHTML = `
        <div class="cat-section stk2-section">
            <div class="cat-section-head"><div><h2 class="cat-title">Products</h2><p class="cat-sub" style="margin:0">Each depletes from its Sales History bucket. Prime Tie Bundled is costed from its shipments (FIFO); Loose and eco Ties carry their own cost per kg.</p></div></div>
            <table class="stk-table stk2-table"><thead><tr><th>Name</th><th>Sales bucket</th><th style="text-align:right">Cost $/kg</th><th>Active</th><th></th></tr></thead>
            <tbody>${products.map(i => `<tr class="stk2-rowlink" data-open="${escHtml(i.id)}">
                <td>${i.profile?.imageUrl ? `<img class="stk2-thumb" src="${escHtml(i.profile.imageUrl)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<strong>${escHtml(i.name)}</strong></td><td class="cat-sub">${escHtml(i.salesKey || '—')}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums" title="${escHtml(i.id === SHIPMENT_PRODUCT_ID ? (i.unitValueSource || 'No costed shipment yet') : 'Own cost per kg (edit in the popover)')}">${money(i.unitValue)}${i.id === SHIPMENT_PRODUCT_ID ? (i.unitValueSource ? ` <span class="cat-sub">${escHtml(i.unitValueSource.split(' · ')[0])}</span>` : '') : ' <span class="cat-sub">own</span>'}</td>
                <td>${i.active === false ? 'No' : 'Yes'}</td>
                <td style="text-align:right"><button class="btn-secondary btn-sm" data-open="${escHtml(i.id)}">Edit</button></td></tr>`).join('')}</tbody></table>
        </div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head">
                <div><h2 class="cat-title">Consumables</h2><p class="cat-sub" style="margin:0">Packaging counted in units. Click a row for its details.</p></div>
                <button class="btn-primary btn-sm" id="stk2-add-consumable">+ Add consumable</button>
            </div>
            ${consumables.length ? `<table class="stk-table stk2-table"><thead><tr><th>Name</th><th>Unit</th><th>Retailer</th><th style="text-align:right">Unit price</th><th style="text-align:right">Qty per unit</th><th style="text-align:right">Lead</th><th>Active</th></tr></thead>
            <tbody>${consumables.map(i => { const p = i.profile || {}; return `<tr class="stk2-rowlink" data-open="${escHtml(i.id)}">
                <td>${p.imageUrl ? `<img class="stk2-thumb" src="${escHtml(p.imageUrl)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<strong>${escHtml(i.name)}</strong>${i.courierLabel ? ' <span class="stk2-chip stk2-chip--unknown" title="Depletes by the labels invoiced on each order"><span class="stk2-chip-ico">🏷</span>courier labels</span>' : ''}${p.supplierSku || p.description ? `<div class="cat-sub" style="margin:0">${[p.supplierSku, p.description].filter(Boolean).map(escHtml).join(' · ')}</div>` : ''}</td>
                <td class="cat-sub">${escHtml(i.unitLabel || 'each')}</td>
                <td>${p.retailerUrl ? `<a href="${escHtml(p.retailerUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escHtml(p.retailer || 'Product')} ↗</a>` : escHtml(p.retailer || '—')}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${money(p.typicalCost)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${p.packSize != null ? fmtNum(p.packSize) : '—'}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${p.leadTimeDays != null && p.leadTimeDays !== '' ? p.leadTimeDays + ' d' : `<span class="cat-sub">${settings.defaultLeadTimeDays ?? 14} d</span>`}</td>
                <td>${i.active === false ? 'No' : 'Yes'}</td></tr>`; }).join('')}</tbody></table>` : '<p class="cat-sub">None yet. Add boxes, bags, labels, staples, tape…</p>'}
        </div>

        <div class="cat-section stk2-section" id="stk2-bom">
            <div class="cat-section-head">
                <div><h2 class="cat-title">Consumables matrix</h2><p class="cat-sub" style="margin:0">Products we sell (from the items sheet) × consumables. Cells are in <strong>pieces</strong> — what one sale uses (2 staples, 0.1 of a box). Stock stays in <strong>units</strong> (boxes, rolls); <em>Quantity per unit</em> on the consumable does the conversion, so 2 staples from a 1,000-staple box is 0.002 boxes. <em>Per order</em> is used once per despatch. Courier labels aren't a row: tick <em>Courier label stock</em> on that consumable and it depletes by the labels invoiced on each order.</p></div>
                <button class="btn-primary btn-sm" id="stk2-bom-save">Save matrix</button>
            </div>
            <div id="stk2-bom-grid"></div>
        </div>

        <div class="cat-section stk2-section">
            <div class="cat-section-head"><div><h2 class="cat-title">Engine settings</h2><p class="cat-sub" style="margin:0">Values the engine reads that don't belong to any one item.</p></div></div>
            <form id="stk2-settings" class="stk2-grid-form">
                <label>Stock epoch<input name="stockEpoch" type="date" value="${escHtml(settings.stockEpoch)}"><small>Opening count date. Nothing is computed before it.</small></label>
                <label>Usage window (days)<input name="consumptionWindowDays" type="number" min="1" value="${settings.consumptionWindowDays}"><small>Trailing window for average daily usage (from Sales History).</small></label>
                <label>Lead time (days)<input name="defaultLeadTimeDays" type="number" min="1" value="${settings.defaultLeadTimeDays ?? 14}"><small>Order-to-delivery for consumables. Reorder point = daily usage × (lead + safety).</small></label>
                <label>Safety days<input name="defaultSafetyDays" type="number" min="0" value="${settings.defaultSafetyDays}"><small>Buffer added to lead time.</small></label>
                <label>Watch multiplier<input name="watchMultiplier" type="number" min="1" step="0.05" value="${settings.watchMultiplier}"><small>"Watch" when on hand ≤ reorder point × this.</small></label>
                <label>Default account code<input name="defaultAccountCode" type="text" value="${escHtml(settings.valuation?.defaultAccountCode || '')}"><small>Used on valuation rows when an item has none.</small></label>
                <div style="align-self:end"><button class="btn-primary btn-sm" type="submit">Save settings</button></div>
            </form>
        </div>`;

        const reload = () => renderSettingsTab(body);
        body.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', e => {
            e.stopPropagation();
            openItemModal({ item: items.find(i => i.id === el.dataset.open), settings, onSaved: reload });
        }));
        body.querySelector('#stk2-add-consumable').addEventListener('click', () => openItemModal({ item: null, settings, onSaved: reload }));

        // Consumables matrix — rows: products we sell (+ per-order); columns:
        // active consumables. One matrix, no versioning: it applies to every
        // sale from the beginning of time.
        const activeCons = consumables.filter(c => c.active !== false);
        const latest = (bom.versions || []).slice().sort((a, b) => String(a.effectiveFrom).localeCompare(String(b.effectiveFrom))).pop();
        const matrix = JSON.parse(JSON.stringify(latest?.recipes || {}));
        let perDespatch = (settings.perDespatch || []).map(e => ({ ...e }));
        const grid = body.querySelector('#stk2-bom-grid');
        const qtyOf = (list, cid) => { const e = (list || []).find(x => x.consumableId === cid); return e ? e.qty : ''; };
        const setQty = (list, cid, qty) => {
            const i = list.findIndex(x => x.consumableId === cid);
            if (qty === '' || qty == null || Number(qty) === 0) { if (i >= 0) list.splice(i, 1); }
            else if (i >= 0) list[i].qty = Number(qty); else list.push({ consumableId: cid, qty: Number(qty) });
        };
        const drawGrid = () => {
            if (!activeCons.length) { grid.innerHTML = '<p class="cat-sub">Add consumables first, then fill in what each product uses.</p>'; return; }
            const prods = (bom.products && bom.products.length) ? bom.products : bom.skus.map(x => ({ sku: x, name: x, tracked: true }));
            const rows = prods.map(pr => `<tr class="${pr.tracked ? '' : 'stk2-bom-untracked'}"><td><strong>${escHtml(pr.name)}</strong><div class="cat-sub" style="margin:0">${escHtml(pr.sku)}${pr.tracked ? '' : ' · no sales mapping yet'}</div></td>${activeCons.map(c => `<td><input type="number" step="any" min="0" data-sku="${escHtml(pr.sku)}" data-cid="${escHtml(c.id)}" value="${qtyOf(matrix[pr.sku], c.id)}" title="${escHtml(pr.name)} × ${escHtml(c.name)}"></td>`).join('')}</tr>`).join('');
            const per = `<tr class="stk2-bom-per"><td><strong>Per order</strong><div class="cat-sub" style="margin:0">once per despatch</div></td>${activeCons.map(c => `<td><input type="number" step="any" min="0" data-per="1" data-cid="${escHtml(c.id)}" value="${qtyOf(perDespatch, c.id)}"></td>`).join('')}</tr>`;
            const colHead = c => { const n = Number(c.profile?.packSize) || 1; return `<th class="stk2-bom-col">${c.profile?.imageUrl ? `<img class="stk2-bom-img" src="${escHtml(c.profile.imageUrl)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<div>${escHtml(c.name)}</div><div class="cat-sub" style="margin:0;font-weight:400;text-transform:none;letter-spacing:0" title="Enter pieces per sale; ${n > 1 ? `1 ${escHtml(c.unitLabel || 'unit')} = ${fmtNum(n)} pieces` : 'one piece is one ' + escHtml(c.unitLabel || 'unit')}">${n > 1 ? `pieces · ${fmtNum(n)} per ${escHtml(c.unitLabel || 'unit')}` : `per ${escHtml(c.unitLabel || 'unit')}`}</div></th>`; };
            grid.innerHTML = `<div class="stk-table-wrap"><table class="stk-table stk2-table stk2-bom-table"><thead><tr><th>Product</th>${activeCons.map(colHead).join('')}</tr></thead><tbody>${rows}${per}</tbody></table></div>`;
            grid.querySelectorAll('input[data-sku]').forEach(inp => inp.addEventListener('input', () => {
                matrix[inp.dataset.sku] = matrix[inp.dataset.sku] || [];
                setQty(matrix[inp.dataset.sku], inp.dataset.cid, inp.value);
            }));
            grid.querySelectorAll('input[data-per]').forEach(inp => inp.addEventListener('input', () => setQty(perDespatch, inp.dataset.cid, inp.value)));
        };
        body.querySelector('#stk2-bom-save').addEventListener('click', async () => {
            try {
                await api('/api/stock/bom', { method: 'PUT', body: JSON.stringify({ versions: [{ effectiveFrom: '2020-01-01', recipes: matrix }] }) });
                await api('/api/stock/settings', { method: 'PUT', body: JSON.stringify({ perDespatch, perLabel: [] }) });
                showToast('Matrix saved');
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
                    defaultLeadTimeDays: Number(f.defaultLeadTimeDays.value),
                    defaultSafetyDays: Number(f.defaultSafetyDays.value), watchMultiplier: Number(f.watchMultiplier.value),
                    valuation: { defaultAccountCode: f.defaultAccountCode.value.trim() },
                }) });
                showToast('Settings saved');
            } catch (err) { showToast('Could not save: ' + err.message); }
        });
    }

    // Item popover — add a consumable, or open any item's details to edit.
    // Consumables carry just: Retailer, Unit price, Quantity per unit, Image
    // link, Link to product. Products: name + account code (value comes from
    // shipments, reorder from usage).
    function openItemModal({ item, settings, onSaved }) {
        const isNew = !item;
        const it = item || { class: 'consumable', unit: 'each', active: true, profile: {} };
        const prod = it.class === 'product';
        const p = it.profile || {};
        // Image: upload a photo (resized in the browser, stored in KV) or link one.
        const imageFields = () => `
                    <div class="modal-field stk2-span2"><label>Image <span class="modal-hint">upload a photo, or paste a link</span></label>
                        <div class="stk2-form-row">
                            <label class="btn-secondary btn-sm" style="cursor:pointer">Upload photo<input type="file" id="stk2-img-file" accept="image/*" hidden></label>
                            <input name="imageUrl" type="url" value="${escHtml(p.imageUrl || '')}" placeholder="or https://…/photo.jpg" style="flex:1;min-width:200px">
                            <button type="button" class="btn-secondary btn-sm" id="stk2-img-remove" ${p.imageUrl ? '' : 'hidden'}>Remove</button>
                        </div>
                    </div>
                    <div class="stk2-span2 stk2-img-preview" ${p.imageUrl ? '' : 'hidden'}><img src="${escHtml(p.imageUrl || '')}" alt=""><span class="cat-sub" id="stk2-img-note"></span></div>`;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
        <div class="modal-box modal-box--wide stk2-modal" role="dialog" aria-modal="true">
            <h3 class="modal-title">${isNew ? 'Add consumable' : escHtml(it.name)}${!isNew ? ` <span class="modal-hint">${escHtml(it.class)} · ${escHtml(it.unit)}</span>` : ''}</h3>
            <form id="stk2-item-form">
                <div class="stk2-modal-grid">
                    <div class="modal-field stk2-span2"><label>Name</label><input name="name" type="text" required value="${escHtml(it.name || '')}" autofocus></div>
                    ${prod ? `
                    ${it.id === SHIPMENT_PRODUCT_ID
                        ? `<div class="modal-field"><label>Weighted cost $/kg <span class="modal-hint">FIFO · from shipments</span></label><input type="text" id="stk2-bundled-cost" value="Loading…" disabled></div>
                           <div class="modal-field"><label>Stock on hand <span class="modal-hint">count − sales + landed ± adjustments</span></label><input type="text" id="stk2-bundled-onhand" value="Loading…" disabled></div>
                           <div class="stk2-span2" id="stk2-bundled-stock"><p class="cat-sub">Loading shipment lots…</p></div>`
                        : `<div class="modal-field"><label>Cost $/kg <span class="modal-hint">ex GST</span></label><input name="unitValue" type="number" step="0.01" min="0" value="${it.unitValue ?? ''}" placeholder="0.00"></div>`}
                    ${imageFields()}`
                    : `
                    <div class="modal-field"><label>SKU <span class="modal-hint">supplier's code</span></label><input name="supplierSku" type="text" value="${escHtml(p.supplierSku || '')}" placeholder="e.g. PT-48-100"></div>
                    <div class="modal-field"><label>Product description</label><input name="description" type="text" value="${escHtml(p.description || '')}" placeholder="What it is, size, colour…"></div>
                    <div class="modal-field"><label>Unit type <span class="modal-hint">what one of these is</span></label><input name="unitLabel" type="text" value="${escHtml(it.unitLabel || '')}" placeholder="box, roll, bag, sheet…" list="stk2-unit-types"><datalist id="stk2-unit-types"><option value="box"><option value="bag"><option value="roll"><option value="sheet"><option value="label"><option value="staple"><option value="pack"></datalist></div>
                    <div class="modal-field stk2-span2 stk2-check"><label style="display:flex;align-items:center;gap:0.5rem;text-transform:none;letter-spacing:0;font-size:0.85rem;font-weight:500"><input type="checkbox" name="courierLabel" ${it.courierLabel ? 'checked' : ''} style="width:auto"> Courier label stock <span class="modal-hint">depletes by the labels invoiced on each order (courier lines), one per label — no matrix cell needed</span></label></div>
                    <div class="modal-field"><label>Retailer</label><input name="retailer" type="text" value="${escHtml(p.retailer || '')}" placeholder="e.g. Packaging House"></div>
                    <div class="modal-field"><label>Unit price <span class="modal-hint">$ ex GST</span></label><input name="unitPrice" type="number" step="0.0001" min="0" value="${p.typicalCost ?? ''}" placeholder="0.00"></div>
                    <div class="modal-field"><label>Quantity per unit <span class="modal-hint">pieces in one unit, e.g. 1,000 staples per box</span></label><input name="packSize" type="number" step="any" min="0" value="${p.packSize ?? ''}" placeholder="1"></div>
                    <div class="modal-field"><label>Lead time <span class="modal-hint">days from ordering to delivery</span></label><input name="leadTimeDays" type="number" min="0" step="1" value="${p.leadTimeDays ?? ''}" placeholder="default ${settings.defaultLeadTimeDays ?? 14}"></div>
                    <div class="modal-field"><label>Link to product</label><input name="retailerUrl" type="url" value="${escHtml(p.retailerUrl || '')}" placeholder="https://…"></div>
                    ${imageFields()}`}
                    ${!isNew ? `<div class="modal-field"><label>Active</label><select name="active"><option value="true" ${it.active !== false ? 'selected' : ''}>Yes</option><option value="false" ${it.active === false ? 'selected' : ''}>No — hide from counts and dashboard</option></select></div>` : ''}
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary" id="stk2-modal-cancel">Cancel</button>
                    <button type="submit" class="btn-primary">${isNew ? 'Add' : 'Save'}</button>
                </div>
            </form>
        </div>`;
        document.body.appendChild(overlay);
        // Prime Tie Bundled: live stock from the engine — on hand, weighted
        // cost, and the breakdown by shipment lot (pulling each lot's $/kg).
        if (it.id === SHIPMENT_PRODUCT_ID) {
            api('/api/stock/levels').then(lv => {
                const b = (lv.items || []).find(x => x.id === it.id);
                const costEl = overlay.querySelector('#stk2-bundled-cost');
                const ohEl = overlay.querySelector('#stk2-bundled-onhand');
                const box = overlay.querySelector('#stk2-bundled-stock');
                if (!b || lv.beforeEpoch) { costEl.value = '—'; ohEl.value = 'Before the stock epoch'; box.innerHTML = ''; return; }
                costEl.value = b.avgCost != null ? `$${fmtNum(b.avgCost, 2)}/kg` : (it.unitValue != null ? `$${fmtNum(it.unitValue, 2)}/kg · latest shipment` : 'No costed shipment yet');
                ohEl.value = b.onHand != null ? `${fmtNum(b.onHand)} kg · $${fmtNum(b.value || 0)}` : 'Unknown — no committed count yet';
                const lots = (b.lots || []).filter(l => l.remaining > 0);
                const pend = (lv.pendingShipments || []).filter(p => p.itemId === it.id);
                box.innerHTML = `
                    ${lots.length ? `<table class="stk2-sub-table" style="width:100%;margin:0.25rem 0 0.5rem"><thead><tr><th>Shipment</th><th style="text-align:right">On hand</th><th style="text-align:right">$/kg</th><th style="text-align:right">Value</th></tr></thead>
                    <tbody>${lots.map(l => `<tr><td>${escHtml(l.note)}<span class="cat-sub"> · ${fmtDate(l.date)}</span></td><td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(l.remaining)} kg</td><td style="text-align:right;font-variant-numeric:tabular-nums">${l.unitCost != null ? '$' + fmtNum(l.unitCost, 2) : '—'}${l.basis && l.basis !== 'landed' && l.basis !== 'counted' ? ` <span class="cat-sub">${escHtml(l.basis)}</span>` : ''}</td><td style="text-align:right;font-variant-numeric:tabular-nums">$${fmtNum(l.value)}</td></tr>`).join('')}</tbody></table>`
                    : `<p class="cat-sub" style="margin:0.25rem 0 0.5rem">${b.onHand == null ? 'Commit a count (sub-counted by shipment) to see the breakdown.' : 'No shipment lots remaining.'}</p>`}
                    ${pend.length ? `<p class="cat-sub" style="margin:0 0 0.5rem">On order (not in on hand): ${pend.map(p => `<strong>${escHtml(p.note)}</strong> ${fmtNum(p.kg)} kg${p.unitCost != null ? ' @ $' + fmtNum(p.unitCost, 2) : ''} · ${escHtml(p.status)} · due ${fmtDate(p.eta)}`).join(' · ')}. A shipment counts as arrived only once its final milestone (Arrived in Tauranga) is ticked.</p>` : ''}
                    <p class="cat-sub" style="margin:0">Stock on hand isn't typed here — it moves through a <a href="#warehouse" onclick="document.querySelector('.modal-overlay')?.remove()">count</a> (sets the baseline per shipment) or an <a href="#warehouse" onclick="document.querySelector('.modal-overlay')?.remove()">adjustment / wastage</a> entry. ${b.baselineDate ? `Last count ${fmtDate(b.baselineDate)}.` : ''}</p>`;
            }).catch(e => {
                overlay.querySelector('#stk2-bundled-stock').innerHTML = `<p class="cat-sub">${escHtml(e.message)}</p>`;
            });
        }
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        overlay.querySelector('#stk2-modal-cancel').addEventListener('click', close);
        // Image: link, upload (resized in the browser, sent after save), or remove.
        let pendingImage = null, removeImage = false;
        const imgInp = overlay.querySelector('input[name="imageUrl"]');
        const imgBox = overlay.querySelector('.stk2-img-preview');
        const imgNote = overlay.querySelector('#stk2-img-note');
        const imgRemove = overlay.querySelector('#stk2-img-remove');
        const showPreview = (src, note) => { imgBox.hidden = !src; imgBox.querySelector('img').src = src || ''; if (imgNote) imgNote.textContent = note || ''; if (imgRemove) imgRemove.hidden = !src; };
        if (imgInp) imgInp.addEventListener('input', () => { pendingImage = null; removeImage = false; showPreview(imgInp.value.trim(), ''); });
        const fileInp = overlay.querySelector('#stk2-img-file');
        if (fileInp) fileInp.addEventListener('change', async () => {
            const file = fileInp.files && fileInp.files[0];
            if (!file) return;
            try {
                pendingImage = await resizeImage(file);
                removeImage = false;
                if (imgInp) imgInp.value = '';
                showPreview(pendingImage.dataUrl, `${file.name} · resized, saved on Save (${Math.round(pendingImage.data.length * 0.75 / 1024)} KB)`);
            } catch (e) { showToast(e.message); }
            fileInp.value = '';
        });
        if (imgRemove) imgRemove.addEventListener('click', () => {
            pendingImage = null; removeImage = true;
            if (imgInp) imgInp.value = '';
            showPreview('', '');
        });
        overlay.querySelector('#stk2-item-form').addEventListener('submit', async e => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const g = k => { const v = f.get(k); return v == null || String(v).trim() === '' ? null : String(v).trim(); };
            const payload = { name: g('name') };
            if (!isNew) payload.active = g('active') !== 'false';
            if (prod) {
                if (it.id !== SHIPMENT_PRODUCT_ID) payload.unitValue = g('unitValue'); // own cost per kg
                payload.profile = { ...(it.profile || {}), imageUrl: g('imageUrl') };
            } else {
                const price = g('unitPrice');
                payload.unitLabel = g('unitLabel');
                payload.courierLabel = f.get('courierLabel') === 'on';
                payload.profile = { retailer: g('retailer'), retailerUrl: g('retailerUrl'), imageUrl: g('imageUrl'), typicalCost: price, packSize: g('packSize'),
                                    supplierSku: g('supplierSku'), description: g('description'), leadTimeDays: g('leadTimeDays') };
                payload.unitValue = price; // valuation uses the purchase price
            }
            try {
                const saved = isNew
                    ? await api('/api/stock/items', { method: 'POST', body: JSON.stringify({ ...payload, class: 'consumable', unit: 'each' }) })
                    : await api('/api/stock/items/' + encodeURIComponent(it.id), { method: 'PATCH', body: JSON.stringify(payload) });
                const imgPath = '/api/stock/items/' + encodeURIComponent(saved.id || it.id) + '/image';
                if (pendingImage) await api(imgPath, { method: 'POST', body: JSON.stringify({ data: pendingImage.data, mediaType: pendingImage.mediaType }) });
                else if (removeImage) await api(imgPath, { method: 'DELETE' }).catch(() => {});
                showToast(isNew ? 'Consumable added' : 'Saved');
                close();
                onSaved && onSaved();
            } catch (err) { showToast('Could not save: ' + err.message); }
        });
    }

    return { renderWarehouse, renderDashboard, renderCounts, renderSettingsTab };
})();
