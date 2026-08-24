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
    function thisMonthYm() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

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

    // The pay month an order belongs to: a manual reassignment (payslipMonth =
    // 'YYYY-MM') wins; otherwise the month it was dispatched. Mirrors the server.
    function orderPayMonth(o) {
        const m = String(o?.payslipMonth || '');
        if (/^\d{4}-\d{2}$/.test(m)) return m;
        return (o?.dispatchedAt || o?.updatedAt || '').slice(0, 7);
    }
    function fmtMonth(ym) {
        if (!/^\d{4}-\d{2}$/.test(ym || '')) return 'Unassigned';
        const [y, m] = ym.split('-').map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString('en-NZ', { month: 'long', year: 'numeric' });
    }

    // Group dispatch rows by pay month, newest month first.
    function groupByMonth(rows) {
        const map = new Map();
        for (const r of rows) {
            if (!map.has(r.month)) map.set(r.month, { month: r.month, rows: [], boxes: 0 });
            const g = map.get(r.month); g.rows.push(r); g.boxes += r.boxes;
        }
        return [...map.values()].sort((a, b) => (b.month || '').localeCompare(a.month || ''));
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

        let dispatched = orders.filter(o => o.status === 'dispatched' || o.status === 'paid');
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
            byPerson[by].push({
                ts, day: ts.slice(0, 10), month: orderPayMonth(o),
                moved: /^\d{4}-\d{2}$/.test(String(o.payslipMonth || '')),
                branch: o.shipTo?.branch || o.customer?.name || '—', id: o.id, boxes: orderBoxes(o),
            });
        }
        for (const t of tabs) byPerson[t].sort((a, b) => b.ts.localeCompare(a.ts));

        const renderPane = (person) => {
            const rows = byPerson[person];
            if (!rows.length) return `<p class="wh-empty">No dispatches by ${escHtml(person)} yet.</p>`;
            const groups = groupByMonth(rows);
            const totalBoxes = rows.reduce((s, r) => s + r.boxes, 0);

            const tbody = groups.map(g => {
                const subhdr = `<tr class="dl-group-header">
                    ${isWarehouse ? '' : '<td></td>'}
                    <td colspan="4"><span class="dl-month-label">${escHtml(fmtMonth(g.month))}</span> · ${g.rows.length} order${g.rows.length === 1 ? '' : 's'}</td>
                    <td class="dl-num dl-group-subtotal">${fmtBoxes(g.boxes)} boxes</td>
                </tr>`;
                const rowsHtml = g.rows.map(r => `
                <tr class="dl-row" data-order-id="${escHtml(r.id)}">
                    ${isWarehouse ? '' : `<td class="dl-check-cell"><input type="checkbox" class="dl-chk" data-order-id="${escHtml(r.id)}" data-boxes="${r.boxes}"></td>`}
                    <td>${escHtml(fmtDate(r.day))}</td>
                    <td>${escHtml(fmtDay(r.day))}</td>
                    <td>${escHtml(r.branch)}</td>
                    <td><a href="#orders/${escHtml(r.id)}" class="dl-order-link">${escHtml(r.id)}</a>${r.moved ? ' <span class="dl-moved" title="Manually reassigned to this month">moved</span>' : ''}</td>
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
                <label class="dl-bulk-month">Reassign to <input type="month" id="dl-bulk-month" value="${thisMonthYm()}"></label>
                <button class="btn-primary btn-sm" id="dl-bulk-assign">Reassign month</button>
                <button class="btn-secondary btn-sm" id="dl-bulk-reset">Reset to dispatch month</button>
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

        async function reassignSelected(month) {
            const checked = [...el.querySelectorAll('.dl-pane.active .dl-chk:checked')];
            if (!checked.length) return;
            const ids = checked.map(c => c.dataset.orderId);
            const btn = document.getElementById('dl-bulk-assign');
            const reset = document.getElementById('dl-bulk-reset');
            btn.disabled = reset.disabled = true;
            try {
                await Promise.all(ids.map(id => patchOrder(id, { payslipMonth: month })));
                await renderDispatchPane(el);
            } catch (err) {
                alert('Reassign failed: ' + err.message);
                btn.disabled = reset.disabled = false;
            }
        }
        document.getElementById('dl-bulk-assign')?.addEventListener('click', () => {
            const m = document.getElementById('dl-bulk-month')?.value;
            if (/^\d{4}-\d{2}$/.test(m || '')) reassignSelected(m);
        });
        document.getElementById('dl-bulk-reset')?.addEventListener('click', () => reassignSelected(null));
    }

    // ── Payslip (consolidated: dispatched auto + manual inputs + settings) ──

    async function renderPayslipPane(el) {
        el.innerHTML = '<div class="orders-loading">Loading…</div>';

        let config = { employees: [] };
        try { config = await apiFetch('/api/payroll/config'); } catch {}
        const employees = (config.employees || []).filter(e => !e.archived);
        if (!employees.length) {
            el.innerHTML = '<p class="cat-sub" style="padding:1rem">No employees configured — set them up in Admin → Payroll.</p>';
            return;
        }

        el.innerHTML = `
        <div class="ps-payslip-wrap">
            <div class="payroll-period-bar">
                <label>Employee
                    <select id="ps-employee">
                        ${employees.map(e => `<option value="${escHtml(e.id)}">${escHtml(e.name)}</option>`).join('')}
                    </select>
                </label>
                <label>Month <input type="month" id="ps-month" value="${thisMonthYm()}"></label>
                <button class="btn-primary btn-sm" id="ps-load-btn">Load</button>
            </div>
            <div id="ps-result"></div>
        </div>`;

        const resultEl = () => document.getElementById('ps-result');

        async function load() {
            const empId = document.getElementById('ps-employee').value;
            const month = document.getElementById('ps-month').value;
            if (!empId || !/^\d{4}-\d{2}$/.test(month)) return;
            resultEl().innerHTML = '<p class="bulk-loading">Computing…</p>';
            let slip;
            try {
                slip = await apiFetch(`/api/payroll/payslip?employee=${encodeURIComponent(empId)}&month=${month}`);
            } catch (err) { resultEl().innerHTML = `<p class="bulk-error">${escHtml(err.message)}</p>`; return; }
            renderSlip(slip, empId, month);
        }

        function renderSlip(slip, empId, month) {
            const i = slip.inputs || {};
            const fmtQty = n => n == null ? '—' : (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
            resultEl().innerHTML = `
            <div class="ps-inputs">
                <h3 class="bulk-table-title">Inputs — ${escHtml(fmtMonth(month))}</h3>
                <div class="ps-inputs-grid">
                    <label class="ps-input--auto">Boxes dispatched <span class="ps-auto-tag">auto · dispatch log</span>
                        <input type="number" value="${i.boxesDispatched || 0}" disabled></label>
                    <label># 10kg boxes packed<input type="number" id="ps-in-10" min="0" step="1" value="${i.packed10kg || 0}"></label>
                    <label># 10×1kg bags packed<input type="number" id="ps-in-1" min="0" step="1" value="${i.packed1kg || 0}"></label>
                    <label>Hours worked<input type="number" id="ps-in-hours" min="0" step="0.5" value="${i.hours || 0}"></label>
                </div>
                <div class="ps-inputs-actions">
                    <button class="btn-primary btn-sm" id="ps-save-btn">Save &amp; recalculate</button>
                    <span class="tally-save-status" id="ps-save-status"></span>
                </div>
                <p class="cat-sub" style="margin:0.4rem 0 0">Base rate &amp; petrol come from Admin → Payroll settings.</p>
            </div>
            <div class="payslip" id="ps-print">
                <div class="payslip-hd">
                    <div>
                        <h3 class="payslip-title">Payslip — ${escHtml(slip.employee.name)}</h3>
                        <p class="payslip-meta">${escHtml(fmtMonth(month))} · ${escHtml(slip.period.start)} → ${escHtml(slip.period.end)}</p>
                    </div>
                    <button class="btn-secondary btn-sm no-print" id="ps-print-btn">Print / PDF</button>
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

            document.getElementById('ps-save-btn').addEventListener('click', async () => {
                const btn = document.getElementById('ps-save-btn');
                const status = document.getElementById('ps-save-status');
                btn.disabled = true; btn.textContent = 'Saving…'; status.textContent = '';
                try {
                    await apiFetch('/api/payroll/monthly', {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            employee: empId, month,
                            packed10kg: Number(document.getElementById('ps-in-10').value) || 0,
                            packed1kg:  Number(document.getElementById('ps-in-1').value)  || 0,
                            hours:      Number(document.getElementById('ps-in-hours').value) || 0,
                        }),
                    });
                    status.textContent = 'Saved ✓';
                    await load();
                } catch (err) {
                    status.textContent = 'Error: ' + err.message;
                    btn.disabled = false; btn.textContent = 'Save & recalculate';
                }
            });
            document.getElementById('ps-print-btn')?.addEventListener('click', () => printPayslip(document.getElementById('ps-print')));
        }

        document.getElementById('ps-load-btn').addEventListener('click', load);
        document.getElementById('ps-employee').addEventListener('change', load);
        document.getElementById('ps-month').addEventListener('change', load);
        await load();
    }

    function printPayslip(node) {
        if (!node) return;
        const styles = Array.from(document.styleSheets)
            .map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
        const win = window.open('', '_blank', 'width=800,height=700');
        win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payslip</title><style>${styles}
            body{margin:0;padding:24px;background:#fff}</style></head><body>${node.outerHTML}</body></html>`);
        win.document.close(); win.focus();
        setTimeout(() => { win.print(); }, 400);
    }

    // ── Main render ──

    async function render(container) {
        let me;
        try { me = await apiFetch('/api/me'); } catch {}
        const isWarehouse = me?.role === 'warehouse';

        const adminTabs = isWarehouse ? '' : `
            <button class="imp-view-btn ps-tab" data-tab="payslip">Payslip</button>`;

        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Payslips</h1>
                <p class="view-subtitle">Monthly dispatch log and payslip.</p>
            </div>
        </div>
        <div class="ps-tab-bar">
            <button class="imp-view-btn ps-tab active" data-tab="dispatch">Dispatch log</button>
            ${adminTabs}
        </div>
        <div id="ps-pane-dispatch" class="ps-pane active"></div>
        ${isWarehouse ? '' : `<div id="ps-pane-payslip" class="ps-pane" hidden></div>`}`;

        // Load dispatch tab immediately
        await renderDispatchPane(document.getElementById('ps-pane-dispatch'));

        if (isWarehouse) return;

        // Lazy-load the payslip tab on first visit
        const loaded = { dispatch: true, payslip: false };
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
                if (tab === 'payslip') await renderPayslipPane(document.getElementById('ps-pane-payslip'));
            });
        });
    }

    return { render };
})();
