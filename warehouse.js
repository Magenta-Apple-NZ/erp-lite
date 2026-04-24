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

    function computeForecast(config, months = 18, actuals = {}) {
        const monthlyAvg = config.monthlyAvg || new Array(12).fill(0);
        const shipments  = config.shipments  || [];
        const starting   = config.startingKg ?? 0;

        const now = new Date();
        let yr = now.getFullYear(), mo = now.getMonth();

        const rows = [];
        let runAvg = starting, runGood = starting, runGreat = starting;

        for (let i = 0; i < months; i++) {
            const ym = `${yr}-${String(mo + 1).padStart(2, '0')}`;
            const incoming = shipments
                .filter(s => s.ym === ym)
                .reduce((sum, s) => sum + (Number(s.kg) || 0), 0);

            const actualSales = actuals[ym] ?? null;
            const avgSales   = actualSales !== null ? actualSales : (Number(monthlyAvg[mo]) || 0);
            const goodSales  = actualSales !== null ? actualSales : avgSales * 1.1;
            const greatSales = actualSales !== null ? actualSales : avgSales * 1.2;

            const openAvg = runAvg, openGood = runGood, openGreat = runGreat;
            runAvg   = openAvg   - avgSales   + incoming;
            runGood  = openGood  - goodSales  + incoming;
            runGreat = openGreat - greatSales + incoming;

            rows.push({
                ym, yr, mo,
                label: `${MONTH_NAMES[mo]} '${String(yr).slice(-2)}`,
                incoming, actualSales, avgSales, goodSales, greatSales,
                openAvg, openGood, openGreat,
                closeAvg: runAvg, closeGood: runGood, closeGreat: runGreat,
            });

            mo++;
            if (mo === 12) { mo = 0; yr++; }
        }
        return rows;
    }

    function buildForecastChart(rows, scenario) {
        const SERIES = {
            avg:   { close: 'closeAvg',   color: '#3b82f6', dash: '',    label: 'Average' },
            good:  { close: 'closeGood',  color: '#10b981', dash: '5 3', label: 'Good'    },
            great: { close: 'closeGreat', color: '#8b5cf6', dash: '5 3', label: 'Great'   },
        };

        const W = 700, H = 205;
        const pad = { l: 52, r: 12, t: 18, b: 50 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;

        const allValues = rows.flatMap(r => [r.closeAvg, r.closeGood, r.closeGreat]);
        const maxV = Math.max(...allValues, 1);
        const minV = Math.min(...allValues, 0);
        const range = maxV - minV || 1;

        function xOf(i) { return pad.l + (i / Math.max(rows.length - 1, 1)) * chartW; }
        function yOf(v) { return pad.t + chartH - ((v - minV) / range) * chartH; }

        const zeroY = yOf(0);
        const zeroLine = minV < 0
            ? `<line x1="${pad.l}" y1="${zeroY.toFixed(1)}" x2="${W - pad.r}" y2="${zeroY.toFixed(1)}" stroke="#ef4444" stroke-width="2" opacity="0.9"/>`
            : '';

        // Bold red fill below zero for selected series
        const selClose = SERIES[scenario].close;
        let negFill = '';
        if (minV < 0) {
            const polyPts = [
                `${xOf(0).toFixed(1)},${zeroY.toFixed(1)}`,
                ...rows.map((r, i) => `${xOf(i).toFixed(1)},${yOf(Math.min(r[selClose], 0)).toFixed(1)}`),
                `${xOf(rows.length - 1).toFixed(1)},${zeroY.toFixed(1)}`,
            ].join(' ');
            negFill = `<polygon points="${polyPts}" fill="#ef4444" opacity="0.18"/>`;
        }

        // Container arrival lines
        const importLines = rows.map((r, i) => {
            if (!r.incoming) return '';
            const x = xOf(i).toFixed(1);
            return `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + chartH}" stroke="#64748b" stroke-width="1" stroke-dasharray="4 3" opacity="0.3"/>
                    <text x="${x}" y="${pad.t - 4}" text-anchor="middle" font-size="8" fill="#64748b">+${fmtFull(r.incoming)}</text>`;
        }).join('');

        // Draw dimmed series first, highlighted last (on top)
        const drawOrder = Object.keys(SERIES).filter(s => s !== scenario).concat(scenario);
        const seriesLines = drawOrder.map(s => {
            const { close, color, dash } = SERIES[s];
            const sel = s === scenario;
            const pts = rows.map((r, i) => `${xOf(i).toFixed(1)},${yOf(r[close]).toFixed(1)}`).join(' ');
            return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${sel ? 2.5 : 1.5}" stroke-dasharray="${dash}" stroke-linejoin="round" stroke-linecap="round" opacity="${sel ? 1 : 0.2}"/>`;
        }).join('');

        const dots = rows.map((r, i) => {
            if (!r.incoming) return '';
            return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(r[selClose]).toFixed(1)}" r="4" fill="${SERIES[scenario].color}" stroke="white" stroke-width="1.5"/>`;
        }).join('');

        const xLabels = rows.map((r, i) => {
            if (i % 3 !== 0) return '';
            return `<text x="${xOf(i).toFixed(1)}" y="${pad.t + chartH + 14}" text-anchor="middle" font-size="8.5" fill="#64748b">${escHtml(r.label)}</text>`;
        }).join('');

        const yLabels = [0, 0.25, 0.5, 0.75, 1].map(f => {
            const val = minV + f * range;
            const y = (pad.t + chartH - f * chartH).toFixed(1);
            return `<text x="${pad.l - 4}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#94a3b8">${fmtKg(val)}</text>
                    <line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`;
        }).join('');

        const legendY = H - 14;
        const legend = Object.entries(SERIES).map(([s, { label, color, dash }], i) => {
            const sel = s === scenario;
            const x = pad.l + i * 100;
            return `<line x1="${x}" y1="${legendY}" x2="${x + 20}" y2="${legendY}" stroke="${color}" stroke-width="${sel ? 2.5 : 1.5}" stroke-dasharray="${dash}" opacity="${sel ? 1 : 0.35}"/>
                    <text x="${x + 24}" y="${legendY + 4}" font-size="8.5" fill="${sel ? '#1e293b' : '#94a3b8'}" font-weight="${sel ? 600 : 400}">${label}</text>`;
        }).join('');

        return `
        <svg viewBox="0 0 ${W} ${H}" class="imp-chart" xmlns="http://www.w3.org/2000/svg">
            ${yLabels}${zeroLine}${negFill}${importLines}${seriesLines}${dots}${xLabels}${legend}
        </svg>`;
    }


    // ── Render the Imports view ──
    let importsAC = null; // AbortController for cost-line event delegation

    async function renderImports() {
        if (importsAC) importsAC.abort();
        importsAC = new AbortController();
        const acSignal = importsAC.signal;

        const body = document.getElementById('wh-body');
        body.innerHTML = '<div class="orders-loading">Loading…</div>';

        let config = {};
        try { config = (await api('/api/import/forecast')) || {}; } catch (e) { /* ok */ }

        let actuals = {};
        try {
            const orders = await api('/api/orders');
            for (const o of (orders || [])) {
                const ym = (o.createdAt || '').slice(0, 7);
                if (!ym) continue;
                const kg = (o.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
                if (kg > 0) actuals[ym] = (actuals[ym] || 0) + kg;
            }
        } catch (e) { /* orders unavailable */ }

        let forex = {};
        const fxToday = new Date().toISOString().slice(0, 10);
        try {
            const cached = localStorage.getItem('imp-fx-' + fxToday);
            if (cached) {
                forex = JSON.parse(cached);
            } else {
                const res = await fetch('https://api.frankfurter.dev/v1/latest?base=NZD&symbols=USD,EUR,CNY,AUD');
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

        let scenario  = 'avg';
        let shipView  = 'cards';
        let activeTab = 'overview';

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

            const fxBar = ['USD','EUR','CNY','AUD'].filter(c => forex[c])
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

        function rebuild() {
            const openShipIds = new Set(
                [...body.querySelectorAll('details[open][data-ship-id]')].map(d => d.dataset.shipId)
            );

            const rows     = computeForecast(config, 18, actuals);
            const closeKey = { avg: 'closeAvg', good: 'closeGood', great: 'closeGreat' }[scenario];
            const openKey  = { avg: 'openAvg',  good: 'openGood',  great: 'openGreat'  }[scenario];
            const salesKey = { avg: 'avgSales', good: 'goodSales', great: 'greatSales' }[scenario];

            const FX_LABELS = { USD: 'US Dollar', EUR: 'Euro', CNY: 'Chinese Yuan', AUD: 'Aus Dollar' };
            const fxSparkline = code => {
                if (!fxHistory?.rates) return '';
                try {
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
                    ${['USD', 'EUR', 'CNY', 'AUD'].filter(c => forex[c]).map(c =>
                        '<div class="imp-fx-tile">' +
                        '<div class="imp-fx-tile-code">' + c + '</div>' +
                        '<div class="imp-fx-tile-rate">' + forex[c].toFixed(4) + '</div>' +
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
                return `
                <tr class="imp-row ${r.incoming ? 'imp-has-import' : ''} ${!hasActual && status !== 'ok' ? 'imp-row--' + status : ''}">
                    <td class="imp-td-month">${escHtml(r.label)}</td>
                    <td class="imp-td-num ${hasActual ? 'imp-actual-val' : ''}">${hasActual ? fmtFull(r.actualSales) : '—'}</td>
                    <td class="imp-td-num">${fmtFull(sales)}</td>
                    <td class="imp-td-num">${fmtFull(r[openKey])}</td>
                    <td class="imp-td-num imp-incoming ${r.incoming ? 'imp-incoming-val' : ''}">${r.incoming ? '+' + fmtFull(r.incoming) : '—'}</td>
                    <td class="imp-td-num ${closing < 0 ? 'fcst-negative' : ''}">${fmtFull(closing)}</td>
                    <td style="text-align:center;padding:0 0.5rem">${dot}</td>
                </tr>`;
            }).join('');

            const allShips      = (config.shipments || []).slice().sort((a, b) => a.ym.localeCompare(b.ym));
            const todayYm       = new Date().toISOString().slice(0, 7);
            const upcomingShips = allShips.filter(s => s.ym >= todayYm);
            const pastShips     = allShips.filter(s => s.ym < todayYm);

            const shipCard = (s, past) => {
                const milestones = s.milestones || [];
                const doneCount  = milestones.filter(m => m.done).length;
                const mHtml = milestones.length ? `
                <div class="imp-milestones">
                    ${milestones.map((m, i) => `
                    <label class="imp-milestone${m.done ? ' imp-milestone--done' : ''}">
                        <input type="checkbox" class="imp-milestone-check"
                            data-ship-id="${escHtml(s.id)}" data-idx="${i}" ${m.done ? 'checked' : ''}>
                        <span class="imp-milestone-label">${escHtml(m.label)}</span>
                        ${m.date ? `<span class="imp-milestone-date">${escHtml(m.date)}</span>` : ''}
                    </label>`).join('')}
                </div>` : '';
                return `
                <details class="imp-event-card ${past ? 'imp-event-card--past' : ''}" data-ship-id="${escHtml(s.id)}">
                    <summary class="imp-event-card-summary">
                        <div>
                            <div class="imp-event-month">${ymLabel(s.ym)}</div>
                            <div class="imp-event-qty">${fmtFull(s.kg)} kg</div>
                            ${s.campaign || s.note ? `<div class="imp-event-note">${escHtml(s.campaign || s.note)}</div>` : ''}
                        </div>
                        <div class="imp-card-badges">
                            ${milestones.length ? `<span class="imp-milestone-progress">${doneCount}/${milestones.length}</span>` : ''}
                            ${s.pricePerKg ? `<span class="imp-price-badge">$${s.pricePerKg}/kg</span>` : ''}
                        </div>
                    </summary>
                    <div class="imp-event-card-detail">
                        ${mHtml}
                        <div class="imp-pricing-grid">
                            <div class="imp-pricing-field">
                                <label class="imp-field-label">Campaign / Ref</label>
                                <input type="text" class="imp-detail-input imp-url-input"
                                    data-ship-id="${escHtml(s.id)}" data-field="campaign"
                                    value="${escHtml(s.campaign || '')}" placeholder="e.g. Batch 41">
                            </div>
                            <div class="imp-pricing-field">
                                <label class="imp-field-label">Price / kg</label>
                                <input type="number" class="imp-detail-input imp-url-input"
                                    data-ship-id="${escHtml(s.id)}" data-field="pricePerKg"
                                    value="${s.pricePerKg || ''}" placeholder="e.g. 4.50" step="0.01" min="0">
                            </div>
                        </div>
                        ${buildCostHtml(s)}
                        ${!past ? `<button class="imp-ship-del" data-id="${escHtml(s.id)}">Remove shipment</button>` : ''}
                    </div>
                </details>`;
            };

            body.innerHTML = `
            <div class="imp-tabs">
                <button class="imp-view-btn ${activeTab === 'overview' ? 'active' : ''}" id="imp-tab-overview">Overview</button>
                <button class="imp-view-btn ${activeTab === 'shipments' ? 'active' : ''}" id="imp-tab-shipments">Shipments${allShips.length ? ` (${allShips.length})` : ''}</button>
            </div>

            <div id="imp-overview-panel"${activeTab !== 'overview' ? ' style="display:none"' : ''}>
                <div class="imp-overview-grid">
                <div class="imp-overview-main">
                <div class="cat-section imp-chart-card">
                    <div class="cat-section-head">
                        <div>
                            <h2 class="cat-title">Stock Trajectory &middot; Prime Ties <span class="fcst-version">v${config.version || 1}</span></h2>
                            <p class="cat-sub">Starting stock: <strong>${fmtFull(config.startingKg ?? 0)}</strong>
                                <button class="btn-link" id="imp-edit-stock-btn">Edit</button></p>
                        </div>
                        <div class="cat-actions">
                            <div class="imp-scenario-wrap">${scenarioBtns}</div>
                        </div>
                    </div>
                    <div id="imp-stock-edit" style="display:none;margin-bottom:1rem">
                        <div class="imp-connect-row">
                            <label style="font-size:0.8125rem;color:#64748b;white-space:nowrap">Current stock (kg):</label>
                            <input type="number" id="imp-stock-kg" class="imp-url-input" style="max-width:140px"
                                value="${config.startingKg ?? ''}" placeholder="e.g. 5000" min="0" step="any">
                            <button class="btn-primary btn-sm" id="imp-stock-save-btn">Save</button>
                            <button class="btn-secondary btn-sm" id="imp-stock-cancel-btn">Cancel</button>
                        </div>
                    </div>
                    <div id="imp-chart-wrap">${buildForecastChart(rows, scenario)}</div>
                </div>

                <div class="cat-section imp-table-card" style="padding-bottom:0">
                    <h2 class="cat-title" style="margin-bottom:0.75rem">Monthly Forecast</h2>
                    <div class="imp-table-wrap">
                        <table class="imp-table">
                            <thead>
                                <tr>
                                    <th class="imp-th-month">Month</th>
                                    <th class="imp-th-num">Actual</th>
                                    <th class="imp-th-num">Est. Sales</th>
                                    <th class="imp-th-num">Opening</th>
                                    <th class="imp-th-num imp-th-incoming">Incoming</th>
                                    <th class="imp-th-num">Closing</th>
                                    <th style="width:32px"></th>
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
                    <p class="cat-sub" style="margin-bottom:1rem">Average kg sold each month &mdash; the baseline for all three scenarios.</p>
                    <div class="fcst-avg-grid">
                        ${MONTH_NAMES.map((m, i) => `
                        <div class="fcst-avg-cell">
                            <label class="fcst-avg-label">${m}</label>
                            <input type="number" class="fcst-avg-input imp-url-input" data-mo="${i}"
                                value="${(config.monthlyAvg || [])[i] || ''}" placeholder="0" min="0" step="any">
                            <span class="fcst-avg-unit">kg</span>
                        </div>`).join('')}
                    </div>
                    <div style="margin-top:1rem">
                        <button class="btn-primary btn-sm" id="imp-avg-save-btn">Save Averages</button>
                    </div>
                </details>
                </div>
                ${fxPanelHtml ? `<div class="imp-overview-side">${fxPanelHtml}</div>` : ''}
                </div>
            </div>

            <div id="imp-shipments-panel"${activeTab !== 'shipments' ? ' style="display:none"' : ''}>
                <div class="cat-section">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;gap:0.75rem">
                        <h3 class="stk-section-title" style="margin:0">Upcoming Shipments</h3>
                        <div style="display:flex;gap:0.35rem;align-items:center">
                            <button class="imp-view-btn ${shipView === 'cards' ? 'active' : ''}" id="imp-view-cards">Cards</button>
                            <button class="imp-view-btn ${shipView === 'matrix' ? 'active' : ''}" id="imp-view-matrix">Matrix</button>
                            <button class="btn-primary btn-sm" id="imp-add-ship-btn">+ Add</button>
                        </div>
                    </div>
                    <div id="imp-add-ship-form" style="display:none;margin-bottom:1rem;padding:0.75rem;background:#f8fafc;border-radius:6px;border:1px solid #e2e8f0">
                        <div class="imp-add-form-grid">
                            <div>
                                <label class="imp-field-label">Arrival month</label>
                                <input type="month" id="ship-ym" class="imp-url-input">
                            </div>
                            <div>
                                <label class="imp-field-label">Volume (kg)</label>
                                <input type="number" id="ship-kg" class="imp-url-input" placeholder="e.g. 8000" min="0" step="any">
                            </div>
                            <div>
                                <label class="imp-field-label">Campaign / Ref</label>
                                <input type="text" id="ship-campaign" class="imp-url-input" placeholder="e.g. Batch 41">
                            </div>
                            <div>
                                <label class="imp-field-label">Price / kg <span style="font-weight:400;color:#94a3b8">(optional)</span></label>
                                <input type="number" id="ship-price" class="imp-url-input" placeholder="e.g. 4.50" step="0.01" min="0">
                            </div>
                            <div style="grid-column:1/-1">
                                <label class="imp-field-label">Note <span style="font-weight:400;color:#94a3b8">(optional)</span></label>
                                <input type="text" id="ship-note" class="imp-url-input" placeholder="e.g. Container 1">
                            </div>
                        </div>
                        <div style="display:flex;gap:0.4rem;margin-top:0.5rem">
                            <button class="btn-primary btn-sm" id="ship-save-btn">Add Shipment</button>
                            <button class="btn-secondary btn-sm" id="ship-cancel-btn">Cancel</button>
                        </div>
                    </div>
                    ${shipView === 'matrix' ? (() => {
                        const allLabels = [...new Set(upcomingShips.flatMap(s => (s.milestones || []).map(m => m.label)))];
                        const cols = upcomingShips.map(s => `<th>${escHtml(s.campaign || s.note || ymLabel(s.ym))}<br><small style="font-weight:400;color:#64748b">${ymLabel(s.ym)}</small></th>`).join('');
                        const rows2 = allLabels.map(lbl => {
                            const cells = upcomingShips.map(s => {
                                const m = (s.milestones || []).find(m => m.label === lbl);
                                return `<td>${m?.done ? escHtml(m.date || '✓') : '<span style="color:#cbd5e1">—</span>'}</td>`;
                            }).join('');
                            return `<tr><td class="imp-matrix-stage">${escHtml(lbl)}</td>${cells}</tr>`;
                        }).join('');
                        const arriveRow = upcomingShips.map(s => `<td style="font-weight:600;color:#1e40af">${ymLabel(s.ym)}</td>`).join('');
                        return `<div class="imp-matrix-wrap">
                            <table class="imp-matrix-table">
                                <thead><tr><th>Milestone</th>${cols}</tr></thead>
                                <tbody>
                                    ${rows2}
                                    <tr class="imp-matrix-row--arrive"><td class="imp-matrix-stage">Arrival</td>${arriveRow}</tr>
                                </tbody>
                            </table>
                        </div>`;
                    })() : `<div class="imp-events-grid">
                        ${upcomingShips.length
                            ? upcomingShips.map(s => shipCard(s, false)).join('')
                            : '<p class="wh-empty" style="margin:0">No upcoming shipments.</p>'}
                    </div>`}
                </div>
                ${pastShips.length ? `
                <div class="cat-section">
                    <h3 class="stk-section-title">Past Shipments</h3>
                    <div class="imp-events-grid imp-events-grid--past">
                        ${pastShips.map(s => shipCard(s, true)).join('')}
                    </div>
                </div>` : ''}
            </div>`;

            // Restore open shipment cards after rebuild
            openShipIds.forEach(id => {
                body.querySelector(`details[data-ship-id="${id}"]`)?.setAttribute('open', '');
            });

            // ── Tab switching ──
            document.getElementById('imp-tab-overview')?.addEventListener('click', () => { activeTab = 'overview'; rebuild(); });
            document.getElementById('imp-tab-shipments')?.addEventListener('click', () => { activeTab = 'shipments'; rebuild(); });

            body.querySelectorAll('.imp-scenario-btn').forEach(btn => {
                btn.addEventListener('click', () => { scenario = btn.dataset.s; rebuild(); });
            });

            document.getElementById('imp-view-cards')?.addEventListener('click', () => { shipView = 'cards'; rebuild(); });
            document.getElementById('imp-view-matrix')?.addEventListener('click', () => { shipView = 'matrix'; rebuild(); });

            document.getElementById('imp-edit-stock-btn')?.addEventListener('click', () => {
                document.getElementById('imp-stock-edit').style.display = '';
                document.getElementById('imp-stock-kg').focus();
            });
            document.getElementById('imp-stock-cancel-btn')?.addEventListener('click', () => {
                document.getElementById('imp-stock-edit').style.display = 'none';
            });
            document.getElementById('imp-stock-save-btn')?.addEventListener('click', async () => {
                const kg = parseFloat(document.getElementById('imp-stock-kg').value) || 0;
                const btn = document.getElementById('imp-stock-save-btn');
                btn.disabled = true; btn.textContent = 'Saving…';
                try {
                    await api('/api/import/forecast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ startingKg: kg }),
                    });
                    config.startingKg = kg;
                    showToast('Stock updated');
                    rebuild();
                } catch (err) {
                    showToast('Save failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Save';
                }
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
                form.style.display = form.style.display === 'none' ? '' : 'none';
            });
            document.getElementById('ship-cancel-btn')?.addEventListener('click', () => {
                document.getElementById('imp-add-ship-form').style.display = 'none';
            });
            document.getElementById('ship-save-btn')?.addEventListener('click', async () => {
                const ym         = document.getElementById('ship-ym').value;
                const kg         = parseFloat(document.getElementById('ship-kg').value) || 0;
                const note       = document.getElementById('ship-note').value.trim();
                const campaign   = document.getElementById('ship-campaign').value.trim();
                const pricePerKg = parseFloat(document.getElementById('ship-price').value) || null;
                if (!ym) { showToast('Please select an arrival month'); return; }
                if (!kg) { showToast('Please enter a volume in kg'); return; }
                const btn = document.getElementById('ship-save-btn');
                btn.disabled = true; btn.textContent = 'Adding…';
                try {
                    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                    const shipments = [...(config.shipments || []), { id, ym, kg, note, campaign, pricePerKg }];
                    await api('/api/import/forecast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ shipments }),
                    });
                    config.shipments = shipments;
                    showToast('Shipment added');
                    rebuild();
                } catch (err) {
                    showToast('Save failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Add Shipment';
                }
            });

            body.querySelectorAll('.imp-ship-del').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.dataset.id;
                    if (!confirm('Remove this shipment?')) return;
                    const shipments = (config.shipments || []).filter(s => s.id !== id);
                    try {
                        await api('/api/import/forecast', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ shipments }),
                        });
                        config.shipments = shipments;
                        showToast('Shipment removed');
                        rebuild();
                    } catch (err) {
                        showToast('Remove failed: ' + err.message);
                    }
                });
            });

            body.querySelectorAll('.imp-milestone-check').forEach(cb => {
                cb.addEventListener('change', async () => {
                    const shipId = cb.dataset.shipId;
                    const idx    = parseInt(cb.dataset.idx);
                    const done   = cb.checked;
                    const today  = new Date().toISOString().slice(0, 10);
                    const shipments = (config.shipments || []).map(s => {
                        if (s.id !== shipId) return s;
                        const milestones = (s.milestones || []).map((m, i) =>
                            i === idx ? { ...m, done, date: done && !m.date ? today : m.date } : m
                        );
                        return { ...s, milestones };
                    });
                    try {
                        await api('/api/import/forecast', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ shipments }),
                        });
                        config.shipments = shipments;
                        const lbl = cb.closest('.imp-milestone');
                        if (lbl) {
                            lbl.classList.toggle('imp-milestone--done', done);
                            if (done) {
                                let ds = lbl.querySelector('.imp-milestone-date');
                                if (!ds) {
                                    ds = document.createElement('span');
                                    ds.className = 'imp-milestone-date';
                                    lbl.appendChild(ds);
                                }
                                ds.textContent = today;
                            }
                        }
                    } catch (err) {
                        showToast('Save failed: ' + err.message);
                        cb.checked = !done;
                    }
                });
            });

            // Auto-save shipment detail fields on change
            body.querySelectorAll('.imp-detail-input').forEach(inp => {
                inp.addEventListener('change', async () => {
                    const shipId = inp.dataset.shipId;
                    const field  = inp.dataset.field;
                    const val    = inp.type === 'number' ? (parseFloat(inp.value) || null) : inp.value.trim() || null;
                    const shipments = (config.shipments || []).map(s =>
                        s.id === shipId ? { ...s, [field]: val } : s
                    );
                    try {
                        await api('/api/import/forecast', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ shipments }),
                        });
                        config.shipments = shipments;
                    } catch (err) {
                        showToast('Save failed: ' + err.message);
                    }
                });
            });

        }

        rebuild();

        // ── Cost-line event delegation (delegated to avoid re-wiring on each rebuild) ──

        async function costSave() {
            try {
                await api('/api/import/forecast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shipments: config.shipments }),
                });
                rebuild();
            } catch (err) { showToast('Save failed: ' + err.message); }
        }

        body.addEventListener('change', async e => {
            if (acSignal.aborted) return;
            const field = e.target.closest('.imp-cl-field');
            if (field) {
                const row = field.closest('.imp-cl-row');
                if (!row) return;
                const { shipId, lineId } = row.dataset;
                const f = field.dataset.f;
                const val = field.type === 'number' ? (parseFloat(field.value) || 0)
                          : field.value;
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: (s.costLines || []).map(l =>
                        l.id === lineId ? { ...l, [f]: val } : l
                    )}
                );
                await costSave();
                return;
            }
            const cb = e.target.closest('.imp-cl-paid');
            if (cb) {
                const { shipId, lineId } = cb.dataset;
                config.shipments = (config.shipments || []).map(s =>
                    s.id !== shipId ? s : { ...s, costLines: (s.costLines || []).map(l =>
                        l.id === lineId ? { ...l, paid: cb.checked } : l
                    )}
                );
                await costSave();
            }
        }, { signal: acSignal });

        body.addEventListener('click', async e => {
            if (acSignal.aborted) return;
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

    return { render, renderImports };
})();
