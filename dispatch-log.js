// Dispatch Log — per-dispatcher tab of dispatched orders with branch,
// order number, and box count. Admin sees a tab per dispatcher; warehouse
// role only sees their own tab.
//
// Payslip assignment: admin can bulk-select rows via checkboxes and
// assign them to a labelled payslip period in one action.
const DispatchLog = (() => {

    const DISPATCHERS = ['Jake', 'Andrew'];

    async function api(path) {
        const r = await fetch(path);
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
    }

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtDay(iso) {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'long' });
    }

    function fmtDate(iso) {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

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
    function orderBoxes(o) {
        const kg = (o.lines || []).reduce((s, l) => s + lineKg(l), 0);
        return kg / 10;
    }
    function fmtBoxes(b) {
        if (!b) return '';
        return Number.isInteger(b) ? String(b) : b.toFixed(1);
    }

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

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Dispatch Log</h1>
                <p class="view-subtitle">Dispatched orders by person. Select rows and assign them to a payslip period.</p>
            </div>
        </div>
        <div id="dl-body"><div class="orders-loading">Loading…</div></div>`;

        let orders, me;
        try {
            [orders, me] = await Promise.all([api('/api/orders'), api('/api/me')]);
        } catch (e) {
            document.getElementById('dl-body').innerHTML =
                `<div class="orders-error">Could not load: ${e.message}</div>`;
            return;
        }

        const isWarehouse = me?.role === 'warehouse';
        const myName = me?.name || 'Jake';

        let dispatched = orders.filter(o => o.status === 'dispatched');
        if (isWarehouse) {
            dispatched = dispatched.filter(o => (o.dispatchedBy || 'Jake') === myName);
        }

        const body = document.getElementById('dl-body');
        if (!dispatched.length) {
            body.innerHTML = `<p class="wh-empty">No orders have been dispatched yet.</p>`;
            return;
        }

        // Per-dispatcher buckets, sorted by dispatch timestamp desc.
        const tabs = isWarehouse ? [myName] : DISPATCHERS;
        const byPerson = Object.fromEntries(tabs.map(t => [t, []]));
        for (const o of dispatched) {
            const by = o.dispatchedBy || 'Jake';
            if (!byPerson[by]) continue;
            const ts = o.dispatchedAt || o.updatedAt || '';
            byPerson[by].push({
                ts,
                day: ts.slice(0, 10),
                branch: o.shipTo?.branch || o.customer?.name || '—',
                id: o.id,
                boxes: orderBoxes(o),
                payslipLabel: o.payslipLabel || null,
            });
        }
        for (const t of tabs) byPerson[t].sort((a, b) => b.ts.localeCompare(a.ts));

        // Group adjacent rows that share the same payslipLabel (incl. null).
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

        const colCount = isWarehouse ? 5 : 6; // extra checkbox col for admin

        const renderPane = (person) => {
            const rows = byPerson[person];
            if (!rows.length) return `<p class="wh-empty">No dispatches by ${escHtml(person)} yet.</p>`;
            const groups = groupByPayslip(rows);
            const totalBoxes = rows.reduce((s, r) => s + r.boxes, 0);

            const tbody = groups.map(g => {
                const headLbl = g.label
                    ? `<span class="dl-payslip-label">${escHtml(g.label)}</span>`
                    : `<span class="dl-payslip-label dl-payslip-label--open">Unassigned</span>`;
                const subhdr = `
                    <tr class="dl-group-header">
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
                <thead>
                    <tr>
                        ${isWarehouse ? '' : `<th class="dl-check-cell"><input type="checkbox" class="dl-chk-all" title="Select all visible"></th>`}
                        <th>Date</th>
                        <th>Day</th>
                        <th>Branch</th>
                        <th>Order #</th>
                        <th class="dl-num">Boxes</th>
                    </tr>
                </thead>
                <tbody>${tbody}</tbody>
                <tfoot>
                    <tr>
                        ${isWarehouse ? '' : '<td></td>'}
                        <td colspan="4">Total · ${rows.length} order${rows.length === 1 ? '' : 's'}</td>
                        <td class="dl-num dl-total">${fmtBoxes(totalBoxes)}</td>
                    </tr>
                </tfoot>
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
                <input type="text" class="dl-bulk-label-input" id="dl-bulk-label"
                    placeholder="Payslip period…" value="${escHtml(defaultPayslipLabel())}">
                <button class="btn-primary btn-sm" id="dl-bulk-assign">Assign to payslip</button>
                <button class="btn-secondary btn-sm" id="dl-bulk-clear">Clear selection</button>
            </div>
        </div>`;

        const panes = tabs.map((t, i) =>
            `<div class="dl-pane${i === 0 ? ' active' : ''}" data-person-pane="${escHtml(t)}">${renderPane(t)}</div>`
        ).join('');

        body.innerHTML = `<div class="cat-section">${bulkBar}${tabBar}${panes}</div>`;

        // ── Tab switching ──
        if (showTabs) {
            body.querySelectorAll('.dl-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.person;
                    body.querySelectorAll('.dl-tab').forEach(b => b.classList.toggle('active', b === btn));
                    body.querySelectorAll('.dl-pane').forEach(p =>
                        p.classList.toggle('active', p.dataset.personPane === target));
                    // Clear selection when switching tabs
                    body.querySelectorAll('.dl-chk').forEach(c => { c.checked = false; c.closest('tr')?.classList.remove('dl-row--checked'); });
                    body.querySelectorAll('.dl-chk-all').forEach(c => c.checked = false);
                    updateBulkBar();
                });
            });
        }

        if (isWarehouse) return;

        // ── Checkbox wiring ──
        function getActivePane() {
            return body.querySelector('.dl-pane.active');
        }

        function updateBulkBar() {
            const checked = body.querySelectorAll('.dl-pane.active .dl-chk:checked');
            const bar = document.getElementById('dl-bulk-bar');
            const countEl = document.getElementById('dl-bulk-count');
            if (!bar) return;
            if (!checked.length) { bar.hidden = true; return; }
            bar.hidden = false;
            const totalBoxes = [...checked].reduce((s, c) => s + (parseFloat(c.dataset.boxes) || 0), 0);
            countEl.textContent = `${checked.length} order${checked.length === 1 ? '' : 's'} · ${fmtBoxes(totalBoxes)} boxes selected`;
        }

        // Individual row checkboxes
        body.addEventListener('change', e => {
            const chk = e.target.closest('.dl-chk');
            if (!chk || chk.classList.contains('dl-chk-all')) return;
            chk.closest('tr')?.classList.toggle('dl-row--checked', chk.checked);
            // Keep select-all in sync
            const pane = getActivePane();
            const all = pane?.querySelectorAll('.dl-chk');
            const allChk = pane?.querySelector('.dl-chk-all');
            if (allChk && all) allChk.checked = [...all].every(c => c.checked);
            updateBulkBar();
        });

        // Select-all per pane
        body.addEventListener('change', e => {
            const allChk = e.target.closest('.dl-chk-all');
            if (!allChk) return;
            const pane = getActivePane();
            pane?.querySelectorAll('.dl-chk').forEach(c => {
                c.checked = allChk.checked;
                c.closest('tr')?.classList.toggle('dl-row--checked', allChk.checked);
            });
            updateBulkBar();
        });

        // Clear selection
        document.getElementById('dl-bulk-clear')?.addEventListener('click', () => {
            body.querySelectorAll('.dl-chk').forEach(c => { c.checked = false; c.closest('tr')?.classList.remove('dl-row--checked'); });
            body.querySelectorAll('.dl-chk-all').forEach(c => c.checked = false);
            updateBulkBar();
        });

        // Bulk assign
        document.getElementById('dl-bulk-assign')?.addEventListener('click', async () => {
            const checked = [...body.querySelectorAll('.dl-pane.active .dl-chk:checked')];
            if (!checked.length) return;
            const label = document.getElementById('dl-bulk-label')?.value.trim() || null;
            const ids = checked.map(c => c.dataset.orderId);

            const btn = document.getElementById('dl-bulk-assign');
            btn.disabled = true; btn.textContent = 'Saving…';
            try {
                await Promise.all(ids.map(id => patchOrder(id, { payslipLabel: label || null })));
                await render(container);
            } catch (err) {
                alert('Assign failed: ' + err.message);
                btn.disabled = false; btn.textContent = 'Assign to payslip';
            }
        });
    }

    return { render };
})();
