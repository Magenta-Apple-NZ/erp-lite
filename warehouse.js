// ── Warehouse module ──
// Handles #warehouse view — Stocktake + Imports tabs

const Warehouse = (() => {

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

    function fmt(n) {
        return Number(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        return new Date(iso).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    // Business Hub went live on 2026-04-01. Forecast actuals for months
    // before this come from the historical sales sheet (see Sales History
    // view); from this month on, Hub orders are authoritative.
    const HUB_LIVE_YM = '2026-04';

    // Order line → kg. Prefers an explicit kgPerUnit field (stamped from the
    // catalog), falls back to parsing "1kg"/"10kg" out of the text, otherwise
    // 0 so non-product lines (freight, fees) don't inflate kg/box totals.
    function lineKg(l) {
        let kgPer;
        if (l?.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) {
            kgPer = Number(l.kgPerUnit);
        } else {
            const text = `${l?.description || ''} ${l?.name || ''} ${l?.sku || ''}`;
            const m = text.match(/\b(10|1)\s*kg\b/i);
            kgPer = m ? Number(m[1]) : 0;
        }
        return (Number(l?.quantity) || 0) * kgPer;
    }

    // ── CSV parser for Enviroware stocktake format ──
    // Finds the header row automatically, handles $-formatted and comma-formatted numbers
    function parseStocktakeCsv(text) {
        const lines = text.replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim());

        // Find header row containing "Item Description" or "Units"
        let headerIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i].toLowerCase();
            if (l.includes('item description') || (l.includes('units') && l.includes('unit value'))) {
                headerIdx = i;
                break;
            }
        }

        // Extract metadata from rows above the header
        let label = '', date = '';
        for (let i = 0; i < Math.min(headerIdx < 0 ? 6 : headerIdx, lines.length); i++) {
            const cols = splitCsvLine(lines[i]);
            if (cols.join('').match(/FY|stocktake|end of year/i)) {
                label = cols.filter(Boolean).join(' ').trim();
            }
            // Look for date like MM/DD/YYYY or YYYY-MM-DD
            const dateMatch = lines[i].match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
            if (dateMatch && !date) {
                const [, a, b, c] = dateMatch;
                const yr = c.length === 2 ? '20' + c : c;
                // Assume MM/DD/YYYY format from the CSV sample
                date = `${yr}-${a.padStart(2,'0')}-${b.padStart(2,'0')}`;
            }
        }

        if (!date) date = new Date().toISOString().slice(0, 10);

        if (headerIdx < 0) {
            // Try to use a standard format: Active, Description, Units, Unit Value, Net
            headerIdx = 0;
        }

        const headerCols = splitCsvLine(lines[headerIdx]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, '_'));

        // Find column indices
        const colIdx = {
            active:      headerCols.findIndex(h => h === 'active' || h.startsWith('includ')),
            description: headerCols.findIndex(h => h.includes('description') || h.includes('item')),
            units:       headerCols.findIndex(h => h === 'units' || h === 'qty' || h === 'quantity'),
            unitValue:   headerCols.findIndex(h => h.includes('unit_value') || h.includes('unit_price') || h.includes('value_ex')),
        };

        // Fallback: if first column is TRUE/FALSE, it's the active flag
        // The description is typically in column 1, units near end
        // This handles the messy Enviroware export format
        const items = [];
        for (let i = headerIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            const cols = splitCsvLine(line);

            // Skip if all empty
            if (cols.every(c => !c.trim())) continue;

            let active = true, description = '', units = 0, unitValue = 0, accountCode = '';

            // Auto-detect format
            const firstCol = cols[0]?.trim().toUpperCase();
            if (firstCol === 'TRUE' || firstCol === 'FALSE') {
                // Enviroware format: Active, Description, ..., Units, UnitValue, Net
                active      = firstCol === 'TRUE';
                description = cols[1]?.trim() || '';
                // Find the last few non-empty numeric columns
                const numCols = cols.slice(-4).map(c => parseNum(c));
                // cols[-3] = units, cols[-2] = unitValue, cols[-1] = net (calculated)
                units     = parseNum(cols[cols.length - 3]) || parseNum(cols[cols.length - 2]) || 0;
                unitValue = parseNum(cols[cols.length - 2]) || 0;
                // If the second-to-last looks like a price (small number) and third-to-last is large, swap
                const rawUnits = parseNum(cols[cols.length - 3]);
                const rawVal   = parseNum(cols[cols.length - 2]);
                if (rawVal > rawUnits && rawUnits > 0) {
                    units = rawUnits;
                    unitValue = rawVal;
                } else if (rawVal < 100 && rawUnits > rawVal) {
                    units = rawUnits;
                    unitValue = rawVal;
                }
            } else if (colIdx.description >= 0) {
                active      = colIdx.active >= 0 ? cols[colIdx.active]?.trim().toUpperCase() !== 'FALSE' : true;
                description = cols[colIdx.description]?.trim() || '';
                units       = colIdx.units >= 0 ? parseNum(cols[colIdx.units]) : 0;
                unitValue   = colIdx.unitValue >= 0 ? parseNum(cols[colIdx.unitValue]) : 0;
            } else {
                continue; // can't parse this row
            }

            if (!description) continue;

            // Extract account code from description e.g. "Stock [41]"
            const acMatch = description.match(/\[(\d+)\]$/);
            if (acMatch) {
                accountCode = acMatch[1];
                description = description.replace(/\s*\[\d+\]$/, '').trim();
            }

            items.push({ active, description, accountCode, units, unitValue, net: Math.round(units * unitValue * 100) / 100 });
        }

        return { label, date, items };
    }

    function splitCsvLine(line) {
        const cols = [];
        let cur = '', inQ = false;
        for (const ch of line) {
            if (ch === '"') { inQ = !inQ; }
            else if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
            else { cur += ch; }
        }
        cols.push(cur);
        return cols;
    }

    function parseNum(str) {
        if (!str) return 0;
        return parseFloat(String(str).replace(/[$,\s]/g, '')) || 0;
    }

    // ── Totals helper ──
    function calcTotal(items) {
        return items.filter(i => i.active).reduce((s, i) => s + (Number(i.units) * Number(i.unitValue)), 0);
    }

    // ── SVG chart — bar chart of snapshot totals over time ──
    function buildChart(snapshots) {
        if (snapshots.length === 0) return '';
        const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
        const max = Math.max(...sorted.map(s => s.total), 1);
        const W = 600, H = 160, pad = { l: 60, r: 10, t: 10, b: 40 };
        const bw = Math.min(50, (W - pad.l - pad.r) / sorted.length - 8);
        const step = (W - pad.l - pad.r) / sorted.length;

        const bars = sorted.map((s, i) => {
            const bh = Math.max(2, ((s.total / max) * (H - pad.t - pad.b)));
            const x = pad.l + i * step + (step - bw) / 2;
            const y = H - pad.b - bh;
            const label = s.date.slice(0, 7); // YYYY-MM
            return `
            <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}"
                  fill="#3b82f6" rx="3" opacity="0.85"/>
            <text x="${(x + bw/2).toFixed(1)}" y="${(H - pad.b + 14).toFixed(1)}"
                  text-anchor="middle" font-size="9" fill="#64748b">${escHtml(label)}</text>
            <title>$${fmt(s.total)} — ${escHtml(s.label)}</title>`;
        }).join('');

        // Y-axis labels
        const yLabels = [0, 0.25, 0.5, 0.75, 1].map(f => {
            const val = max * f;
            const y = H - pad.b - f * (H - pad.t - pad.b);
            return `<text x="${pad.l - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#94a3b8">$${Math.round(val/1000)}k</text>
                    <line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>`;
        }).join('');

        return `
        <svg viewBox="0 0 ${W} ${H}" class="stk-chart" xmlns="http://www.w3.org/2000/svg">
            ${yLabels}${bars}
        </svg>`;
    }

    // ── Stocktake editor state ──
    let editRows = [];
    let currentSnapshotId = null;

    function tableHtml(rows) {
        if (!rows.length) return '<p class="wh-empty">No items yet.</p>';
        const activeTotal = calcTotal(rows);
        return `
        <table class="stk-table">
            <thead>
                <tr>
                    <th style="width:30px" title="Include in total">✓</th>
                    <th>Description</th>
                    <th style="width:60px">Acct</th>
                    <th style="width:90px;text-align:right">Units</th>
                    <th style="width:100px;text-align:right">Unit Value</th>
                    <th style="width:110px;text-align:right">Net (ex. GST)</th>
                </tr>
            </thead>
            <tbody>
                ${rows.map((r, i) => `
                <tr class="stk-row ${r.active ? '' : 'stk-inactive'}" data-idx="${i}">
                    <td><input type="checkbox" class="stk-active" ${r.active ? 'checked' : ''}></td>
                    <td><input type="text" class="stk-desc" value="${escHtml(r.description)}" placeholder="Description"></td>
                    <td><input type="text" class="stk-acct" value="${escHtml(r.accountCode)}" placeholder="—" maxlength="6"></td>
                    <td><input type="number" class="stk-units" value="${r.units}" min="0" step="any" style="text-align:right"></td>
                    <td><input type="number" class="stk-uval" value="${r.unitValue}" min="0" step="0.01" placeholder="0.00" style="text-align:right"></td>
                    <td class="stk-net" style="text-align:right;padding-right:0.75rem">$${fmt(r.net)}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        <div class="stk-total-row">
            <span>Total (active items, ex. GST)</span>
            <strong id="stk-live-total">$${fmt(activeTotal)}</strong>
        </div>`;
    }

    function wireTable(container) {
        container.querySelectorAll('.stk-row').forEach(tr => {
            const idx = parseInt(tr.dataset.idx);

            tr.querySelector('.stk-active').addEventListener('change', e => {
                editRows[idx].active = e.target.checked;
                tr.classList.toggle('stk-inactive', !e.target.checked);
                updateTotal();
            });
            tr.querySelector('.stk-desc').addEventListener('input', e => { editRows[idx].description = e.target.value; });
            tr.querySelector('.stk-acct').addEventListener('input', e => { editRows[idx].accountCode = e.target.value; });

            const updateNet = () => {
                editRows[idx].units     = parseFloat(tr.querySelector('.stk-units').value) || 0;
                editRows[idx].unitValue = parseFloat(tr.querySelector('.stk-uval').value) || 0;
                editRows[idx].net       = Math.round(editRows[idx].units * editRows[idx].unitValue * 100) / 100;
                tr.querySelector('.stk-net').textContent = '$' + fmt(editRows[idx].net);
                updateTotal();
            };
            tr.querySelector('.stk-units').addEventListener('input', updateNet);
            tr.querySelector('.stk-uval').addEventListener('input', updateNet);
        });
    }

    function updateTotal() {
        const el = document.getElementById('stk-live-total');
        if (el) el.textContent = '$' + fmt(calcTotal(editRows));
    }

    function addBlankRow() {
        editRows.push({ active: true, description: '', accountCode: '', units: 0, unitValue: 0, net: 0 });
        const tbl = document.getElementById('stk-table-wrap');
        if (tbl) {
            tbl.innerHTML = tableHtml(editRows);
            wireTable(tbl);
        }
    }

    // ── Main render ──
    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Warehouse</h1>
                <p class="view-subtitle">Track stock on hand and value over time.</p>
            </div>
        </div>
        <div id="wh-body"><div class="orders-loading">Loading…</div></div>`;

        await renderStocktake();
    }

    async function renderStocktake() {
        const body = document.getElementById('wh-body');
        body.innerHTML = '<div class="orders-loading">Loading…</div>';

        let snapshots = [];
        try { snapshots = await api('/api/stocktake'); } catch (e) { /* ok if empty */ }

        const histHtml = snapshots.length ? `
        <div class="stk-history">
            <h3 class="stk-section-title">History</h3>
            ${buildChart(snapshots)}
            <table class="stk-hist-table">
                <thead><tr><th>Label</th><th>Date</th><th style="text-align:right">Total (ex. GST)</th><th></th></tr></thead>
                <tbody>
                    ${snapshots.map(s => `
                    <tr>
                        <td><a href="#" class="stk-hist-link" data-id="${s.id}">${escHtml(s.label)}</a></td>
                        <td style="color:#64748b">${fmtDate(s.date)}</td>
                        <td style="text-align:right;font-weight:700">$${fmt(s.total)}</td>
                        <td style="text-align:right">
                            <button class="stk-del-btn" data-id="${s.id}" title="Delete snapshot">×</button>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>` : '';

        body.innerHTML = `
        <div class="stk-layout">
            <div class="stk-editor cat-section">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title" id="stk-editor-title">New Stocktake</h2>
                        <p class="cat-sub">Edit values below then save as a snapshot.</p>
                    </div>
                    <div class="cat-actions">
                        <input type="date" id="stk-date" class="stk-date-input" value="${new Date().toISOString().slice(0,10)}">
                        <input type="text" id="stk-label" class="stk-label-input" placeholder="Label, e.g. FY26 End of Year">
                        <label class="btn-secondary btn-sm cat-upload-lbl" title="Import existing CSV">
                            Import CSV
                            <input type="file" id="stk-csv-file" accept=".csv" style="display:none">
                        </label>
                        <button class="btn-secondary btn-sm" id="stk-add-row-btn">+ Add row</button>
                        <button class="btn-primary btn-sm" id="stk-save-btn">Save Snapshot</button>
                    </div>
                </div>
                <div id="stk-table-wrap" class="stk-table-wrap">
                    <p class="wh-empty">Import a CSV or add rows manually to begin.</p>
                </div>
            </div>
            ${histHtml ? `<div class="stk-right">${histHtml}</div>` : ''}
        </div>`;

        editRows = [];
        currentSnapshotId = null;

        // CSV import
        document.getElementById('stk-csv-file').addEventListener('change', async e => {
            const file = e.target.files[0];
            if (!file) return;
            e.target.value = '';
            try {
                const { label, date, items } = parseStocktakeCsv(await file.text());
                if (!items.length) { showToast('No items found — check CSV format'); return; }
                editRows = items;
                currentSnapshotId = null;
                if (label) document.getElementById('stk-label').value = label;
                if (date)  document.getElementById('stk-date').value = date;
                document.getElementById('stk-editor-title').textContent = 'Imported Stocktake';
                const wrap = document.getElementById('stk-table-wrap');
                wrap.innerHTML = tableHtml(editRows);
                wireTable(wrap);
                showToast(`Imported ${items.length} items`);
            } catch (err) {
                showToast('Parse error: ' + err.message);
            }
        });

        // Add blank row
        document.getElementById('stk-add-row-btn').addEventListener('click', addBlankRow);

        // Save snapshot
        document.getElementById('stk-save-btn').addEventListener('click', async () => {
            if (!editRows.length) { showToast('Nothing to save'); return; }
            const btn = document.getElementById('stk-save-btn');
            btn.disabled = true; btn.textContent = 'Saving…';
            const label = document.getElementById('stk-label').value.trim() || document.getElementById('stk-date').value;
            const date  = document.getElementById('stk-date').value;
            try {
                let snap;
                if (currentSnapshotId) {
                    snap = await api('/api/stocktake/' + currentSnapshotId, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ label, items: editRows }),
                    });
                } else {
                    snap = await api('/api/stocktake', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ label, date, items: editRows }),
                    });
                    currentSnapshotId = snap.id;
                }
                document.getElementById('stk-editor-title').textContent = escHtml(snap.label);
                showToast('Snapshot saved — $' + fmt(snap.total));
                // Refresh history
                await renderStocktake();
                // Restore editor state to the saved snapshot
                loadSnapshot(snap);
            } catch (err) {
                showToast('Save failed: ' + err.message);
                btn.disabled = false; btn.textContent = 'Save Snapshot';
            }
        });

        // History links & delete
        body.querySelectorAll('.stk-hist-link').forEach(a => {
            a.addEventListener('click', async e => {
                e.preventDefault();
                try {
                    const snap = await api('/api/stocktake/' + a.dataset.id);
                    loadSnapshot(snap);
                } catch (err) {
                    showToast('Load failed: ' + err.message);
                }
            });
        });

        body.querySelectorAll('.stk-del-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this snapshot?')) return;
                try {
                    await api('/api/stocktake/' + btn.dataset.id, { method: 'DELETE' });
                    showToast('Deleted');
                    await renderStocktake();
                } catch (err) {
                    showToast('Delete failed: ' + err.message);
                }
            });
        });
    }

    function loadSnapshot(snap) {
        editRows = snap.items.map(i => ({ ...i }));
        currentSnapshotId = snap.id;
        const titleEl = document.getElementById('stk-editor-title');
        if (titleEl) titleEl.textContent = snap.label;
        const labelEl = document.getElementById('stk-label');
        if (labelEl) labelEl.value = snap.label;
        const dateEl = document.getElementById('stk-date');
        if (dateEl) dateEl.value = snap.date;
        const wrap = document.getElementById('stk-table-wrap');
        if (wrap) { wrap.innerHTML = tableHtml(editRows); wireTable(wrap); }
    }

    // ══════════════════════════════════════════
    //  STOCK FORECAST — Prime Ties
    // ══════════════════════════════════════════

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function fmtKg(n) {
        const v = Math.round(n);
        if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
        if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(v);
    }

    function fmtFull(n) {
        return Math.round(n).toLocaleString('en-NZ');
    }

    function ymLabel(ym) {
        if (!ym) return '';
        const [y, m] = ym.split('-');
        return `${MONTH_NAMES[parseInt(m) - 1]} ${y}`;
    }

    // Source-of-truth for when a shipment lands: the date on the last
    // milestone (typically "Arrived in Tauranga") trumps the shipment-level
    // s.ym field. defaultMilestonesV3 seeds dates from startDate so this
    // value is always populated for v3 ships; legacy ships without
    // milestone dates fall back to s.ym.
    function shipArrivalDate(s) {
        const milestones = s?.milestones || [];
        for (let i = milestones.length - 1; i >= 0; i--) {
            const date = milestones[i]?.date;
            if (date) return date.slice(0, 10);
        }
        return s?.ym ? s.ym + '-01' : '';
    }
    function shipArrivalYm(s) {
        const d = shipArrivalDate(s);
        return d ? d.slice(0, 7) : '';
    }

    function shipIncomingKg(s) {
        // V3 shipments split raw weights into white/colour with a waste %.
        // Fall back to legacy `s.kg` when those aren't populated — otherwise
        // a half-filled v3 shipment silently contributes 0 to incoming
        // and the forecast looks like nothing's arriving.
        if (s.schema === 3) {
            const net   = (Number(s.whiteRawKg) || 0) + (Number(s.colourRawKg) || 0);
            const waste = Math.max(0, Math.min(100, Number(s.wastePct ?? 10)));
            const yieldKg = net * (100 - waste) / 100;
            if (yieldKg > 0) return yieldKg;
        }
        return Number(s.kg) || 0;
    }

    // Seasonal demand baseline (kg/month, Jan→Dec). Used when the user's
    // stored config has no monthlyAvg array — without this every month
    // subtracts 0 and the projected stock line flatlines at startingKg.
    const FORECAST_MONTHLY_AVG_DEFAULT = [2000, 750, 1000, 2000, 3000, 5500, 7000, 5000, 1000, 200, 50, 400];

    // Derive a shipment's status from its milestone completions so the
    // badge stays in sync with reality. The previous behaviour relied on
    // a manual dropdown that was easy to forget. Mapping is positional so
    // it works for both the v3 7-stage flow and legacy 5-stage shipments:
    //   none done            → planning
    //   only the anchor done → planning
    //   first real step done → ordered
    //   anywhere in the middle → in-transit
    //   second-to-last done  → customs
    //   final stage done     → delivered
    function deriveShipStatus(s) {
        const milestones = s?.milestones || [];
        if (!milestones.length) return s?.status || 'planning';
        const lastDone = milestones.reduce((acc, m, i) => m.done ? i : acc, -1);
        if (lastDone < 0) return 'planning';
        const total = milestones.length;
        if (lastDone === 0) return 'planning';
        if (lastDone === 1) return 'ordered';
        if (lastDone >= total - 1) return 'delivered';
        if (lastDone === total - 2) return 'customs';
        return 'in-transit';
    }

    function computeForecast(config, months = 18, actuals = {}) {
        const rawAvg     = Array.isArray(config.monthlyAvg) ? config.monthlyAvg : null;
        const hasAvg     = rawAvg && rawAvg.length === 12 && rawAvg.some(v => Number(v) > 0);
        const monthlyAvg = hasAvg ? rawAvg : FORECAST_MONTHLY_AVG_DEFAULT;
        const shipments  = config.shipments  || [];
        const starting   = config.startingKg ?? 0;

        // Stocktake anchor: the forecast starts at the stocktake's month and
        // its first row's demand is pro-rated for the remaining days. Any
        // shipment arriving BEFORE the stocktake date is assumed to be
        // already on the shelf (so it doesn't get added again). Falls back
        // to "start of current month" so legacy configs without a date
        // behave the same as before this change.
        const today = new Date();
        let stocktake;
        if (config.stocktakeDate && /^\d{4}-\d{2}-\d{2}$/.test(config.stocktakeDate)) {
            stocktake = config.stocktakeDate;
        } else {
            stocktake = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
        }
        const [stkYrStr, stkMoStr, stkDayStr] = stocktake.split('-');
        const stkYr  = parseInt(stkYrStr, 10);
        const stkMo  = parseInt(stkMoStr, 10) - 1; // 0..11
        const stkDay = parseInt(stkDayStr, 10);
        const daysInStkMonth = new Date(stkYr, stkMo + 1, 0).getDate();
        const proration = Math.max(0, Math.min(1,
            (daysInStkMonth - stkDay + 1) / daysInStkMonth));

        let yr = stkYr, mo = stkMo;
        const rows = [];
        let runAvg = starting, runGood = starting, runGreat = starting;

        for (let i = 0; i < months; i++) {
            const ym = `${yr}-${String(mo + 1).padStart(2, '0')}`;
            const isStkMonth = (i === 0);

            // Use the milestone-driven arrival date, not s.ym. A shipment
            // currently sitting in customs with "Arrived in Tauranga" dated
            // this month should add to this month's incoming column —
            // unless its arrival is BEFORE the stocktake (in which case
            // it's already on the shelf and counted in starting).
            const incomingShips = shipments.filter(s => {
                const d = shipArrivalDate(s);
                if (!d || d.slice(0, 7) !== ym) return false;
                if (isStkMonth && d < stocktake) return false;
                return true;
            });
            const incoming = incomingShips.reduce((sum, s) => sum + shipIncomingKg(s), 0);

            // Mid-month rule: keep the projection conservative. When actuals
            // exist for a month, use max(actuals, forecast) for the math —
            // so an in-progress month with 200 kg sold doesn't masquerade as
            // a low-volume month and inflate the closing stock estimate.
            const actualSales = actuals[ym] ?? null;
            const fcstAvg     = (Number(monthlyAvg[mo]) || 0) * (isStkMonth ? proration : 1);
            const fcstGood    = fcstAvg * 1.1;
            const fcstGreat   = fcstAvg * 1.2;
            const avgSales   = actualSales !== null ? Math.max(actualSales, fcstAvg)   : fcstAvg;
            const goodSales  = actualSales !== null ? Math.max(actualSales, fcstGood)  : fcstGood;
            const greatSales = actualSales !== null ? Math.max(actualSales, fcstGreat) : fcstGreat;

            const openAvg = runAvg, openGood = runGood, openGreat = runGreat;
            runAvg   = openAvg   - avgSales   + incoming;
            runGood  = openGood  - goodSales  + incoming;
            runGreat = openGreat - greatSales + incoming;

            rows.push({
                ym, yr, mo,
                label: `${MONTH_NAMES[mo]} '${String(yr).slice(-2)}` + (isStkMonth && stkDay > 1 ? ` (from ${stkDay})` : ''),
                incoming, incomingShips, actualSales, avgSales, goodSales, greatSales,
                openAvg, openGood, openGreat,
                closeAvg: runAvg, closeGood: runGood, closeGreat: runGreat,
                isStkMonth, proration: isStkMonth ? proration : 1,
            });

            mo++;
            if (mo === 12) { mo = 0; yr++; }
        }
        return rows;
    }

    function buildForecastChart(rows, scenario, shipments) {
        const id = 'forecast-chart';
        const SERIES = [
            { key: 'closeAvg',   color: '#3b82f6', dash: [],     label: 'Average', s: 'avg',   negFill: true  },
            { key: 'closeGood',  color: '#10b981', dash: [],     label: 'Good',    s: 'good',  negFill: false },
            { key: 'closeGreat', color: '#8b5cf6', dash: [],     label: 'Great',   s: 'great', negFill: false },
        ];

        const allValues = rows.flatMap(r => [r.closeAvg, r.closeGood, r.closeGreat]);
        const minV = Math.min(...allValues, 0);

        const annotations = {};
        if (minV < 0) {
            annotations.zeroLine = {
                type: 'line', yMin: 0, yMax: 0,
                borderColor: 'rgba(239,68,68,0.8)', borderWidth: 2,
            };
        }

        // Shipment windows: a translucent band from start month → arrival
        // month, with markers at each end. Start label sits at the top of
        // the chart, arrival label (with kg) at the bottom. Overlapping
        // windows are darkened so concurrent shipments are visible at a
        // glance. Falls back to arrival-only when the start date is
        // unknown (legacy shipments without s.startDate).
        const ymToIndex = {};
        rows.forEach((r, i) => { ymToIndex[r.ym] = i; });

        const shipSpans = []; // for overlap calc
        (shipments || []).forEach((s, idx) => {
            const arriveCol = ymToIndex[shipArrivalYm(s)];
            if (arriveCol == null) return;
            const startYm = s.startDate ? s.startDate.slice(0, 7) : null;
            const startCol = startYm != null ? ymToIndex[startYm] : null;
            const kg = shipIncomingKg(s);
            const tag = s.seq ? `#${s.seq}` : '';

            if (startCol != null && startCol !== arriveCol) {
                shipSpans.push({ startCol, arriveCol });
                annotations['shipBox' + idx] = {
                    type: 'box',
                    xMin: startCol - 0.5,
                    xMax: arriveCol + 0.5,
                    backgroundColor: 'rgba(59,130,246,0.06)',
                    borderWidth: 0,
                    drawTime: 'beforeDatasetsDraw',
                };
                annotations['shipStart' + idx] = {
                    type: 'line',
                    xMin: startCol, xMax: startCol,
                    borderColor: 'rgba(59,130,246,0.55)',
                    borderWidth: 1.25,
                    label: {
                        display: true,
                        content: tag ? `${tag} start` : 'start',
                        position: 'start',
                        font: { size: 8.5, weight: '600' },
                        color: '#1d4ed8',
                        backgroundColor: 'transparent',
                        padding: { x: 2, y: 1 },
                    },
                };
            }

            annotations['shipEnd' + idx] = {
                type: 'line',
                xMin: arriveCol, xMax: arriveCol,
                borderColor: 'rgba(59,130,246,0.85)',
                borderWidth: 2,
                label: {
                    display: true,
                    content: `${tag ? tag + ' · ' : ''}+${fmtFull(kg)}`,
                    position: 'end',
                    font: { size: 8.5, weight: '600' },
                    color: '#1d4ed8',
                    backgroundColor: 'transparent',
                    padding: { x: 2, y: 1 },
                },
            };
        });

        // Overlap pass: for any contiguous run of months covered by ≥2
        // shipments, paint an additional translucent box on top so the
        // overlap reads visually deeper than a single in-transit window.
        if (shipSpans.length > 1) {
            const depth = new Array(rows.length).fill(0);
            shipSpans.forEach(({ startCol, arriveCol }) => {
                for (let i = startCol; i <= arriveCol; i++) depth[i] += 1;
            });
            let runStart = null;
            for (let i = 0; i <= depth.length; i++) {
                const isOverlap = i < depth.length && depth[i] >= 2;
                if (isOverlap && runStart == null) runStart = i;
                if (!isOverlap && runStart != null) {
                    annotations['shipOverlap' + runStart] = {
                        type: 'box',
                        xMin: runStart - 0.5,
                        xMax: (i - 1) + 0.5,
                        backgroundColor: 'rgba(59,130,246,0.10)',
                        borderWidth: 0,
                        drawTime: 'beforeDatasetsDraw',
                    };
                    runStart = null;
                }
            }
        }

        // Year-boundary reference lines: faint vertical guides at January
        // (calendar year) and April (NZ financial year). Drawn behind data
        // so they don't compete with shipment markers.
        rows.forEach((r, i) => {
            if (r.mo === 0) {
                annotations['yrCal' + i] = {
                    type: 'line',
                    xMin: i - 0.5, xMax: i - 0.5,
                    borderColor: 'rgba(148,163,184,0.45)',
                    borderWidth: 1,
                    borderDash: [3, 3],
                    drawTime: 'beforeDatasetsDraw',
                };
            } else if (r.mo === 3) {
                annotations['yrFin' + i] = {
                    type: 'line',
                    xMin: i - 0.5, xMax: i - 0.5,
                    borderColor: 'rgba(148,163,184,0.3)',
                    borderWidth: 1,
                    borderDash: [2, 4],
                    drawTime: 'beforeDatasetsDraw',
                };
            }
        });

        // Emphasise the active scenario — the other two render as thin,
        // faded reference lines so the toggle has a visible effect on the
        // chart, not just the table below.
        const datasets = SERIES.map(({ key, color, dash, label, s, negFill }) => {
            const isActive = s === scenario;
            return {
                label,
                data: rows.map(r => r[key]),
                borderColor: isActive ? color : color + '4D', // 30% alpha for muted lines
                backgroundColor: 'transparent',
                borderWidth: isActive ? 3 : 1.25,
                borderDash: isActive ? dash : [4, 4],
                pointRadius: isActive ? 3.5 : 1.5,
                pointHoverRadius: 6,
                pointBackgroundColor: isActive ? color : color + '66',
                pointBorderColor: 'white',
                pointBorderWidth: 1.5,
                fill: isActive && negFill ? { target: { value: 0 }, above: 'transparent', below: 'rgba(239,68,68,0.15)' } : false,
                tension: 0.2,
                order: isActive ? 0 : 2,
            };
        });

        window._chartQ[id] = {
            type: 'line',
            data: { labels: rows.map(r => r.label), datasets },
            options: {
                animation: false,
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { font: { size: 10 }, boxWidth: 16, padding: 10 } },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${fmtFull(ctx.parsed.y)} kg` } },
                    annotation: { annotations },
                },
                scales: {
                    x: {
                        grid: { color: '#f1f5f9' },
                        ticks: {
                            font: { size: 8.5 }, color: '#64748b',
                            maxRotation: 0, autoSkip: false,
                            // show every other month label; intermediate ticks stay
                            // for the gridlines but render blank
                            callback: function(_v, i) {
                                const lbl = this.getLabelForValue(i);
                                return i % 2 === 0 ? lbl : '';
                            },
                        },
                    },
                    y: {
                        grid: { color: '#f1f5f9' },
                        ticks: {
                            font: { size: 8.5 }, color: '#94a3b8',
                            callback: v => Math.abs(v) >= 10000 ? (v / 1000).toFixed(0) + 'k'
                                : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : v,
                        },
                    },
                },
            },
        };
        return `<div style="position:relative;height:205px;width:100%"><canvas data-chart-id="${id}"></canvas></div>`;
    }


    // ── Imports prefetch cache — populated on dashboard load, consumed once on first render ──
    let _importsPrefetchP = null;

    function prefetchImports() {
        if (_importsPrefetchP) return;
        _importsPrefetchP = (async () => {
            let config = {}, actuals = {};
            try {
                const [configData, ordersData] = await Promise.all([
                    fetch('/api/import/forecast').then(r => r.ok ? r.json() : {}).catch(() => ({})),
                    fetch('/api/orders').then(r => r.ok ? r.json() : []).catch(() => []),
                ]);
                config = configData || {};
                for (const o of (ordersData || [])) {
                    const ym = (o.createdAt || '').slice(0, 7);
                    if (!ym) continue;
                    // Pre-Hub-live months are sourced from the sales sheet
                    // (Sales History view); imported HST-* orders for those
                    // months would just duplicate the sheet's authoritative
                    // figure here. The forecast starts from "now" anyway, so
                    // dropping pre-cutoff actuals doesn't change projections.
                    if (ym < HUB_LIVE_YM) continue;
                    const kg = (o.lines || []).reduce((s, l) => s + lineKg(l), 0);
                    if (kg > 0) actuals[ym] = (actuals[ym] || 0) + kg;
                }
            } catch (e) { /* prefetch optional */ }
            return { config, actuals };
        })();
    }

    // ── Render the Imports view ──
    let importsAC = null; // AbortController for cost-line event delegation

    async function renderImports() {
        if (importsAC) importsAC.abort();
        importsAC = new AbortController();
        const acSignal = importsAC.signal;

        const body = document.getElementById('wh-body');
        body.innerHTML = '<div class="orders-loading">Loading…</div>';

        let config = {}, actuals = {};
        if (_importsPrefetchP) {
            try { ({ config, actuals } = await _importsPrefetchP); } catch (e) {}
            _importsPrefetchP = null; // consume once — next visit fetches fresh
        } else {
            try { config = (await api('/api/import/forecast')) || {}; } catch (e) { /* ok */ }
            try {
                const orders = await api('/api/orders');
                for (const o of (orders || [])) {
                    const ym = (o.createdAt || '').slice(0, 7);
                    if (!ym) continue;
                    const kg = (o.lines || []).reduce((s, l) => s + lineKg(l), 0);
                    if (kg > 0) actuals[ym] = (actuals[ym] || 0) + kg;
                }
            } catch (e) { /* orders unavailable */ }
        }

        let forex = {};
        const fxToday = new Date().toISOString().slice(0, 10);
        try {
            const cached = localStorage.getItem('imp-fx-' + fxToday);
            if (cached) {
                forex = JSON.parse(cached);
            } else {
                const res = await fetch('https://open.er-api.com/v6/latest/NZD');
                if (res.ok) {
                    const data = await res.json();
                    forex = data.rates || {};
                    localStorage.setItem('imp-fx-' + fxToday, JSON.stringify(forex));
                }
            }
        } catch (e) { /* forex optional */ }

        let fxHistory = {};
        try {
            const histMonthKey = 'imp-fx-hist-' + new Date().toISOString().slice(0, 7);
            const cachedHist = localStorage.getItem(histMonthKey);
            if (cachedHist) {
                fxHistory = JSON.parse(cachedHist);
            } else {
                const now2 = new Date();
                const start2 = new Date(now2);
                start2.setMonth(start2.getMonth() - 13);
                const histRes = await fetch(
                    'https://api.frankfurter.dev/v1/' +
                    start2.toISOString().slice(0, 10) + '..' + now2.toISOString().slice(0, 10) +
                    '?base=NZD&symbols=USD,EUR,CNY,AUD'
                );
                if (histRes.ok) {
                    fxHistory = await histRes.json();
                    localStorage.setItem(histMonthKey, JSON.stringify(fxHistory));
                }
            }
        } catch (e) { /* sparklines optional */ }

        // BDT historical data from jsDelivr currency API (monthly, ~13 points)
        let bdtHistory = {};
        try {
            const bdtMonthKey = 'imp-fx-bdt-' + new Date().toISOString().slice(0, 7);
            const cachedBdt = localStorage.getItem(bdtMonthKey);
            if (cachedBdt) {
                bdtHistory = JSON.parse(cachedBdt);
            } else {
                const dates = [];
                for (let i = 12; i >= 0; i--) {
                    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
                    dates.push(d.toISOString().slice(0, 10));
                }
                const results = await Promise.all(dates.map(d =>
                    fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@' + d + '/v1/currencies/nzd.json')
                        .then(r => r.ok ? r.json() : null)
                        .then(j => j?.nzd?.bdt ? { month: d.slice(0, 7), rate: j.nzd.bdt } : null)
                        .catch(() => null)
                ));
                results.forEach(r => { if (r) bdtHistory[r.month] = r.rate; });
                if (Object.keys(bdtHistory).length > 0)
                    localStorage.setItem(bdtMonthKey, JSON.stringify(bdtHistory));
            }
        } catch (e) { /* BDT sparkline optional */ }

        let scenario  = 'great';
        let activeTab = 'forecast';
        let showAllShips = false;
        let currentDetailShipId = null;

        // Build line-item cost breakdown HTML for a shipment card
        function buildCostHtml(s) {
            const lines = s.costLines || [];
            const CCYS = ['NZD', 'USD', 'EUR', 'AUD', 'CNY', 'BDT'];
            const DEFAULT_CATS = ['Raw Product', 'Bangladesh Costs', 'Freight', 'Miscellaneous'];

            function lineNzd(l) {
                const amt = Number(l.amount) || 0;
                if (!amt) return 0;
                if (!l.ccy || l.ccy === 'NZD') return amt;
                const rate = forex[l.ccy];
                return rate ? amt / rate : amt;
            }

            const presentCats = [...new Set(lines.map(l => l.cat || 'Miscellaneous'))];
            const cats = presentCats.length ? presentCats : DEFAULT_CATS;

            const totalNzd      = lines.reduce((t, l) => t + lineNzd(l), 0);
            const paidNzd       = lines.filter(l => l.paid).reduce((t, l) => t + lineNzd(l), 0);
            const outstandingNzd = totalNzd - paidNzd;
            const ppkg = totalNzd > 0 && s.kg > 0 ? (totalNzd / s.kg).toFixed(2) : null;

            const fxBar = ['USD','EUR','CNY','AUD','BDT'].filter(c => forex[c])
                .map(c => `<span>${c}&nbsp;<strong>${forex[c].toFixed(4)}</strong></span>`).join('');

            const catsHtml = cats.map(cat => {
                const catLines = lines.filter(l => (l.cat || 'Miscellaneous') === cat);
                const catNzd   = catLines.reduce((t, l) => t + lineNzd(l), 0);
                const catPaid  = catLines.filter(l => l.paid).reduce((t, l) => t + lineNzd(l), 0);

                const rowsHtml = catLines.map(l => {
                    const nzd = lineNzd(l);
                    const liveFx = l.ccy && l.ccy !== 'NZD' && forex[l.ccy];
                    return `<tr class="imp-cl-row${l.paid ? ' imp-cl-paid-row' : ''}" data-ship-id="${escHtml(s.id)}" data-line-id="${escHtml(l.id)}">
                        <td><input class="imp-cl-field imp-cl-inp" data-f="desc" value="${escHtml(l.desc || '')}" placeholder="Description…"></td>
                        <td class="imp-cl-td-amt">
                            <input class="imp-cl-field imp-cl-num" data-f="amount" type="number" value="${l.amount != null ? l.amount : ''}" placeholder="0" step="0.01" min="0">
                            <select class="imp-cl-field imp-cl-ccy" data-f="ccy">
                                ${CCYS.map(c => `<option${c === (l.ccy || 'NZD') ? ' selected' : ''}>${c}</option>`).join('')}
                            </select>
                        </td>
                        <td class="imp-cl-td-nzd">
                            ${nzd > 0 ? `<span>$${Math.round(nzd).toLocaleString('en-NZ')}</span>` : '<span class="imp-cl-nil">—</span>'}
                            ${liveFx ? `<span class="imp-cl-fxtag">${forex[l.ccy].toFixed(4)}</span>` : ''}
                        </td>
                        <td><input class="imp-cl-field imp-cl-inp imp-cl-paidvia" data-f="paidVia" value="${escHtml(l.paidVia || '')}" placeholder="Paid via…"></td>
                        <td class="imp-cl-td-chk">
                            <input type="checkbox" class="imp-cl-paid" data-ship-id="${escHtml(s.id)}" data-line-id="${escHtml(l.id)}" ${l.paid ? 'checked' : ''} title="Paid">
                        </td>
                        <td><button class="imp-cl-del" data-ship-id="${escHtml(s.id)}" data-line-id="${escHtml(l.id)}" title="Remove">×</button></td>
                    </tr>`;
                }).join('');

                return `<div class="imp-cl-cat">
                    <div class="imp-cl-cat-hd">
                        <span class="imp-cl-cat-name">${escHtml(cat)}</span>
                        ${catNzd > 0 ? `<span class="imp-cl-cat-sum${catNzd > catPaid + 0.5 ? ' imp-cl-cat-os' : ''}">$${Math.round(catNzd).toLocaleString('en-NZ')}</span>` : ''}
                        <button class="imp-cl-add-line btn-link" data-ship-id="${escHtml(s.id)}" data-cat="${escHtml(cat)}">+ line</button>
                    </div>
                    ${catLines.length ? `<table class="imp-cl-table">
                        <thead><tr>
                            <th>Description</th>
                            <th class="imp-cl-th-amt">Amount</th>
                            <th class="imp-cl-th-nzd">≈&thinsp;NZD</th>
                            <th class="imp-cl-th-paidvia">Paid Via</th>
                            <th class="imp-cl-th-chk" title="Paid">✓</th>
                            <th style="width:18px"></th>
                        </tr></thead>
                        <tbody>${rowsHtml}</tbody>
                    </table>` : ''}
                </div>`;
            }).join('');

            const totalsHtml = totalNzd > 0 ? `
            <div class="imp-cost-v2-totals">
                <div class="imp-cv2-row imp-cv2-total">
                    <span>Total</span>
                    <strong>$${Math.round(totalNzd).toLocaleString('en-NZ')}</strong>
                    ${ppkg ? `<span class="imp-cost-ppkg">→&thinsp;$${ppkg}/kg</span>` : ''}
                </div>
                <div class="imp-cv2-row imp-cv2-paid-row">
                    <span>Paid</span>
                    <span>$${Math.round(paidNzd).toLocaleString('en-NZ')}</span>
                </div>
                ${outstandingNzd > 0.5
                    ? `<div class="imp-cv2-row imp-cv2-os-row"><span>Outstanding</span><strong>$${Math.round(outstandingNzd).toLocaleString('en-NZ')}</strong></div>`
                    : `<div class="imp-cv2-row imp-cv2-done-row"><span>Fully paid ✓</span></div>`}
            </div>` : '';

            const emptyHtml = !lines.length ? `
            <div class="imp-cost-v2-empty">
                <span>No cost lines yet</span>
                <div class="imp-cost-v2-defaults">
                    ${DEFAULT_CATS.map(c => `<button class="imp-cl-add-line btn-secondary btn-sm" data-ship-id="${escHtml(s.id)}" data-cat="${escHtml(c)}">+ ${escHtml(c)}</button>`).join('')}
                </div>
            </div>` : '';

            return `<div class="imp-cost-v2">
                <div class="imp-cost-v2-hdr">
                    <span class="imp-cost-v2-title">Cost Breakdown</span>
                    ${fxBar ? `<span class="imp-cost-v2-fxbar">${fxBar}</span>` : ''}
                    <button class="imp-cl-add-cat btn-link" data-ship-id="${escHtml(s.id)}">+ category</button>
                </div>
                ${catsHtml}
                ${totalsHtml}
                ${emptyHtml}
            </div>`;
        }

        // ────────────────────────────────────────────────────────────────
        // RIGID SCHEMA (Shipment #42 onwards)
        //
        // Every new shipment carries a fixed set of cost lines under three
        // sections (Raw Product / Processing / Freight). A fourth section,
        // "Other Costs", takes free-form lines via the existing costLines
        // array. The right-hand "% of Total" chart is driven off the four
        // section totals.
        //
        // Detection: shipments with s.seq are rendered by renderShipDetailNew.
        // Legacy shipments (no seq) keep falling through to the original
        // free-form renderer below.
        // ────────────────────────────────────────────────────────────────

        const SHIP_SECTIONS = [
            { key: 'raw',        label: 'Raw',        colour: '#16a34a' },
            { key: 'processing', label: 'Processing', colour: '#7c3aed' },
            { key: 'freight',    label: 'Freight',    colour: '#2563eb' },
            { key: 'other',      label: 'Other',      colour: '#64748b' },
        ];

        // Rigid 7-line schema. Sections + labels match the operator's mental
        // model — see Business-Hub.md. `kind` controls how the line is
        // computed: 'rawProduct' = rate × own kg field; 'perKg' = rate × ship kg;
        // 'flat' = amount. Raw lines have editable per-line labels (line.labelOverride).
        const FIXED_LINE_SCHEMA = [
            { key: 'rawA',           section: 'raw',        label: 'Raw Product Costs (1)', kind: 'rawProduct', kgField: 'rawWhiteKg',  defaultRate: 0,    defaultCcy: 'EUR', editableLabel: true },
            { key: 'rawB',           section: 'raw',        label: 'Raw Product Costs (2)', kind: 'rawProduct', kgField: 'rawColourKg', defaultRate: 0,    defaultCcy: 'EUR', editableLabel: true },
            { key: 'processing',     section: 'processing', label: 'Processing Costs',      kind: 'flat',       defaultAmount: 0,     defaultCcy: 'USD' },
            { key: 'management',     section: 'processing', label: 'Management Costs',      kind: 'flat',       defaultAmount: 0,     defaultCcy: 'USD' },
            { key: 'freightItalyBd', section: 'freight',    label: 'Italy → Bangladesh',    kind: 'flat',       defaultAmount: 9000,  defaultCcy: 'USD' },
            { key: 'freightBdTga',   section: 'freight',    label: 'Bangladesh → Tauranga', kind: 'flat',       defaultAmount: 8000,  defaultCcy: 'USD' },
            { key: 'freightTgaKati', section: 'freight',    label: 'Tauranga → Katikati',   kind: 'flat',       defaultAmount: 5000,  defaultCcy: 'NZD' },
        ];

        // Aliases for shipments created against the previous schema. Read-only:
        // we never write to old keys, but we read from them so any test data
        // entered under #42's first iteration doesn't disappear.
        const FIXED_LINE_ALIASES = {
            rawA: 'rawWhite',
            rawB: 'rawColour',
        };
        function fixedLineFor(s, key) {
            const fl = s.fixedLines || {};
            if (fl[key]) return fl[key];
            const alias = FIXED_LINE_ALIASES[key];
            return alias ? fl[alias] : undefined;
        }

        // Build the default fixedLines map for a fresh shipment.
        function defaultFixedLines() {
            const out = {};
            for (const def of FIXED_LINE_SCHEMA) {
                const line = { ccy: def.defaultCcy, paid: false, paidVia: '' };
                if (def.kind === 'flat') line.amount = def.defaultAmount;
                else                     line.rate   = def.defaultRate;
                out[def.key] = line;
            }
            return out;
        }

        // Default kg split: 60% white / 40% colour (rounded to whole kg).
        function defaultRawSplit(kg) {
            const w = Math.round((kg || 0) * 0.6);
            return { rawWhiteKg: w, rawColourKg: Math.max(0, (kg || 0) - w) };
        }

        // Convert a single fixed line into NZD using current forex rates.
        // kind dictates which factor to multiply the value by.
        function fixedLineNzd(def, line, s, forex) {
            if (!line) return 0;
            let amount = 0;
            if (def.kind === 'flat')          amount = Number(line.amount) || 0;
            else if (def.kind === 'perKg')    amount = (Number(line.rate) || 0) * (Number(s.kg) || 0);
            else if (def.kind === 'rawProduct') amount = (Number(line.rate) || 0) * (Number(s[def.kgField]) || 0);
            if (!amount) return 0;
            const ccy = line.ccy || def.defaultCcy;
            if (ccy === 'NZD') return amount;
            const rate = forex[ccy];
            return rate ? amount / rate : amount;
        }

        // Convert a freeform Other-Costs line to NZD.
        function otherLineNzd(l, forex) {
            const amt = Number(l.amount) || 0;
            if (!amt) return 0;
            if (!l.ccy || l.ccy === 'NZD') return amt;
            const rate = forex[l.ccy];
            return rate ? amt / rate : amt;
        }

        // Compute per-section NZD totals and the global total/paid figures.
        function computeShipTotalsNew(s, forex) {
            const sectionTotals = { raw: 0, processing: 0, freight: 0, other: 0 };
            const sectionPaid   = { raw: 0, processing: 0, freight: 0, other: 0 };
            for (const def of FIXED_LINE_SCHEMA) {
                const line = fixedLineFor(s, def.key);
                const nzd  = fixedLineNzd(def, line, s, forex);
                sectionTotals[def.section] += nzd;
                if (line?.paid) sectionPaid[def.section] += nzd;
            }
            for (const l of (s.costLines || [])) {
                const nzd = otherLineNzd(l, forex);
                sectionTotals.other += nzd;
                if (l.paid) sectionPaid.other += nzd;
            }
            const total = sectionTotals.raw + sectionTotals.processing + sectionTotals.freight + sectionTotals.other;
            const paid  = sectionPaid.raw  + sectionPaid.processing  + sectionPaid.freight  + sectionPaid.other;
            return { sectionTotals, sectionPaid, total, paid };
        }

        // Right-side sticky chart: four horizontal bars showing each section's
        // share of the total. Bars use the section colours from SHIP_SECTIONS.
        function buildPctChartHtml(sectionTotals, total) {
            const bars = SHIP_SECTIONS.map(sec => {
                const v = sectionTotals[sec.key] || 0;
                const pct = total > 0 ? (v / total) * 100 : 0;
                const pctTxt = total > 0 ? pct.toFixed(1) + '%' : '—';
                const valTxt = v > 0 ? '$' + Math.round(v).toLocaleString('en-NZ') : '$0';
                return `<div class="ship-pct-row">
                    <div class="ship-pct-row-hd">
                        <span class="ship-pct-row-name" style="color:${sec.colour}">${sec.label}</span>
                        <span class="ship-pct-row-pct">${pctTxt}</span>
                    </div>
                    <div class="ship-pct-bar"><div class="ship-pct-bar-fill" style="width:${Math.min(100,pct).toFixed(2)}%;background:${sec.colour}"></div></div>
                    <div class="ship-pct-row-val">${valTxt}</div>
                </div>`;
            }).join('');

            return `<aside class="ship-pct-chart">
                <h4 class="ship-pct-title">% of Total</h4>
                ${bars}
                <div class="ship-pct-total">
                    <span>Total</span>
                    <strong>${total > 0 ? '$' + Math.round(total).toLocaleString('en-NZ') : '$0'}</strong>
                </div>
            </aside>`;
        }

        const CCYS_FIXED = ['NZD', 'USD', 'EUR', 'AUD', 'CNY', 'BDT'];

        // ────────────────────────────────────────────────────────────────
        // RIGID SCHEMA V3 (Shipment framework, 2026-05 onward)
        //
        // 16 templated lines across 4 sections, mirroring the operator's
        // landed-cost spreadsheet. New shipments are tagged `schema: 3`.
        // Three input fields drive everything else:
        //   netKg     — total raw weight imported
        //   whitePct  — white share of yield (colour = 100 - white)
        //   wastePct  — expected loss; yield = 100 - waste
        // Derived: yieldKg = netKg × yield%, whiteKg = yieldKg × white%, …
        //
        // Per-kg lines multiply against yield kg (not raw kg) — the operator's
        // costing convention. Allocation lines (rent/salaries) carry their
        // own `allocFactor` and `annualAmount` fields. LC Refund allows
        // negative amounts to offset the matching handling charge.
        // ────────────────────────────────────────────────────────────────

        const SHIP_SECTIONS_V3 = [
            { key: 'raw',        label: 'Raw Product',     colour: '#16a34a' },
            { key: 'bangladesh', label: 'Bangladesh',      colour: '#7c3aed' },
            { key: 'freight',    label: 'Freight',         colour: '#2563eb' },
            { key: 'misc',       label: 'Miscellaneous',   colour: '#64748b' },
        ];

        // kgField on perKg lines selects which derived weight to multiply by.
        const FIXED_LINE_SCHEMA_V3 = [
            // Raw Product
            { key: 'rawWhite',       section: 'raw',        label: 'White Toeclips',           kind: 'perKg', kgField: 'whiteRawKg',  defaultRate: 1.50,    defaultCcy: 'EUR' },
            { key: 'rawColour',      section: 'raw',        label: 'Coloured Toeclips',        kind: 'perKg', kgField: 'colourRawKg', defaultRate: 0.75,    defaultCcy: 'EUR' },
            { key: 'inspection',     section: 'raw',        label: 'Preshipment Inspection',   kind: 'flat',  defaultAmount: 0,    defaultCcy: 'EUR' },
            // Bangladesh
            { key: 'handlingA',      section: 'bangladesh', label: 'Handling & Sorting (1)',   kind: 'perKg', kgField: 'netKg',    defaultRate: 1.18,    defaultCcy: 'USD' },
            { key: 'handlingB',      section: 'bangladesh', label: 'LC Deposit',               kind: 'perKg', kgField: 'netKg',    defaultRate: 0,       defaultCcy: 'USD' },
            { key: 'lcRefund',       section: 'bangladesh', label: 'LC Refund',                kind: 'perKg', kgField: 'netKg',    defaultRate: 0,       defaultCcy: 'NZD', allowNegative: true },
            { key: 'bundling',       section: 'bangladesh', label: 'Bundling',                 kind: 'perKg', kgField: 'yieldKg',  defaultRate: 79,      defaultCcy: 'BDT' },
            { key: 'rent',           section: 'bangladesh', label: 'Rent (Annual)',            kind: 'allocation', defaultAlloc: 0.67, defaultAnnual: 243075,  defaultCcy: 'BDT' },
            { key: 'salaries',       section: 'bangladesh', label: 'Salaries (Annual)',        kind: 'allocation', defaultAlloc: 0.67, defaultAnnual: 1060430, defaultCcy: 'BDT' },
            { key: 'bankFees',       section: 'bangladesh', label: 'Bank Fees',                kind: 'flat',  defaultAmount: 557,  defaultCcy: 'NZD' },
            // Freight
            { key: 'freightItalyBd', section: 'freight',    label: 'Italy → Bangladesh',       kind: 'flat',  defaultAmount: 15000, defaultCcy: 'NZD' },
            { key: 'freightBdNz',    section: 'freight',    label: 'Bangladesh → New Zealand', kind: 'flat',  defaultAmount: 34000, defaultCcy: 'NZD' },
            { key: 'freightTgaKati', section: 'freight',    label: 'Tauranga → Katikati',      kind: 'flat',  defaultAmount: 2556,  defaultCcy: 'NZD' },
            // Miscellaneous
            { key: 'rubbish',        section: 'misc',       label: 'Rubbish Collection',       kind: 'flat',  defaultAmount: 600,  defaultCcy: 'NZD' },
            { key: 'otherExpenses',  section: 'misc',       label: 'Other Expenses',           kind: 'flat',  defaultAmount: 400,  defaultCcy: 'NZD' },
            { key: 'interest',       section: 'misc',       label: 'Interest Cost',            kind: 'flat',  defaultAmount: 0,    defaultCcy: 'NZD' },
        ];

        function defaultFixedLinesV3() {
            const out = {};
            for (const def of FIXED_LINE_SCHEMA_V3) {
                const line = { ccy: def.defaultCcy, paid: false, paidVia: '' };
                if (def.kind === 'flat')            line.amount = def.defaultAmount;
                else if (def.kind === 'perKg')      line.rate   = def.defaultRate;
                else if (def.kind === 'allocation') { line.allocFactor = def.defaultAlloc; line.annualAmount = def.defaultAnnual; }
                out[def.key] = line;
            }
            return out;
        }

        // ── V3 timeline ─────────────────────────────────────────────────
        // Standard stage gaps (days from the previous step). Stored as
        // relative deltas so editing one date can cascade forward by the
        // same gap. Operator can still adjust dates per-shipment as
        // actuals come in. These act as fallbacks; user-saved overrides
        // live on config.stageDefaults.
        const SHIP_STAGE_DEFAULTS_V3 = [
            { label: 'Start LC',              gap: 0  },  // anchor
            { label: 'LC ready',              gap: 14 },
            { label: 'Shipped (Left Italy)',  gap: 14 },
            { label: 'LC presented',          gap: 21 },
            { label: 'Landed in Bangladesh',  gap: 70 },
            { label: 'Left Bangladesh',       gap: 42 },
            { label: 'Arrived in Tauranga',   gap: 50 },
        ];

        function getStageDefaults(config) {
            const saved = config && Array.isArray(config.stageDefaults) ? config.stageDefaults : null;
            if (!saved || saved.length !== SHIP_STAGE_DEFAULTS_V3.length) return SHIP_STAGE_DEFAULTS_V3;
            return SHIP_STAGE_DEFAULTS_V3.map((d, i) => ({
                label: d.label,
                gap: Number(saved[i]?.gap) >= 0 ? Number(saved[i].gap) : d.gap,
            }));
        }

        function addDaysIso(iso, days) {
            if (!iso) return '';
            const d = new Date(iso + 'T00:00:00');
            if (isNaN(d)) return '';
            d.setDate(d.getDate() + days);
            return d.toISOString().slice(0, 10);
        }

        function defaultMilestonesV3(startDate, defaults = SHIP_STAGE_DEFAULTS_V3) {
            let cum = 0;
            return defaults.map((m, i) => {
                cum += i === 0 ? 0 : (Number(m.gap) || 0);
                return {
                    label: m.label,
                    date:  startDate ? addDaysIso(startDate, cum) : '',
                    done:  i === 0 ? !!startDate : false,
                };
            });
        }

        // Arrival month is the YYYY-MM of the final milestone (Arrived
        // in Tauranga) so the forecast can still group shipments by ETA.
        function ymFromStartDate(startDate, defaults = SHIP_STAGE_DEFAULTS_V3) {
            const totalDays = defaults.slice(1).reduce((s, m) => s + (Number(m.gap) || 0), 0);
            const arrival = addDaysIso(startDate, totalDays);
            return arrival ? arrival.slice(0, 7) : '';
        }

        // Derived weights from the three primary inputs (whiteRawKg,
        // colourRawKg, wastePct — the values that appear on the supplier's
        // bill of lading). netKg / whitePct are computed from these so the
        // existing per-kg cost lines (which multiply against derived.whiteKg
        // / colourKg / yieldKg) keep working without schema churn.
        function computeShipDerivedV3(s) {
            const whiteRawKg  = Number(s.whiteRawKg) || 0;
            const colourRawKg = Number(s.colourRawKg) || 0;
            const wastePct    = clampPct(s.wastePct, 10);
            const netKg       = whiteRawKg + colourRawKg;
            const whitePct    = netKg > 0 ? (whiteRawKg / netKg) * 100 : 0;
            const colourPct   = netKg > 0 ? (colourRawKg / netKg) * 100 : 0;
            const yieldPct    = 100 - wastePct;
            const yieldKg     = netKg * yieldPct / 100;
            const whiteKg     = whiteRawKg * yieldPct / 100;
            const colourKg    = colourRawKg * yieldPct / 100;
            return { whiteRawKg, colourRawKg, netKg, whitePct, colourPct, wastePct, yieldPct, yieldKg, whiteKg, colourKg };
        }
        function clampPct(v, fallback) {
            if (v === undefined || v === null || v === '') return fallback;
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(0, Math.min(100, n));
        }

        function fixedLineNzdV3(def, line, derived, forex) {
            if (!line) return 0;
            let amount = 0;
            if (def.kind === 'flat')            amount = Number(line.amount) || 0;
            else if (def.kind === 'perKg') {
                // Fallback: entries saved before flat→perKg migration stored `amount`;
                // treat it as the per-kg rate so old records aren't silently zeroed.
                const rate = line.rate != null ? Number(line.rate) : Number(line.amount) || 0;
                amount = rate * (Number(derived[def.kgField]) || 0);
            }
            else if (def.kind === 'allocation') amount = (Number(line.allocFactor) || 0) * (Number(line.annualAmount) || 0);
            if (!amount) return 0;
            const ccy = line.ccy || def.defaultCcy;
            if (ccy === 'NZD') return amount;
            const rate = forex[ccy];
            return rate ? amount / rate : amount;
        }

        function computeShipTotalsV3(s, forex) {
            const derived = computeShipDerivedV3(s);
            const sectionTotals = { raw: 0, bangladesh: 0, freight: 0, misc: 0 };
            const sectionPaid   = { raw: 0, bangladesh: 0, freight: 0, misc: 0 };
            for (const def of FIXED_LINE_SCHEMA_V3) {
                const line = (s.fixedLines || {})[def.key];
                const nzd  = fixedLineNzdV3(def, line, derived, forex);
                sectionTotals[def.section] += nzd;
                if (line?.paid) sectionPaid[def.section] += nzd;
            }
            for (const l of (s.extraLines || [])) {
                const sec = l.section;
                if (!(sec in sectionTotals)) continue;
                const kg  = l.kind === 'perKg' ? (Number(derived[l.kgField || 'netKg']) || 0) : 0;
                const raw = l.kind === 'flat' ? (Number(l.amount) || 0) : (Number(l.rate) || 0) * kg;
                if (!raw) continue;
                const ccy = l.ccy || 'NZD';
                const nzd = ccy === 'NZD' ? raw : (forex[ccy] ? raw / forex[ccy] : raw);
                sectionTotals[sec] += nzd;
                if (l.paid) sectionPaid[sec] += nzd;
            }
            const total = sectionTotals.raw + sectionTotals.bangladesh + sectionTotals.freight + sectionTotals.misc;
            const paid  = sectionPaid.raw  + sectionPaid.bangladesh  + sectionPaid.freight  + sectionPaid.misc;
            const ppkgYield = derived.yieldKg > 0 ? total / derived.yieldKg : 0;
            return { sectionTotals, sectionPaid, total, paid, derived, ppkgYield };
        }

        // Render one rigid line as a table row. Per-kg lines show their rate
        // and the auto-computed total (kg × rate); flat lines just show the
        // amount. Both still expose ccy + paid + paidVia.
        function buildFixedRowHtml(s, def, forex) {
            const line = fixedLineFor(s, def.key) || {};
            const nzd  = fixedLineNzd(def, line, s, forex);
            const ccy  = line.ccy || def.defaultCcy;
            const labelText = line.labelOverride || def.label;

            let amountCellInner = '';
            if (def.kind === 'flat') {
                const amt = line.amount != null ? line.amount : '';
                amountCellInner = `<input class="ship-fix-num" data-f="amount" type="number" value="${amt}" placeholder="0" step="0.01" min="0">`;
            } else {
                // perKg or rawProduct — show rate, with the multiplier in the kg cell
                const rate = line.rate != null ? line.rate : '';
                amountCellInner = `<input class="ship-fix-num" data-f="rate" type="number" value="${rate}" placeholder="0" step="0.01" min="0"><span class="ship-fix-unit">/kg</span>`;
            }

            const ccySelect = `<select class="ship-fix-ccy" data-f="ccy">
                ${CCYS_FIXED.map(c => `<option${c === ccy ? ' selected' : ''}>${c}</option>`).join('')}
            </select>`;

            // For per-kg lines, show the multiplier (own kg or shipment kg) and the local-ccy total;
            // for flat lines, this column is blank.
            let multCell = '';
            if (def.kind === 'rawProduct') {
                const ownKg = Number(s[def.kgField]) || 0;
                const localTotal = (Number(line.rate) || 0) * ownKg;
                multCell = `<span class="ship-fix-mult">× ${ownKg.toLocaleString('en-NZ')} kg</span>` +
                           (localTotal > 0 ? `<span class="ship-fix-localtotal">= ${localTotal.toLocaleString('en-NZ',{maximumFractionDigits:2})} ${ccy}</span>` : '');
            } else if (def.kind === 'perKg') {
                const shipKg = Number(s.kg) || 0;
                const localTotal = (Number(line.rate) || 0) * shipKg;
                multCell = `<span class="ship-fix-mult">× ${shipKg.toLocaleString('en-NZ')} kg</span>` +
                           (localTotal > 0 ? `<span class="ship-fix-localtotal">= ${localTotal.toLocaleString('en-NZ',{maximumFractionDigits:2})} ${ccy}</span>` : '');
            }

            const liveFx = ccy && ccy !== 'NZD' && forex[ccy];

            const labelCell = def.editableLabel
                ? `<input class="ship-fix-label-inp" data-f="labelOverride" value="${escHtml(labelText)}" placeholder="${escHtml(def.label)}">`
                : escHtml(labelText);

            return `<tr class="ship-fix-row${line.paid ? ' ship-fix-row--paid' : ''}" data-ship-id="${escHtml(s.id)}" data-line-key="${escHtml(def.key)}">
                <td class="ship-fix-td-label">${labelCell}</td>
                <td class="ship-fix-td-amt">${amountCellInner}${ccySelect}</td>
                <td class="ship-fix-td-mult">${multCell}</td>
                <td class="ship-fix-td-nzd">
                    ${nzd > 0 ? `<span>$${Math.round(nzd).toLocaleString('en-NZ')}</span>` : '<span class="ship-fix-nil">—</span>'}
                    ${liveFx ? `<span class="ship-fix-fxtag">${forex[ccy].toFixed(4)}</span>` : ''}
                </td>
                <td class="ship-fix-td-paidvia"><input class="ship-fix-paidvia" data-f="paidVia" value="${escHtml(line.paidVia || '')}" placeholder="Paid via…"></td>
                <td class="ship-fix-td-chk"><input type="checkbox" class="ship-fix-paid" ${line.paid ? 'checked' : ''} title="Paid"></td>
            </tr>`;
        }

        function buildFixedSectionHtml(s, sectionKey, forex) {
            const sec   = SHIP_SECTIONS.find(x => x.key === sectionKey);
            const defs  = FIXED_LINE_SCHEMA.filter(d => d.section === sectionKey);
            const totals = computeShipTotalsNew(s, forex);
            const subtotal = totals.sectionTotals[sectionKey] || 0;

            return `<div class="ship-fix-section" data-section="${escHtml(sectionKey)}">
                <div class="ship-fix-section-hd">
                    <span class="ship-fix-section-dot" style="background:${sec.colour}"></span>
                    <span class="ship-fix-section-name">${sec.label}</span>
                    <span class="ship-fix-section-sum">${subtotal > 0 ? '$' + Math.round(subtotal).toLocaleString('en-NZ') : '—'}</span>
                </div>
                <table class="ship-fix-table">
                    <thead><tr>
                        <th>Line</th>
                        <th class="ship-fix-th-amt">Amount</th>
                        <th class="ship-fix-th-mult"></th>
                        <th class="ship-fix-th-nzd">≈&thinsp;NZD</th>
                        <th class="ship-fix-th-paidvia">Paid Via</th>
                        <th class="ship-fix-th-chk" title="Paid">✓</th>
                    </tr></thead>
                    <tbody>${defs.map(d => buildFixedRowHtml(s, d, forex)).join('')}</tbody>
                </table>
            </div>`;
        }

        // Other Costs — the only freeform section. Reuses costLines on the
        // shipment so the existing add/delete/save handlers Just Work.
        function buildOtherSectionHtml(s, forex) {
            const sec   = SHIP_SECTIONS.find(x => x.key === 'other');
            const lines = s.costLines || [];
            const subtotal = lines.reduce((t, l) => t + otherLineNzd(l, forex), 0);

            const rowsHtml = lines.map(l => {
                const nzd = otherLineNzd(l, forex);
                const liveFx = l.ccy && l.ccy !== 'NZD' && forex[l.ccy];
                return `<tr class="imp-cl-row${l.paid ? ' imp-cl-paid-row' : ''}" data-ship-id="${escHtml(s.id)}" data-line-id="${escHtml(l.id)}">
                    <td><input class="imp-cl-field imp-cl-inp" data-f="desc" value="${escHtml(l.desc || '')}" placeholder="Description…"></td>
                    <td class="imp-cl-td-amt">
                        <input class="imp-cl-field imp-cl-num" data-f="amount" type="number" value="${l.amount != null ? l.amount : ''}" placeholder="0" step="0.01" min="0">
                        <select class="imp-cl-field imp-cl-ccy" data-f="ccy">
                            ${CCYS_FIXED.map(c => `<option${c === (l.ccy || 'NZD') ? ' selected' : ''}>${c}</option>`).join('')}
                        </select>
                    </td>
                    <td class="imp-cl-td-nzd">
                        ${nzd > 0 ? `<span>$${Math.round(nzd).toLocaleString('en-NZ')}</span>` : '<span class="imp-cl-nil">—</span>'}
                        ${liveFx ? `<span class="imp-cl-fxtag">${forex[l.ccy].toFixed(4)}</span>` : ''}
                    </td>
                    <td><input class="imp-cl-field imp-cl-inp imp-cl-paidvia" data-f="paidVia" value="${escHtml(l.paidVia || '')}" placeholder="Paid via…"></td>
                    <td class="imp-cl-td-chk">
                        <input type="checkbox" class="imp-cl-paid" data-ship-id="${escHtml(s.id)}" data-line-id="${escHtml(l.id)}" ${l.paid ? 'checked' : ''} title="Paid">
                    </td>
                    <td><button class="imp-cl-del" data-ship-id="${escHtml(s.id)}" data-line-id="${escHtml(l.id)}" title="Remove">×</button></td>
                </tr>`;
            }).join('');

            return `<div class="ship-fix-section" data-section="other">
                <div class="ship-fix-section-hd">
                    <span class="ship-fix-section-dot" style="background:${sec.colour}"></span>
                    <span class="ship-fix-section-name">${sec.label}</span>
                    <span class="ship-fix-section-sum">${subtotal > 0 ? '$' + Math.round(subtotal).toLocaleString('en-NZ') : '—'}</span>
                    <button class="imp-cl-add-line btn-link" data-ship-id="${escHtml(s.id)}" data-cat="Other">+ line</button>
                </div>
                ${lines.length ? `<table class="imp-cl-table">
                    <thead><tr>
                        <th>Description</th>
                        <th class="imp-cl-th-amt">Amount</th>
                        <th class="imp-cl-th-nzd">≈&thinsp;NZD</th>
                        <th class="imp-cl-th-paidvia">Paid Via</th>
                        <th class="imp-cl-th-chk" title="Paid">✓</th>
                        <th style="width:18px"></th>
                    </tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>` : '<p class="ship-fix-other-empty">No other costs yet — interest, rubbish, bank fees, etc.</p>'}
            </div>`;
        }

        // ── V3 row + section builders ────────────────────────────────────
        // Cost-line row in the V3 detail breakdown. Columns are split so
        // each cell holds a single concept (units, rate, ccy, subtotal, NZD)
        // — keeps numbers right-aligned and prevents the old
        // amount+ccy+mult cluster from drifting out of column.
        function buildFixedRowHtmlV3(s, def, derived, forex, showActuals) {
            const line = (s.fixedLines || {})[def.key] || {};
            const nzd  = fixedLineNzdV3(def, line, derived, forex);
            const ccy  = line.ccy || def.defaultCcy;
            const labelText = line.labelOverride || def.label;

            const minAttr = def.allowNegative ? '' : ' min="0"';

            let unitsCellInner = '<span class="ship-fix-nil">—</span>';
            let costCellInner = '';
            let localTotal = 0;

            if (def.kind === 'flat') {
                const amt = line.amount != null ? line.amount : '';
                costCellInner = `<input class="ship-fix-num" data-f="amount" type="number" value="${amt}" placeholder="0" step="0.01"${minAttr}>`;
                localTotal = Number(line.amount) || 0;
            } else if (def.kind === 'perKg') {
                const kg = Number(derived[def.kgField]) || 0;
                unitsCellInner = `<span class="ship-fix-units">${kg.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}</span><span class="ship-fix-units-unit">kg</span>`;
                const rate = line.rate != null ? line.rate : '';
                costCellInner = `<input class="ship-fix-num" data-f="rate" type="number" value="${rate}" placeholder="0" step="0.0001" min="0"><span class="ship-fix-unit">/kg</span>`;
                localTotal = (Number(line.rate) || 0) * kg;
            } else if (def.kind === 'allocation') {
                const af = line.allocFactor != null ? line.allocFactor : '';
                unitsCellInner = `<input class="ship-fix-num ship-fix-num--alloc" data-f="allocFactor" type="number" value="${af}" placeholder="0.67" step="0.01" min="0" title="Allocation factor"><span class="ship-fix-units-unit">×</span>`;
                const aa = line.annualAmount != null ? line.annualAmount : '';
                costCellInner = `<input class="ship-fix-num" data-f="annualAmount" type="number" value="${aa}" placeholder="annual" step="0.01" min="0" title="Annual amount"><span class="ship-fix-unit">/yr</span>`;
                localTotal = (Number(line.allocFactor) || 0) * (Number(line.annualAmount) || 0);
            }

            const ccyPill = `<select class="ship-fix-ccy" data-f="ccy">
                ${CCYS_FIXED.map(c => `<option${c === ccy ? ' selected' : ''}>${c}</option>`).join('')}
            </select>`;

            const subDisplay = localTotal
                ? `<span>${localTotal.toLocaleString('en-NZ', { maximumFractionDigits: 2 })}</span>`
                : '<span class="ship-fix-nil">—</span>';

            const nzdDisplay = (() => {
                if (nzd === 0) return '<span class="ship-fix-nil">—</span>';
                const sign = nzd < 0 ? '-' : '';
                return `<span${nzd < 0 ? ' class="ship-fix-neg"' : ''}>${sign}$${Math.round(Math.abs(nzd)).toLocaleString('en-NZ')}</span>`;
            })();

            let actualCells = '';
            if (showActuals) {
                const actual = line.actual != null ? line.actual : '';
                const variance = line.actual != null && nzd != null ? line.actual - nzd : null;
                const varDisplay = variance == null ? '<span class="ship-fix-nil">—</span>'
                    : `<span class="ship-var${variance > 0.5 ? ' ship-var--over' : variance < -0.5 ? ' ship-var--under' : ''}">${variance >= 0 ? '+' : ''}$${Math.round(variance).toLocaleString('en-NZ')}</span>`;
                actualCells = `
                <td class="ship-fix-td-actual"><input class="ship-fix-num" data-f="actual" type="number" value="${actual}" placeholder="—" step="1" min="0"></td>
                <td class="ship-fix-td-var">${varDisplay}</td>`;
            }

            return `<tr class="ship-fix-row${line.paid ? ' ship-fix-row--paid' : ''}" data-ship-id="${escHtml(s.id)}" data-line-key="${escHtml(def.key)}">
                <td class="ship-fix-td-label"><input class="ship-fix-label-inp" data-f="labelOverride" value="${escHtml(labelText)}" placeholder="${escHtml(def.label)}"></td>
                <td class="ship-fix-td-units">${unitsCellInner}</td>
                <td class="ship-fix-td-cost">${costCellInner}</td>
                <td class="ship-fix-td-ccy">${ccyPill}</td>
                <td class="ship-fix-td-sub">${subDisplay}</td>
                <td class="ship-fix-td-nzd">${nzdDisplay}</td>
                ${actualCells}
                <td class="ship-fix-td-chk"><input type="checkbox" class="ship-fix-paid" ${line.paid ? 'checked' : ''} title="Paid"></td>
            </tr>`;
        }

        function buildFixedSectionHtmlV3(s, sectionKey, totals, forex) {
            const sec         = SHIP_SECTIONS_V3.find(x => x.key === sectionKey);
            const defs        = FIXED_LINE_SCHEMA_V3.filter(d => d.section === sectionKey);
            const extras      = (s.extraLines || []).filter(l => l.section === sectionKey);
            const subtotal    = totals.sectionTotals[sectionKey] || 0;
            const derived     = totals.derived;
            const showActuals = sectionKey === 'bangladesh' || sectionKey === 'freight';
            const subDisp     = subtotal === 0 ? '—' :
                (subtotal < 0 ? '-' : '') + '$' + Math.round(Math.abs(subtotal)).toLocaleString('en-NZ');

            const extraRowsHtml = extras.map(l => {
                const kg = l.kind === 'perKg' ? (Number(derived[l.kgField || 'netKg']) || 0) : 0;
                const localTotal = l.kind === 'flat' ? (Number(l.amount) || 0) : (Number(l.rate) || 0) * kg;
                const ccy = l.ccy || 'NZD';
                const nzd = (() => {
                    if (!localTotal) return 0;
                    if (ccy === 'NZD') return localTotal;
                    return forex[ccy] ? localTotal / forex[ccy] : localTotal;
                })();

                let unitsCellInner = '<span class="ship-fix-nil">—</span>';
                let costCellInner  = '';
                if (l.kind === 'flat') {
                    costCellInner = `<input class="ship-fix-num" data-f="amount" type="number" value="${l.amount != null ? l.amount : ''}" placeholder="0" step="0.01" min="0">`;
                } else {
                    unitsCellInner = `<span class="ship-fix-units">${kg.toLocaleString('en-NZ', { maximumFractionDigits: 0 })}</span><span class="ship-fix-units-unit">kg</span>`;
                    costCellInner  = `<input class="ship-fix-num" data-f="rate" type="number" value="${l.rate != null ? l.rate : ''}" placeholder="0" step="0.0001" min="0"><span class="ship-fix-unit">/kg</span>`;
                }

                const subDisplay = localTotal
                    ? `<span>${localTotal.toLocaleString('en-NZ', { maximumFractionDigits: 2 })}</span>`
                    : '<span class="ship-fix-nil">—</span>';
                const nzdDisplay = nzd === 0 ? '<span class="ship-fix-nil">—</span>'
                    : `<span>$${Math.round(nzd).toLocaleString('en-NZ')}</span>`;
                const ccySelect = `<select class="ship-fix-ccy" data-f="ccy">
                    ${CCYS_FIXED.map(c => `<option${c === ccy ? ' selected' : ''}>${c}</option>`).join('')}
                </select>`;

                let extraActualCells = '';
                if (showActuals) {
                    const actual = l.actual != null ? l.actual : '';
                    const variance = l.actual != null && nzd != null ? l.actual - nzd : null;
                    const varDisplay = variance == null ? '<span class="ship-fix-nil">—</span>'
                        : `<span class="ship-var${variance > 0.5 ? ' ship-var--over' : variance < -0.5 ? ' ship-var--under' : ''}">${variance >= 0 ? '+' : ''}$${Math.round(variance).toLocaleString('en-NZ')}</span>`;
                    extraActualCells = `
                    <td class="ship-fix-td-actual"><input class="ship-fix-num" data-f="actual" type="number" value="${actual}" placeholder="—" step="1" min="0"></td>
                    <td class="ship-fix-td-var">${varDisplay}</td>`;
                }

                return `<tr class="ship-fix-row ship-extra-row${l.paid ? ' ship-fix-row--paid' : ''}" data-ship-id="${escHtml(s.id)}" data-extra-id="${escHtml(l.id)}">
                    <td class="ship-fix-td-label">
                        <input class="ship-fix-label-inp" data-f="label" value="${escHtml(l.label || '')}" placeholder="Description…">
                        <button class="ship-extra-del btn-link" data-ship-id="${escHtml(s.id)}" data-extra-id="${escHtml(l.id)}" title="Remove">×</button>
                    </td>
                    <td class="ship-fix-td-units">${unitsCellInner}</td>
                    <td class="ship-fix-td-cost">${costCellInner}</td>
                    <td class="ship-fix-td-ccy">${ccySelect}</td>
                    <td class="ship-fix-td-sub">${subDisplay}</td>
                    <td class="ship-fix-td-nzd">${nzdDisplay}</td>
                    ${extraActualCells}
                    <td class="ship-fix-td-chk"><input type="checkbox" class="ship-fix-paid" ${l.paid ? 'checked' : ''} title="Paid"></td>
                </tr>`;
            }).join('');

            const actualHeaders = showActuals
                ? '<th class="ship-fix-th-actual">Actual NZD</th><th class="ship-fix-th-var">Var</th>'
                : '';

            // Raw Product: section-level actual paid field below the table
            let sectionFooter = '';
            if (sectionKey === 'raw') {
                const rawActual  = (s.sectionActuals || {}).raw;
                const variance   = rawActual != null ? rawActual - subtotal : null;
                const varDisplay = variance == null ? '' :
                    `<span class="ship-var${variance > 0.5 ? ' ship-var--over' : variance < -0.5 ? ' ship-var--under' : ''}">${variance >= 0 ? '+' : ''}$${Math.round(variance).toLocaleString('en-NZ')}</span>`;
                sectionFooter = `<div class="ship-sec-actual-row">
                    <span class="ship-sec-actual-lbl">Actual paid (NZD)</span>
                    <input class="ship-section-actual-inp imp-url-input" data-ship-id="${escHtml(s.id)}" data-section="raw" type="number" value="${rawActual ?? ''}" placeholder="—" step="1" min="0">
                    ${varDisplay}
                </div>`;
            }

            return `<div class="ship-fix-section" data-section="${escHtml(sectionKey)}">
                <div class="ship-fix-section-hd">
                    <span class="ship-fix-section-dot" style="background:${sec.colour}"></span>
                    <span class="ship-fix-section-name">${sec.label}</span>
                    <span class="ship-fix-section-sum">${subDisp}</span>
                </div>
                <table class="ship-fix-table ship-fix-table--v3">
                    <thead><tr>
                        <th class="ship-fix-th-line">Line Item</th>
                        <th class="ship-fix-th-units">Units</th>
                        <th class="ship-fix-th-cost">Cost / Unit</th>
                        <th class="ship-fix-th-ccy">Ccy</th>
                        <th class="ship-fix-th-sub">Sub-total</th>
                        <th class="ship-fix-th-nzd">≈&thinsp;NZD</th>
                        ${actualHeaders}
                        <th class="ship-fix-th-chk" title="Paid">✓</th>
                    </tr></thead>
                    <tbody>
                        ${defs.map(d => buildFixedRowHtmlV3(s, d, derived, forex, showActuals)).join('')}
                        ${extraRowsHtml}
                    </tbody>
                </table>
                ${sectionFooter}
            </div>`;
        }

        function buildPctChartHtmlV3(sectionTotals, total) {
            const id = 'ship-pct-' + Math.random().toString(36).slice(2, 9);
            const labels = SHIP_SECTIONS_V3.map(s => s.label);
            const data   = SHIP_SECTIONS_V3.map(s => Math.max(0, sectionTotals[s.key] || 0));
            const colors = SHIP_SECTIONS_V3.map(s => s.colour);

            window._chartQ = window._chartQ || {};
            window._chartQ[id] = {
                type: 'doughnut',
                data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '62%',
                    animation: { animateRotate: true, animateScale: false, duration: 350 },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: ctx => {
                                    const v = ctx.parsed;
                                    const pct = total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '—';
                                    return ` ${ctx.label}: $${Math.round(v).toLocaleString('en-NZ')} (${pct})`;
                                },
                            },
                        },
                    },
                },
            };

            const legend = SHIP_SECTIONS_V3.map(sec => {
                const v = sectionTotals[sec.key] || 0;
                const pct = total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '—';
                return `<div class="ship-pct-legend-row">
                    <span class="ship-pct-legend-dot" style="background:${sec.colour}"></span>
                    <span class="ship-pct-legend-name">${sec.label}</span>
                    <span class="ship-pct-legend-pct">${pct}</span>
                </div>`;
            }).join('');

            return `<aside class="ship-pct-chart">
                <h4 class="ship-pct-title">% of Total</h4>
                <div class="ship-pct-canvas-wrap">
                    <canvas data-chart-id="${id}"></canvas>
                    <div class="ship-pct-canvas-center">
                        <div class="ship-pct-canvas-total">${total > 0 ? '$' + Math.round(total).toLocaleString('en-NZ') : '$0'}</div>
                        <div class="ship-pct-canvas-label">total</div>
                    </div>
                </div>
                <div class="ship-pct-legend">${legend}</div>
            </aside>`;
        }

        // ── Shipment Analytics ─────────────────────────────────────────
        // Aggregates the shipment fleet from three angles. Cost/Kg and
        // %-of-Total skip historical shipments (no cost data); the
        // timeline grid includes them since their dates are populated.
        function diffDays(aIso, bIso) {
            if (!aIso || !bIso) return null;
            const a = new Date(aIso + 'T00:00:00');
            const b = new Date(bIso + 'T00:00:00');
            if (isNaN(a) || isNaN(b)) return null;
            return Math.round((b - a) / 86400000);
        }

        function buildShipAnalyticsSection(allShips, forex, stageDefaults) {
            const v3       = allShips.filter(s => s.schema === 3);
            const v3Cost   = v3.filter(s => !s.historical);
            // Latest shipments first (highest seq number)
            const v3Sorted = [...v3].sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
            const sortedCost = [...v3Cost].sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));

            // ── Cost/Kg + Waste table ────────────────────────────────────
            let totYield = 0, totCost = 0, totWaste = 0, wasteN = 0;
            const costRows = sortedCost.map((s, i) => {
                const t = computeShipTotalsV3(s, forex);
                const yieldKg = t.derived.yieldKg;
                const cost    = t.total;
                const ppkg    = yieldKg > 0 ? cost / yieldKg : 0;
                const waste   = t.derived.wastePct || 0;
                totYield += yieldKg;
                totCost  += cost;
                if (waste > 0) { totWaste += waste; wasteN++; }
                return `<tr${i >= 3 ? ' class="sa-row-extra"' : ''}>
                    <td class="sa-td-ship">#${s.seq}</td>
                    <td class="sa-td-num">${fmtFull(yieldKg)}</td>
                    <td class="sa-td-num">$${fmtFull(cost)}</td>
                    <td class="sa-td-num sa-td-emph">$${ppkg.toFixed(2)}</td>
                    <td class="sa-td-num">${waste.toFixed(1)}%</td>
                </tr>`;
            }).join('');
            const avgPpkg  = totYield > 0 ? totCost / totYield : 0;
            const avgWaste = wasteN > 0 ? totWaste / wasteN : 0;
            const costFoot = sortedCost.length ? `<tr class="sa-tr-foot">
                <td class="sa-td-ship">Fleet</td>
                <td class="sa-td-num">${fmtFull(totYield)}</td>
                <td class="sa-td-num">$${fmtFull(totCost)}</td>
                <td class="sa-td-num sa-td-emph">$${avgPpkg.toFixed(2)}</td>
                <td class="sa-td-num">${avgWaste.toFixed(1)}%</td>
            </tr>` : '';
            const costTable = sortedCost.length ? `<table class="sa-table">
                <thead><tr>
                    <th>Shipment</th>
                    <th class="sa-th-num">Yield kg</th>
                    <th class="sa-th-num">Cost NZD</th>
                    <th class="sa-th-num">$ / kg</th>
                    <th class="sa-th-num">Waste %</th>
                </tr></thead>
                <tbody>${costRows}</tbody>
                <tfoot>${costFoot}</tfoot>
            </table>` : '<p class="wh-empty" style="margin:0">No V3 shipments with cost data yet.</p>';

            // ── Shipping Timelines: gap days between consecutive stages ─
            // Skip the first stage (Start LC = anchor); show 6 deltas.
            const stageLabels = (stageDefaults || SHIP_STAGE_DEFAULTS_V3).map(d => d.label);
            const gapHeaders = stageLabels.slice(1).map(lbl =>
                `<th class="sa-th-num" title="${escHtml(lbl)}">${escHtml(lbl.split(' ')[0])}</th>`
            ).join('');

            const dated = v3Sorted.filter(s => (s.milestones || []).filter(m => m.date).length >= 2);
            const gapsByCol = stageLabels.slice(1).map(() => []);
            const tlRows = dated.map((s, i) => {
                const ms = s.milestones || [];
                let totalDays = 0, anyTotal = false;
                const cells = stageLabels.slice(1).map((_, j) => {
                    const prev = ms[j]?.date, curr = ms[j + 1]?.date;
                    const d = diffDays(prev, curr);
                    if (d != null) { gapsByCol[j].push(d); totalDays += d; anyTotal = true; }
                    return d == null ? '<td class="sa-td-num sa-td-na">—</td>' : `<td class="sa-td-num">${d}d</td>`;
                }).join('');
                const totalCell = anyTotal ? `<td class="sa-td-num sa-td-emph">${totalDays}d</td>` : '<td class="sa-td-num sa-td-na">—</td>';
                const tag = s.historical ? '<span class="sa-tag-hist">historical</span>' : '';
                return `<tr${i >= 3 ? ' class="sa-row-extra"' : ''}><td class="sa-td-ship">#${s.seq}${tag}</td>${cells}${totalCell}</tr>`;
            }).join('');
            const avgRow = (() => {
                if (!dated.length) return '';
                let totalAvg = 0, hasTotalAvg = false;
                const cells = gapsByCol.map(arr => {
                    if (!arr.length) return '<td class="sa-td-num sa-td-na">—</td>';
                    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
                    totalAvg += m; hasTotalAvg = true;
                    return `<td class="sa-td-num">${m.toFixed(0)}d</td>`;
                }).join('');
                const total = hasTotalAvg ? `<td class="sa-td-num sa-td-emph">${totalAvg.toFixed(0)}d</td>` : '<td class="sa-td-num sa-td-na">—</td>';
                return `<tr class="sa-tr-foot"><td class="sa-td-ship">Average</td>${cells}${total}</tr>`;
            })();
            const defaultsRow = (() => {
                const sd = stageDefaults || SHIP_STAGE_DEFAULTS_V3;
                let total = 0;
                const cells = sd.slice(1).map(g => { total += g.gap; return `<td class="sa-td-num sa-td-default">${g.gap}d</td>`; }).join('');
                return `<tr class="sa-tr-foot sa-tr-default"><td class="sa-td-ship">Default</td>${cells}<td class="sa-td-num sa-td-emph sa-td-default">${total}d</td></tr>`;
            })();
            const tlTable = dated.length ? `<table class="sa-table">
                <thead><tr>
                    <th>Shipment</th>
                    ${gapHeaders}
                    <th class="sa-th-num">Total</th>
                </tr></thead>
                <tbody>${tlRows}</tbody>
                <tfoot>${avgRow}${defaultsRow}</tfoot>
            </table>` : '<p class="wh-empty" style="margin:0">Need at least 2 dated stages on a shipment to show timeline gaps.</p>';

            // ── % of Total stacked bars ────────────────────────────────
            const pctRows = sortedCost.map((s, i) => {
                const extraCls = i >= 3 ? ' sa-row-extra' : '';
                const t = computeShipTotalsV3(s, forex);
                const total = t.total;
                if (total <= 0) return `<div class="sa-pct-row sa-pct-row--empty${extraCls}">
                    <div class="sa-pct-label">#${s.seq}</div>
                    <div class="sa-pct-bar"><span class="wh-empty" style="font-size:0.75rem">no cost data</span></div>
                </div>`;
                const segs = SHIP_SECTIONS_V3.map(sec => {
                    const v = t.sectionTotals[sec.key] || 0;
                    if (v <= 0) return '';
                    const pct = (v / total) * 100;
                    return `<div class="sa-pct-seg" style="width:${pct.toFixed(2)}%;background:${sec.colour}"
                        title="${escHtml(sec.label)}: $${fmtFull(v)} (${pct.toFixed(1)}%)"></div>`;
                }).join('');
                return `<div class="sa-pct-row${extraCls}">
                    <div class="sa-pct-label">#${s.seq}</div>
                    <div class="sa-pct-bar">${segs}</div>
                    <div class="sa-pct-total">$${fmtFull(total)}</div>
                </div>`;
            }).join('');
            const pctLegend = SHIP_SECTIONS_V3.map(sec =>
                `<span class="sa-pct-leg-item"><span class="sa-pct-leg-dot" style="background:${sec.colour}"></span>${escHtml(sec.label)}</span>`
            ).join('');
            const pctBlock = sortedCost.length ? `
                <div class="sa-pct-rows">${pctRows}</div>
                <div class="sa-pct-legend">${pctLegend}</div>
            ` : '<p class="wh-empty" style="margin:0">No V3 shipments with cost data yet.</p>';

            const moreBtn = (n) => n > 3
                ? `<div class="sa-card-foot"><button class="btn-link sa-show-more-btn" data-extra="${n - 3}">Show more (${n - 3})</button></div>`
                : '';

            return `
            <div class="cat-section sa-block">
                <div class="sa-hd">
                    <h2 class="cat-title" style="margin:0">Shipment Analytics</h2>
                    <p class="cat-sub" style="margin:0">Compare the fleet across cost efficiency, timing, and cost mix.</p>
                </div>

                <div class="sa-card">
                    <div class="sa-card-hd">
                        <h3 class="sa-card-title">Cost / Kg & Waste %</h3>
                        <span class="sa-card-sub">${sortedCost.length} shipment${sortedCost.length !== 1 ? 's' : ''} · historical excluded</span>
                    </div>
                    <div class="sa-card-body">${costTable}</div>
                    ${moreBtn(sortedCost.length)}
                </div>

                <div class="sa-card">
                    <div class="sa-card-hd">
                        <h3 class="sa-card-title">Shipping Timelines</h3>
                        <span class="sa-card-sub">days between consecutive stages</span>
                    </div>
                    <div class="sa-card-body sa-card-body--wide">${tlTable}</div>
                    ${moreBtn(dated.length)}
                </div>

                <div class="sa-card">
                    <div class="sa-card-hd">
                        <h3 class="sa-card-title">Cost Composition</h3>
                        <span class="sa-card-sub">% of total NZD by section</span>
                    </div>
                    <div class="sa-card-body">${pctBlock}</div>
                    ${moreBtn(sortedCost.length)}
                </div>
            </div>`;
        }

        // Minimalist SVG line-chart timeline. Dots are spaced by date when
        // ≥2 dates exist; otherwise evenly by index. Done dots fill solid;
        // a thin grey rule joins them with a slate progress overlay up to
        // the last completed step. The row beneath shows a step number,
        // label, and an editable date input.
        // Map stage label keywords → emoji icon. Checked in order; first match wins.
        const MILESTONE_ICON_MAP = [
            [/italy|left.*bang/i,           '🚢'],
            [/tauranga|new zealand/i,        '🚛'],
            [/land.*bang|arriv.*bang/i,      '🇧🇩'],
            [/lc.*present|presented/i,       '📋'],
            [/lc.*ready/i,                   '✅'],
            [/start.*lc|lc.*start/i,         '📄'],
            [/customs/i,                     '📦'],
            [/port/i,                        '⚓'],
        ];
        function milestoneIcon(label) {
            for (const [re, icon] of MILESTONE_ICON_MAP) {
                if (re.test(label)) return icon;
            }
            return '📍';
        }

        function buildStageTimelineV3(s, milestones) {
            if (!milestones.length) {
                return '<p class="wh-empty" style="margin:0">No stages yet — click + Add to create one.</p>';
            }

            const W = 800, padX = 24;
            const tsValues = milestones.map(m => m.date ? new Date(m.date + 'T00:00:00').getTime() : null).filter(t => t != null);
            const useDates = tsValues.length >= 2;
            const minTs = useDates ? Math.min(...tsValues) : 0;
            const maxTs = useDates ? Math.max(...tsValues) : 0;
            const range  = maxTs - minTs || 1;
            const xFor = (m, i) => useDates && m.date
                ? padX + ((W - 2*padX) * (new Date(m.date + 'T00:00:00').getTime() - minTs) / range)
                : padX + ((W - 2*padX) * i / Math.max(1, milestones.length - 1));
            const pctFor = (m, i) => (xFor(m, i) / W * 100).toFixed(2);

            const lastDoneIdx = milestones.reduce((acc, m, i) => m.done ? i : acc, -1);
            const lastDoneX   = lastDoneIdx >= 0 ? xFor(milestones[lastDoneIdx], lastDoneIdx) : padX;

            // SVG carries only the track lines; icons are HTML so they don't stretch.
            const svg = `<svg viewBox="0 0 ${W} 4" preserveAspectRatio="none" class="ship-tl-svg">
                <line x1="${padX}" y1="2" x2="${W-padX}" y2="2" stroke="#e2e8f0" stroke-width="2"/>
                ${lastDoneIdx >= 0 ? `<line x1="${padX}" y1="2" x2="${lastDoneX.toFixed(1)}" y2="2" stroke="#7c3aed" stroke-width="2"/>` : ''}
            </svg>`;

            const icons = milestones.map((m, i) =>
                `<span class="ship-tl-icon${m.done ? ' ship-tl-icon--done' : ''}"
                       style="left:${pctFor(m, i)}%"
                       title="${escHtml(m.label)}${m.date ? ' · ' + escHtml(m.date) : ''}"
                 >${milestoneIcon(m.label)}</span>`
            ).join('');

            const rows = milestones.map((m, i) => `
                <div class="ship-tl-row${m.done ? ' ship-tl-row--done' : ''}">
                    <button type="button" class="ship-tl-toggle${m.done ? ' ship-tl-toggle--done' : ''}"
                            data-ship-id="${escHtml(s.id)}" data-idx="${i}"
                            title="Click to ${m.done ? 'mark not done' : 'mark done'}">
                        <span class="ship-tl-icon-badge">${milestoneIcon(m.label)}</span>
                        <span class="ship-tl-label">${escHtml(m.label)}</span>
                    </button>
                    <input type="date" class="ship-tl-date"
                        data-ship-id="${escHtml(s.id)}" data-idx="${i}"
                        value="${escHtml(m.date || '')}"
                        title="Edit date — later steps shift by their default gaps">
                </div>
            `).join('');

            return `<div class="ship-tl-section">
                <div class="ship-tl-track">
                    ${svg}
                    <div class="ship-tl-icons-row">${icons}</div>
                </div>
                <div class="ship-tl-rows">${rows}</div>
            </div>`;
        }

        function buildStageDefaultsPanel(config) {
            const defaults = getStageDefaults(config);
            const rows = defaults.map((m, i) => {
                const prev = i > 0 ? defaults[i - 1].label : '';
                if (i === 0) {
                    return `<div class="ship-tl-cfg-row">
                        <span class="ship-tl-cfg-num">${String(i + 1).padStart(2, '0')}</span>
                        <span class="ship-tl-cfg-label">${escHtml(m.label)}</span>
                        <span class="ship-tl-cfg-anchor">anchor</span>
                    </div>`;
                }
                return `<div class="ship-tl-cfg-row">
                    <span class="ship-tl-cfg-num">${String(i + 1).padStart(2, '0')}</span>
                    <span class="ship-tl-cfg-label">${escHtml(m.label)}</span>
                    <span class="ship-tl-cfg-rule">
                        <input type="number" class="ship-tl-cfg-gap" data-idx="${i}"
                              value="${m.gap}" min="0" step="1"
                              title="Days after previous step">
                        <span class="ship-tl-cfg-unit">days after ${escHtml(prev)}</span>
                    </span>
                </div>`;
            }).join('');
            return `<div class="ship-tl-cfg" id="ship-tl-cfg" hidden>
                <div class="ship-tl-cfg-hd">
                    <strong>Default gaps between stages</strong>
                    <span class="ship-tl-cfg-hint">Applied to new shipments and when an existing date is edited.</span>
                </div>
                <div class="ship-tl-cfg-list">${rows}</div>
                <div class="ship-tl-cfg-actions">
                    <button class="btn-link" id="ship-tl-cfg-reset" type="button">Reset to defaults</button>
                    <span class="ship-tl-cfg-saved" id="ship-tl-cfg-saved" hidden>Saved</span>
                </div>
            </div>`;
        }

        function renderShipDetailV3(s) {
            currentDetailShipId = s.id;
            const totals  = computeShipTotalsV3(s, forex);
            const d       = totals.derived;
            const total   = totals.total;
            const paid    = totals.paid;
            const osNzd   = total - paid;
            const paidPct = total > 0 ? Math.round(paid / total * 100) : 0;
            const ppkg    = totals.ppkgYield > 0 ? totals.ppkgYield.toFixed(2) : null;

            // Display labels: legacy shipments stored 'Order placed' as the
            // anchor; surface as 'Start LC' to match current taxonomy.
            const STAGE_LABEL_RENAMES = { 'Order placed': 'Start LC' };
            const milestones = (s.milestones || []).map(m =>
                STAGE_LABEL_RENAMES[m.label] ? { ...m, label: STAGE_LABEL_RENAMES[m.label] } : m
            );

            const fmtKg = v => (v || 0).toLocaleString('en-NZ', { maximumFractionDigits: 0 });

            // Net = white + colour. Waste applies evenly to both. Visual bar
            // segments are scaled against netKg so they always total 100%.
            const whiteWasteKg  = Math.max(0, d.whiteRawKg  - d.whiteKg);
            const colourWasteKg = Math.max(0, d.colourRawKg - d.colourKg);
            const segPct = v => d.netKg > 0 ? (v / d.netKg) * 100 : 0;

            body.innerHTML = `
            <div class="ship-detail-view ship-detail-view--new ship-detail-view--v3">
                <div class="ship-detail-topbar">
                    <button class="ship-detail-back">← Shipments</button>
                </div>
                <div class="ship-detail-tabs no-print">
                    <button class="ship-detail-tab ship-detail-tab--active" data-tab="overview">Overview</button>
                    <button class="ship-detail-tab" data-tab="lc">Letter of Credit</button>
                </div>

                <div id="ship-tab-overview" class="ship-tab-panel">
                <div class="ship-detail-layout">
                    <div class="ship-detail-main">
                        <div class="ship-detail-hdr">
                            <h1 class="ship-detail-title">Shipment #${s.seq}${s.campaign ? ' — ' + escHtml(s.campaign) : ''}</h1>
                            <p class="ship-detail-meta">${ymLabel(s.ym)} &middot; ${fmtKg(d.netKg)} kg net &middot; ${d.yieldPct.toFixed(1)}% yield</p>
                        </div>

                        ${(() => {
                            // Paid card greens up as paidPct rises; Outstanding reddens as it rises.
                            // hue 0 = red, 120 = green. Hue stays gray-ish (null) when total = 0.
                            const osPct  = total > 0 ? Math.max(0, Math.min(100, (osNzd / total) * 100)) : 0;
                            const paidH  = total > 0 ? paidPct * 1.2 : null;
                            const osH    = total > 0 ? 120 - osPct * 1.2 : null;
                            const tint   = h => h == null
                                ? 'background:#f8fafc;border-color:#e2e8f0;color:#1e293b'
                                : `background:hsl(${h},80%,96%);border-color:hsl(${h},60%,82%);color:hsl(${h},65%,32%)`;
                            return `<div class="ship-sum-row">
                                <div class="ship-sum-card">
                                    <div class="ship-sum-val">${fmtKg(d.yieldKg)}</div>
                                    <div class="ship-sum-lbl">KG</div>
                                </div>
                                <div class="ship-sum-card">
                                    <div class="ship-sum-val">${ppkg ? '$' + ppkg : '—'}</div>
                                    <div class="ship-sum-lbl">$ / kg</div>
                                </div>
                                <div class="ship-sum-card" style="${tint(paidH)}">
                                    <div class="ship-sum-val">$${Math.round(paid).toLocaleString('en-NZ')}</div>
                                    <div class="ship-sum-lbl">Paid (${paidPct}%)</div>
                                </div>
                                <div class="ship-sum-card" style="${tint(osH)}">
                                    <div class="ship-sum-val">${osNzd > 0.5 ? '$' + Math.round(osNzd).toLocaleString('en-NZ') : '✓ Clear'}</div>
                                    <div class="ship-sum-lbl">Outstanding</div>
                                </div>
                            </div>`;
                        })()}

                        <div class="ship-det-section">
                            <div class="ship-det-hd">
                                <h3 class="ship-det-title">Shipment Stage</h3>
                                <div class="ship-det-hd-actions">
                                    <label class="ship-start-date-lbl">
                                        <span>Started</span>
                                        <input type="date" class="imp-detail-input imp-url-input"
                                            data-ship-id="${escHtml(s.id)}" data-field="startDate"
                                            value="${escHtml(s.startDate||'')}"
                                            title="Sets the anchor date — all unconfirmed stage dates cascade forward automatically">
                                    </label>
                                    ${s.ym ? `<span class="ship-start-eta">→ ETA ${ymLabel(s.ym)}</span>` : ''}
                                    <button class="btn-link ship-tl-cfg-toggle" type="button" title="Edit default gaps between stages">Defaults</button>
                                </div>
                            </div>
                            ${buildStageTimelineV3(s, milestones)}
                            ${buildStageDefaultsPanel(config)}
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd">
                                <h3 class="ship-det-title">Cost Breakdown</h3>
                                <button class="btn-link ship-add-cost-toggle" data-ship-id="${escHtml(s.id)}">+ Add cost</button>
                            </div>
                            <div class="ship-add-cost-form" data-ship-id="${escHtml(s.id)}" hidden>
                                <div class="ship-add-cost-fields">
                                    <select class="ship-add-cost-section">
                                        ${SHIP_SECTIONS_V3.map(sec => `<option value="${sec.key}">${sec.label}</option>`).join('')}
                                    </select>
                                    <input class="ship-add-cost-label imp-url-input" type="text" placeholder="Label…">
                                    <select class="ship-add-cost-kind">
                                        <option value="flat">Flat</option>
                                        <option value="perKg">Per kg (net)</option>
                                        <option value="perKgYield">Per kg (yield)</option>
                                    </select>
                                    <select class="ship-add-cost-ccy">
                                        ${CCYS_FIXED.map(c => `<option>${c}</option>`).join('')}
                                    </select>
                                    <button class="btn-secondary btn-sm ship-add-cost-confirm" data-ship-id="${escHtml(s.id)}">Add</button>
                                    <button class="btn-link ship-add-cost-cancel">Cancel</button>
                                </div>
                            </div>
                            ${buildFixedSectionHtmlV3(s, 'raw',        totals, forex)}
                            ${buildFixedSectionHtmlV3(s, 'bangladesh', totals, forex)}
                            ${buildFixedSectionHtmlV3(s, 'freight',    totals, forex)}
                            ${buildFixedSectionHtmlV3(s, 'misc',       totals, forex)}
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd"><h3 class="ship-det-title">Notes</h3></div>
                            <textarea class="ship-notes-ta" rows="5"
                                data-ship-id="${escHtml(s.id)}" data-field="notes"
                                placeholder="Internal notes, contacts, terms, tracking references…">${escHtml(s.notes||'')}</textarea>
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd"><h3 class="ship-det-title">Net Weight Breakdown</h3></div>
                            ${(() => {
                                const wasteKg = whiteWasteKg + colourWasteKg;
                                return `<div class="ship-yield-bar" title="Net ${fmtKg(d.netKg)} kg → Yield ${fmtKg(d.yieldKg)} kg (${d.yieldPct.toFixed(1)}%)">
                                ${d.whiteKg  > 0 ? `<div class="ship-yield-seg ship-yield-seg--white"  style="width:${segPct(d.whiteKg).toFixed(2)}%"  title="White yield: ${fmtKg(d.whiteKg)} kg"></div>` : ''}
                                ${d.colourKg > 0 ? `<div class="ship-yield-seg ship-yield-seg--colour" style="width:${segPct(d.colourKg).toFixed(2)}%" title="Colour yield: ${fmtKg(d.colourKg)} kg"></div>` : ''}
                                ${wasteKg    > 0 ? `<div class="ship-yield-seg ship-yield-seg--waste"  style="width:${segPct(wasteKg).toFixed(2)}%"  title="Waste: ${fmtKg(wasteKg)} kg (${d.wastePct.toFixed(1)}%)"></div>` : ''}
                            </div>`;
                            })()}
                            <div class="ship-yield-legend">
                                <span class="ship-yield-leg-item"><span class="ship-yield-leg-dot ship-yield-leg-dot--white"></span>White ${fmtKg(d.whiteRawKg)} kg</span>
                                <span class="ship-yield-leg-item"><span class="ship-yield-leg-dot ship-yield-leg-dot--colour"></span>Colour ${fmtKg(d.colourRawKg)} kg</span>
                                <span class="ship-yield-leg-item"><span class="ship-yield-leg-dot ship-yield-leg-dot--waste"></span>Waste ${d.wastePct.toFixed(1)}% (−${fmtKg(d.netKg - d.yieldKg)} kg)</span>
                                <span class="ship-yield-leg-formula">White + Colour = ${fmtKg(d.netKg)} kg × ${d.yieldPct.toFixed(0)}% = ${fmtKg(d.yieldKg)} kg yield</span>
                            </div>
                            <div class="ship-yield-grid">
                                <div class="ship-yield-field">
                                    <label class="imp-field-label">White amount (kg)</label>
                                    <input type="number" class="ship-yield-input"
                                        data-ship-id="${escHtml(s.id)}" data-field="whiteRawKg"
                                        value="${s.whiteRawKg ?? ''}" placeholder="7000" step="any" min="0">
                                </div>
                                <div class="ship-yield-field">
                                    <label class="imp-field-label">Coloured amount (kg)</label>
                                    <input type="number" class="ship-yield-input"
                                        data-ship-id="${escHtml(s.id)}" data-field="colourRawKg"
                                        value="${s.colourRawKg ?? ''}" placeholder="13000" step="any" min="0">
                                </div>
                                <div class="ship-yield-field">
                                    <label class="imp-field-label">Waste %</label>
                                    <input type="number" class="ship-yield-input"
                                        data-ship-id="${escHtml(s.id)}" data-field="wastePct"
                                        value="${s.wastePct ?? ''}" placeholder="10" step="0.1" min="0" max="100">
                                </div>
                            </div>
                        </div>

                        <div class="ship-det-danger">
                            <button class="imp-ship-del" data-id="${escHtml(s.id)}">Remove shipment</button>
                        </div>
                    </div>

                    ${buildPctChartHtmlV3(totals.sectionTotals, total)}
                </div>
                </div>

                <div id="ship-tab-lc" class="ship-tab-panel" hidden>
                    <div class="ship-lc-loading">Loading LC data…</div>
                </div>
            </div>`;

            if (typeof initCharts === 'function') initCharts(body);

            // Tab switching
            body.querySelectorAll('.ship-detail-tab').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    body.querySelectorAll('.ship-detail-tab').forEach(function(b) { b.classList.remove('ship-detail-tab--active'); });
                    btn.classList.add('ship-detail-tab--active');
                    var tab = btn.dataset.tab;
                    body.querySelectorAll('.ship-tab-panel').forEach(function(p) { p.hidden = true; });
                    var panel = body.querySelector('#ship-tab-' + tab);
                    if (!panel) return;
                    panel.hidden = false;
                    if (tab === 'lc' && panel.querySelector('.ship-lc-loading')) {
                        loadShipLcPanel(panel, s);
                    }
                });
            });
        }

        async function loadShipLcPanel(panel, s) {
            try {
                var data = await fetch('/api/lc').then(function(r) { return r.json(); });
                var lcs  = (data && data.lcs) ? data.lcs : [];
                var linked = lcs.find(function(l) { return l.linkedShipmentId === s.id; });
                if (linked) {
                    panel.innerHTML =
                        '<div class="ship-lc-card">'
                        + '<div class="ship-lc-card-hd">'
                        + '<span class="ship-lc-ref">#' + escHtml(linked.lcNumber) + '</span>'
                        + '<a class="ship-lc-open" href="#lc/' + escHtml(linked.id) + '">Open LC →</a>'
                        + '</div>'
                        + '<div class="ship-lc-meta">'
                        + '<span class="ship-lc-label">Beneficiary</span><span class="ship-lc-val">' + escHtml(linked.beneficiary || '—') + '</span>'
                        + '<span class="ship-lc-label">Applicant</span><span class="ship-lc-val">' + escHtml((linked.applicant && linked.applicant.name) || '—') + '</span>'
                        + '<span class="ship-lc-label">Amount</span><span class="ship-lc-val">' + escHtml((linked.currency || '') + ' ' + (linked.amount ? Number(linked.amount).toLocaleString('en-NZ') : '—')) + '</span>'
                        + '<span class="ship-lc-label">Expires</span><span class="ship-lc-val">' + escHtml(linked.expiryDate || '—') + '</span>'
                        + '<span class="ship-lc-label">Latest Ship</span><span class="ship-lc-val">' + escHtml(linked.latestShipDate || '—') + '</span>'
                        + '</div>'
                        + '</div>';
                } else {
                    var seqLabel = s.seq ? '#' + s.seq : s.id;
                    panel.innerHTML =
                        '<div class="ship-lc-empty">'
                        + '<p>No Letter of Credit linked to this shipment.</p>'
                        + '<a class="btn-primary" href="#lc/new" id="ship-reg-lc-btn">Register LC for Shipment ' + escHtml(seqLabel) + '</a>'
                        + '</div>';
                    var regBtn = panel.querySelector('#ship-reg-lc-btn');
                    if (regBtn) {
                        regBtn.addEventListener('click', function(e) {
                            e.preventDefault();
                            if (typeof LC !== 'undefined' && LC.setPendingShipId) {
                                LC.setPendingShipId(s.id, s.seq || s.id);
                            }
                            location.hash = 'lc/new';
                        });
                    }
                }
            } catch (err) {
                panel.innerHTML = '<p class="ship-lc-err">Could not load LC data.</p>';
            }
        }

        function renderShipDetailNew(s) {
            currentDetailShipId = s.id;
            const totals  = computeShipTotalsNew(s, forex);
            const total   = totals.total;
            const paid    = totals.paid;
            const osNzd   = total - paid;
            const paidPct = total > 0 ? Math.round(paid / total * 100) : 0;
            const ppkg    = total > 0 && s.kg > 0 ? (total / s.kg).toFixed(2) : null;

            const STATUS_META = {
                planning:    { l: 'Planning',    c: '#94a3b8' },
                ordered:     { l: 'Ordered',     c: '#3b82f6' },
                'in-transit':{ l: 'In Transit',  c: '#f59e0b' },
                customs:     { l: 'Customs',     c: '#8b5cf6' },
                delivered:   { l: 'Delivered',   c: '#10b981' },
            };
            const curStatus  = deriveShipStatus(s);
            const statusMeta = STATUS_META[curStatus] || { l: curStatus, c: '#94a3b8' };

            const milestones = s.milestones || [];
            const totalKg    = Number(s.kg) || 0;
            const whiteKg    = Number(s.rawWhiteKg) || 0;
            const colourKg   = Number(s.rawColourKg) || 0;
            const splitDelta = totalKg - (whiteKg + colourKg);

            body.innerHTML = `
            <div class="ship-detail-view ship-detail-view--new">
                <div class="ship-detail-topbar">
                    <button class="ship-detail-back">← Shipments</button>
                    <a class="ship-lc-btn" href="#lc/new" onclick="LC?.setPendingShip('Shipment #${s.seq}')">Register Letter of Credit</a>
                    <div class="ship-status-wrap" title="Derived from completed stages — tick milestones to advance.">
                        <span class="ship-status-dot" style="background:${statusMeta.c}"></span>
                        <span class="ship-status-badge">${statusMeta.l}</span>
                    </div>
                </div>

                <div class="ship-detail-layout">
                    <div class="ship-detail-main">
                        <div class="ship-detail-hdr">
                            <h1 class="ship-detail-title">Shipment #${s.seq}${s.campaign ? ' — ' + escHtml(s.campaign) : ''}</h1>
                            <p class="ship-detail-meta">${ymLabel(s.ym)} &middot; ${fmtFull(s.kg)} kg${s.pricePerKg ? ` &middot; $${s.pricePerKg}/kg listed` : ''}</p>
                        </div>

                        <div class="ship-sum-row">
                            <div class="ship-sum-card">
                                <div class="ship-sum-val">$${Math.round(total).toLocaleString('en-NZ')}</div>
                                <div class="ship-sum-lbl">Total Cost (NZD)</div>
                            </div>
                            <div class="ship-sum-card">
                                <div class="ship-sum-val">${ppkg ? '$'+ppkg : '—'}</div>
                                <div class="ship-sum-lbl">Cost / kg</div>
                            </div>
                            <div class="ship-sum-card ship-sum-card--paid">
                                <div class="ship-sum-val">$${Math.round(paid).toLocaleString('en-NZ')}</div>
                                <div class="ship-sum-lbl">Paid (${paidPct}%)</div>
                            </div>
                            <div class="ship-sum-card ${osNzd > 0.5 ? 'ship-sum-card--os' : 'ship-sum-card--clear'}">
                                <div class="ship-sum-val">${osNzd > 0.5 ? '$'+Math.round(osNzd).toLocaleString('en-NZ') : '✓ Clear'}</div>
                                <div class="ship-sum-lbl">${osNzd > 0.5 ? 'Outstanding' : 'Fully Paid'}</div>
                            </div>
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd">
                                <h3 class="ship-det-title">Milestones</h3>
                                <button class="btn-link ship-add-milestone" data-ship-id="${escHtml(s.id)}">+ Add</button>
                            </div>
                            <div class="imp-milestones">
                                ${milestones.length
                                    ? milestones.map((m, i) => `
                                    <label class="imp-milestone${m.done?' imp-milestone--done':''}">
                                        <input type="checkbox" class="imp-milestone-check"
                                            data-ship-id="${escHtml(s.id)}" data-idx="${i}" ${m.done?'checked':''}>
                                        <span class="imp-milestone-label">${escHtml(m.label)}</span>
                                        ${m.date?`<span class="imp-milestone-date">${escHtml(m.date)}</span>`:''}
                                    </label>`).join('')
                                    : '<p class="wh-empty" style="margin:0.25rem 0">No milestones — click + Add to create one.</p>'
                                }
                            </div>
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd"><h3 class="ship-det-title">Raw Product Split</h3></div>
                            <div class="ship-raw-split">
                                <div class="ship-raw-split-field">
                                    <label class="imp-field-label">Line 1 (kg)</label>
                                    <input type="number" class="imp-detail-input ship-raw-kg"
                                        data-ship-id="${escHtml(s.id)}" data-field="rawWhiteKg"
                                        value="${whiteKg}" placeholder="0" step="any" min="0">
                                </div>
                                <div class="ship-raw-split-field">
                                    <label class="imp-field-label">Line 2 (kg)</label>
                                    <input type="number" class="imp-detail-input ship-raw-kg"
                                        data-ship-id="${escHtml(s.id)}" data-field="rawColourKg"
                                        value="${colourKg}" placeholder="0" step="any" min="0">
                                </div>
                                <div class="ship-raw-split-status">
                                    ${Math.abs(splitDelta) < 1
                                        ? `<span class="ship-raw-split-ok">✓ matches ${totalKg.toLocaleString('en-NZ')} kg total</span>`
                                        : `<span class="ship-raw-split-bad">${splitDelta > 0 ? '+' : ''}${Math.round(splitDelta).toLocaleString('en-NZ')} kg vs total ${totalKg.toLocaleString('en-NZ')} kg</span>`}
                                </div>
                            </div>
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd"><h3 class="ship-det-title">Cost Breakdown</h3></div>
                            ${buildFixedSectionHtml(s, 'raw',        forex)}
                            ${buildFixedSectionHtml(s, 'processing', forex)}
                            ${buildFixedSectionHtml(s, 'freight',    forex)}
                            ${buildOtherSectionHtml(s, forex)}
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd"><h3 class="ship-det-title">Shipment Details</h3></div>
                            <div class="imp-pricing-grid">
                                <div class="imp-pricing-field">
                                    <label class="imp-field-label">Arrival month</label>
                                    <input type="month" class="imp-detail-input imp-url-input"
                                        data-ship-id="${escHtml(s.id)}" data-field="ym"
                                        value="${escHtml(s.ym||'')}">
                                </div>
                                <div class="imp-pricing-field">
                                    <label class="imp-field-label">Volume (kg)</label>
                                    <input type="number" class="imp-detail-input imp-url-input"
                                        data-ship-id="${escHtml(s.id)}" data-field="kg"
                                        value="${s.kg||''}" placeholder="12000" step="any" min="0">
                                </div>
                                <div class="imp-pricing-field">
                                    <label class="imp-field-label">Listed price / kg</label>
                                    <input type="number" class="imp-detail-input imp-url-input"
                                        data-ship-id="${escHtml(s.id)}" data-field="pricePerKg"
                                        value="${s.pricePerKg||''}" placeholder="4.50" step="0.01" min="0">
                                </div>
                            </div>
                        </div>

                        <div class="ship-det-section">
                            <div class="ship-det-hd"><h3 class="ship-det-title">Notes</h3></div>
                            <textarea class="ship-notes-ta" rows="5"
                                data-ship-id="${escHtml(s.id)}" data-field="notes"
                                placeholder="Internal notes, contacts, terms, tracking references…">${escHtml(s.notes||'')}</textarea>
                        </div>

                        <div class="ship-det-danger">
                            <button class="imp-ship-del" data-id="${escHtml(s.id)}">Remove shipment</button>
                        </div>
                    </div>

                    ${buildPctChartHtml(totals.sectionTotals, total)}
                </div>
            </div>`;
        }

        function renderShipDetail(s) {
            // V3 framework — schema-tagged shipments use the new renderer.
            if (s.schema === 3) return renderShipDetailV3(s);
            // V2 rigid (Shipment #42 .. start of v3) — kept for legacy data.
            if (s.seq) return renderShipDetailNew(s);
            currentDetailShipId = s.id;
            const lines = s.costLines || [];
            function lineNzdD(l) {
                const amt = Number(l.amount) || 0;
                if (!amt) return 0;
                if (!l.ccy || l.ccy === 'NZD') return amt;
                const rate = forex[l.ccy];
                return rate ? amt / rate : amt;
            }
            const totalNzd = lines.reduce((t, l) => t + lineNzdD(l), 0);
            const paidNzd  = lines.filter(l => l.paid).reduce((t, l) => t + lineNzdD(l), 0);
            const osNzd    = totalNzd - paidNzd;
            const paidPct  = totalNzd > 0 ? Math.round(paidNzd / totalNzd * 100) : 0;
            const ppkg     = totalNzd > 0 && s.kg > 0 ? (totalNzd / s.kg).toFixed(2) : null;

            const STATUS_META = {
                planning:    { l: 'Planning',    c: '#94a3b8' },
                ordered:     { l: 'Ordered',     c: '#3b82f6' },
                'in-transit':{ l: 'In Transit',  c: '#f59e0b' },
                customs:     { l: 'Customs',     c: '#8b5cf6' },
                delivered:   { l: 'Delivered',   c: '#10b981' },
            };
            const curStatus  = deriveShipStatus(s);
            const statusMeta = STATUS_META[curStatus] || { l: curStatus, c: '#94a3b8' };

            const QUICK_COSTS = [
                { cat: 'Raw Product',      desc: 'Product cost',       ccy: 'EUR' },
                { cat: 'Bangladesh Costs', desc: 'Processing fee',     ccy: 'BDT' },
                { cat: 'Bangladesh Costs', desc: 'Agent commission',   ccy: 'USD' },
                { cat: 'Freight',          desc: 'Sea freight',        ccy: 'USD' },
                { cat: 'Freight',          desc: 'Port charges (THC)', ccy: 'USD' },
                { cat: 'Freight',          desc: 'Marine insurance',   ccy: 'USD' },
                { cat: 'Miscellaneous',    desc: 'Customs duty',       ccy: 'NZD' },
                { cat: 'Miscellaneous',    desc: 'Biosecurity levy',   ccy: 'NZD' },
            ];

            const milestones = s.milestones || [];

            body.innerHTML = `
            <div class="ship-detail-view">
                <div class="ship-detail-topbar">
                    <button class="ship-detail-back">← Shipments</button>
                    <a class="ship-lc-btn" href="#lc/new" onclick="LC?.setPendingShip('Shipment #${s.seq}')">Register Letter of Credit</a>
                    <div class="ship-status-wrap" title="Derived from completed stages — tick milestones to advance.">
                        <span class="ship-status-dot" style="background:${statusMeta.c}"></span>
                        <span class="ship-status-badge">${statusMeta.l}</span>
                    </div>
                </div>

                <div class="ship-detail-hdr">
                    <h1 class="ship-detail-title">${escHtml(s.campaign || ymLabel(s.ym))}</h1>
                    <p class="ship-detail-meta">${ymLabel(s.ym)} &middot; ${fmtFull(s.kg)} kg${s.pricePerKg ? ` &middot; $${s.pricePerKg}/kg listed` : ''}</p>
                </div>

                <div class="ship-sum-row">
                    <div class="ship-sum-card">
                        <div class="ship-sum-val">$${Math.round(totalNzd).toLocaleString('en-NZ')}</div>
                        <div class="ship-sum-lbl">Total Cost (NZD)</div>
                    </div>
                    <div class="ship-sum-card">
                        <div class="ship-sum-val">${ppkg ? '$'+ppkg : '—'}</div>
                        <div class="ship-sum-lbl">Cost / kg</div>
                    </div>
                    <div class="ship-sum-card ship-sum-card--paid">
                        <div class="ship-sum-val">$${Math.round(paidNzd).toLocaleString('en-NZ')}</div>
                        <div class="ship-sum-lbl">Paid (${paidPct}%)</div>
                    </div>
                    <div class="ship-sum-card ${osNzd > 0.5 ? 'ship-sum-card--os' : 'ship-sum-card--clear'}">
                        <div class="ship-sum-val">${osNzd > 0.5 ? '$'+Math.round(osNzd).toLocaleString('en-NZ') : '✓ Clear'}</div>
                        <div class="ship-sum-lbl">${osNzd > 0.5 ? 'Outstanding' : 'Fully Paid'}</div>
                    </div>
                </div>

                <div class="ship-det-section">
                    <div class="ship-det-hd">
                        <h3 class="ship-det-title">Milestones</h3>
                        <button class="btn-link ship-add-milestone" data-ship-id="${escHtml(s.id)}">+ Add</button>
                    </div>
                    <div class="imp-milestones">
                        ${milestones.length
                            ? milestones.map((m, i) => `
                            <label class="imp-milestone${m.done?' imp-milestone--done':''}">
                                <input type="checkbox" class="imp-milestone-check"
                                    data-ship-id="${escHtml(s.id)}" data-idx="${i}" ${m.done?'checked':''}>
                                <span class="imp-milestone-label">${escHtml(m.label)}</span>
                                ${m.date?`<span class="imp-milestone-date">${escHtml(m.date)}</span>`:''}
                            </label>`).join('')
                            : '<p class="wh-empty" style="margin:0.25rem 0">No milestones — click + Add to create one.</p>'
                        }
                    </div>
                </div>

                <div class="ship-det-section">
                    <div class="ship-det-hd">
                        <h3 class="ship-det-title">Cost Breakdown</h3>
                    </div>
                    ${buildCostHtml(s)}
                    <div class="ship-quick-costs">
                        <span class="ship-qc-label">Quick add:</span>
                        ${QUICK_COSTS.map(q=>`<button class="ship-quick-cost btn-secondary btn-sm"
                            data-ship-id="${escHtml(s.id)}" data-cat="${escHtml(q.cat)}"
                            data-desc="${escHtml(q.desc)}" data-ccy="${escHtml(q.ccy)}">${escHtml(q.desc)}</button>`).join('')}
                    </div>
                </div>

                <div class="ship-det-section">
                    <div class="ship-det-hd"><h3 class="ship-det-title">Shipment Details</h3></div>
                    <div class="imp-pricing-grid">
                        <div class="imp-pricing-field">
                            <label class="imp-field-label">Arrival month</label>
                            <input type="month" class="imp-detail-input imp-url-input"
                                data-ship-id="${escHtml(s.id)}" data-field="ym"
                                value="${escHtml(s.ym||'')}">
                        </div>
                        <div class="imp-pricing-field">
                            <label class="imp-field-label">Volume (kg)</label>
                            <input type="number" class="imp-detail-input imp-url-input"
                                data-ship-id="${escHtml(s.id)}" data-field="kg"
                                value="${s.kg||''}" placeholder="12000" step="any" min="0">
                        </div>
                        <div class="imp-pricing-field">
                            <label class="imp-field-label">Listed price / kg</label>
                            <input type="number" class="imp-detail-input imp-url-input"
                                data-ship-id="${escHtml(s.id)}" data-field="pricePerKg"
                                value="${s.pricePerKg||''}" placeholder="4.50" step="0.01" min="0">
                        </div>
                    </div>
                </div>

                <div class="ship-det-section">
                    <div class="ship-det-hd"><h3 class="ship-det-title">Notes</h3></div>
                    <textarea class="ship-notes-ta" rows="5"
                        data-ship-id="${escHtml(s.id)}" data-field="notes"
                        placeholder="Internal notes, contacts, terms, tracking references…">${escHtml(s.notes||'')}</textarea>
                </div>

                <div class="ship-det-danger">
                    <button class="imp-ship-del" data-id="${escHtml(s.id)}">Remove shipment</button>
                </div>
            </div>`;
        }

        function rebuild() {
            currentDetailShipId = null;

            const rows     = computeForecast(config, 18, actuals);
            const closeKey = { avg: 'closeAvg', good: 'closeGood', great: 'closeGreat' }[scenario];
            const openKey  = { avg: 'openAvg',  good: 'openGood',  great: 'openGreat'  }[scenario];
            const salesKey = { avg: 'avgSales', good: 'goodSales', great: 'greatSales' }[scenario];

            const FX_LABELS = { USD: 'US Dollar', EUR: 'Euro', CNY: 'Chinese Yuan', AUD: 'Aus Dollar', BDT: 'Bangladeshi Taka' };
            const FX_DISPLAY = ['USD', 'EUR', 'CNY', 'AUD', 'BDT'];
            const fxSparkline = code => {
                try {
                    if (code === 'BDT') {
                        const months = Object.keys(bdtHistory).sort();
                        const values = months.map(m => bdtHistory[m]);
                        if (values.length < 2 || typeof drawSparkline !== 'function') return '';
                        return drawSparkline(values, months);
                    }
                    if (!fxHistory?.rates) return '';
                    const byMonth = {};
                    Object.keys(fxHistory.rates).sort().forEach(d => {
                        const month = d.slice(0, 7);
                        const rate = fxHistory.rates[d]?.[code];
                        if (rate !== undefined) byMonth[month] = rate;
                    });
                    const values = Object.values(byMonth);
                    const months = Object.keys(byMonth);
                    if (values.length < 2 || typeof drawSparkline !== 'function') return '';
                    return drawSparkline(values, months);
                } catch (e) { return ''; }
            };
            const fxPanelHtml = Object.keys(forex).length ? `
            <div class="cat-section imp-fx-panel">
                <div class="imp-fx-header">
                    <h2 class="cat-title" style="margin:0">FX Rates</h2>
                    <span class="imp-fx-base-tag">1 NZD =</span>
                </div>
                <div class="imp-fx-grid">
                    ${FX_DISPLAY.filter(c => forex[c]).map(c =>
                        '<div class="imp-fx-tile">' +
                        '<div class="imp-fx-tile-header">' +
                        '<div class="imp-fx-tile-code">' + c + '</div>' +
                        '<div class="imp-fx-tile-rate">' + forex[c].toFixed(4) + '</div>' +
                        '</div>' +
                        '<div class="imp-fx-tile-name">' + FX_LABELS[c] + '</div>' +
                        fxSparkline(c) +
                        '</div>'
                    ).join('')}
                </div>
                <p class="imp-fx-date">as of ${fxToday}</p>
            </div>` : '';

            const scenarioBtns = ['avg', 'good', 'great'].map(s =>
                `<button class="imp-scenario-btn ${scenario === s ? 'active' : ''}" data-s="${s}">${{ avg: 'Average', good: 'Good +10%', great: 'Great +20%' }[s]}</button>`
            ).join('');

            let _prevFcstYr = null;
            const tableRows = rows.map(r => {
                const closing   = r[closeKey];
                const sales     = r[salesKey];
                const hasActual = r.actualSales !== null;
                const status  = closing < 0 ? 'critical' : closing < sales * 2 ? 'low' : 'ok';
                const dot = {
                    ok:       '<span class="fcst-dot fcst-dot--ok" title="Sufficient stock"></span>',
                    low:      '<span class="fcst-dot fcst-dot--low" title="Less than 2 months supply"></span>',
                    critical: '<span class="fcst-dot fcst-dot--critical" title="Out of stock"></span>',
                }[status];
                let yearRow = '';
                if (r.yr !== _prevFcstYr) {
                    if (_prevFcstYr !== null) yearRow = `<tr class="imp-year-divider"><td colspan="7">${r.yr}</td></tr>`;
                    _prevFcstYr = r.yr;
                }
                const incomingShip = r.incomingShips && r.incomingShips.length ? r.incomingShips[0] : null;
                const incomingContent = r.incoming
                    ? (incomingShip
                        ? `<button class="imp-incoming-link" data-ship-id="${escHtml(incomingShip.id)}" title="${escHtml(incomingShip.campaign || ymLabel(incomingShip.ym))}">${'+' + fmtFull(r.incoming)}</button>`
                        : '+' + fmtFull(r.incoming))
                    : '—';
                return yearRow + `
                <tr class="imp-row ${r.incoming ? 'imp-has-import' : ''} ${!hasActual && status !== 'ok' ? 'imp-row--' + status : ''}">
                    <td class="imp-td-month">${escHtml(r.label)}</td>
                    <td class="imp-td-num ${hasActual ? 'imp-actual-val' : ''}">${hasActual ? fmtFull(r.actualSales) : '—'}</td>
                    <td class="imp-td-num">${fmtFull(sales)}</td>
                    <td class="imp-td-num">${fmtFull(r[openKey])}</td>
                    <td class="imp-td-num imp-incoming ${r.incoming ? 'imp-incoming-val' : ''}">${incomingContent}</td>
                    <td class="imp-td-num ${closing < 0 ? 'fcst-negative' : ''}">${fmtFull(closing)}</td>
                    <td style="text-align:center;padding:0 0.5rem">${dot}</td>
                </tr>`;
            }).join('');

            // Annual Est. Sales — sum the next 12 forecast rows under the
            // active scenario so it tracks the toggle. Surfaced as a chip
            // beside the table title.
            const annualEstSales = rows.slice(0, 12).reduce((t, r) => t + (r[salesKey] || 0), 0);
            const annualLabel = ({ avg: 'Average', good: 'Good +10%', great: 'Great +20%' })[scenario] || 'Average';

            // Sort by startDate (when the LC opens) so the cards run in
            // production order. Fall back to ym for legacy ships without a
            // startDate field.
            const shipSortKey = s => s.startDate || (s.ym ? s.ym + '-01' : '9999-99-99');
            const allShips      = (config.shipments || []).slice()
                .sort((a, b) => shipSortKey(a).localeCompare(shipSortKey(b)));

            // Every shipment surfaces with a "#N" — fall back to a virtual
            // index for legacy shipments that pre-date the seq field. We
            // mutate the in-memory copy only; nothing writes back to KV.
            allShips.forEach((s, i) => { if (!s.seq) s._displaySeq = i + 1; });
            const displaySeqOf = s => s.seq || s._displaySeq || 0;

            const todayYm       = new Date().toISOString().slice(0, 7);
            // Past/upcoming is also milestone-driven so a shipment arriving
            // this month stays in "upcoming" until its final stage is dated
            // in a prior month.
            const upcomingShips = allShips.filter(s => (shipArrivalYm(s) || s.ym) >= todayYm);
            const pastShips     = allShips.filter(s => (shipArrivalYm(s) || s.ym) <  todayYm);

            const SHIP_STATUS_COLORS = { planning:'#94a3b8', ordered:'#3b82f6', 'in-transit':'#f59e0b', customs:'#8b5cf6', delivered:'#10b981' };
            const SHIP_STATUS_LABELS = { planning:'Planning', ordered:'Ordered', 'in-transit':'In Transit', customs:'Customs', delivered:'Delivered' };

            // Compact card for the overview's "Upcoming Shipments" strip.
            // Shows core info: #, ETA, yield kg, $paid/$total, current stage.
            // Card is clickable (delegates to .imp-event-card--nav handler).
            // Map a stage label to its step number for the minimalist
            // current-stage badge on upcoming cards. Falls back to '·' for
            // ad-hoc / legacy labels not in the standard sequence.
            const STAGE_STEP_NUMS = (() => {
                const map = {};
                getStageDefaults(config).forEach((d, i) => { map[d.label] = String(i + 1).padStart(2, '0'); });
                map['Order placed'] = map['Start LC'];
                return map;
            })();
            const STATUS_C = { planning:'#94a3b8', ordered:'#3b82f6', 'in-transit':'#f59e0b', customs:'#8b5cf6', delivered:'#10b981' };
            const STATUS_L = { planning:'Planning', ordered:'Ordered', 'in-transit':'In transit', customs:'Customs', delivered:'Delivered' };
            const STAGE_GREENS = ['#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857'];

            function fmtKshort(n) {
                const v = Math.round(n);
                if (Math.abs(v) >= 10000) return '$' + Math.round(v / 1000) + 'k';
                if (Math.abs(v) >= 1000)  return '$' + (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
                return '$' + v.toLocaleString('en-NZ');
            }

            const upcomingCard = (s) => {
                let totalNzd = 0, paidNzd = 0;
                if (s.schema === 3) {
                    const t = computeShipTotalsV3(s, forex);
                    totalNzd = t.total; paidNzd = t.paid;
                } else if (s.seq) {
                    const t = computeShipTotalsNew(s, forex);
                    totalNzd = t.total; paidNzd = t.paid;
                }

                const outstandingNzd = Math.max(0, totalNzd - paidNzd);
                const pctPaid        = totalNzd > 0 ? Math.round(paidNzd / totalNzd * 100) : 0;

                const milestones = s.milestones || [];
                const segs = STAGE_GREENS.map((bg, i) => {
                    const m = milestones[i];
                    const done = !!(m && m.done);
                    const label = (m && m.label) || `Stage ${i + 1}`;
                    const dateTxt = m && m.date ? ' · ' + m.date : '';
                    return `<span class="db-ms-seg${done ? ' db-ms-seg--done' : ''}"
                        style="background:${bg}"
                        title="${escHtml(label + dateTxt)}"></span>`;
                }).join('');

                // "Arrives May, 26" — driven by the last-milestone date when
                // available, otherwise the shipment-level ym.
                const arriveYm = shipArrivalYm(s) || s.ym;
                let arriveLabel = '';
                if (arriveYm) {
                    const [yr, mo] = arriveYm.split('-');
                    arriveLabel = `Arrives ${MONTH_NAMES[parseInt(mo, 10) - 1]}, ${yr.slice(-2)}`;
                }

                const payBar = totalNzd > 0 ? `
                    <div class="imp-pay-progress" title="${pctPaid}% paid">
                        <div class="imp-pay-bar">
                            <div class="imp-pay-bar-paid" style="width:${pctPaid}%"></div>
                        </div>
                        <div class="imp-pay-labels">
                            <span class="imp-pay-paid">${fmtKshort(paidNzd)} paid</span>
                            <span class="imp-pay-os">${fmtKshort(outstandingNzd)} outstanding</span>
                        </div>
                    </div>`
                    : '<div class="imp-pay-empty">No costs entered</div>';

                const seqForTitle = displaySeqOf(s);
                return `
                <div class="imp-upcoming-card imp-event-card--nav" data-ship-id="${escHtml(s.id)}">
                    <div class="imp-upcoming-row1">
                        <span class="imp-upcoming-num">#${seqForTitle}</span>
                    </div>
                    <div class="imp-upcoming-arrival">${escHtml(arriveLabel)}</div>
                    ${payBar}
                    <div class="db-ship-ms" role="img" aria-label="Milestone progress">${segs}</div>
                </div>`;
            };

            const shipCard = (s, past) => {
                const milestones = s.milestones || [];
                const doneCount  = milestones.filter(m => m.done).length;

                // V3 → computeShipTotalsV3; V2 (seq, no schema) → computeShipTotalsNew;
                // legacy free-form → sum costLines.
                let totalNzd, paidNzd;
                if (s.schema === 3) {
                    const t = computeShipTotalsV3(s, forex);
                    totalNzd = t.total;
                    paidNzd  = t.paid;
                } else if (s.seq) {
                    const t = computeShipTotalsNew(s, forex);
                    totalNzd = t.total;
                    paidNzd  = t.paid;
                } else {
                    const lineNzdC = l => {
                        const amt = Number(l.amount) || 0;
                        if (!amt) return 0;
                        if (!l.ccy || l.ccy === 'NZD') return amt;
                        const rate = forex[l.ccy];
                        return rate ? amt / rate : amt;
                    };
                    const lines = s.costLines || [];
                    totalNzd = lines.reduce((t, l) => t + lineNzdC(l), 0);
                    paidNzd  = lines.filter(l => l.paid).reduce((t, l) => t + lineNzdC(l), 0);
                }
                const osNzd  = totalNzd - paidNzd;
                const status = deriveShipStatus(s);
                const sc     = SHIP_STATUS_COLORS[status] || '#94a3b8';

                // Every card leads with "Shipment #N". Legacy shipments use
                // their virtual displaySeq computed above. The campaign and
                // month always drop to the subtitle line.
                const seqForTitle = displaySeqOf(s);
                const title    = `Shipment #${seqForTitle}`;
                const subtitle = [s.campaign, ymLabel(s.ym)].filter(Boolean).join(' · ');

                return `
                <div class="imp-event-card imp-event-card--nav ${past ? 'imp-event-card--past' : ''}" data-ship-id="${escHtml(s.id)}">
                    <div class="imp-event-card-summary">
                        <div>
                            <div class="imp-event-title">${escHtml(title)}</div>
                            ${subtitle ? `<div class="imp-event-month">${escHtml(subtitle)}</div>` : ''}
                            <div class="imp-event-qty">${fmtFull(s.kg)} kg</div>
                            ${s.note ? `<div class="imp-event-note">${escHtml(s.note)}</div>` : ''}
                            ${totalNzd > 0 ? `<div class="imp-ship-cost-pill">
                                $${Math.round(totalNzd).toLocaleString('en-NZ')} NZD &middot;
                                ${osNzd > 0.5
                                    ? `<span class="imp-ship-os">$${Math.round(osNzd).toLocaleString('en-NZ')} outstanding</span>`
                                    : '<span class="imp-ship-paid-ok">paid ✓</span>'}
                            </div>` : ''}
                        </div>
                        <div class="imp-card-badges">
                            ${milestones.length ? `<span class="imp-milestone-progress">${doneCount}/${milestones.length}</span>` : ''}
                            <span class="imp-ship-status-badge" style="color:${sc};background:${sc}18;border-color:${sc}30">${SHIP_STATUS_LABELS[status]||status}</span>
                        </div>
                    </div>
                    <svg class="imp-card-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>`;
            };

            const totalShips = upcomingShips.length + pastShips.length;
            const visibleShips = showAllShips
                ? [...upcomingShips, ...pastShips.slice().reverse()]
                : upcomingShips.slice(0, 3);

            body.innerHTML = `
            <div>
                <div class="imp-overview-grid">
                <div class="imp-overview-main">
                <div class="imp-tabs">
                    <button class="imp-tab-btn${activeTab==='forecast'?' imp-tab-btn--active':''}" data-tab="forecast">Forecast</button>
                    <button class="imp-tab-btn${activeTab==='analytics'?' imp-tab-btn--active':''}" data-tab="analytics">Analytics</button>
                </div>
                <div class="imp-tab-pane${activeTab==='forecast'?'':' imp-tab-pane--hidden'}" data-tab-pane="forecast">
                <div class="cat-section imp-upcoming-card-section">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;gap:0.75rem">
                        <h2 class="cat-title" style="margin:0">${showAllShips ? 'All Shipments' : 'Upcoming Shipments'}</h2>
                        <div style="display:flex;gap:0.4rem;align-items:center">
                            ${totalShips > 3 ? `<button class="btn-link" id="imp-toggle-all-ships">${showAllShips ? 'Show upcoming only' : `View all (${totalShips})`}</button>` : ''}
                            <button class="btn-primary btn-sm" id="imp-add-ship-btn">+ Add</button>
                        </div>
                    </div>
                    <div id="imp-add-ship-form" style="display:none;margin-bottom:1rem;padding:0.75rem;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0">
                        <div class="imp-add-form-grid">
                            <div>
                                <label class="imp-field-label">Shipment #</label>
                                <input type="number" id="ship-seq" class="imp-url-input" min="1" step="1">
                            </div>
                            <div>
                                <label class="imp-field-label">Start date</label>
                                <input type="date" id="ship-startdate" class="imp-url-input">
                            </div>
                            <div>
                                <label class="imp-field-label">White amount (kg)</label>
                                <input type="number" id="ship-whitekg" class="imp-url-input" placeholder="e.g. 7000" min="0" step="any">
                            </div>
                            <div>
                                <label class="imp-field-label">Coloured amount (kg)</label>
                                <input type="number" id="ship-colourkg" class="imp-url-input" placeholder="e.g. 13000" min="0" step="any">
                            </div>
                            <div>
                                <label class="imp-field-label">Waste %</label>
                                <input type="number" id="ship-wastepct" class="imp-url-input" placeholder="10" min="0" max="100" step="0.1" value="10">
                            </div>
                        </div>
                        <p id="ship-yield-preview" class="imp-add-yield-preview"></p>
                        <div style="display:flex;gap:0.4rem;margin-top:0.5rem">
                            <button class="btn-primary btn-sm" id="ship-save-btn">Add Shipment</button>
                            <button class="btn-secondary btn-sm" id="ship-cancel-btn">Cancel</button>
                        </div>
                    </div>
                    <div class="imp-upcoming-grid">
                        ${visibleShips.length
                            ? visibleShips.map(s => upcomingCard(s)).join('')
                            : '<p class="wh-empty" style="margin:0">No upcoming shipments — click + Add to create one.</p>'}
                    </div>
                </div>

                <div class="cat-section imp-chart-card">
                    <div class="cat-section-head">
                        <div>
                            <h2 class="cat-title">Stock Trajectory &middot; Prime Ties <span class="fcst-version">v${config.version || 1}</span>
                                <span class="chart-info" title="Projects kg-on-hand 18 months forward from your stocktake. Each month: opening − Est. Sales (max of actual vs forecast) + incoming shipments. Three scenarios (Average / Good +10% / Great +20%) — toggle them at right; the active line is bold, the others fade for reference. Triangle markers along the X-axis are shipment arrivals. Where the line goes below zero, a red fill flags an out-of-stock month.">&#9432;</span>
                            </h2>
                            <p class="cat-sub">Stocktake: <strong>${fmtFull(config.startingKg ?? 0)} kg</strong>
                                ${config.stocktakeDate ? `as of <strong>${config.stocktakeDate}</strong>` : '<span style="color:#94a3b8">(no date set — assuming start of this month)</span>'}
                                <button class="btn-link" id="imp-edit-stock-btn">Edit</button></p>
                        </div>
                        <div class="cat-actions">
                            <div class="imp-scenario-wrap">${scenarioBtns}</div>
                        </div>
                    </div>
                    <div id="imp-stock-edit" style="display:none;margin-bottom:1rem">
                        <div class="imp-connect-row">
                            <label style="font-size:0.8125rem;color:#64748b;white-space:nowrap">Stock on hand (kg):</label>
                            <input type="number" id="imp-stock-kg" class="imp-url-input" style="max-width:140px"
                                value="${config.startingKg ?? ''}" placeholder="e.g. 5000" min="0" step="any">
                            <label style="font-size:0.8125rem;color:#64748b;white-space:nowrap">as of</label>
                            <input type="date" id="imp-stock-date" class="imp-url-input" style="max-width:170px"
                                value="${escHtml(config.stocktakeDate || new Date().toISOString().slice(0, 10))}">
                            <button class="btn-primary btn-sm" id="imp-stock-save-btn">Save</button>
                            <button class="btn-secondary btn-sm" id="imp-stock-cancel-btn">Cancel</button>
                        </div>
                        <p class="cat-sub" style="margin:0.5rem 0 0;font-size:0.78rem">
                            Stocktake = physical count on a given day. Forecasted sales after the stocktake are pro-rated for the partial first month; shipments arriving before the stocktake date are assumed already on the shelf.
                        </p>
                    </div>
                    <div id="imp-chart-wrap">${buildForecastChart(rows, scenario, allShips)}</div>
                </div>

                <div class="cat-section imp-table-card" style="padding-bottom:0">
                    <div class="imp-table-head">
                        <h2 class="cat-title" style="margin:0">Monthly Forecast</h2>
                        <div class="imp-annual-chip" title="Sum of Est. Sales over the next 12 months at the active scenario">
                            <span class="imp-annual-chip-lbl">12-mo Est. Sales · ${annualLabel}</span>
                            <span class="imp-annual-chip-val">${fmtFull(annualEstSales)} kg</span>
                        </div>
                    </div>
                    <div class="imp-table-wrap">
                        <table class="imp-table">
                            <thead>
                                <tr>
                                    <th class="imp-th-month" title="Forecast month. The first row is the stocktake month and is pro-rated for the days remaining after the stocktake date.">Month</th>
                                    <th class="imp-th-num" title="Actual kg sold this month, derived from dispatched orders in /api/orders (only counts months on or after the Hub-live cutoff).">Actual</th>
                                    <th class="imp-th-num" title="Est. Sales = max(Actual, monthly forecast). Conservative: an in-progress month with only a few hundred kg sold still uses the full forecast for the closing-stock projection, so the rest of the month's expected sales aren't lost.">Est. Sales</th>
                                    <th class="imp-th-num" title="Opening stock = previous month's Closing. The first row's Opening is the stocktake kg.">Opening</th>
                                    <th class="imp-th-num imp-th-incoming" title="Sum of shipments arriving in this month (using each shipment's final-milestone date). Shipments dated before the stocktake are assumed already on the shelf and excluded from the stocktake month.">Incoming</th>
                                    <th class="imp-th-num" title="Closing = Opening − Est. Sales + Incoming.&#10;&#10;Status dot:&#10;● green = healthy (more than 2 months of supply at the current Est. Sales rate)&#10;● orange = low (less than 2 months of supply)&#10;● red = critical (stock goes negative)">Closing</th>
                                    <th style="width:32px" title="Health indicator — see the Closing column tooltip for the colour rules."></th>
                                </tr>
                            </thead>
                            <tbody>${tableRows}</tbody>
                        </table>
                    </div>
                </div>

                <details class="cat-section" style="margin-top:1.25rem">
                    <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;padding-bottom:0.5rem">
                        <h2 class="cat-title" style="margin:0">Monthly Sales Averages</h2>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </summary>
                    <p class="cat-sub" style="margin-bottom:1rem">Edit the Average column &mdash; Good and Great derive automatically (+10% / +20%).</p>
                    <div class="fcst-matrix-wrap">
                        <table class="fcst-matrix">
                            <thead>
                                <tr>
                                    <th class="fcst-matrix-mo">Month</th>
                                    <th class="fcst-matrix-num fcst-matrix-num--edit">Average (kg)</th>
                                    <th class="fcst-matrix-num">Good <span class="fcst-matrix-mult">+10%</span></th>
                                    <th class="fcst-matrix-num fcst-matrix-num--accent">Great <span class="fcst-matrix-mult">+20%</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${MONTH_NAMES.map((m, i) => {
                                    const avgKg = Number((config.monthlyAvg || [])[i]) || 0;
                                    return `
                                    <tr>
                                        <td class="fcst-matrix-mo">${m}</td>
                                        <td class="fcst-matrix-num fcst-matrix-num--edit">
                                            <input type="number" class="fcst-avg-input" data-mo="${i}"
                                                value="${avgKg || ''}" placeholder="0" min="0" step="any">
                                        </td>
                                        <td class="fcst-matrix-num" data-derived="good" data-mo="${i}">${fmtFull(avgKg * 1.1)}</td>
                                        <td class="fcst-matrix-num fcst-matrix-num--accent" data-derived="great" data-mo="${i}">${fmtFull(avgKg * 1.2)}</td>
                                    </tr>`;
                                }).join('')}
                            </tbody>
                            <tfoot>
                                <tr class="fcst-matrix-totals">
                                    <td class="fcst-matrix-mo">Annual</td>
                                    <td class="fcst-matrix-num fcst-matrix-num--edit" id="fcst-avg-total-avg">${fmtFull((config.monthlyAvg || []).reduce((t, v) => t + (Number(v) || 0), 0))}</td>
                                    <td class="fcst-matrix-num" id="fcst-avg-total-good">${fmtFull((config.monthlyAvg || []).reduce((t, v) => t + (Number(v) || 0), 0) * 1.1)}</td>
                                    <td class="fcst-matrix-num fcst-matrix-num--accent" id="fcst-avg-total-great">${fmtFull((config.monthlyAvg || []).reduce((t, v) => t + (Number(v) || 0), 0) * 1.2)}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                    <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap">
                        <button class="btn-primary btn-sm" id="imp-avg-save-btn">Save Averages</button>
                        <button class="btn-secondary btn-sm" id="imp-avg-recompute-btn"
                            title="Average each calendar month's kg from /api/sales/monthly (the same weaved series the Sales History uses)">
                            Recompute from history
                        </button>
                    </div>
                </details>

                </div>
                <div class="imp-tab-pane${activeTab==='analytics'?'':' imp-tab-pane--hidden'}" data-tab-pane="analytics">
                ${buildShipAnalyticsSection(allShips, forex, getStageDefaults(config))}
                </div>
                </div>
                ${fxPanelHtml ? `<div class="imp-overview-side">${fxPanelHtml}</div>` : ''}
                </div>
            </div>`;

            if (typeof initCharts === 'function') initCharts(body);

            body.querySelectorAll('.imp-scenario-btn').forEach(btn => {
                btn.addEventListener('click', () => { scenario = btn.dataset.s; rebuild(); });
            });

            document.getElementById('imp-edit-stock-btn')?.addEventListener('click', () => {
                document.getElementById('imp-stock-edit').style.display = '';
                document.getElementById('imp-stock-kg').focus();
            });
            document.getElementById('imp-stock-cancel-btn')?.addEventListener('click', () => {
                document.getElementById('imp-stock-edit').style.display = 'none';
            });
            document.getElementById('imp-stock-save-btn')?.addEventListener('click', async () => {
                const kg   = parseFloat(document.getElementById('imp-stock-kg').value) || 0;
                const date = document.getElementById('imp-stock-date').value;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    showToast('Pick a stocktake date');
                    return;
                }
                const btn = document.getElementById('imp-stock-save-btn');
                btn.disabled = true; btn.textContent = 'Saving…';
                try {
                    await api('/api/import/forecast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ startingKg: kg, stocktakeDate: date }),
                    });
                    config.startingKg    = kg;
                    config.stocktakeDate = date;
                    showToast('Stocktake saved');
                    rebuild();
                } catch (err) {
                    showToast('Save failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Save';
                }
            });

            // ── Tabs (Forecast / Analytics) ──
            body.querySelectorAll('.imp-tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    activeTab = btn.dataset.tab;
                    body.querySelectorAll('.imp-tab-btn').forEach(b =>
                        b.classList.toggle('imp-tab-btn--active', b.dataset.tab === activeTab));
                    body.querySelectorAll('.imp-tab-pane').forEach(p =>
                        p.classList.toggle('imp-tab-pane--hidden', p.dataset.tabPane !== activeTab));
                });
            });

            // ── View all / upcoming-only toggle ──
            document.getElementById('imp-toggle-all-ships')?.addEventListener('click', () => {
                showAllShips = !showAllShips;
                rebuild();
            });

            // ── Show more / Show less for analytics tables ──
            body.querySelectorAll('.sa-show-more-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const card = btn.closest('.sa-card');
                    const expanded = card.classList.toggle('sa-card--expanded');
                    btn.textContent = expanded ? 'Show less' : `Show more (${btn.dataset.extra})`;
                });
            });

            // Pull the weaved monthly series, group by calendar month across
            // all available history, and average. Populates the input fields
            // — user still has to click Save to commit. The series weaves
            // sheet (pre-2026-04) with Hub orders (from cutoff on), so this
            // averages real sales, not the manual baseline.
            document.getElementById('imp-avg-recompute-btn')?.addEventListener('click', async () => {
                const btn = document.getElementById('imp-avg-recompute-btn');
                btn.disabled = true; btn.textContent = 'Loading…';
                try {
                    const resp = await fetch('/api/sales/monthly');
                    if (!resp.ok) throw new Error('Failed to fetch sales/monthly');
                    const { monthly } = await resp.json();
                    const bucket = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));
                    for (const [ym, kg] of Object.entries(monthly || {})) {
                        const mo = parseInt(ym.slice(5), 10) - 1;
                        if (mo < 0 || mo > 11) continue;
                        const v = Number(kg) || 0;
                        if (v <= 0) continue;
                        bucket[mo].sum += v;
                        bucket[mo].count++;
                    }
                    const averages = bucket.map(b => b.count ? Math.round(b.sum / b.count) : 0);
                    averages.forEach((avg, i) => {
                        const inp = body.querySelector('.fcst-avg-input[data-mo="' + i + '"]');
                        if (inp) inp.value = avg;
                    });
                    updateAvgSummary();
                    showToast('Averaged from history — click Save Averages to commit');
                } catch (err) {
                    showToast('Recompute failed: ' + err.message);
                } finally {
                    btn.disabled = false; btn.textContent = 'Recompute from history';
                }
            });

            // Live-update derived Good/Great cells + annual totals as the
            // user types in any Average cell.
            function updateAvgSummary() {
                let total = 0;
                MONTH_NAMES.forEach((_, i) => {
                    const inp = body.querySelector('.fcst-avg-input[data-mo="' + i + '"]');
                    const v   = parseFloat(inp?.value) || 0;
                    total += v;
                    const goodCell  = body.querySelector('td[data-derived="good"][data-mo="' + i + '"]');
                    const greatCell = body.querySelector('td[data-derived="great"][data-mo="' + i + '"]');
                    if (goodCell)  goodCell.textContent  = fmtFull(v * 1.1);
                    if (greatCell) greatCell.textContent = fmtFull(v * 1.2);
                });
                const elAvg   = document.getElementById('fcst-avg-total-avg');
                const elGood  = document.getElementById('fcst-avg-total-good');
                const elGreat = document.getElementById('fcst-avg-total-great');
                if (elAvg)   elAvg.textContent   = fmtFull(total);
                if (elGood)  elGood.textContent  = fmtFull(total * 1.1);
                if (elGreat) elGreat.textContent = fmtFull(total * 1.2);
            }
            body.querySelectorAll('.fcst-avg-input').forEach(inp => {
                inp.addEventListener('input', updateAvgSummary);
            });

            document.getElementById('imp-avg-save-btn')?.addEventListener('click', async () => {
                const monthlyAvg = MONTH_NAMES.map((_, i) => {
                    const inp = body.querySelector('.fcst-avg-input[data-mo="' + i + '"]');
                    return parseFloat(inp?.value) || 0;
                });
                const btn = document.getElementById('imp-avg-save-btn');
                btn.disabled = true; btn.textContent = 'Saving…';
                try {
                    await api('/api/import/forecast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ monthlyAvg }),
                    });
                    config.monthlyAvg = monthlyAvg;
                    showToast('Averages saved');
                    rebuild();
                } catch (err) {
                    showToast('Save failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Save';
                }
            });

            document.getElementById('imp-add-ship-btn')?.addEventListener('click', () => {
                const form = document.getElementById('imp-add-ship-form');
                const opening = form.style.display === 'none';
                form.style.display = opening ? '' : 'none';
                if (opening) {
                    // Default seq = next available, date = today.
                    const seqInp = document.getElementById('ship-seq');
                    if (seqInp && !seqInp.value) {
                        const existing = (config.shipments || []).map(s => Number(s.seq) || 0);
                        seqInp.value = Math.max(41, ...existing) + 1;
                    }
                    const dateInp = document.getElementById('ship-startdate');
                    if (dateInp && !dateInp.value) {
                        dateInp.value = new Date().toISOString().slice(0, 10);
                    }
                }
            });
            document.getElementById('ship-cancel-btn')?.addEventListener('click', () => {
                document.getElementById('imp-add-ship-form').style.display = 'none';
            });
            // Live preview: yield breakdown + estimated cost-per-yield-kg
            // (uses default V3 cost lines + current forex so the operator
            // sees a ballpark before committing the shipment).
            const refreshYieldPreview = () => {
                const preview = document.getElementById('ship-yield-preview');
                if (!preview) return;
                const whiteRawKg  = parseFloat(document.getElementById('ship-whitekg').value)  || 0;
                const colourRawKg = parseFloat(document.getElementById('ship-colourkg').value) || 0;
                const wastePct    = clampPct(document.getElementById('ship-wastepct').value, 10);
                if (!whiteRawKg && !colourRawKg) { preview.textContent = ''; return; }
                const totals = computeShipTotalsV3(
                    { whiteRawKg, colourRawKg, wastePct, fixedLines: defaultFixedLinesV3() },
                    forex
                );
                const d = totals.derived;
                const ppkg = totals.ppkgYield > 0 ? '$' + totals.ppkgYield.toFixed(2) : '—';
                preview.textContent =
                    `Net ${Math.round(d.netKg).toLocaleString('en-NZ')} kg ` +
                    `→ yield ${Math.round(d.yieldKg).toLocaleString('en-NZ')} kg ` +
                    `(white ${Math.round(d.whiteKg).toLocaleString('en-NZ')} / colour ${Math.round(d.colourKg).toLocaleString('en-NZ')}) ` +
                    `· est. ${ppkg} / yield kg`;
            };
            ['ship-whitekg', 'ship-colourkg', 'ship-wastepct'].forEach(id => {
                document.getElementById(id)?.addEventListener('input', refreshYieldPreview);
            });

            document.getElementById('ship-save-btn')?.addEventListener('click', async () => {
                const seq         = parseInt(document.getElementById('ship-seq').value, 10);
                const startDate   = document.getElementById('ship-startdate').value;
                const whiteRawKg  = parseFloat(document.getElementById('ship-whitekg').value)  || 0;
                const colourRawKg = parseFloat(document.getElementById('ship-colourkg').value) || 0;
                const wastePct    = clampPct(document.getElementById('ship-wastepct').value, 10);
                if (!Number.isFinite(seq) || seq < 1) { showToast('Please enter a shipment number'); return; }
                if (!startDate) { showToast('Please pick a start date'); return; }
                if (!whiteRawKg && !colourRawKg) { showToast('Enter white and/or coloured weight'); return; }
                if ((config.shipments || []).some(s => Number(s.seq) === seq)) {
                    showToast(`Shipment #${seq} already exists — pick another number`); return;
                }
                const btn = document.getElementById('ship-save-btn');
                btn.disabled = true; btn.textContent = 'Adding…';
                try {
                    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                    const stageDefaults = getStageDefaults(config);
                    const newShip = {
                        id, seq, schema: 3,
                        startDate,
                        ym: ymFromStartDate(startDate, stageDefaults),
                        whiteRawKg, colourRawKg, wastePct,
                        fixedLines: defaultFixedLinesV3(),
                        status:     'planning',
                        milestones: defaultMilestonesV3(startDate, stageDefaults),
                    };
                    const shipments = [...(config.shipments || []), newShip];
                    await api('/api/import/forecast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ shipments }),
                    });
                    config.shipments = shipments;
                    showToast(`Shipment #${seq} added`);
                    rebuild();
                } catch (err) {
                    showToast('Save failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Add Shipment';
                }
            });

        }

        rebuild();

        // Deep-link: another view (e.g. the dashboard calendar) stashed a
        // shipment id on the module before navigating. Open that shipment's
        // detail card now that the list has rendered. Consume once.
        if (Warehouse._pendingShipId) {
            const target = (config.shipments || []).find(s => s.id === Warehouse._pendingShipId);
            Warehouse._pendingShipId = null;
            if (target) renderShipDetail(target);
        }

        // ── Cost-line event delegation (delegated to avoid re-wiring on each rebuild) ──

        async function costSave() {
            try {
                await api('/api/import/forecast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shipments: config.shipments }),
                });
                if (currentDetailShipId) {
                    const updated = config.shipments.find(sh => sh.id === currentDetailShipId);
                    if (updated) renderShipDetail(updated);
                } else {
                    rebuild();
                }
            } catch (err) { showToast('Save failed: ' + err.message); }
        }

        async function quietSave() {
            try {
                await api('/api/import/forecast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shipments: config.shipments }),
                });
            } catch (err) { showToast('Save failed: ' + err.message); }
        }

        body.addEventListener('change', async e => {
            if (acSignal.aborted) return;

            // Section-level actual paid (Raw Product)
            if (e.target.matches('.ship-section-actual-inp')) {
                const { shipId, section } = e.target.dataset;
                const val = parseFloat(e.target.value) || null;
                config.shipments = (config.shipments || []).map(s => {
                    if (s.id !== shipId) return s;
                    return { ...s, sectionActuals: { ...(s.sectionActuals || {}), [section]: val } };
                });
                await costSave();
                return;
            }

            // ── Fixed-schema (rigid) cost line — amount/rate/ccy/paidVia/labelOverride ──
            const fixField = e.target.closest('.ship-fix-num, .ship-fix-ccy, .ship-fix-paidvia, .ship-fix-label-inp');
            if (fixField) {
                const row = fixField.closest('.ship-fix-row');
                if (!row) return;
                const f   = fixField.dataset.f;
                const val = fixField.type === 'number' ? (parseFloat(fixField.value) || 0) : fixField.value;
                if (row.dataset.extraId) {
                    const { shipId, extraId } = row.dataset;
                    config.shipments = (config.shipments || []).map(s => {
                        if (s.id !== shipId) return s;
                        return { ...s, extraLines: (s.extraLines || []).map(l =>
                            l.id !== extraId ? l : { ...l, [f]: val }
                        )};
                    });
                } else {
                    const { shipId, lineKey } = row.dataset;
                    config.shipments = (config.shipments || []).map(s => {
                        if (s.id !== shipId) return s;
                        const fixedLines = { ...(s.fixedLines || {}) };
                        fixedLines[lineKey] = { ...(fixedLines[lineKey] || {}), [f]: val };
                        return { ...s, fixedLines };
                    });
                }
                await costSave();
                return;
            }

            // Fixed-schema paid checkbox
            const fixPaid = e.target.closest('.ship-fix-paid');
            if (fixPaid) {
                const row = fixPaid.closest('.ship-fix-row');
                if (!row) return;
                if (row.dataset.extraId) {
                    const { shipId, extraId } = row.dataset;
                    config.shipments = (config.shipments || []).map(s => {
                        if (s.id !== shipId) return s;
                        return { ...s, extraLines: (s.extraLines || []).map(l =>
                            l.id !== extraId ? l : { ...l, paid: fixPaid.checked }
                        )};
                    });
                } else {
                    const { shipId, lineKey } = row.dataset;
                    config.shipments = (config.shipments || []).map(s => {
                        if (s.id !== shipId) return s;
                        const fixedLines = { ...(s.fixedLines || {}) };
                        fixedLines[lineKey] = { ...(fixedLines[lineKey] || {}), paid: fixPaid.checked };
                        return { ...s, fixedLines };
                    });
                }
                await costSave();
                return;
            }

            // V3 yield drivers (netKg / whitePct / wastePct) — re-render
            // because every per-kg line multiplier depends on these.
            if (e.target.matches('.ship-yield-input')) {
                const { shipId, field: f } = e.target.dataset;
                const raw = e.target.value;
                const val = raw === '' ? null : (Number.isFinite(parseFloat(raw)) ? parseFloat(raw) : null);
                config.shipments = (config.shipments || []).map(s => s.id === shipId ? { ...s, [f]: val } : s);
                await costSave();
                return;
            }

            // Raw Product white/colour kg split
            if (e.target.matches('.ship-raw-kg')) {
                const { shipId, field: f } = e.target.dataset;
                const val = parseFloat(e.target.value) || 0;
                config.shipments = (config.shipments || []).map(s => s.id === shipId ? { ...s, [f]: val } : s);
                await costSave();
                return;
            }

            // Cost line field
            const field = e.target.closest('.imp-cl-field');
            if (field) {
                const row = field.closest('.imp-cl-row');
                if (!row) return;
                const { shipId, lineId } = row.dataset;
                const f = field.dataset.f;
                const val = field.type === 'number' ? (parseFloat(field.value) || 0) : field.value;
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: (s.costLines || []).map(l =>
                        l.id === lineId ? { ...l, [f]: val } : l
                    )}
                );
                await costSave();
                return;
            }

            // Cost line paid checkbox
            const paidCb = e.target.closest('.imp-cl-paid');
            if (paidCb) {
                const { shipId, lineId } = paidCb.dataset;
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: (s.costLines || []).map(l =>
                        l.id === lineId ? { ...l, paid: paidCb.checked } : l
                    )}
                );
                await costSave();
                return;
            }

            // Milestone date input (per-stage editable date) — when a date
            // is set, cascade later steps forward by their default gaps.
            // Existing 'done' flags are preserved.
            if (e.target.matches('.ship-tl-date')) {
                const { shipId } = e.target.dataset;
                const idx = parseInt(e.target.dataset.idx);
                const date = e.target.value || '';
                const stageDefaults = getStageDefaults(config);
                config.shipments = (config.shipments || []).map(sh => {
                    if (sh.id !== shipId) return sh;
                    const ms = [...(sh.milestones || [])];
                    ms[idx] = { ...ms[idx], date };
                    if (date) {
                        let prev = date;
                        for (let i = idx + 1; i < ms.length; i++) {
                            const gap = Number(stageDefaults[i]?.gap) || 0;
                            const nextDate = addDaysIso(prev, gap);
                            ms[i] = { ...ms[i], date: nextDate };
                            prev = nextDate;
                        }
                    }
                    const patch = { ...sh, milestones: ms };
                    if (idx === 0 && date) patch.startDate = date;
                    // ym = the actual arrival milestone date (last one). Earlier
                    // logic computed it from startDate + default gaps, which
                    // ignored manual edits to the arrival or any intermediate
                    // stage — leaving the forecast pinned to the wrong month.
                    if (date) {
                        const arrival = ms[ms.length - 1]?.date;
                        patch.ym = arrival
                            ? arrival.slice(0, 7)
                            : ymFromStartDate(ms[0]?.date || sh.startDate || date, stageDefaults);
                    }
                    return patch;
                });
                await costSave();
                return;
            }

            // Stage-defaults gap edit — persist to config.stageDefaults
            if (e.target.matches('.ship-tl-cfg-gap')) {
                const i = parseInt(e.target.dataset.idx);
                const v = Math.max(0, Math.round(Number(e.target.value) || 0));
                e.target.value = v;
                const current = getStageDefaults(config).map(d => ({ label: d.label, gap: d.gap }));
                current[i] = { ...current[i], gap: v };
                config.stageDefaults = current;
                await quietSave();
                const saved = document.getElementById('ship-tl-cfg-saved');
                if (saved) {
                    saved.hidden = false;
                    clearTimeout(saved._t);
                    saved._t = setTimeout(() => { saved.hidden = true; }, 1200);
                }
                return;
            }

            // Milestone checkbox
            if (e.target.matches('.imp-milestone-check')) {
                const { shipId } = e.target.dataset;
                const idx   = parseInt(e.target.dataset.idx);
                const done  = e.target.checked;
                const today = new Date().toISOString().slice(0, 10);
                config.shipments = (config.shipments || []).map(s => {
                    if (s.id !== shipId) return s;
                    const milestones = (s.milestones || []).map((m, i) =>
                        i === idx ? { ...m, done, date: done && !m.date ? today : m.date } : m
                    );
                    return { ...s, milestones };
                });
                await costSave();
                // Re-render so the derived status badge + timeline reflect the
                // newly-completed stage. Skip if we've navigated away.
                const updated = config.shipments.find(s => s.id === shipId);
                if (updated && currentDetailShipId === shipId) renderShipDetail(updated);
                return;
            }

            // Shipment detail field or notes — quiet save (no re-render)
            if (e.target.matches('.imp-detail-input, .ship-notes-ta')) {
                const { shipId, field: f } = e.target.dataset;
                const val = e.target.type === 'number' ? (parseFloat(e.target.value) || null) : e.target.value.trim() || null;
                // V3 startDate drives the milestone offsets and ETA month —
                // re-derive both, but preserve any actuals the operator
                // already ticked off (only fill blank dates from the new
                // schedule).
                if (f === 'startDate' && val) {
                    const stageDefaults = getStageDefaults(config);
                    config.shipments = (config.shipments || []).map(s => {
                        if (s.id !== shipId || s.schema !== 3) {
                            return s.id === shipId ? { ...s, [f]: val } : s;
                        }
                        const fresh = defaultMilestonesV3(val, stageDefaults);
                        const merged = (s.milestones || []).map((m, i) => {
                            const f = fresh[i];
                            if (!f) return m;
                            // Preserve date only if milestone is marked done (confirmed actual).
                            // Undone milestones get the recalculated projected date.
                            return { ...m, date: m.done ? m.date : f.date };
                        });
                        const padded = merged.length < fresh.length
                            ? [...merged, ...fresh.slice(merged.length)]
                            : merged;
                        return { ...s, startDate: val, ym: ymFromStartDate(val, stageDefaults), milestones: padded };
                    });
                    await quietSave();
                    renderShipDetail(config.shipments.find(s => s.id === shipId));
                    return;
                }
                config.shipments = (config.shipments || []).map(s => s.id === shipId ? { ...s, [f]: val } : s);
                await quietSave();
                return;
            }

            // Status select — quiet save + update dot color
            if (e.target.matches('.ship-status-sel')) {
                const { shipId } = e.target.dataset;
                const status = e.target.value;
                const STATUS_COLORS = { planning:'#94a3b8', ordered:'#3b82f6', 'in-transit':'#f59e0b', customs:'#8b5cf6', delivered:'#10b981' };
                config.shipments = (config.shipments || []).map(s => s.id === shipId ? { ...s, status } : s);
                await quietSave();
                const dot = body.querySelector('.ship-status-dot');
                if (dot) dot.style.background = STATUS_COLORS[status] || '#94a3b8';
                return;
            }
        }, { signal: acSignal });

        body.addEventListener('click', async e => {
            if (acSignal.aborted) return;

            // Incoming cell in forecast table → jump to shipment detail
            const incomingLink = e.target.closest('.imp-incoming-link');
            if (incomingLink) {
                const s = config.shipments.find(sh => sh.id === incomingLink.dataset.shipId);
                if (s) { renderShipDetail(s); return; }
            }

            // Navigate into shipment detail
            const card = e.target.closest('.imp-event-card--nav');
            if (card && !e.target.closest('button, input, select, label, a')) {
                const s = config.shipments.find(sh => sh.id === card.dataset.shipId);
                if (s) { renderShipDetail(s); return; }
            }

            // Back to shipment list (overview)
            if (e.target.closest('.ship-detail-back')) {
                rebuild();
                return;
            }

            // Delete shipment (from detail view or list)
            const delShip = e.target.closest('.imp-ship-del');
            if (delShip) {
                const id = delShip.dataset.id;
                if (!confirm('Remove this shipment? This cannot be undone.')) return;
                config.shipments = (config.shipments || []).filter(s => s.id !== id);
                try {
                    await api('/api/import/forecast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ shipments: config.shipments }),
                    });
                    showToast('Shipment removed');
                    rebuild();
                } catch (err) { showToast('Remove failed: ' + err.message); }
                return;
            }

            // Quick-add cost line from shortcut button
            const qc = e.target.closest('.ship-quick-cost');
            if (qc) {
                const { shipId, cat, desc, ccy } = qc.dataset;
                const line = {
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                    cat, desc, amount: null, ccy, paidVia: '', paid: false,
                };
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: [...(s.costLines || []), line] }
                );
                await costSave();
                return;
            }

            // Stage track step → toggle done (mirror checkbox behaviour, click anywhere on step)
            const stageStep = e.target.closest('.ship-stage-step, .ship-tl-toggle');
            if (stageStep) {
                const { shipId } = stageStep.dataset;
                const idx = parseInt(stageStep.dataset.idx);
                const today = new Date().toISOString().slice(0, 10);
                config.shipments = (config.shipments || []).map(s => {
                    if (s.id !== shipId) return s;
                    const milestones = (s.milestones || []).map((m, i) =>
                        i === idx ? { ...m, done: !m.done, date: !m.done && !m.date ? today : m.date } : m
                    );
                    return { ...s, milestones };
                });
                await costSave();
                return;
            }

            // Stage defaults panel — open/close
            if (e.target.closest('.ship-tl-cfg-toggle')) {
                const panel = document.getElementById('ship-tl-cfg');
                if (panel) panel.hidden = !panel.hidden;
                return;
            }

            // Stage defaults — reset to factory defaults
            if (e.target.closest('#ship-tl-cfg-reset')) {
                delete config.stageDefaults;
                await quietSave();
                renderShipDetail(config.shipments.find(sh => sh.id === currentDetailShipId));
                return;
            }

            // Add cost — toggle / confirm / cancel
            if (e.target.closest('.ship-add-cost-toggle')) {
                const form = body.querySelector('.ship-add-cost-form');
                if (form) form.hidden = !form.hidden;
                return;
            }
            if (e.target.closest('.ship-add-cost-cancel')) {
                const form = body.querySelector('.ship-add-cost-form');
                if (form) form.hidden = true;
                return;
            }
            const confirmCost = e.target.closest('.ship-add-cost-confirm');
            if (confirmCost) {
                const form = body.querySelector('.ship-add-cost-form');
                const label = form.querySelector('.ship-add-cost-label').value.trim();
                if (!label) { showToast('Please enter a label'); return; }
                const section = form.querySelector('.ship-add-cost-section').value;
                const kindRaw = form.querySelector('.ship-add-cost-kind').value;
                const kind    = kindRaw === 'flat' ? 'flat' : 'perKg';
                const kgField = kindRaw === 'perKgYield' ? 'yieldKg' : 'netKg';
                const ccy     = form.querySelector('.ship-add-cost-ccy').value;
                const { shipId } = confirmCost.dataset;
                const newLine = {
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                    section, label, kind, kgField, ccy, paid: false, paidVia: '',
                    ...(kind === 'flat' ? { amount: null } : { rate: null }),
                };
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, extraLines: [...(s.extraLines || []), newLine] }
                );
                form.querySelector('.ship-add-cost-label').value = '';
                form.hidden = true;
                await costSave();
                return;
            }

            // Delete extra cost line
            const extraDel = e.target.closest('.ship-extra-del');
            if (extraDel) {
                const { shipId, extraId } = extraDel.dataset;
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, extraLines: (s.extraLines || []).filter(l => l.id !== extraId) }
                );
                await costSave();
                return;
            }

            // Add milestone
            const addMile = e.target.closest('.ship-add-milestone');
            if (addMile) {
                const { shipId } = addMile.dataset;
                const label = prompt('Milestone name (e.g. "Place order", "Customs clearance"):');
                if (!label?.trim()) return;
                config.shipments = (config.shipments || []).map(s => {
                    if (s.id !== shipId) return s;
                    return { ...s, milestones: [...(s.milestones || []), { label: label.trim(), done: false, date: '' }] };
                });
                await costSave();
                return;
            }

            // Cost line delete
            const del = e.target.closest('.imp-cl-del');
            if (del) {
                const { shipId, lineId } = del.dataset;
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: (s.costLines || []).filter(l => l.id !== lineId) }
                );
                await costSave();
                return;
            }
            const addLine = e.target.closest('.imp-cl-add-line');
            if (addLine) {
                const { shipId } = addLine.dataset;
                const cat = addLine.dataset.cat;
                const line = {
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                    cat, desc: '', amount: null, ccy: 'NZD', paidVia: '', paid: false,
                };
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: [...(s.costLines || []), line] }
                );
                await costSave();
                return;
            }
            const addCat = e.target.closest('.imp-cl-add-cat');
            if (addCat) {
                const { shipId } = addCat.dataset;
                const name = prompt('Category name:');
                if (!name?.trim()) return;
                const line = {
                    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                    cat: name.trim(), desc: '', amount: null, ccy: 'NZD', paidVia: '', paid: false,
                };
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: [...(s.costLines || []), line] }
                );
                await costSave();
            }
        }, { signal: acSignal });
    }

    // ── Public: render the same Stock Trajectory chart shown on the
    // Imports view (with the avg/good/great scenario toggle) into a
    // given dashboard container. Same data source, same logic, no
    // duplicated chart code.
    async function renderDashboardForecast(container) {
        if (!container) return;
        container.innerHTML = '<span class="db-mod-loading">Loading…</span>';

        let config = {};
        let actuals = {};
        try {
            const [configData, ordersData] = await Promise.all([
                fetch('/api/import/forecast').then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch('/api/orders').then(r => r.ok ? r.json() : []).catch(() => []),
            ]);
            config = configData || {};
            for (const o of (ordersData || [])) {
                const ym = (o.createdAt || '').slice(0, 7);
                if (!ym || ym < HUB_LIVE_YM) continue;
                const kg = (o.lines || []).reduce((s, l) => s + lineKg(l), 0);
                if (kg > 0) actuals[ym] = (actuals[ym] || 0) + kg;
            }
        } catch (e) { /* render with whatever we got */ }

        let scenario = 'great';
        const rebuild = () => {
            const rows = computeForecast(config, 18, actuals);
            const scenarioBtns = ['avg', 'good', 'great'].map(s =>
                `<button class="imp-scenario-btn ${scenario === s ? 'active' : ''}" data-s="${s}">${{ avg: 'Average', good: 'Good +10%', great: 'Great +20%' }[s]}</button>`
            ).join('');
            container.innerHTML = `
                <div class="db-fcst-toolbar"><div class="imp-scenario-wrap">${scenarioBtns}</div></div>
                <div class="db-fcst-chart-wrap">${buildForecastChart(rows, scenario, config.shipments)}</div>`;
            initCharts(container);
            container.querySelectorAll('.imp-scenario-btn').forEach(btn => {
                btn.addEventListener('click', () => { scenario = btn.dataset.s; rebuild(); });
            });
        };
        rebuild();
    }

    return { render, renderImports, prefetchImports, renderDashboardForecast };
})();
