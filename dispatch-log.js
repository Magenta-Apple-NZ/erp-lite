// Dispatch Log — daily tally of dispatched orders.
// v1: just a count per date. Box-counts and hours come later.
const DispatchLog = (() => {

    async function api(path) {
        const r = await fetch(path);
        if (!r.ok) throw new Error(r.statusText);
        return r.json();
    }

    function fmtDay(iso) {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString('en-NZ', { weekday: 'long' });
    }

    function fmtDate(iso) {
        const d = new Date(iso + 'T00:00:00');
        return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
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

        let orders;
        try {
            orders = await api('/api/orders');
        } catch (e) {
            document.getElementById('dl-body').innerHTML =
                `<div class="orders-error">Could not load orders: ${e.message}</div>`;
            return;
        }

        // Group dispatched orders by YYYY-MM-DD. Prefer dispatchedAt; fall back
        // to updatedAt for orders that were dispatched before the field was added.
        const byDate = new Map();
        for (const o of orders) {
            if (o.status !== 'dispatched') continue;
            const ts = o.dispatchedAt || o.updatedAt;
            if (!ts) continue;
            const day = ts.slice(0, 10);
            if (!byDate.has(day)) byDate.set(day, []);
            byDate.get(day).push(o);
        }

        const rows = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
        const totalOrders = rows.reduce((s, [, list]) => s + list.length, 0);

        const body = document.getElementById('dl-body');
        if (!rows.length) {
            body.innerHTML = `<p class="wh-empty">No orders have been dispatched yet.</p>`;
            return;
        }

        body.innerHTML = `
        <div class="cat-section">
            <table class="cat-table dl-table">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Day</th>
                        <th class="dl-num">Dispatches</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(([d, list]) => `
                    <tr>
                        <td>${fmtDate(d)}</td>
                        <td>${fmtDay(d)}</td>
                        <td class="dl-num">${list.length}</td>
                    </tr>`).join('')}
                </tbody>
                <tfoot>
                    <tr>
                        <td colspan="2">Total · ${rows.length} day${rows.length === 1 ? '' : 's'}</td>
                        <td class="dl-num">${totalOrders}</td>
                    </tr>
                </tfoot>
            </table>
        </div>`;
    }

    return { render };
})();
