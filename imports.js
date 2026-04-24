const ImportsView = (() => {

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Imports</h1>
                <p class="view-subtitle">Stock forecast and import schedule.</p>
            </div>
        </div>
        <div id="wh-body"><div class="orders-loading">Loading…</div></div>`;

        if (typeof Warehouse !== 'undefined' && typeof Warehouse.renderImports === 'function') {
            await Warehouse.renderImports();
        }
    }

    return { render };
})();
