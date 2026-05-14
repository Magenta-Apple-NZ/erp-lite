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
    // parsing "1kg"/"10kg" out of the line text, then to 1 if not found).
    function lineKg(l) {
        let kgPer;
        if (l?.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) {
            kgPer = Number(l.kgPerUnit);
        } else {
            const text = `${l?.description || ''} ${l?.name || ''} ${l?.sku || ''}`;
            const m = text.match(/\b(10|1)\s*kg\b/i);
            kgPer = m ? Number(m[1]) : 1;
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

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Dispatch Log</h1>
                <p class="view-subtitle">Dispatched orders by person.</p>
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
            });
        }
        for (const t of tabs) byPerson[t].sort((a, b) => b.ts.localeCompare(a.ts));

        const renderPane = (person) => {
            const rows = byPerson[person];
            if (!rows.length) return `<p class="wh-empty">No dispatches by ${escHtml(person)} yet.</p>`;
            const totalBoxes = rows.reduce((s, r) => s + r.boxes, 0);
            const tbody = rows.map(r => `
                <tr>
                    <td>${escHtml(fmtDate(r.day))}</td>
                    <td>${escHtml(fmtDay(r.day))}</td>
                    <td>${escHtml(r.branch)}</td>
                    <td><a href="#orders/${escHtml(r.id)}" class="dl-order-link">${escHtml(r.id)}</a></td>
                    <td class="dl-num">${fmtBoxes(r.boxes)}</td>
                </tr>`).join('');
            return `
            <table class="cat-table dl-table">
                <thead>
                    <tr>
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
    }

    return { render };
})();
