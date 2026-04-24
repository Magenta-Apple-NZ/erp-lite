// ── Warehouse module ──
// Handles #warehouse view — Stocktake tab

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
        <div class="wh-tabs">
            <button class="wh-tab active" data-tab="stocktake">Stocktake</button>
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

    return { render };
})();
