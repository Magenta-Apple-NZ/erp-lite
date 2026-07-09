// Payslips — three-tab view combining:
//   Dispatch   : dispatch log with bulk payslip-label assignment
//   Tally      : quick daily entry form (boxes + hours + expenses)
//   Payslip    : period summary table
//
// Warehouse role sees only the Dispatch tab.
// Admin sees all three.
const Payslips = (() => {

    const DISPATCHERS = ['Jake', 'Andrew'];

    // ── Shared helpers ──

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function apiFetch(path, opts) {
        const r = await fetch(path, opts);
        if (!r.ok) {
            const body = await r.json().catch(() => ({ error: r.statusText }));
            throw new Error(body.error || r.statusText);
        }
        return r.json();
    }

    function fmtDate(iso) {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    function fmtDay(iso) {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'long' });
    }
    function fmtMoney(n) {
        return '$' + Number(n || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function fmtShortDate(iso) {
        const [, m, d] = iso.split('-').map(Number);
        return `${d}-${MONTHS[m - 1]}`;
    }

    // ── Dispatch tab ──

    function lineKg(l) {
        if (l?.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) return Number(l.kgPerUnit) * (Number(l.quantity) || 0);
        const text = `${l?.description || ''} ${l?.name || ''} ${l?.sku || ''}`;
        const m = text.match(/\b(10|1)\s*kg\b/i);
        return (m ? Number(m[1]) : 0) * (Number(l?.quantity) || 0);
    }
    function orderBoxes(o) { return (o.lines || []).reduce((s, l) => s + lineKg(l), 0) / 10; }
    function fmtBoxes(b) { return !b ? '' : Number.isInteger(b) ? String(b) : b.toFixed(1); }

    async function patchOrder(id, body) {
        const r = await fetch('/api/orders/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
    }

    function defaultPayslipLabel() {
        const d = new Date();
        return d.toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' });
    }

    function groupByPayslip(rows) {
        const groups = [];
        let current = null;
        for (const r of rows) {
            const lbl = r.payslipLabel || null;
            if (!current || current.label !== lbl) {
                current = { label: lbl, rows: [], boxes: 0 };
                groups.push(current);
            }
            current.rows.push(r);
            current.boxes += r.boxes;
        }
        return groups;
    }

    async function renderDispatchPane(el) {
        el.innerHTML = '<div class="orders-loading">Loading…</div>';

        let orders, me;
        try {
            [orders, me] = await Promise.all([apiFetch('/api/orders'), apiFetch('/api/me')]);
        } catch (e) {
            el.innerHTML = `<div class="orders-error">Could not load: ${escHtml(e.message)}</div>`;
            return;
        }

        const isWarehouse = me?.role === 'warehouse';
        const myName = me?.name || 'Jake';

        let dispatched = orders.filter(o => o.status === 'dispatched');
        if (isWarehouse) dispatched = dispatched.filter(o => (o.dispatchedBy || 'Jake') === myName);

        if (!dispatched.length) {
            el.innerHTML = `<p class="wh-empty">No orders have been dispatched yet.</p>`;
            return;
        }

        const tabs = isWarehouse ? [myName] : DISPATCHERS;
        const byPerson = Object.fromEntries(tabs.map(t => [t, []]));
        for (const o of dispatched) {
            const by = o.dispatchedBy || 'Jake';
            if (!byPerson[by]) continue;
            const ts = o.dispatchedAt || o.updatedAt || '';
            byPerson[by].push({ ts, day: ts.slice(0, 10), branch: o.shipTo?.branch || o.customer?.name || '—', id: o.id, boxes: orderBoxes(o), payslipLabel: o.payslipLabel || null });
        }
        for (const t of tabs) byPerson[t].sort((a, b) => b.ts.localeCompare(a.ts));

        const renderPane = (person) => {
            const rows = byPerson[person];
            if (!rows.length) return `<p class="wh-empty">No dispatches by ${escHtml(person)} yet.</p>`;
            const groups = groupByPayslip(rows);
            const totalBoxes = rows.reduce((s, r) => s + r.boxes, 0);

            const tbody = groups.map(g => {
                const headLbl = g.label
                    ? `<span class="dl-payslip-label">${escHtml(g.label)}</span>`
                    : `<span class="dl-payslip-label dl-payslip-label--open">Unassigned</span>`;
                const subhdr = `<tr class="dl-group-header">
                    ${isWarehouse ? '' : '<td></td>'}
                    <td colspan="4">${headLbl} · ${g.rows.length} order${g.rows.length === 1 ? '' : 's'}</td>
                    <td class="dl-num dl-group-subtotal">${fmtBoxes(g.boxes)} boxes</td>
                </tr>`;
                const rowsHtml = g.rows.map(r => `
                <tr class="dl-row" data-order-id="${escHtml(r.id)}">
                    ${isWarehouse ? '' : `<td class="dl-check-cell"><input type="checkbox" class="dl-chk" data-order-id="${escHtml(r.id)}" data-boxes="${r.boxes}"></td>`}
                    <td>${escHtml(fmtDate(r.day))}</td>
                    <td>${escHtml(fmtDay(r.day))}</td>
                    <td>${escHtml(r.branch)}</td>
                    <td><a href="#orders/${escHtml(r.id)}" class="dl-order-link">${escHtml(r.id)}</a></td>
                    <td class="dl-num">${fmtBoxes(r.boxes)}</td>
                </tr>`).join('');
                return subhdr + rowsHtml;
            }).join('');

            return `
            <table class="cat-table dl-table">
                <thead><tr>
                    ${isWarehouse ? '' : `<th class="dl-check-cell"><input type="checkbox" class="dl-chk-all" title="Select all visible"></th>`}
                    <th>Date</th><th>Day</th><th>Branch</th><th>Order #</th><th class="dl-num">Boxes</th>
                </tr></thead>
                <tbody>${tbody}</tbody>
                <tfoot><tr>
                    ${isWarehouse ? '' : '<td></td>'}
                    <td colspan="4">Total · ${rows.length} order${rows.length === 1 ? '' : 's'}</td>
                    <td class="dl-num dl-total">${fmtBoxes(totalBoxes)}</td>
                </tr></tfoot>
            </table>`;
        };

        const showTabs = tabs.length > 1;
        const tabBar = showTabs
            ? `<div class="dl-tabs">${tabs.map((t, i) =>
                `<button class="imp-view-btn dl-tab${i === 0 ? ' active' : ''}" data-person="${escHtml(t)}">${escHtml(t)} <span class="dl-tab-count">${byPerson[t].length}</span></button>`
              ).join('')}</div>`
            : '';
        const bulkBar = isWarehouse ? '' : `
        <div class="dl-bulk-bar" id="dl-bulk-bar" hidden>
            <span class="dl-bulk-count" id="dl-bulk-count"></span>
            <div class="dl-bulk-actions">
                <input type="text" class="dl-bulk-label-input" id="dl-bulk-label" placeholder="Payslip period…" value="${escHtml(defaultPayslipLabel())}">
                <button class="btn-primary btn-sm" id="dl-bulk-assign">Assign to payslip</button>
                <button class="btn-secondary btn-sm" id="dl-bulk-clear">Clear selection</button>
            </div>
        </div>`;
        const panes = tabs.map((t, i) =>
            `<div class="dl-pane${i === 0 ? ' active' : ''}" data-person-pane="${escHtml(t)}">${renderPane(t)}</div>`
        ).join('');

        el.innerHTML = `<div class="cat-section">${bulkBar}${tabBar}${panes}</div>`;

        if (showTabs) {
            el.querySelectorAll('.dl-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.person;
                    el.querySelectorAll('.dl-tab').forEach(b => b.classList.toggle('active', b === btn));
                    el.querySelectorAll('.dl-pane').forEach(p => p.classList.toggle('active', p.dataset.personPane === target));
                    el.querySelectorAll('.dl-chk').forEach(c => { c.checked = false; c.closest('tr')?.classList.remove('dl-row--checked'); });
                    el.querySelectorAll('.dl-chk-all').forEach(c => c.checked = false);
                    updateBulkBar();
                });
            });
        }

        if (isWarehouse) return;

        function getActivePane() { return el.querySelector('.dl-pane.active'); }

        function updateBulkBar() {
            const checked = el.querySelectorAll('.dl-pane.active .dl-chk:checked');
            const bar = document.getElementById('dl-bulk-bar');
            if (!bar) return;
            if (!checked.length) { bar.hidden = true; return; }
            bar.hidden = false;
            const totalBoxes = [...checked].reduce((s, c) => s + (parseFloat(c.dataset.boxes) || 0), 0);
            document.getElementById('dl-bulk-count').textContent = `${checked.length} order${checked.length === 1 ? '' : 's'} · ${fmtBoxes(totalBoxes)} boxes selected`;
        }

        el.addEventListener('change', e => {
            const chk = e.target.closest('.dl-chk');
            if (!chk || chk.classList.contains('dl-chk-all')) return;
            chk.closest('tr')?.classList.toggle('dl-row--checked', chk.checked);
            const pane = getActivePane();
            const allChk = pane?.querySelector('.dl-chk-all');
            if (allChk) allChk.checked = [...(pane?.querySelectorAll('.dl-chk') || [])].every(c => c.checked);
            updateBulkBar();
        });
        el.addEventListener('change', e => {
            const allChk = e.target.closest('.dl-chk-all');
            if (!allChk) return;
            getActivePane()?.querySelectorAll('.dl-chk').forEach(c => {
                c.checked = allChk.checked;
                c.closest('tr')?.classList.toggle('dl-row--checked', allChk.checked);
            });
            updateBulkBar();
        });

        document.getElementById('dl-bulk-clear')?.addEventListener('click', () => {
            el.querySelectorAll('.dl-chk').forEach(c => { c.checked = false; c.closest('tr')?.classList.remove('dl-row--checked'); });
            el.querySelectorAll('.dl-chk-all').forEach(c => c.checked = false);
            updateBulkBar();
        });

        document.getElementById('dl-bulk-assign')?.addEventListener('click', async () => {
            const checked = [...el.querySelectorAll('.dl-pane.active .dl-chk:checked')];
            if (!checked.length) return;
            const label = document.getElementById('dl-bulk-label')?.value.trim() || null;
            const ids = checked.map(c => c.dataset.orderId);
            const btn = document.getElementById('dl-bulk-assign');
            btn.disabled = true; btn.textContent = 'Saving…';
            try {
                await Promise.all(ids.map(id => patchOrder(id, { payslipLabel: label || null })));
                await renderDispatchPane(el);
            } catch (err) {
                alert('Assign failed: ' + err.message);
                btn.disabled = false; btn.textContent = 'Assign to payslip';
            }
        });
    }

    // ── Tally entry tab ──

    async function renderTallyPane(el) {
        el.innerHTML = '<div class="orders-loading">Loading…</div>';

        let config = { employees: [] };
        try { config = await apiFetch('/api/payroll/config'); } catch {}
        const employees = (config.employees || []).filter(e => !e.archived);

        if (!employees.length) {
            el.innerHTML = '<p class="cat-sub" style="padding:1rem">No employees configured — set them up in Admin → Payroll.</p>';
            return;
        }

        const now = new Date();
        const todayIso = now.toISOString().slice(0, 10);

        el.innerHTML = `
        <div class="ps-tally-wrap">
            <div class="ps-tally-form">
                <h3 class="bulk-table-title">New entry</h3>
                <div class="ps-tally-fields">
                    <label>Date<input type="date" id="t-date" value="${todayIso}"></label>
                    <label>Employee
                        <select id="t-employee">
                            ${employees.map(e => `<option value="${escHtml(e.id)}" data-name="${escHtml(e.name)}">${escHtml(e.name)}</option>`).join('')}
                        </select>
                    </label>
                    <label># 10kg boxes<input type="number" id="t-10kg" min="0" step="1" placeholder="0"></label>
                    <label># 10×1kg bags<input type="number" id="t-1kg" min="0" step="1" placeholder="0"></label>
                    <label>Hours<input type="number" id="t-hours" min="0" step="0.5" placeholder="0"></label>
                    <label>Expenses ($)<input type="number" id="t-expenses" min="0" step="0.50" placeholder="0.00"></label>
                </div>
                <div class="ps-tally-actions">
                    <button class="btn-primary btn-sm" id="t-add-btn">Add entry</button>
                    <span class="tally-save-status" id="t-status"></span>
                </div>
            </div>
            <div id="t-recent-wrap">
                <h3 class="bulk-table-title" style="margin-top:1.5rem">Recent entries</h3>
                <div id="t-recent"><div class="orders-loading">Loading…</div></div>
            </div>
        </div>`;

        await loadRecentEntries(employees);

        document.getElementById('t-add-btn').addEventListener('click', async () => {
            const date      = document.getElementById('t-date').value;
            const empSelect = document.getElementById('t-employee');
            const empName   = empSelect.options[empSelect.selectedIndex]?.dataset.name || '';
            const boxes10kg = Number(document.getElementById('t-10kg').value)     || 0;
            const boxes1kg  = Number(document.getElementById('t-1kg').value)      || 0;
            const hours     = Number(document.getElementById('t-hours').value)    || 0;
            const expenses  = Number(document.getElementById('t-expenses').value) || 0;

            if (!date || !empName) { document.getElementById('t-status').textContent = 'Pick a date and employee.'; return; }

            const btn = document.getElementById('t-add-btn');
            const status = document.getElementById('t-status');
            btn.disabled = true; btn.textContent = 'Saving…'; status.textContent = '';

            try {
                const saves = [];
                if (boxes10kg || boxes1kg) {
                    saves.push(fetch('/api/payroll/packing-log', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entries: [{ date, employee: empName, boxes10kg, boxes1kg }] }),
                    }).then(r => { if (!r.ok) throw new Error('Packing log failed'); }));
                }
                if (hours || expenses) {
                    saves.push(fetch('/api/payroll/timesheets', {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ entries: [{ date, employee: empName, hours, expenses }] }),
                    }).then(r => { if (!r.ok) throw new Error('Timesheets failed'); }));
                }
                await Promise.all(saves);
                status.textContent = 'Saved ✓';
                // Clear form values (keep date + employee)
                ['t-10kg','t-1kg','t-hours','t-expenses'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
                await loadRecentEntries(employees);
            } catch (err) {
                status.textContent = 'Error: ' + err.message;
            } finally {
                btn.disabled = false; btn.textContent = 'Add entry';
            }
        });

        async function loadRecentEntries(emps) {
            const recentEl = document.getElementById('t-recent');
            if (!recentEl) return;
            try {
                const [packLog, tsLog] = await Promise.all([
                    apiFetch('/api/payroll/packing-log'),
                    apiFetch('/api/payroll/timesheets'),
                ]);
                // Merge by date+employee into a unified row set
                const byKey = new Map();
                for (const p of packLog) {
                    const k = `${p.date}::${p.employee}`;
                    byKey.set(k, { date: p.date, employee: p.employee, boxes10kg: p.boxes10kg || 0, boxes1kg: p.boxes1kg || 0, hours: 0, expenses: 0 });
                }
                for (const t of tsLog) {
                    const k = `${t.date}::${t.employee}`;
                    const prev = byKey.get(k) || { date: t.date, employee: t.employee, boxes10kg: 0, boxes1kg: 0, hours: 0, expenses: 0 };
                    byKey.set(k, { ...prev, hours: (prev.hours || 0) + (Number(t.hours) || 0), expenses: (prev.expenses || 0) + (Number(t.expenses) || 0) });
                }
                const rows = [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
                if (!rows.length) { recentEl.innerHTML = '<p class="cat-sub">No entries yet.</p>'; return; }
                const fmtN = n => n ? (Number.isInteger(n) ? String(n) : Number(n).toFixed(1)) : '—';
                recentEl.innerHTML = `
                <table class="cat-table">
                    <thead><tr>
                        <th>Date</th><th>Employee</th>
                        <th class="bulk-num">10kg</th><th class="bulk-num">1×1kg</th>
                        <th class="bulk-num">Hours</th><th class="bulk-num">Expenses</th>
                    </tr></thead>
                    <tbody>
                        ${rows.map(r => `<tr>
                            <td>${escHtml(fmtShortDate(r.date))}</td>
                            <td>${escHtml(r.employee)}</td>
                            <td class="bulk-num">${fmtN(r.boxes10kg)}</td>
                            <td class="bulk-num">${fmtN(r.boxes1kg)}</td>
                            <td class="bulk-num">${fmtN(r.hours)}</td>
                            <td class="bulk-num">${r.expenses ? fmtMoney(r.expenses) : '—'}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>`;
            } catch (err) {
                recentEl.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`;
            }
        }
    }

    // ── Payslip summary tab ──

    async function renderPayslipPane(el) {
        el.innerHTML = '<div class="orders-loading">Loading…</div>';

        let config = { employees: [] };
        try { config = await apiFetch('/api/payroll/config'); } catch {}
        const employees = (config.employees || []).filter(e => !e.archived);

        if (!employees.length) {
            el.innerHTML = '<p class="cat-sub" style="padding:1rem">No employees configured — set them up in Admin → Payroll.</p>';
            return;
        }

        const now = new Date();
        const yr = now.getFullYear(), mo = now.getMonth() + 1;
        const monthStart = `${yr}-${String(mo).padStart(2, '0')}-01`;
        const monthEnd   = `${yr}-${String(mo).padStart(2, '0')}-${String(new Date(yr, mo, 0).getDate()).padStart(2, '0')}`;

        el.innerHTML = `
        <div class="ps-payslip-wrap">
            <div class="payroll-period-bar">
                <label>Employee
                    <select id="ps-employee">
                        ${employees.map(e => `<option value="${escHtml(e.id)}">${escHtml(e.name)}</option>`).join('')}
                    </select>
                </label>
                <label>From <input type="date" id="ps-start" value="${monthStart}"></label>
                <label>To <input type="date" id="ps-end" value="${monthEnd}"></label>
                <button class="btn-primary btn-sm" id="ps-gen-btn">Generate</button>
            </div>
            <div id="ps-result"></div>
        </div>`;

        document.getElementById('ps-gen-btn').addEventListener('click', async () => {
            const empId = document.getElementById('ps-employee').value;
            const start = document.getElementById('ps-start').value;
            const end   = document.getElementById('ps-end').value;
            if (!empId || !start || !end) return;
            const resultEl = document.getElementById('ps-result');
            resultEl.innerHTML = '<p class="bulk-loading">Computing…</p>';
            try {
                const slip = await apiFetch(`/api/payroll/payslip?employee=${encodeURIComponent(empId)}&start=${start}&end=${end}`);
                const fmtQty = n => n == null ? '—' : (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
                resultEl.innerHTML = `
                <div class="payslip">
                    <div class="payslip-hd">
                        <div>
                            <h3 class="payslip-title">Payslip — ${escHtml(slip.employee.name)}</h3>
                            <p class="payslip-meta">${escHtml(slip.period.start)} → ${escHtml(slip.period.end)}</p>
                        </div>
                    </div>
                    <table class="payslip-table">
                        <thead><tr><th>Component</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
                        <tbody>
                            ${slip.lines.map(l => `<tr>
                                <td>${escHtml(l.label)}${l.note ? ` <span class="payslip-note">${escHtml(l.note)}</span>` : ''}</td>
                                <td class="bulk-num">${fmtQty(l.qty)}</td>
                                <td class="bulk-num">${l.rate != null ? fmtMoney(l.rate) : '—'}</td>
                                <td class="bulk-num">${fmtMoney(l.amount)}</td>
                            </tr>`).join('')}
                        </tbody>
                        <tfoot>
                            <tr><td colspan="3" class="payslip-total-label">Total</td><td class="bulk-num payslip-total">${fmtMoney(slip.total)}</td></tr>
                        </tfoot>
                    </table>
                </div>`;
            } catch (err) {
                resultEl.innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`;
            }
        });
    }

    // ── Main render ──

    async function render(container) {
        let me;
        try { me = await apiFetch('/api/me'); } catch {}
        const isWarehouse = me?.role === 'warehouse';

        const adminTabs = isWarehouse ? '' : `
            <button class="imp-view-btn ps-tab" data-tab="tally">Tally entry</button>
            <button class="imp-view-btn ps-tab" data-tab="payslip">Payslip</button>`;

        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Payslips</h1>
                <p class="view-subtitle">Dispatch log, daily tally, and payslip summary.</p>
            </div>
        </div>
        <div class="ps-tab-bar">
            <button class="imp-view-btn ps-tab active" data-tab="dispatch">Dispatch log</button>
            ${adminTabs}
        </div>
        <div id="ps-pane-dispatch" class="ps-pane active"></div>
        ${isWarehouse ? '' : `
        <div id="ps-pane-tally"   class="ps-pane" hidden></div>
        <div id="ps-pane-payslip" class="ps-pane" hidden></div>`}`;

        // Load dispatch tab immediately
        await renderDispatchPane(document.getElementById('ps-pane-dispatch'));

        if (isWarehouse) return;

        // Lazy-load other tabs on first visit
        const loaded = { dispatch: true, tally: false, payslip: false };
        container.querySelectorAll('.ps-tab').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tab = btn.dataset.tab;
                container.querySelectorAll('.ps-tab').forEach(b => b.classList.toggle('active', b === btn));
                container.querySelectorAll('.ps-pane').forEach(p => {
                    const match = p.id === `ps-pane-${tab}`;
                    p.classList.toggle('active', match);
                    p.hidden = !match;
                });
                if (loaded[tab]) return;
                loaded[tab] = true;
                if (tab === 'tally')   await renderTallyPane(document.getElementById('ps-pane-tally'));
                if (tab === 'payslip') await renderPayslipPane(document.getElementById('ps-pane-payslip'));
            });
        });
    }

    return { render };
})();
