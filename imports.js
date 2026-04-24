const ImportsView = (() => {

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Imports</h1>
                <p class="view-subtitle">Foreign exchange rates and import schedule.</p>
            </div>
        </div>
        <div class="cat-section" style="margin-bottom:1.5rem">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">FX Rates</h2>
                    <p class="cat-sub">Live exchange rates from frankfurter.dev.</p>
                </div>
            </div>
            <div class="fx-rates-panel" id="header-currencies"></div>
        </div>
        <div id="wh-body"><div class="orders-loading">Loading…</div></div>`;

        if (typeof renderHeaderCurrencies === 'function' && currentConfig?.currencies) {
            renderHeaderCurrencies(currentConfig.currencies);
        }

        if (typeof Warehouse !== 'undefined' && typeof Warehouse.renderImports === 'function') {
            await Warehouse.renderImports();
        }
    }

    return { render };
})();
