// Dispatch Log — per-dispatcher tab of dispatched orders with branch,
// order number, and box count. Admin sees a tab per dispatcher; warehouse
// role only sees their own tab.
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

    // A box holds 10kg of product, whether that's 1 × 10kg bundle or
    // 10 × 1kg bags. Each line contributes (qty × kgPerUnit) kg; boxes is
    // the total kg / 10. kgPerUnit is stamped by the catalog (falls back to
    // parsing "1kg"/"10kg" out of the line text, otherwise 0 — freight and
    // other non-product lines shouldn't appear in the box count).
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

    async function patch(id, body) {
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
                <p class="view-subtitle">Dispatched orders by person. Group runs into payslip periods to subtotal a pay tally.</p>
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

        // Per-dispatcher buckets, each sorted by dispatch timestamp desc.
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
        // Rows are already in reverse-chrono order, so each group is a
        // contiguous chronological slice of the log.
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
                        <td colspan="${isWarehouse ? 4 : 5}">${headLbl} · ${g.rows.length} order${g.rows.length === 1 ? '' : 's'}</td>
                        <td class="dl-num dl-group-subtotal">${fmtBoxes(g.boxes)} boxes</td>
                    </tr>`;
                const rowsHtml = g.rows.map(r => `
                    <tr>
                        <td>${escHtml(fmtDate(r.day))}</td>
                        <td>${escHtml(fmtDay(r.day))}</td>
                        <td>${escHtml(r.branch)}</td>
                        <td><a href="#orders/${escHtml(r.id)}" class="dl-order-link">${escHtml(r.id)}</a></td>
                        ${isWarehouse ? '' : `<td class="dl-action-cell"><button class="dl-assign-btn" data-order-id="${escHtml(r.id)}" data-current-label="${escHtml(r.payslipLabel || '')}" title="Assign this run to a payslip period">${r.payslipLabel ? 'Re-assign' : 'Assign to Payslip'}</button></td>`}
                        <td class="dl-num">${fmtBoxes(r.boxes)}</td>
                    </tr>`).join('');
                return subhdr + rowsHtml;
            }).join('');

            return `
            <table class="cat-table dl-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Day</th>
                        <th>Branch</th>
                        <th>Order #</th>
                        ${isWarehouse ? '' : '<th>Payslip</th>'}
                        <th class="dl-num">Boxes</th>
                    </tr>
                </thead>
                <tbody>${tbody}</tbody>
                <tfoot>
                    <tr>
                        <td colspan="${isWarehouse ? 4 : 5}">Total · ${rows.length} order${rows.length === 1 ? '' : 's'}</td>
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

        const panes = tabs.map((t, i) =>
            `<div class="dl-pane${i === 0 ? ' active' : ''}" data-person-pane="${escHtml(t)}">${renderPane(t)}</div>`
        ).join('');

        body.innerHTML = `<div class="cat-section">${tabBar}${panes}</div>`;

        if (showTabs) {
            body.querySelectorAll('.dl-tab').forEach(btn => {
                btn.addEventListener('click', () => {
                    const target = btn.dataset.person;
                    body.querySelectorAll('.dl-tab').forEach(b => b.classList.toggle('active', b === btn));
                    body.querySelectorAll('.dl-pane').forEach(p =>
                        p.classList.toggle('active', p.dataset.personPane === target));
                });
            });
        }

        // Delegated handler for "Assign to Payslip" buttons (admin only).
        // Clicking the button assigns the prompted label to that order AND
        // every older un-assigned order up to (but not past) the next
        // already-assigned dispatch — i.e. the row marks the end of a run.
        body.addEventListener('click', async (e) => {
            const btn = e.target.closest('.dl-assign-btn');
            if (!btn) return;
            const orderId = btn.dataset.orderId;
            const current = btn.dataset.currentLabel;
            const promptDefault = current || defaultPayslipLabel();
            const label = window.prompt(
                'Payslip label for this run\n(applies to this dispatch and all unassigned dispatches older than it)',
                promptDefault);
            if (label === null) return;            // cancelled
            const trimmed = label.trim();

            // Find the active person's rows in chronological order so we
            // can scan from the picked row backwards through unassigned ones.
            const person = body.querySelector('.dl-pane.active')?.dataset.personPane
                || tabs[0];
            const personRows = byPerson[person].slice().sort((a, b) => a.ts.localeCompare(b.ts));
            const idx = personRows.findIndex(r => r.id === orderId);
            if (idx < 0) return;

            // The end-of-run anchor is the clicked row itself. Walk backward
            // through older rows, collecting any that are unassigned. Stop
            // at the first already-assigned row (that's the previous run's
            // boundary). The picked row also gets the new label.
            const toAssign = [personRows[idx].id];
            for (let i = idx - 1; i >= 0; i--) {
                if (personRows[i].payslipLabel) break;
                toAssign.push(personRows[i].id);
            }

            btn.disabled = true; btn.textContent = 'Saving…';
            try {
                await Promise.all(toAssign.map(id =>
                    patch(id, { payslipLabel: trimmed || null })));
                // Re-render the whole view so the groups/subtotals refresh.
                await render(container);
            } catch (err) {
                alert('Assign failed: ' + err.message);
                btn.disabled = false; btn.textContent = current ? 'Re-assign' : 'Assign to Payslip';
            }
        });
    }

    return { render };
})();
