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
    let activeTab = 'stocktake';

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Warehouse</h1>
                <p class="view-subtitle">Track stock on hand and value over time.</p>
            </div>
        </div>
        <div class="wh-tabs">
            <button class="wh-tab ${activeTab === 'stocktake' ? 'active' : ''}" data-tab="stocktake">Stocktake</button>
            <button class="wh-tab ${activeTab === 'imports' ? 'active' : ''}" data-tab="imports">Imports</button>
        </div>
        <div id="wh-body"><div class="orders-loading">Loading…</div></div>`;

        container.querySelectorAll('.wh-tab').forEach(btn => {
            btn.addEventListener('click', async () => {
                container.querySelectorAll('.wh-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeTab = btn.dataset.tab;
                if (activeTab === 'stocktake') await renderStocktake();
                else if (activeTab === 'imports') await renderImports();
            });
        });

        if (activeTab === 'stocktake') await renderStocktake();
        else await renderImports();
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
    //  IMPORTS TAB
    // ══════════════════════════════════════════

    // Account code labels (matches stocktake CSV [codes])
    const ACCT_LABELS = {
        39: 'Prime Tie (packed)',
        40: 'Processed Product',
        41: 'In-process (NZ)',
        42: 'Shipment 4',
        43: 'Shipment 5',
    };

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const MONTH_IDX = Object.fromEntries(MONTH_NAMES.map((m,i) => [m, i]));

    // ── CSV parser for the Import Schedule format ──
    // Row 0: prepared date + group labels
    // Row 1: column headers
    // Rows 2+: data (Calendar Year and Financial Year are forward-filled)
    function parseImportCsv(text) {
        const raw = text.replace(/^﻿/, '').split(/\r?\n/);
        const lines = raw.map(l => l.trim()).filter((_, i) => i < raw.length);

        // Row 0: get prepared date
        const dateMatch = lines[0]?.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        let preparedDate = '';
        if (dateMatch) {
            const [, d, m, y] = dateMatch;
            const yr = y.length === 2 ? '20' + y : y;
            preparedDate = `${yr}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
        }

        // Find header row (contains "Calendar Year" or "Month")
        let headerIdx = 1;
        for (let i = 0; i < Math.min(4, lines.length); i++) {
            if (lines[i].toLowerCase().includes('calendar year') || lines[i].toLowerCase().includes('financial year')) {
                headerIdx = i;
                break;
            }
        }

        // Parse account codes from header row (last few cols are numeric codes)
        const headerCols = splitCsvLine(lines[headerIdx]);
        const accountCodes = headerCols.slice(12).map(h => parseInt(h)).filter(n => !isNaN(n) && n > 0);

        // Build rows with forward-fill
        let lastCalYear = '', lastFY = '';
        const rows = [];

        for (let i = headerIdx + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            const cols = splitCsvLine(line);

            // Skip if no month
            const month = cols[2]?.trim();
            if (!month || !MONTH_NAMES.includes(month)) continue;

            if (cols[0]?.trim()) lastCalYear = cols[0].trim();
            if (cols[1]?.trim()) lastFY = cols[1].trim();

            const actuals     = parseNum(cols[3]);
            const salesAvg    = parseNum(cols[4]);
            const salesGood   = parseNum(cols[5]);
            const salesGreat  = parseNum(cols[6]);
            const stockAvg    = parseNum(cols[7]);
            const stockGood   = parseNum(cols[8]);
            const stockGreat  = parseNum(cols[9]);
            const stocktake   = parseNum(cols[11]);
            const incomingTotal = parseNum(cols[12]);

            // Account code breakdown (cols 13+)
            const incoming = {};
            accountCodes.forEach((code, idx) => {
                const val = parseNum(cols[13 + idx]);
                if (val) incoming[code] = val;
            });

            // Determine if this is a start-of-FY marker
            const fyStart = (cols[10]?.trim().toLowerCase() === 'stock');

            rows.push({
                calendarYear: lastCalYear,
                financialYear: lastFY,
                month,
                fyStart,
                actuals,
                salesAvg, salesGood, salesGreat,
                stockAvg, stockGood, stockGreat,
                stocktake,
                incomingTotal,
                incoming,
            });
        }

        return { preparedDate, accountCodes, rows };
    }

    // ── Stock trajectory SVG line chart ──
    function buildImportChart(rows, scenario = 'avg') {
        const stockKey = { avg: 'stockAvg', good: 'stockGood', great: 'stockGreat' };
        const now = new Date();
        const nowKey = `${now.getFullYear()}-${MONTH_NAMES[now.getMonth()]}`;

        // Only rows with actual stock data
        const validRows = rows.filter(r => r[stockKey[scenario]] > 0 || r.incomingTotal > 0);
        if (!validRows.length) return '';

        const W = 700, H = 200;
        const pad = { l: 52, r: 12, t: 14, b: 38 };
        const chartW = W - pad.l - pad.r;
        const chartH = H - pad.t - pad.b;

        const vals = validRows.map(r => r[stockKey[scenario]]).filter(v => v > 0);
        const maxV = Math.max(...vals, 1);

        function xOf(i) { return pad.l + (i / Math.max(validRows.length - 1, 1)) * chartW; }
        function yOf(v) { return pad.t + chartH - (v / maxV) * chartH; }

        // Import event vertical lines
        const importLines = validRows.map((r, i) => {
            if (!r.incomingTotal) return '';
            const x = xOf(i).toFixed(1);
            return `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + chartH}" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.5"/>
                    <text x="${x}" y="${(pad.t - 3)}" text-anchor="middle" font-size="8" fill="#3b82f6" font-weight="600">${fmtK(r.incomingTotal)}</text>`;
        }).join('');

        // Line path
        const pts = validRows.map((r, i) => {
            const v = r[stockKey[scenario]];
            return v > 0 ? `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}` : null;
        }).filter(Boolean);
        const linePath = pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round"/>` : '';

        // Dots on import months
        const dots = validRows.map((r, i) => {
            if (!r.incomingTotal) return '';
            const v = r[stockKey[scenario]];
            if (!v) return '';
            return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4" fill="#3b82f6" stroke="white" stroke-width="1.5"/>`;
        }).join('');

        // Stocktake dots
        const stkDots = validRows.map((r, i) => {
            if (!r.stocktake) return '';
            return `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(r.stocktake).toFixed(1)}" r="3.5" fill="#059669" stroke="white" stroke-width="1.5">
                <title>Stocktake: ${fmtK(r.stocktake)} — ${r.month} ${r.calendarYear}</title>
            </circle>`;
        }).join('');

        // X axis labels — show every 3rd row
        const xLabels = validRows.map((r, i) => {
            if (i % 3 !== 0) return '';
            const label = `${r.month}'${String(r.calendarYear).slice(-2)}`;
            const rowKey = `${r.calendarYear}-${r.month}`;
            const isPast = rowKey < nowKey;
            return `<text x="${xOf(i).toFixed(1)}" y="${(pad.t + chartH + 13)}" text-anchor="middle" font-size="8.5" fill="${isPast ? '#cbd5e1' : '#64748b'}">${escHtml(label)}</text>`;
        }).join('');

        // Y axis labels
        const ySteps = [0, 0.25, 0.5, 0.75, 1];
        const yLabels = ySteps.map(f => {
            const val = maxV * f;
            const y = (pad.t + chartH - f * chartH).toFixed(1);
            return `<text x="${pad.l - 5}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" font-size="8.5" fill="#94a3b8">${fmtK(val)}</text>
                    <line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="#f1f5f9" stroke-width="1"/>`;
        }).join('');

        // "Now" vertical line
        const nowIdx = validRows.findIndex(r => `${r.calendarYear}-${r.month}` >= nowKey);
        const nowLine = nowIdx >= 0 ? `<line x1="${xOf(nowIdx).toFixed(1)}" y1="${pad.t}" x2="${xOf(nowIdx).toFixed(1)}" y2="${pad.t + chartH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
            <text x="${xOf(nowIdx).toFixed(1)}" y="${pad.t + chartH + 26}" text-anchor="middle" font-size="8" fill="#94a3b8">Today</text>` : '';

        return `
        <svg viewBox="0 0 ${W} ${H}" class="imp-chart" xmlns="http://www.w3.org/2000/svg">
            ${yLabels}${importLines}${linePath}${dots}${stkDots}${xLabels}${nowLine}
            <text x="${pad.l}" y="${H - 2}" font-size="8" fill="#94a3b8">● Incoming stock &nbsp; ● Stocktake</text>
        </svg>`;
    }

    function fmtK(n) {
        if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
        return String(Math.round(n));
    }

    // ── Render the Imports tab ──
    async function renderImports() {
        const body = document.getElementById('wh-body');
        body.innerHTML = '<div class="orders-loading">Loading…</div>';

        let schedule = null;
        try { schedule = await api('/api/import'); } catch (e) { /* ok */ }

        let scenario = 'avg';

        function rebuildImports(sched) {
            if (!sched?.rows?.length) {
                body.innerHTML = `
                <div class="cat-section" style="max-width:600px">
                    <div class="cat-section-head">
                        <div><h2 class="cat-title">Import Schedule</h2>
                             <p class="cat-sub">Upload the import schedule CSV to track incoming stock.</p></div>
                        <div class="cat-actions">
                            <label class="btn-primary btn-sm cat-upload-lbl">
                                Import CSV <input type="file" id="imp-csv-file" accept=".csv" style="display:none">
                            </label>
                        </div>
                    </div>
                    <p class="wh-empty">No schedule uploaded yet.</p>
                </div>`;
                wireImportUpload();
                return;
            }

            const { preparedDate, accountCodes, rows } = sched;
            const now = new Date();
            const nowKey = `${now.getFullYear()}-${MONTH_NAMES[now.getMonth()]}`;

            // Find upcoming imports
            const upcomingImports = rows.filter(r =>
                r.incomingTotal > 0 && `${r.calendarYear}-${r.month}` >= nowKey
            );
            const pastImports = rows.filter(r =>
                r.incomingTotal > 0 && `${r.calendarYear}-${r.month}` < nowKey
            );

            // Scenario toggle labels
            const scenarioBtns = ['avg','good','great'].map(s =>
                `<button class="imp-scenario-btn ${scenario === s ? 'active' : ''}" data-s="${s}">${s.charAt(0).toUpperCase() + s.slice(1)}</button>`
            ).join('');

            // Upcoming import event cards
            const upcomingCards = upcomingImports.length
                ? upcomingImports.map(r => {
                    const acctEntries = Object.entries(r.incoming).map(([code, qty]) =>
                        `<span class="imp-acct-tag" title="${escHtml(ACCT_LABELS[code] || 'Acct ' + code)}">[${code}] ${fmtK(qty)}</span>`
                    ).join('');
                    return `
                    <div class="imp-event-card">
                        <div class="imp-event-month">${r.month} ${r.calendarYear}</div>
                        <div class="imp-event-qty">${fmtK(r.incomingTotal)} <span>units</span></div>
                        ${acctEntries}
                        ${r.financialYear ? `<div class="imp-event-fy">${escHtml(r.financialYear)}</div>` : ''}
                    </div>`;
                }).join('')
                : '<p class="wh-empty" style="margin:0">No upcoming imports in schedule.</p>';

            // Full schedule table — show rows around today (6 months back + all future)
            const tableRows = rows.map(r => {
                const rowKey = `${r.calendarYear}-${r.month}`;
                const isPast = rowKey < nowKey;
                const isToday = rowKey === nowKey;
                const hasImport = r.incomingTotal > 0;
                const stockVal = { avg: r.stockAvg, good: r.stockGood, great: r.stockGreat }[scenario];
                const stocktakeCell = r.stocktake
                    ? `<td class="imp-td-num imp-stocktake" title="Actual stocktake">${fmtK(r.stocktake)}</td>`
                    : `<td class="imp-td-num"></td>`;
                const acctCells = accountCodes.map(code =>
                    r.incoming[code] ? `<td class="imp-td-num imp-acct-val">${fmtK(r.incoming[code])}</td>`
                                     : `<td class="imp-td-num"></td>`
                ).join('');

                return `
                <tr class="imp-row ${isPast ? 'imp-past' : ''} ${isToday ? 'imp-today' : ''} ${hasImport ? 'imp-has-import' : ''}">
                    <td class="imp-td-period">${r.financialYear ? `<span class="imp-fy-badge">${escHtml(r.financialYear)}</span>` : ''}</td>
                    <td class="imp-td-month">${r.month} ${r.calendarYear || ''}</td>
                    <td class="imp-td-num">${r.actuals ? fmtK(r.actuals) : (isPast ? '—' : '')}</td>
                    <td class="imp-td-num">${r.salesAvg ? fmtK({ avg: r.salesAvg, good: r.salesGood, great: r.salesGreat }[scenario]) : ''}</td>
                    <td class="imp-td-num imp-stock">${stockVal ? fmtK(stockVal) : ''}</td>
                    ${stocktakeCell}
                    <td class="imp-td-num imp-incoming ${hasImport ? 'imp-incoming-val' : ''}">${hasImport ? fmtK(r.incomingTotal) : ''}</td>
                    ${acctCells}
                </tr>`;
            }).join('');

            const acctHeaders = accountCodes.map(c =>
                `<th class="imp-th-num" title="${escHtml(ACCT_LABELS[c] || '')}">[${c}]</th>`
            ).join('');

            body.innerHTML = `
            <div class="imp-layout">
                <div class="imp-main">
                    <div class="cat-section imp-chart-card">
                        <div class="cat-section-head">
                            <div>
                                <h2 class="cat-title">Stock Trajectory</h2>
                                <p class="cat-sub">Prepared ${preparedDate ? fmtDate(preparedDate) : '—'} · Scenario: <span id="imp-scenario-label">Average</span></p>
                            </div>
                            <div class="cat-actions">
                                <div class="imp-scenario-wrap">${scenarioBtns}</div>
                                <label class="btn-secondary btn-sm cat-upload-lbl" title="Replace schedule">
                                    Replace CSV <input type="file" id="imp-csv-file" accept=".csv" style="display:none">
                                </label>
                            </div>
                        </div>
                        <div id="imp-chart-wrap">${buildImportChart(rows, scenario)}</div>
                    </div>

                    <div class="cat-section imp-table-card" style="padding-bottom:0">
                        <h2 class="cat-title" style="margin-bottom:0.75rem">Monthly Schedule</h2>
                        <div class="imp-table-wrap">
                            <table class="imp-table">
                                <thead>
                                    <tr>
                                        <th style="width:50px"></th>
                                        <th class="imp-th-month">Month</th>
                                        <th class="imp-th-num">Actuals</th>
                                        <th class="imp-th-num">Est. Sales</th>
                                        <th class="imp-th-num">Stock</th>
                                        <th class="imp-th-num">Stocktake</th>
                                        <th class="imp-th-num imp-th-incoming">Incoming</th>
                                        ${acctHeaders}
                                    </tr>
                                </thead>
                                <tbody>${tableRows}</tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <div class="imp-sidebar">
                    <div class="cat-section">
                        <h3 class="stk-section-title">Upcoming Imports</h3>
                        <div class="imp-events">${upcomingCards}</div>
                    </div>
                    ${pastImports.length ? `
                    <div class="cat-section">
                        <h3 class="stk-section-title">Past Imports</h3>
                        <div class="imp-events imp-events--past">
                            ${pastImports.map(r => `
                            <div class="imp-event-card imp-event-card--past">
                                <div class="imp-event-month">${r.month} ${r.calendarYear}</div>
                                <div class="imp-event-qty">${fmtK(r.incomingTotal)} <span>units</span></div>
                                ${Object.entries(r.incoming).map(([c,q]) => `<span class="imp-acct-tag">[${c}] ${fmtK(q)}</span>`).join('')}
                            </div>`).join('')}
                        </div>
                    </div>` : ''}
                </div>
            </div>`;

            // Scenario buttons
            body.querySelectorAll('.imp-scenario-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    scenario = btn.dataset.s;
                    body.querySelectorAll('.imp-scenario-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    document.getElementById('imp-scenario-label').textContent = btn.textContent;
                    document.getElementById('imp-chart-wrap').innerHTML = buildImportChart(rows, scenario);
                    // Re-render table rows with new scenario
                    const labels = { avg: 'Average', good: 'Good', great: 'Great' };
                    document.getElementById('imp-scenario-label').textContent = labels[scenario];
                    rebuildImports(sched); // full re-render to update table
                });
            });

            wireImportUpload();
        }

        function wireImportUpload() {
            document.getElementById('imp-csv-file')?.addEventListener('change', async e => {
                const file = e.target.files[0];
                if (!file) return;
                e.target.value = '';
                try {
                    const parsed = parseImportCsv(await file.text());
                    if (!parsed.rows.length) { showToast('No rows found — check CSV format'); return; }
                    await api('/api/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(parsed),
                    });
                    schedule = parsed;
                    showToast(`Imported ${parsed.rows.length} months`);
                    rebuildImports(schedule);
                } catch (err) {
                    showToast('Import failed: ' + err.message);
                }
            });
        }

        rebuildImports(schedule);
    }

    return { render };
})();
