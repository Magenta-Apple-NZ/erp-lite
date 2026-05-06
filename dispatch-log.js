// Dispatch Log — daily tally of dispatched orders, split by dispatcher.
// Admin sees per-dispatcher columns; warehouse role only sees their own.
const DispatchLog = (() => {

    const DISPATCHERS = ['Jake', 'Andrew'];

    async function api(path) {
        const r = await fetch(path);
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
    }

    function fmtDay(iso) {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'long' });
    }

    function fmtDate(iso) {
        return new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Dispatch Log</h1>
                <p class="view-subtitle">Daily count of orders dispatched.</p>
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

        // Filter to dispatched orders. Warehouse only sees their own attribution.
        let dispatched = orders.filter(o => o.status === 'dispatched');
        if (isWarehouse) {
            dispatched = dispatched.filter(o => (o.dispatchedBy || 'Jake') === myName);
        }

        // Group by date with sub-counts per dispatcher.
        const byDate = new Map();
        for (const o of dispatched) {
            const ts = o.dispatchedAt || o.updatedAt;
            if (!ts) continue;
            const day = ts.slice(0, 10);
            const by = o.dispatchedBy || 'Jake';
            if (!byDate.has(day)) byDate.set(day, {});
            const counts = byDate.get(day);
            counts[by] = (counts[by] || 0) + 1;
        }

        const rows = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
        const body = document.getElementById('dl-body');

        if (!rows.length) {
            body.innerHTML = `<p class="wh-empty">No orders have been dispatched yet.</p>`;
            return;
        }

        // Columns: warehouse sees just their own count; admin sees both + total.
        const cols = isWarehouse ? [myName] : DISPATCHERS;
        const totals = Object.fromEntries(cols.map(c => [c, 0]));
        let grandTotal = 0;

        const tbody = rows.map(([d, counts]) => {
            const cells = cols.map(c => {
                const n = counts[c] || 0;
                totals[c] += n;
                return `<td class="dl-num">${n || ''}</td>`;
            }).join('');
            const dayTotal = cols.reduce((s, c) => s + (counts[c] || 0), 0);
            grandTotal += dayTotal;
            const totalCell = isWarehouse ? '' : `<td class="dl-num dl-total">${dayTotal}</td>`;
            return `<tr><td>${fmtDate(d)}</td><td>${fmtDay(d)}</td>${cells}${totalCell}</tr>`;
        }).join('');

        const headerCols = cols.map(c => `<th class="dl-num">${c}</th>`).join('');
        const totalHeader = isWarehouse ? '' : `<th class="dl-num">Total</th>`;
        const footCols = cols.map(c => `<td class="dl-num">${totals[c]}</td>`).join('');
        const footTotal = isWarehouse ? '' : `<td class="dl-num dl-total">${grandTotal}</td>`;

        body.innerHTML = `
        <div class="cat-section">
            <table class="cat-table dl-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Day</th>
                        ${headerCols}
                        ${totalHeader}
                    </tr>
                </thead>
                <tbody>${tbody}</tbody>
                <tfoot>
                    <tr>
                        <td colspan="2">Total · ${rows.length} day${rows.length === 1 ? '' : 's'}</td>
                        ${footCols}
                        ${footTotal}
                    </tr>
                </tfoot>
            </table>
        </div>`;
    }

    return { render };
})();
