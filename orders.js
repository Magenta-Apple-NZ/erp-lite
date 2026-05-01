// ── Orders module ──
// Handles all views under #orders, #orders/new, #orders/<id>, #orders/<id>/edit

const Orders = (() => {

    // ── State ──
    let xeroConnected = false;
    let customersCache = null;
    let currentUser = null;

    // label = display name, xeroName = exact Xero contact name, xeroCode = Xero account number for lookup
    const CUSTOMER_PRESETS = [
        { key: 'farmlands',   label: 'Farmlands',     xeroName: 'Farmlands',      xeroCode: 'C1010' },
        { key: 'pgg',         label: 'PGG Wrightson', xeroName: 'PGG Wrightson',  xeroCode: 'C1020' },
        { key: 'horicentre',  label: 'HortiCentre',   xeroName: 'HortiCentre Ltd', xeroCode: 'C1030' },
        { key: 'cash',        label: 'Cash Sale',     xeroName: 'Cash Sale',       xeroCode: '' },
    ];

    // Close overflow menus when clicking outside; close on item click (capture so it fires before any stopPropagation)
    document.addEventListener('click', e => {
        const trigger = e.target.closest('.overflow-trigger');
        if (trigger) {
            // Close every OTHER open menu; this one is toggled by its inline onclick
            document.querySelectorAll('.overflow-menu.open').forEach(m => {
                if (m !== trigger.closest('.overflow-menu')) m.classList.remove('open');
            });
        } else {
            document.querySelectorAll('.overflow-menu.open').forEach(m => m.classList.remove('open'));
        }
    }, true);

    // ── Status helpers ──
    const STATUS_LABELS = {
        new:          'New',
        reviewed:     'Reviewed',
        sent_to_xero: 'Sent to Xero',
        dispatched:   'Dispatched',
        paid:         'Paid',
    };
    const STATUS_COLOURS = {
        new:          '#3b82f6',
        reviewed:     '#f59e0b',
        sent_to_xero: '#8b5cf6',
        dispatched:   '#64748b',
        paid:         '#10b981',
    };

    // Xero brand mark — a Xero-blue circle with a white "x". Designed to read at
    // 15–18px so it works as a row-action icon. Dim state is handled via the
    // .row-action-btn--dim CSS opacity, so the SVG itself stays a single source.
    function xeroBadgeSVG() {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" aria-label="Xero">
            <circle cx="12" cy="12" r="11" fill="#13B5EA"/>
            <text x="12" y="17" text-anchor="middle" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="15">x</text>
        </svg>`;
    }

    function statusBadge(status) {
        const label = STATUS_LABELS[status] || status;
        const colour = STATUS_COLOURS[status] || '#94a3b8';
        return `<span class="order-status-badge" style="background:${colour}20;color:${colour};border:1px solid ${colour}40">${label}</span>`;
    }

    // ── API helpers ──
    async function api(path, opts = {}) {
        const resp = await fetch(path, opts);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ error: resp.statusText }));
            throw new Error(err.error || resp.statusText);
        }
        return resp.json();
    }

    async function getUser() {
        if (currentUser) return currentUser;
        try {
            const u = await api('/api/me');
            if (u && u.name && u.name !== 'Unknown') {
                currentUser = u;
            } else {
                return u || { name: 'Unknown', email: null };
            }
        } catch {
            return { name: 'Unknown', email: null };
        }
        return currentUser;
    }

    async function logEvent(orderId, action, detail = '') {
        const user = await getUser();
        return api('/api/orders/' + orderId, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event: { timestamp: new Date().toISOString(), user: user.name, action, detail },
            }),
        }).catch(() => {}); // non-blocking
    }

    async function checkXeroStatus() {
        try {
            const s = await api('/api/xero/status');
            xeroConnected = s.connected;
        } catch {
            xeroConnected = false;
        }
    }

    async function loadCustomers(bust = false) {
        if (customersCache && !bust) return customersCache;
        customersCache = await api('/api/xero/customers' + (bust ? '?bust=1' : ''));
        return customersCache;
    }

    // ── Currency format ──
    function fmt(n) {
        return Number(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function orderTotal(order) {
        return order.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
    }

    // ── Date format ──
    function fmtDate(iso) {
        return new Date(iso).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function fmtDateTime(iso) {
        return new Date(iso).toLocaleString('en-NZ', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    // ── Xero connection banner ──
    function xeroConnectBanner() {
        return `
        <div class="xero-banner">
            <div class="xero-banner-text">
                <strong>Xero not connected.</strong>
                Connect Xero to pull customer names, push draft invoices, and close the loop on dispatch.
            </div>
            <a href="/api/xero/auth" class="btn-primary xero-connect-btn">Connect Xero</a>
        </div>`;
    }

    // ── Orders list view ──
    async function renderList(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Orders</h1>
                <p class="view-subtitle">Track orders from creation through to dispatch.</p>
            </div>
            <a href="#orders/new" class="btn-primary">+ New Order</a>
        </div>
        <div class="orders-filter-bar">
            <input type="text" id="filter-customer" placeholder="Customer…" class="orders-filter-input">
            <input type="text" id="filter-branch" placeholder="Branch…" class="orders-filter-input">
            <select id="filter-status" class="orders-filter-select">
                <option value="">All statuses</option>
                <option value="new">New</option>
                <option value="reviewed">Reviewed</option>
                <option value="sent_to_xero">Sent to Xero</option>
                <option value="dispatched">Dispatched</option>
                <option value="paid">Paid</option>
            </select>
            <button class="btn-secondary btn-sm" id="filter-clear">Clear</button>
        </div>
        <div id="orders-list-body"><div class="orders-loading">Loading…</div></div>`;

        await checkXeroStatus();

        let orders = [];
        try {
            orders = await api('/api/orders');
        } catch (e) {
            document.getElementById('orders-list-body').innerHTML =
                `<div class="orders-error">Could not load orders: ${e.message}</div>`;
            return;
        }

        const body = document.getElementById('orders-list-body');

        function applyFilters() {
            const cust   = document.getElementById('filter-customer')?.value.toLowerCase().trim() || '';
            const branch = document.getElementById('filter-branch')?.value.toLowerCase().trim() || '';
            const status = document.getElementById('filter-status')?.value || '';
            return orders.filter(o =>
                (!cust   || (o.customer?.name || '').toLowerCase().includes(cust)) &&
                (!branch || (o.shipTo?.branch || '').toLowerCase().includes(branch)) &&
                (!status || o.status === status)
            );
        }

        function renderTable() {
            renderOrdersTable(applyFilters());
        }

        ['filter-customer', 'filter-branch', 'filter-status'].forEach(id => {
            const el = document.getElementById(id);
            el?.addEventListener('input', renderTable);
            el?.addEventListener('change', renderTable);
        });
        document.getElementById('filter-clear')?.addEventListener('click', () => {
            document.getElementById('filter-customer').value = '';
            document.getElementById('filter-branch').value = '';
            document.getElementById('filter-status').value = '';
            renderTable();
        });

        if (!xeroConnected) {
            body.insertAdjacentHTML('beforebegin', xeroConnectBanner());
        }

        function renderOrdersTable(els) {
            if (!els.length) {
                body.innerHTML = `
                <div class="orders-empty">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">
                        <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                        <rect x="9" y="3" width="6" height="4" rx="1"/>
                        <line x1="9" y1="12" x2="15" y2="12"/>
                        <line x1="9" y1="16" x2="12" y2="16"/>
                    </svg>
                    <p>${orders.length ? 'No orders match the current filter.' : 'No orders yet. <a href="#orders/new">Create the first one.</a>'}</p>
                </div>`;
                return;
            }
            body.innerHTML = `
            <div class="orders-table-wrap">
                <table class="orders-table">
                    <thead>
                        <tr>
                            <th>Order</th>
                            <th>Customer</th>
                            <th>Ship To</th>
                            <th>PO</th>
                            <th>Date</th>
                            <th>Total</th>
                            <th>Status</th>
                            <th>Xero</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${els.map(o => {
                            const xeroUrl = o.xeroInvoiceId
                                ? `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${encodeURIComponent(o.xeroInvoiceId)}`
                                : null;
                            return `
                        <tr class="order-row" data-id="${o.id}">
                            <td class="order-id">${o.id}</td>
                            <td>${escHtml(o.customer.name)}</td>
                            <td class="order-ship-to">${escHtml(o.shipTo?.branch || '—')}</td>
                            <td class="order-po">${escHtml(o.poNumber || '—')}</td>
                            <td class="order-date">${fmtDate(o.createdAt)}</td>
                            <td class="order-total">$${fmt(orderTotal(o))}</td>
                            <td>${statusBadge(o.status)}${o.paidAt ? '<span class="paid-badge" title="Paid">✓ Paid</span>' : ''}</td>
                            <td class="order-xero">${o.xeroInvoiceNumber
                                ? `<span class="xero-inv-num">${escHtml(o.xeroInvoiceNumber)}</span>`
                                : '<span class="xero-pending">—</span>'}</td>
                            <td class="order-actions-col">
                                <div class="row-actions">
                                    <a class="row-action-btn" href="#orders/${o.id}/edit" title="Edit order" onclick="event.stopPropagation()">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                    </a>
                                    <a class="row-action-btn" href="#orders/${o.id}" title="View packing slip" onclick="event.stopPropagation()">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                                    </a>
                                    <button class="row-action-btn"
                                        title="Print delivery address"
                                        data-pa-to="${escHtml(o.shipTo?.branch || o.customer.name)}"
                                        data-pa-addr="${escHtml(o.shipTo?.address || '')}"
                                        data-pa-ref="${escHtml(o.xeroInvoiceNumber || o.id)}"
                                        data-pa-id="${o.id}"
                                        data-pa-po="${escHtml(o.poNumber || '')}"
                                        onclick="event.stopPropagation()">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11" rx="1"/><path d="M15 9h4l3 3v5h-7"/><circle cx="5.5" cy="18.5" r="2"/><circle cx="18.5" cy="18.5" r="2"/></svg>
                                    </button>
                                    ${xeroUrl
                                        ? `<a class="row-action-btn row-action-btn--xero" href="${xeroUrl}" target="_blank" rel="noopener" title="Open in Xero" onclick="event.stopPropagation()">${xeroBadgeSVG()}</a>`
                                        : `<span class="row-action-btn row-action-btn--xero row-action-btn--dim" title="Not yet synced to Xero">${xeroBadgeSVG()}</span>`}
                                    <div class="overflow-menu">
                                        <button class="row-action-btn overflow-trigger" title="More actions" onclick="event.stopPropagation();this.closest('.overflow-menu').classList.toggle('open')">•••</button>
                                        <div class="overflow-dropdown">
                                            <div class="overflow-section">Send Packing Slip</div>
                                            ${printerMenuItems('slip', { indent: true, orderId: o.id })}
                                            <hr class="overflow-divider">
                                            ${printerMenuItems('address', { prefix: 'Send Address to ', orderId: o.id })}
                                            <hr class="overflow-divider">
                                            <button class="overflow-item overflow-danger" data-delete-order="${o.id}">Delete</button>
                                        </div>
                                    </div>
                                </div>
                            </td>
                        </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>`;
        }

        // Delegated events on body — survive re-renders of body.innerHTML
        body.addEventListener('click', e => {
            // Row-level send-to-printer (slip / address) via PrintNode
            const sendBtn = e.target.closest('[data-print-doc][data-order-id]');
            if (sendBtn) {
                const orderId   = sendBtn.dataset.orderId;
                const doc       = sendBtn.dataset.printDoc;
                const printerId = Number(sendBtn.dataset.printId);
                const label     = sendBtn.dataset.printLabel || ('Printer #' + printerId);
                const order     = orders.find(o => o.id === orderId);
                if (!order) return;
                if (doc === 'slip')    sendSlipToPrinter(order, sendBtn, { printerId, label });
                if (doc === 'address') sendAddressToPrinter(order, sendBtn, { printerId, label });
                return;
            }
            // Browser-print delivery address (truck icon + any other data-pa-id button)
            const printBtn = e.target.closest('[data-pa-id]');
            if (printBtn) {
                printAddressPopup({
                    id:                printBtn.dataset.paId,
                    shipTo:            { branch: printBtn.dataset.paTo, address: printBtn.dataset.paAddr },
                    customer:          { name: printBtn.dataset.paTo },
                    xeroInvoiceNumber: printBtn.dataset.paRef !== printBtn.dataset.paId ? printBtn.dataset.paRef : null,
                    poNumber:          printBtn.dataset.paPo || '',
                });
                return;
            }
            const deleteBtn = e.target.closest('[data-delete-order]');
            if (deleteBtn) {
                const orderId = deleteBtn.dataset.deleteOrder;
                if (!confirm(`Delete order ${orderId}? This cannot be undone.`)) return;
                api('/api/orders/' + orderId, { method: 'DELETE' })
                    .then(() => { orders = orders.filter(o => o.id !== orderId); renderTable(); })
                    .catch(err => alert('Delete failed: ' + err.message));
                return;
            }
            if (e.target.closest('.overflow-menu')) return;
            const row = e.target.closest('tr.order-row');
            if (row) location.hash = 'orders/' + row.dataset.id;
        });

        renderTable();
    }

    // ── Customer section HTML (shared by new + edit forms) ──
    function customerSectionHtml(customers, selectedName = '', selectedId = '') {
        const presetMatch = CUSTOMER_PRESETS.find(p =>
            selectedName && (
                selectedName.toLowerCase() === p.xeroName.toLowerCase() ||
                selectedName.toLowerCase().includes(p.label.toLowerCase())
            )
        );
        const selectedKey = presetMatch ? presetMatch.key : (selectedName ? 'other' : '');

        const radios = CUSTOMER_PRESETS.map(p => `
            <label class="customer-preset-opt ${selectedKey === p.key ? 'selected' : ''}">
                <input type="radio" name="customer-preset" value="${p.key}" ${selectedKey === p.key ? 'checked' : ''}>
                <span>${p.label}</span>
            </label>`).join('') + `
            <label class="customer-preset-opt ${selectedKey === 'other' ? 'selected' : ''}">
                <input type="radio" name="customer-preset" value="other" ${selectedKey === 'other' ? 'checked' : ''}>
                <span>Other</span>
            </label>`;

        const otherDisplay = selectedKey === 'other' ? '' : 'none';
        const otherSearch = customers.length
            ? `<div class="customer-search-wrap">
                <input type="text" id="customer-search" placeholder="Search customers…" autocomplete="off" value="${escHtml(selectedKey === 'other' ? selectedName : '')}">
                <div id="customer-dropdown" class="customer-dropdown" style="display:none"></div>
               </div>`
            : `<input type="text" id="customer-search" placeholder="Customer name" value="${escHtml(selectedKey === 'other' ? selectedName : '')}">`;

        return `
        <div class="customer-presets">${radios}</div>
        <div id="customer-other-wrap" style="display:${otherDisplay};margin-top:10px">
            ${otherSearch}
        </div>
        <input type="hidden" id="customer-id" value="${escHtml(selectedKey === 'other' ? selectedId : '')}">
        <input type="hidden" id="customer-name-val" value="${escHtml(selectedName)}">`;
    }

    function wireCustomerSection(customers) {
        document.querySelectorAll('input[name="customer-preset"]').forEach(radio => {
            radio.addEventListener('change', () => {
                const otherWrap = document.getElementById('customer-other-wrap');
                const idInput = document.getElementById('customer-id');
                const nameInput = document.getElementById('customer-name-val');
                // Update selected styling
                document.querySelectorAll('.customer-preset-opt').forEach(l => l.classList.remove('selected'));
                radio.closest('.customer-preset-opt').classList.add('selected');

                if (radio.value === 'other') {
                    otherWrap.style.display = '';
                    idInput.value = '';
                    nameInput.value = '';
                    document.getElementById('customer-search')?.focus();
                    return;
                }

                otherWrap.style.display = 'none';
                const preset = CUSTOMER_PRESETS.find(p => p.key === radio.value);
                nameInput.value = preset.xeroName;

                // Match by exact xeroName first, then partial, then xeroCode
                const match = customers.find(c => c.name.toLowerCase() === preset.xeroName.toLowerCase())
                    || customers.find(c => c.name.toLowerCase().includes(preset.xeroName.toLowerCase()))
                    || customers.find(c => (c.accountNumber || '').toUpperCase() === preset.xeroCode);
                idInput.value = match ? match.xeroContactId : '';
            });
        });

        // If "Other" is pre-selected, wire up the search
        if (customers.length) wireCustomerSearch(customers);

        // If a preset is already checked (edit mode pre-population), set the hidden fields
        const checked = document.querySelector('input[name="customer-preset"]:checked');
        if (checked && checked.value !== 'other') {
            const preset = CUSTOMER_PRESETS.find(p => p.key === checked.value);
            if (preset) {
                const match = customers.find(c => c.name.toLowerCase() === preset.xeroName.toLowerCase())
                    || customers.find(c => c.name.toLowerCase().includes(preset.xeroName.toLowerCase()))
                    || customers.find(c => (c.accountNumber || '').toUpperCase() === preset.xeroCode);
                document.getElementById('customer-id').value = match ? match.xeroContactId : '';
                document.getElementById('customer-name-val').value = preset.xeroName;
            }
        }
    }

    // ── New order form ──
    async function renderNew(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">New Order</h1>
            </div>
            <a href="#orders" class="btn-secondary">← Back to Orders</a>
        </div>
        <div id="new-order-body"><div class="orders-loading">Loading…</div></div>`;

        await checkXeroStatus();

        let customers = [], catalogStores = [], catalogItems = [];
        try {
            if (xeroConnected) customers = await loadCustomers();
        } catch (e) { /* manual entry fallback */ }
        try { catalogStores = await api('/api/catalog/stores'); } catch (e) { /* optional */ }
        try { catalogItems = await api('/api/catalog/items'); } catch (e) { /* optional */ }

        // Compute next sequential PKS ID for pre-population
        let nextOrderNum = '';
        try {
            const allOrders = await api('/api/orders');
            let max = 0;
            for (const o of (allOrders || [])) {
                const m = (o.id || '').match(/^PKS-(\d+)$/);
                if (m) max = Math.max(max, parseInt(m[1]));
            }
            nextOrderNum = String(max + 1).padStart(4, '0');
        } catch (e) { /* non-critical */ }

        const body = document.getElementById('new-order-body');
        if (!xeroConnected) body.insertAdjacentHTML('beforebegin', xeroConnectBanner());

        body.innerHTML = orderFormHtml({ customers, catalogStores, submitLabel: 'Create Order', nextOrderNum });

        wireOrderForm({ customers, catalogStores, catalogItems });
        document.getElementById('submit-order-btn').addEventListener('click', () => submitNewOrder());
    }

    // ── Edit order form ──
    async function renderEdit(container, orderId) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Edit Order</h1>
            </div>
            <a href="#orders/${orderId}" class="btn-secondary">← Cancel</a>
        </div>
        <div id="new-order-body"><div class="orders-loading">Loading…</div></div>`;

        await checkXeroStatus();

        let order, customers = [], catalogStores = [], catalogItems = [];
        try {
            order = await api('/api/orders/' + orderId);
        } catch (e) {
            document.getElementById('new-order-body').innerHTML =
                `<div class="orders-error">${e.message}</div>`;
            return;
        }
        try { if (xeroConnected) customers = await loadCustomers(); } catch (e) {}
        try { catalogStores = await api('/api/catalog/stores'); } catch (e) {}
        try { catalogItems = await api('/api/catalog/items'); } catch (e) {}

        const body = document.getElementById('new-order-body');
        if (!xeroConnected) body.insertAdjacentHTML('beforebegin', xeroConnectBanner());

        if (order.xeroInvoiceId) {
            body.insertAdjacentHTML('afterbegin', `
                <div class="form-warn">This order has already been pushed to Xero (${escHtml(order.xeroInvoiceNumber)}). Editing it here will not update the Xero invoice.</div>`);
        }

        body.innerHTML += orderFormHtml({
            customers,
            catalogStores,
            submitLabel: 'Save Changes',
            defaults: order,
        });

        wireOrderForm({ customers, catalogStores, catalogItems, defaults: order });
        document.getElementById('submit-order-btn').addEventListener('click', () => submitEditOrder(orderId));
    }

    // ── Shared order form HTML ──
    function orderFormHtml({ customers, catalogStores, submitLabel, defaults = {}, nextOrderNum = '' }) {
        // Strip the prefix to show just the numeric portion in the input
        const numericId = defaults.id
            ? defaults.id.replace(/^(?:PKS|ORD)-(?:\d{4}-)?/, '')
            : nextOrderNum;
        return `
        <form id="new-order-form" class="order-form" onsubmit="return false">
            <!-- Customer + Ship To grouped -->
            <section class="form-section">
                <h2 class="form-section-title">Customer & Ship To</h2>
                <div class="form-row" style="align-items:flex-start">
                    <div class="form-field" style="flex:2;min-width:0">
                        <label>Branch / Store</label>
                        ${catalogStores.length ? `
                        <div class="customer-search-wrap">
                            <input type="text" id="ship-branch" placeholder="Search stores…" autocomplete="off" value="${escHtml(defaults.shipTo?.branch || '')}">
                            <div id="store-dropdown" class="customer-dropdown" style="display:none"></div>
                        </div>` : `
                        <input type="text" id="ship-branch" placeholder="e.g. Martinborough Branch" value="${escHtml(defaults.shipTo?.branch || '')}">`}
                    </div>
                    <div class="form-field" style="flex:1;min-width:0">
                        <label>Customer</label>
                        ${customerSectionHtml(customers, defaults.customer?.name || '', defaults.customer?.xeroContactId || '')}
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-field">
                        <label>Delivery address <span class="form-hint">optional</span></label>
                        <textarea id="ship-address" rows="3" placeholder="Street address…">${escHtml(defaults.shipTo?.address || '')}</textarea>
                    </div>
                </div>
            </section>

            <!-- Reference -->
            <section class="form-section">
                <h2 class="form-section-title">Reference</h2>
                <div class="form-row">
                    <div class="form-field" style="flex:1">
                        <label>Order Number <span class="form-hint">optional — leave blank to auto-assign</span></label>
                        <div class="order-num-wrap">
                            <span class="order-num-prefix">PKS-</span>
                            <input type="text" id="order-number" placeholder="e.g. 1021" pattern="[0-9]*" inputmode="numeric"
                                value="${escHtml(numericId)}"${defaults.id ? ' readonly style="background:#f8fafc;color:#64748b"' : ''}>
                        </div>
                        <span class="form-hint" style="display:block;margin-top:4px">Xero invoice: INV-<span id="order-num-preview">${numericId || '…'}</span></span>
                    </div>
                    <div class="form-field" style="flex:1">
                        <label>PO Number <span class="form-hint">optional</span></label>
                        <input type="text" id="po-number" placeholder="e.g. PO-12345" value="${escHtml(defaults.poNumber || '')}">
                    </div>
                </div>
            </section>

            <!-- Line Items -->
            <section class="form-section">
                <h2 class="form-section-title">Items</h2>
                <div class="line-items-wrap">
                    <table class="line-items-table">
                        <thead>
                            <tr>
                                <th style="flex:1.5">SKU</th>
                                <th style="flex:3">Description</th>
                                <th style="flex:1;text-align:right">Qty</th>
                                <th style="flex:1;text-align:right">Unit Price</th>
                                <th style="flex:1;text-align:right">Total</th>
                                <th style="flex:none;width:36px"></th>
                            </tr>
                        </thead>
                        <tbody id="line-items-body"></tbody>
                    </table>
                    <button type="button" id="add-line-btn" class="add-line-btn">+ Add line</button>
                </div>
                <div class="order-totals">
                    <div class="totals-row">
                        <span>Subtotal (excl. GST)</span>
                        <span id="form-total">$0.00</span>
                    </div>
                    <div class="totals-row">
                        <span>GST (15%)</span>
                        <span id="form-gst">$0.00</span>
                    </div>
                    <div class="totals-row totals-grand totals-gst-border">
                        <span>Total incl. GST</span>
                        <span id="form-total-gst">$0.00</span>
                    </div>
                </div>
            </section>

            <!-- Packing Notes -->
            <section class="form-section">
                <h2 class="form-section-title">Packing Notes <span class="form-hint">optional</span></h2>
                <div class="form-field">
                    <textarea id="packing-notes" rows="3" placeholder="Any special handling, packaging instructions, or delivery notes…">${escHtml(defaults.packingNotes || '')}</textarea>
                </div>
            </section>

            <div class="form-actions">
                <div id="form-error" class="form-error" style="display:none"></div>
                <button type="button" id="submit-order-btn" class="btn-primary btn-lg">${submitLabel}</button>
            </div>
        </form>`;
    }

    // ── Wire form interactions (shared by new + edit) ──
    function wireOrderForm({ customers, catalogStores, catalogItems, defaults = {} }) {
        wireCustomerSection(customers);
        if (catalogStores.length) wireStoreSearch(catalogStores);

        // Live preview: ORD-1021 → INV-1021
        document.getElementById('order-number')?.addEventListener('input', e => {
            const preview = document.getElementById('order-num-preview');
            if (preview) preview.textContent = e.target.value.trim() || '…';
        });

        lineCount = 0;
        // Pre-populate existing lines or add a blank one
        const existingLines = defaults.lines || [];
        if (existingLines.length) {
            existingLines.forEach(l => addLineItem(catalogItems, l));
        } else {
            addLineItem(catalogItems);
        }

        document.getElementById('add-line-btn').addEventListener('click', () => addLineItem(catalogItems));
    }

    function wireCustomerSearch(customers) {
        const searchEl = document.getElementById('customer-search');
        const dropdown = document.getElementById('customer-dropdown');
        const idInput = document.getElementById('customer-id');
        const nameInput = document.getElementById('customer-name-val');
        if (!searchEl || !dropdown) return;

        searchEl.addEventListener('input', () => {
            nameInput.value = searchEl.value;
            idInput.value = '';
            const q = searchEl.value.toLowerCase().trim();
            if (!q) { dropdown.style.display = 'none'; return; }
            const matches = customers.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
            if (!matches.length) { dropdown.style.display = 'none'; return; }
            dropdown.innerHTML = matches.map(c =>
                `<div class="customer-option" data-id="${c.xeroContactId}" data-name="${escHtml(c.name)}">${escHtml(c.name)}</div>`
            ).join('');
            dropdown.style.display = '';
        });

        dropdown.addEventListener('mousedown', e => {
            const opt = e.target.closest('.customer-option');
            if (!opt) return;
            searchEl.value = opt.dataset.name;
            idInput.value = opt.dataset.id;
            nameInput.value = opt.dataset.name;
            dropdown.style.display = 'none';
        });

        document.addEventListener('click', e => {
            if (!e.target.closest('.customer-search-wrap')) dropdown.style.display = 'none';
        });
    }

    function wireStoreSearch(stores) {
        const input = document.getElementById('ship-branch');
        const dropdown = document.getElementById('store-dropdown');
        if (!input || !dropdown) return;

        input.addEventListener('input', () => {
            const q = input.value.toLowerCase().trim();
            if (!q) { dropdown.style.display = 'none'; return; }
            const matches = stores.filter(s =>
                (s.customer || '').toLowerCase().includes(q) ||
                (s.branch || '').toLowerCase().includes(q) ||
                (s.city || '').toLowerCase().includes(q)
            ).slice(0, 8);
            if (!matches.length) { dropdown.style.display = 'none'; return; }
            dropdown.innerHTML = matches.map(s => {
                const label = [s.customer, s.branch].filter(Boolean).join(' — ');
                const addr  = [s.streetAddress, s.city, s.postcode].filter(Boolean).join('\n');
                const displayName = [s.customer, s.branch].filter(Boolean).join(' - ');
                return `<div class="customer-option"
                    data-name="${escHtml(displayName)}"
                    data-addr="${escHtml(addr)}"
                    data-customer="${escHtml(s.customer || '')}"
                    data-accountid="${escHtml(s.accountId || '')}">
                    ${escHtml(label)}<span class="store-city">${escHtml(s.city)}</span>
                </div>`;
            }).join('');
            dropdown.style.display = '';
        });

        dropdown.addEventListener('mousedown', e => {
            const opt = e.target.closest('.customer-option');
            if (!opt) return;
            input.value = opt.dataset.name;
            document.getElementById('ship-address').value = opt.dataset.addr;
            const storeCustName = opt.dataset.customer || '';
            if (storeCustName) {
                // Try to match a preset radio button first
                const preset = CUSTOMER_PRESETS.find(p =>
                    storeCustName.toLowerCase() === p.xeroName.toLowerCase() ||
                    storeCustName.toLowerCase().includes(p.label.toLowerCase())
                );
                const radioToCheck = document.querySelector(
                    `input[name="customer-preset"][value="${preset ? preset.key : 'other'}"]`
                );
                if (radioToCheck && !radioToCheck.checked) {
                    radioToCheck.checked = true;
                    radioToCheck.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // If matched "other", also fill the text field
                if (!preset) {
                    const customerSearch = document.getElementById('customer-search');
                    const customerNameVal = document.getElementById('customer-name-val');
                    if (customerSearch) customerSearch.value = storeCustName;
                    if (customerNameVal) customerNameVal.value = storeCustName;
                }
            }
            dropdown.style.display = 'none';
        });

        document.addEventListener('click', e => {
            if (!e.target.closest('.customer-search-wrap')) dropdown.style.display = 'none';
        });
    }

    let lineCount = 0;

    function getPriceForQty(item, qty) {
        // Use || (not ??) so a stored 0 falls through to the next field rather than returning 0
        const base = item.defaultPrice || item.unitPrice || item.price || 0;
        if (item.pb3Quantity && qty >= item.pb3Quantity) return item.pb3Price || base;
        if (item.pb2Quantity && qty >= item.pb2Quantity) return item.pb2Price || base;
        if (item.pb1Quantity && qty >= item.pb1Quantity) return item.pb1Price || base;
        return base;
    }

    function addLineItem(catalogItems = [], prefill = null) {
        const idx = lineCount++;
        const tbody = document.getElementById('line-items-body');
        const tr = document.createElement('tr');
        tr.className = 'line-item-row';
        tr.dataset.idx = idx;
        tr.innerHTML = `
            <td style="flex:1.5">
                <input type="text" class="line-sku" placeholder="e.g. PT-I-10" autocomplete="off" value="${escHtml(prefill?.sku || '')}">
            </td>
            <td style="flex:3">
                <input type="text" class="line-desc" placeholder="Product / description" required value="${escHtml(prefill?.description || '')}">
            </td>
            <td style="flex:1">
                <input type="number" class="line-qty" value="${prefill?.quantity ?? 1}" min="0" step="any" required>
            </td>
            <td style="flex:1">
                <input type="number" class="line-price" value="${prefill?.unitPrice ?? ''}" min="0" step="0.01" placeholder="0.00" required>
            </td>
            <td style="flex:1" class="line-total">$0.00</td>
            <td style="flex:none;width:36px">
                <button type="button" class="line-remove-btn" title="Remove">×</button>
            </td>`;

        tbody.appendChild(tr);

        const skuEl   = tr.querySelector('.line-sku');
        const descEl  = tr.querySelector('.line-desc');
        const qtyEl   = tr.querySelector('.line-qty');
        const priceEl = tr.querySelector('.line-price');
        const totalEl = tr.querySelector('.line-total');

        function updateRow() {
            const qty = parseFloat(qtyEl.value) || 0;
            if (tr._catalogItem) {
                priceEl.value = getPriceForQty(tr._catalogItem, qty).toFixed(2);
            }
            const price = parseFloat(priceEl.value) || 0;
            totalEl.textContent = '$' + fmt(qty * price);
            updateFormTotal();
        }

        // Initialise total for pre-filled rows
        if (prefill) {
            const qty = parseFloat(qtyEl.value) || 0;
            const price = parseFloat(priceEl.value) || 0;
            totalEl.textContent = '$' + fmt(qty * price);
            updateFormTotal();
        }

        qtyEl.addEventListener('input', updateRow);
        priceEl.addEventListener('input', () => {
            tr._catalogItem = null;
            const qty = parseFloat(qtyEl.value) || 0;
            const price = parseFloat(priceEl.value) || 0;
            totalEl.textContent = '$' + fmt(qty * price);
            updateFormTotal();
        });
        tr.querySelector('.line-remove-btn').addEventListener('click', () => { tr.remove(); updateFormTotal(); });

        // Item autocomplete from catalog (shared pick logic)
        if (catalogItems.length) {
            const pickCatalogItem = item => {
                tr._catalogItem = item;
                descEl.value = item.name;
                skuEl.value = item.id;
                if (item.isLoose) {
                    qtyEl.min = 10; qtyEl.step = 10;
                    if ((parseFloat(qtyEl.value) || 0) < 10) qtyEl.value = 10;
                } else {
                    qtyEl.min = 0; qtyEl.step = 'any';
                }
                const qty = parseFloat(qtyEl.value) || 1;
                priceEl.value = (getPriceForQty(item, qty) ?? 0).toFixed(2);
                updateRow();
            };

            // SKU field autocomplete
            const skuDropdown = document.createElement('div');
            skuDropdown.className = 'customer-dropdown';
            skuDropdown.style.display = 'none';
            skuEl.parentNode.style.position = 'relative';
            skuEl.parentNode.appendChild(skuDropdown);

            skuEl.addEventListener('input', () => {
                tr._catalogItem = null;
                const q = skuEl.value.toLowerCase().trim();
                if (!q) { skuDropdown.style.display = 'none'; return; }
                const matches = catalogItems.filter(i =>
                    (i.id && i.id.toLowerCase().includes(q)) || (i.name || '').toLowerCase().includes(q)
                ).slice(0, 6);
                if (!matches.length) { skuDropdown.style.display = 'none'; return; }
                skuDropdown.innerHTML = matches.map(i =>
                    `<div class="customer-option" data-idx="${catalogItems.indexOf(i)}"><strong>${escHtml(i.id)}</strong><span class="store-city">${escHtml(i.name)}</span></div>`
                ).join('');
                skuDropdown.style.display = '';
            });
            skuDropdown.addEventListener('mousedown', e => {
                const opt = e.target.closest('.customer-option');
                if (!opt) return;
                const item = catalogItems[parseInt(opt.dataset.idx)];
                if (item) { pickCatalogItem(item); skuDropdown.style.display = 'none'; }
            });
            skuEl.addEventListener('blur', () => setTimeout(() => { skuDropdown.style.display = 'none'; }, 150));

            // Description field autocomplete
            const itemDropdown = document.createElement('div');
            itemDropdown.className = 'customer-dropdown';
            itemDropdown.style.display = 'none';
            descEl.parentNode.style.position = 'relative';
            descEl.parentNode.appendChild(itemDropdown);

            descEl.addEventListener('input', () => {
                tr._catalogItem = null;
                const q = descEl.value.toLowerCase().trim();
                if (!q) { itemDropdown.style.display = 'none'; return; }
                const matches = catalogItems.filter(i =>
                    (i.name || '').toLowerCase().includes(q) || (i.id && i.id.toLowerCase().includes(q))
                ).slice(0, 6);
                if (!matches.length) { itemDropdown.style.display = 'none'; return; }
                itemDropdown.innerHTML = matches.map(i =>
                    `<div class="customer-option" data-idx="${catalogItems.indexOf(i)}">${escHtml(i.name)}<span class="store-city">${escHtml(i.id)}</span></div>`
                ).join('');
                itemDropdown.style.display = '';
            });
            itemDropdown.addEventListener('mousedown', e => {
                const opt = e.target.closest('.customer-option');
                if (!opt) return;
                const item = catalogItems[parseInt(opt.dataset.idx)];
                if (item) { pickCatalogItem(item); itemDropdown.style.display = 'none'; }
            });
            descEl.addEventListener('blur', () => setTimeout(() => { itemDropdown.style.display = 'none'; }, 150));
        }
    }

    function updateFormTotal() {
        let subtotal = 0;
        document.querySelectorAll('.line-item-row').forEach(tr => {
            const qty = parseFloat(tr.querySelector('.line-qty').value) || 0;
            const price = parseFloat(tr.querySelector('.line-price').value) || 0;
            subtotal += qty * price;
        });
        const gst = subtotal * 0.15;
        const elSub  = document.getElementById('form-total');
        const elGst  = document.getElementById('form-gst');
        const elIncl = document.getElementById('form-total-gst');
        if (elSub)  elSub.textContent  = '$' + fmt(subtotal);
        if (elGst)  elGst.textContent  = '$' + fmt(gst);
        if (elIncl) elIncl.textContent = '$' + fmt(subtotal + gst);
    }

    function getLineItems() {
        const lines = [];
        document.querySelectorAll('.line-item-row').forEach(tr => {
            const sku = tr.querySelector('.line-sku').value.trim();
            const desc = tr.querySelector('.line-desc').value.trim();
            const qty = parseFloat(tr.querySelector('.line-qty').value);
            const price = parseFloat(tr.querySelector('.line-price').value);
            if (desc && !isNaN(price)) {
                lines.push({ sku, description: desc, quantity: isNaN(qty) ? 0 : qty, unitPrice: price });
            }
        });
        return lines;
    }

    function getCustomerFromForm() {
        return {
            xeroContactId: document.getElementById('customer-id')?.value || '',
            name: document.getElementById('customer-name-val')?.value.trim() ||
                  document.getElementById('customer-search')?.value.trim() || '',
        };
    }

    function showFormError(msg) {
        const el = document.getElementById('form-error');
        if (!el) return;
        el.textContent = msg;
        el.style.display = msg ? '' : 'none';
    }

    async function submitNewOrder() {
        showFormError('');
        const customer = getCustomerFromForm();
        if (!customer.name) { showFormError('Customer name is required.'); return; }
        const lines = getLineItems();
        if (!lines.length) { showFormError('Add at least one line item.'); return; }

        const btn = document.getElementById('submit-order-btn');
        btn.disabled = true; btn.textContent = 'Creating…';

        try {
            const order = await api('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer,
                    orderNumber: document.getElementById('order-number')?.value.trim() || '',
                    poNumber: document.getElementById('po-number').value.trim(),
                    shipTo: {
                        branch: document.getElementById('ship-branch').value.trim(),
                        address: document.getElementById('ship-address').value.trim(),
                    },
                    lines,
                    packingNotes: document.getElementById('packing-notes').value.trim(),
                }),
            });
            await logEvent(order.id, 'Order created');
            location.hash = 'orders/' + order.id;
        } catch (e) {
            showFormError(e.message);
            btn.disabled = false; btn.textContent = 'Create Order';
        }
    }

    async function submitEditOrder(orderId) {
        showFormError('');
        const customer = getCustomerFromForm();
        if (!customer.name) { showFormError('Customer name is required.'); return; }
        const lines = getLineItems();
        if (!lines.length) { showFormError('Add at least one line item.'); return; }

        const btn = document.getElementById('submit-order-btn');
        btn.disabled = true; btn.textContent = 'Saving…';

        try {
            await api('/api/orders/' + orderId, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    customer,
                    poNumber: document.getElementById('po-number').value.trim(),
                    shipTo: {
                        branch: document.getElementById('ship-branch').value.trim(),
                        address: document.getElementById('ship-address').value.trim(),
                    },
                    lines,
                    packingNotes: document.getElementById('packing-notes').value.trim(),
                }),
            });
            await logEvent(orderId, 'Order edited');
            location.hash = 'orders/' + orderId;
        } catch (e) {
            showFormError(e.message);
            btn.disabled = false; btn.textContent = 'Save Changes';
        }
    }

    // Read the printer registry from the loaded config. Each entry:
    //   { id: <PrintNode printer id>, label: "Warehouse", documents: ["slip","address","label"] }
    function getPrinters() {
        // currentConfig is declared with `let` at top of app.js — shared across non-module scripts.
        const cfg = (typeof currentConfig !== 'undefined') ? currentConfig : null;
        return Array.isArray(cfg?.printers) ? cfg.printers : [];
    }

    // Render one overflow-menu button per printer that supports the given document type.
    // `prefix` is prepended to the label ("Send address to Warehouse" etc.).
    // `indent` adds left padding so items sit visually beneath a section heading.
    function printerMenuItems(docType, { prefix = '', indent = false, orderId = null } = {}) {
        return getPrinters()
            .filter(p => Array.isArray(p.documents) && p.documents.includes(docType))
            .map(p => {
                const label = (p.label || ('Printer #' + p.id));
                const cls = 'overflow-item' + (indent ? ' overflow-indent' : '');
                const orderAttr = orderId ? ` data-order-id="${escHtml(orderId)}"` : '';
                return `<button class="${cls}" data-print-doc="${escHtml(docType)}" data-print-id="${escHtml(p.id)}" data-print-label="${escHtml(label)}"${orderAttr}>${escHtml(prefix + label)}</button>`;
            })
            .join('');
    }

    // ── Action bar buttons — driven by order status ──
    function actionButtons(order, xeroConnected) {
        const edit = `<a href="#orders/${order.id}/edit" class="btn-secondary btn-sm" id="edit-order-btn">Edit</a>`;

        let primaryAction = '';
        let xeroMenuItem  = '';

        if (order.status === 'new') {
            primaryAction = `<button class="btn-secondary btn-sm" disabled title="Print the packing slip first to review it">Send to Xero</button>`;
        } else if (order.status === 'reviewed') {
            primaryAction = xeroConnected
                ? `<button id="push-xero-btn" class="btn-primary">Send to Xero</button>`
                : `<span class="xero-not-connected">Xero not connected</span>`;
        } else if (order.status === 'sent_to_xero') {
            primaryAction = `<button id="dispatch-btn" class="btn-primary">Mark as Dispatched</button>`;
            if (order.xeroInvoiceId) {
                const url = `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${encodeURIComponent(order.xeroInvoiceId)}`;
                xeroMenuItem = `<a href="${url}" target="_blank" rel="noopener" class="overflow-item">✓ ${escHtml(order.xeroInvoiceNumber)} — View in Xero ↗</a>`;
            }
        } else {
            primaryAction = `<span class="status-dispatched-tag">✓ Dispatched</span>`;
            if (order.xeroInvoiceId) {
                const url = `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${encodeURIComponent(order.xeroInvoiceId)}`;
                xeroMenuItem = `<a href="${url}" target="_blank" rel="noopener" class="overflow-item">✓ ${escHtml(order.xeroInvoiceNumber)} — View in Xero ↗</a>`;
            }
        }

        const menu = `
            <div class="overflow-menu">
                <button class="overflow-trigger btn-secondary btn-sm" title="More actions" onclick="event.stopPropagation();this.closest('.overflow-menu').classList.toggle('open')">•••</button>
                <div class="overflow-dropdown">
                    ${xeroMenuItem}
                    <div class="overflow-section">Send Packing Slip</div>
                    ${printerMenuItems('slip', { indent: true })}
                    <button class="overflow-item overflow-indent" id="print-slip-btn">Local Printer</button>
                    <hr class="overflow-divider">
                    <button class="overflow-item" id="print-address-btn">Print Address</button>
                    ${printerMenuItems('address', { prefix: 'Send Address to ' })}
                    <hr class="overflow-divider">
                    <button class="overflow-item" id="link-xero-btn">Link Xero Invoice…</button>
                    <hr class="overflow-divider">
                    <button class="overflow-item overflow-danger" id="delete-order-btn">Delete</button>
                </div>
            </div>`;

        return `${edit}${primaryAction}${menu}`;
    }

    function refreshActionBar(order) {
        const sel = document.getElementById('order-status-sel');
        if (sel) sel.value = order.status;
        const actionBtns = document.getElementById('action-btns');
        if (!actionBtns) return; // not on the detail view — nothing to refresh
        actionBtns.innerHTML = actionButtons(order, xeroConnected);
        wireDetailButtons(order);
    }

    // The order-detail container element. Looked up by id rather than threaded
    // through every handler — wireDetailButtons runs in a closure over `order`
    // but not `container`, so anywhere a full re-render is needed we resolve it
    // here.
    function getDetailContainer() {
        return document.getElementById('orders-detail-container');
    }

    // ── Order detail / packing slip ──
    async function renderDetail(container, orderId) {
        container.classList.add('slip-view');
        container.innerHTML = `<div id="order-detail-body"><div class="orders-loading">Loading…</div></div>`;

        let order;
        try {
            order = await api('/api/orders/' + orderId);
        } catch (e) {
            document.getElementById('order-detail-body').innerHTML =
                `<div class="orders-error">${e.message}</div>`;
            return;
        }

        await checkXeroStatus();

        const body = document.getElementById('order-detail-body');

        body.innerHTML = `
        <!-- Action bar (hidden when printing) -->
        <div class="order-actions no-print">
            <div class="order-actions-left">
                <a href="#orders" class="btn-secondary btn-sm">← Orders</a>
                <select id="order-status-sel" class="order-status-sel">
                    ${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}"${order.status === k ? ' selected' : ''}>${v}</option>`).join('')}
                </select>
            </div>
            <div class="order-actions-right" id="action-btns">
                ${actionButtons(order, xeroConnected)}
            </div>
        </div>

        <!-- Packing Slip (printable) -->
        <div class="packing-slip" id="packing-slip">${slipBodyHTML(order)}</div>

        <!-- Activity log (hidden when printing) -->
        ${renderEventLog(order.events || [])}`;

        wireDetailButtons(order);
    }

    function renderEventLog(events) {
        if (!events.length) return `<div class="event-log no-print"><p class="event-log-empty">No activity yet.</p></div>`;
        return `
        <div class="event-log no-print">
            <h3 class="event-log-title">Activity</h3>
            <div class="event-list">
                ${events.map(e => `
                <div class="event-item">
                    <span class="event-who">${escHtml(e.user)}</span>
                    <span class="event-action">${escHtml(e.action)}</span>
                    ${e.detail ? `<span class="event-detail">${escHtml(e.detail)}</span>` : ''}
                    <span class="event-time">${fmtDateTime(e.timestamp)}</span>
                </div>`).join('')}
            </div>
        </div>`;
    }

    // Address sheet — A4 landscape. The body markup and styles are shared between
    // the "Print Address" popup (browser print) and the "Send Address to Printer"
    // PrintNode flow (off-screen html2pdf capture).
    const ADDRESS_PAGE_STYLES = `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: white; }
        .page {
            width: 297mm; min-height: 210mm;
            padding: 16mm 22mm 14mm;
            display: flex; flex-direction: column;
        }
        .addr-header {
            display: flex; justify-content: space-between; align-items: flex-start;
            border-bottom: 2px solid #1e293b; padding-bottom: 7mm; margin-bottom: 9mm;
        }
        .addr-from { font-size: 9pt; color: #475569; line-height: 1.6; }
        .addr-from strong { display: block; font-size: 11pt; color: #1e293b; margin-bottom: 2mm; }
        .addr-label {
            font-size: 9pt; font-weight: 700; text-transform: uppercase;
            letter-spacing: 0.12em; color: #94a3b8; margin-bottom: 5mm;
        }
        .addr-to { flex: 1; }
        .addr-name { font-size: 36pt; font-weight: 700; color: #1e293b; line-height: 1.15; margin-bottom: 5mm; }
        .addr-street { font-size: 22pt; color: #334155; line-height: 1.5; white-space: pre-line; }
        .addr-refs {
            margin-top: auto; padding-top: 8mm; border-top: 1px solid #e2e8f0;
            font-size: 10pt; color: #64748b; display: flex; gap: 12mm;
        }
        @media print { @page { size: A4 landscape; margin: 0; } body { print-color-adjust: exact; } }
    `;

    // Inner content of the printable .packing-slip element. Pulled out so the
    // same markup can be rendered on the detail view, off-screen for PrintNode
    // sends, or in a popup for browser-print.
    function slipBodyHTML(order) {
        return `
            <div class="slip-top">
                <img src="enviroware_logo_clean.png" alt="Enviroware" class="slip-logo">
                <div class="slip-title">PACKING SLIP</div>
            </div>

            <hr class="slip-rule">

            <div class="slip-body">
                <div class="slip-from">
                    <div class="slip-col-label">FROM</div>
                    <div class="slip-from-name">Enviroware</div>
                    <div class="slip-from-addr">93 Tetley Road,<br>Katikati</div>

                    <div class="slip-inv-details">
                        <div class="slip-col-label">INVOICE DETAILS</div>
                        ${order.xeroInvoiceNumber
                            ? `<div class="slip-inv-row"><span>Invoice No.</span><strong>${escHtml(order.xeroInvoiceNumber)}</strong></div>`
                            : ''}
                        <div class="slip-inv-row"><span>Order</span><strong>${escHtml(order.id)}</strong></div>
                        ${order.poNumber
                            ? `<div class="slip-inv-row"><span>PO</span><strong>${escHtml(order.poNumber)}</strong></div>`
                            : ''}
                    </div>
                </div>

                <div class="slip-shipto">
                    <div class="slip-col-label">SHIP TO</div>
                    ${order.shipTo?.branch
                        ? `<div class="slip-shipto-name">${escHtml(order.shipTo.branch)}</div>`
                        : `<div class="slip-shipto-name">${escHtml(order.customer.name)}</div>`}
                    ${order.shipTo?.address
                        ? `<div class="slip-shipto-addr">${escHtml(order.shipTo.address).replace(/\n/g, '<br>')}</div>`
                        : ''}
                </div>
            </div>

            <hr class="slip-rule">

            <table class="slip-lines">
                <thead>
                    <tr>
                        <th class="sl-qty">QTY</th>
                        <th class="sl-sku">SKU</th>
                        <th class="sl-desc">DESCRIPTION</th>
                        <th class="sl-num">UNIT PRICE</th>
                    </tr>
                </thead>
                <tbody>
                    ${(order.lines || []).map(l => `
                    <tr>
                        <td class="sl-qty">${l.quantity || ''}</td>
                        <td class="sl-sku">${escHtml(l.sku || '')}</td>
                        <td class="sl-desc">${escHtml(l.description)}</td>
                        <td class="sl-num">$${fmt(l.unitPrice)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>

            ${order.packingNotes ? `
            <div class="slip-notes">
                <div class="slip-notes-label">Packing Notes</div>
                <div class="slip-notes-text">${escHtml(order.packingNotes).replace(/\n/g, '<br>')}</div>
            </div>` : ''}

            <div class="slip-footer">
                Enviroware &middot; orders@primetie.co.nz &middot; (07) 549-1716 &middot; 93 Tetley Road, Katikati
            </div>`;
    }

    function addressPageBodyHTML(order) {
        const to   = order.shipTo?.branch || order.customer?.name || '';
        const addr = order.shipTo?.address || '';
        const ref  = order.xeroInvoiceNumber || order.id;
        const po   = order.poNumber ? `PO: ${order.poNumber}` : '';
        return `
            <div class="page">
                <div class="addr-header">
                    <div class="addr-from">
                        <strong>Enviroware</strong>
                        93 Tetley Road, Katikati<br>
                        orders@primetie.co.nz · (07) 549-1716
                    </div>
                    <div style="text-align:right; font-size:10pt; color:#64748b">
                        <strong style="color:#1e293b">${escHtml(ref)}</strong>
                        ${po ? `<br>${escHtml(po)}` : ''}
                    </div>
                </div>
                <div class="addr-label">Deliver to</div>
                <div class="addr-to">
                    <div class="addr-name">${escHtml(to)}</div>
                    ${addr ? `<div class="addr-street">${escHtml(addr)}</div>` : ''}
                </div>
                <div class="addr-refs">
                    <span>Order: <strong>${escHtml(order.id)}</strong></span>
                    ${po ? `<span>${escHtml(po)}</span>` : ''}
                </div>
            </div>`;
    }

    // Modal for "Link to Xero Invoice" — replaces the older two-prompt() flow.
    // Returns a Promise that resolves to { invoiceId, invoiceNumber } on Link
    // or null on Cancel/Esc/click-outside.
    function openLinkXeroModal({ invoiceId = '', invoiceNumber = '' } = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal-box">
                    <h3 class="modal-title">Link to Xero Invoice</h3>
                    <div class="modal-field">
                        <label>Xero invoice URL or ID</label>
                        <input type="text" id="lx-id" placeholder="Paste URL or InvoiceID" value="${escHtml(invoiceId)}">
                        <span class="modal-hint">Accepts the full Edit.aspx URL or just the GUID.</span>
                    </div>
                    <div class="modal-field">
                        <label>Invoice number <span class="modal-hint">optional</span></label>
                        <input type="text" id="lx-num" placeholder="INV-1042" value="${escHtml(invoiceNumber)}">
                    </div>
                    <div id="lx-error" style="display:none;color:#dc2626;font-size:0.9em;margin-bottom:0.65rem"></div>
                    <div class="modal-actions">
                        <button class="btn-primary" id="lx-save">Link</button>
                        <button class="btn-secondary" id="lx-cancel">Cancel</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);

            const idInput  = overlay.querySelector('#lx-id');
            const numInput = overlay.querySelector('#lx-num');
            const errEl    = overlay.querySelector('#lx-error');
            const saveBtn  = overlay.querySelector('#lx-save');

            const close = value => {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(value);
            };
            const onKey = e => {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter' && (e.target === idInput || e.target === numInput)) save();
            };
            const save = () => {
                const raw = idInput.value.trim();
                if (!raw) { errEl.textContent = 'Paste a Xero URL or invoice ID.'; errEl.style.display = ''; return; }
                const guidMatch = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                const id = guidMatch ? guidMatch[0] : raw;
                if (!guidMatch && !/^[0-9a-f-]{20,}$/i.test(id)) {
                    errEl.textContent = "Couldn't find an InvoiceID GUID in that input.";
                    errEl.style.display = '';
                    return;
                }
                close({ invoiceId: id, invoiceNumber: numInput.value.trim() || null });
            };

            saveBtn.addEventListener('click', save);
            overlay.querySelector('#lx-cancel').addEventListener('click', () => close(null));
            overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
            document.addEventListener('keydown', onKey);

            setTimeout(() => idInput.focus(), 0);
        });
    }

    function printAddressPopup(order) {
        const ref = order.xeroInvoiceNumber || order.id;
        const win = window.open('', '_blank', 'width=1100,height=780');
        win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
            <title>Address – ${escHtml(ref)}</title>
            <style>${ADDRESS_PAGE_STYLES}</style>
            </head><body>${addressPageBodyHTML(order)}</body></html>`);
        win.document.close();
        win.focus();
        setTimeout(() => { win.print(); }, 400);
    }

    // Render an element to a base64-encoded PDF (no data: prefix) using html2pdf.
    // Element must already be in the DOM so it has computed dimensions.
    async function elementToPdfBase64(el, { orientation = 'portrait' } = {}) {
        if (typeof html2pdf === 'undefined') {
            throw new Error('PDF library not loaded — refresh the page and try again');
        }
        const dataUri = await html2pdf()
            .set({
                margin: 0,
                html2canvas: { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false },
                jsPDF: { unit: 'mm', format: 'a4', orientation },
            })
            .from(el)
            .outputPdf('datauristring');
        // Strip "data:application/pdf;base64,"
        return dataUri.split(',')[1];
    }

    async function sendToPrintNode({ order, document: doc, pdfBase64, printerId }) {
        return api('/api/print', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: order.id, document: doc, pdfBase64, printerId }),
        });
    }

    // Translate a PrintNode terminal failure into a single line for both
    // the on-screen banner and the order log.
    function describePrintFailure(result) {
        return result.message ? `${result.state}: ${result.message}` : result.state;
    }

    async function sendSlipToPrinter(order, btn, { printerId, label } = {}) {
        const orig = btn?.textContent;
        const dest = label || 'printer';
        if (btn) { btn.disabled = true; btn.textContent = `Printing → ${dest}…`; }

        // Render the slip off-screen so this works from the list view too
        // (where #packing-slip isn't on the page). Same .packing-slip class
        // means the page's existing CSS is applied at capture time.
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-100000px;top:0;background:#fff;';
        host.innerHTML = `<div class="packing-slip">${slipBodyHTML(order)}</div>`;
        document.body.appendChild(host);

        try {
            const slipEl = host.querySelector('.packing-slip');
            const pdfBase64 = await elementToPdfBase64(slipEl, { orientation: 'portrait' });
            const result = await sendToPrintNode({ order, document: 'slip', pdfBase64, printerId });

            const jobRef = `PrintNode job #${result.jobId}`;

            if (result.success) {
                // Confirmed printed — terminal state was 'done'.
                showToast(`Slip printed at ${dest} (${jobRef})`);
                logEvent(order.id, 'Printed packing slip', `${dest} · ${jobRef}`);
                if (order.status === 'new') {
                    api('/api/orders/' + order.id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'reviewed' }),
                    }).then(() => {
                        order.status = 'reviewed';
                        refreshActionBar(order);
                    }).catch(() => {});
                }
            } else if (result.confirmed) {
                // Terminal failure (error/cancelled/expired) — surface PrintNode's verbatim message.
                const detail = describePrintFailure(result);
                showErrorBanner(`Print FAILED at ${dest} — ${detail}. Use "Print in browser" as a fallback. (${jobRef})`);
                logEvent(order.id, 'Print failed', `${dest} · ${detail} · ${jobRef}`);
            } else {
                // Polling closed without a terminal state — likely the local PrintNode Client is offline.
                const stateLabel = result.state || 'pending';
                showErrorBanner(`Slip not confirmed at ${dest} after 25s — last state: ${stateLabel}. The PrintNode Client may be offline. Use "Print in browser" as a fallback. (${jobRef})`);
                logEvent(order.id, 'Print unconfirmed', `${dest} · last state: ${stateLabel} · ${jobRef}`);
            }
        } catch (e) {
            showErrorBanner('Print failed: ' + e.message);
            logEvent(order.id, 'Print error', e.message);
        } finally {
            host.remove();
            if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    async function sendAddressToPrinter(order, btn, { printerId, label } = {}) {
        const orig = btn?.textContent;
        const dest = label || 'printer';
        if (btn) { btn.disabled = true; btn.textContent = `Printing → ${dest}…`; }

        // Render the address sheet off-screen so html2canvas can capture it at its
        // declared 297mm × 210mm size, then remove it.
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-100000px;top:0;background:#fff;';
        host.innerHTML =
            `<style>${ADDRESS_PAGE_STYLES}</style>${addressPageBodyHTML(order)}`;
        document.body.appendChild(host);

        try {
            const page = host.querySelector('.page');
            const pdfBase64 = await elementToPdfBase64(page, { orientation: 'landscape' });
            const result = await sendToPrintNode({ order, document: 'address', pdfBase64, printerId });

            const jobRef = `PrintNode job #${result.jobId}`;

            if (result.success) {
                showToast(`Address printed at ${dest} (${jobRef})`);
                logEvent(order.id, 'Printed address sheet', `${dest} · ${jobRef}`);
            } else if (result.confirmed) {
                const detail = describePrintFailure(result);
                showErrorBanner(`Address print FAILED at ${dest} — ${detail}. (${jobRef})`);
                logEvent(order.id, 'Address print failed', `${dest} · ${detail} · ${jobRef}`);
            } else {
                const stateLabel = result.state || 'pending';
                showErrorBanner(`Address not confirmed at ${dest} after 25s — last state: ${stateLabel}. The PrintNode Client may be offline. (${jobRef})`);
                logEvent(order.id, 'Address print unconfirmed', `${dest} · last state: ${stateLabel} · ${jobRef}`);
            }
        } catch (e) {
            showErrorBanner('Print failed: ' + e.message);
            logEvent(order.id, 'Print error', e.message);
        } finally {
            host.remove();
            if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    function wireDetailButtons(order) {
        const orderId = order.id;

        // Status override dropdown — guard against duplicate listeners since the select
        // persists across refreshActionBar() calls (it's outside #action-btns).
        const statusSel = document.getElementById('order-status-sel');
        if (statusSel && !statusSel._wired) {
            statusSel._wired = true;
            statusSel.addEventListener('change', async e => {
                const newStatus = e.target.value;
                const prev = order.status;
                try {
                    await api('/api/orders/' + orderId, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: newStatus, event: { ts: new Date().toISOString(), msg: `Status set to ${STATUS_LABELS[newStatus]}` } }),
                    });
                    order.status = newStatus;
                    // Only rebuild action buttons — status-sel already has its listener
                    document.getElementById('action-btns').innerHTML = actionButtons(order, xeroConnected);
                    wireDetailButtons(order); // safe: _wired prevents re-adding status listener
                } catch (err) {
                    showErrorBanner('Could not update status: ' + err.message);
                    e.target.value = prev;
                }
            });
        }

        // Link to existing Xero invoice (manual reconciliation)
        document.getElementById('link-xero-btn')?.addEventListener('click', async () => {
            const result = await openLinkXeroModal({
                invoiceId: order.xeroInvoiceId || '',
                invoiceNumber: order.xeroInvoiceNumber || '',
            });
            if (!result) return;
            const { invoiceId, invoiceNumber } = result;
            try {
                const updated = await api('/api/orders/' + orderId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        xeroInvoiceId: invoiceId,
                        xeroInvoiceNumber: invoiceNumber,
                        status: order.status === 'new' ? 'reviewed' : order.status,
                        event: { ts: new Date().toISOString(), msg: `Linked to Xero invoice ${invoiceNumber || invoiceId}` },
                    }),
                });
                Object.assign(order, updated);
                showToast('Linked to Xero');
                await Orders.renderDetail(getDetailContainer(), orderId);
            } catch (e) {
                showErrorBanner('Link failed: ' + e.message);
            }
        });


        // Delete order
        document.getElementById('delete-order-btn')?.addEventListener('click', async () => {
            if (!confirm(`Delete order ${orderId}? This cannot be undone.`)) return;
            try {
                await api('/api/orders/' + orderId, { method: 'DELETE' });
                location.hash = 'orders';
            } catch (e) {
                showErrorBanner('Delete failed: ' + e.message);
            }
        });

        // Print address sheet
        document.getElementById('print-address-btn')?.addEventListener('click', () => {
            printAddressPopup(order);
        });

        // Send-to-printer buttons are rendered dynamically from config.printers — one per
        // (printer × document) combo. Wire them via data attributes rather than fixed ids.
        document.querySelectorAll('#action-btns [data-print-doc]').forEach(btn => {
            btn.addEventListener('click', e => {
                const doc       = btn.dataset.printDoc;
                const printerId = Number(btn.dataset.printId);
                const label     = btn.dataset.printLabel || ('Printer #' + printerId);
                if (doc === 'slip')    sendSlipToPrinter(order, e.currentTarget, { printerId, label });
                if (doc === 'address') sendAddressToPrinter(order, e.currentTarget, { printerId, label });
            });
        });

        // Print — opens clean popup, advances new → reviewed
        document.getElementById('print-slip-btn')?.addEventListener('click', async () => {
            const slipEl = document.getElementById('packing-slip');
            if (!slipEl) return;
            const styles = Array.from(document.styleSheets)
                .map(s => { try { return Array.from(s.cssRules).map(r => r.cssText).join('\n'); } catch { return ''; } })
                .join('\n');
            const win = window.open('', '_blank', 'width=900,height=700');
            win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8">
                <title>${escHtml(order.xeroInvoiceNumber || order.id)}</title>
                <style>${styles}
                body { margin: 0; padding: 0; background: white; }
                .packing-slip { box-shadow: none; border-radius: 0; width: 100%; min-height: auto; padding: 14mm 18mm; box-sizing: border-box; }
                @media print { @page { margin: 0; size: A4; } }
                </style>
                </head><body>${slipEl.outerHTML}</body></html>`);
            win.document.close();
            win.focus();
            setTimeout(() => { win.print(); win.close(); }, 400);

            // Log the print event and advance new → reviewed
            logEvent(orderId, 'Printed packing slip', order.xeroInvoiceNumber || order.id);
            if (order.status === 'new') {
                api('/api/orders/' + orderId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'reviewed' }),
                }).then(updated => {
                    order.status = 'reviewed';
                    refreshActionBar(order);
                }).catch(err => showErrorBanner('Could not update status: ' + err.message));
            }
        });

        // Send to Xero — advances reviewed → sent_to_xero
        document.getElementById('push-xero-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('push-xero-btn');
            btn.disabled = true;
            btn.textContent = 'Sending to Xero…';
            clearErrorBanner();
            try {
                const result = await api('/api/xero/push', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId }),
                });
                // Persist status change
                await api('/api/orders/' + orderId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'sent_to_xero' }),
                });
                // Update invoice on the slip
                const invRow = document.querySelector('.slip-inv-details .slip-inv-row strong');
                if (invRow) invRow.textContent = result.invoiceNumber;
                order.status = 'sent_to_xero';
                order.xeroInvoiceNumber = result.invoiceNumber;
                // Update status select to reflect new status
                const sel = document.getElementById('order-status-sel');
                if (sel) sel.value = 'sent_to_xero';
                refreshActionBar(order);
                logEvent(orderId, 'Sent to Xero', result.invoiceNumber);
                showToast('Invoice created in Xero: ' + result.invoiceNumber);
            } catch (e) {
                console.error('Xero push failed:', e);
                const msg = e.message || 'Unknown error — check browser console';
                showErrorBanner('Xero push failed: ' + msg);
                showToast('Xero push failed: ' + msg);
                btn.disabled = false;
                btn.textContent = 'Send to Xero';
            }
        });

        // Mark as Dispatched
        document.getElementById('dispatch-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('dispatch-btn');
            btn.disabled = true;
            btn.textContent = 'Saving…';
            clearErrorBanner();
            try {
                await api('/api/orders/' + orderId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'dispatched' }),
                });
                order.status = 'dispatched';
                refreshActionBar(order);
                logEvent(orderId, 'Marked as dispatched');
                showToast('Order marked as dispatched');
            } catch (e) {
                showErrorBanner('Error: ' + e.message);
                btn.disabled = false;
                btn.textContent = 'Mark as Dispatched';
            }
        });
    }

    // ── Error banner (persistent, above action bar) ──
    function showErrorBanner(msg) {
        let banner = document.getElementById('order-error-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'order-error-banner';
            banner.className = 'order-error-banner no-print';
            const actionsEl = document.querySelector('.order-actions');
            if (actionsEl) actionsEl.insertAdjacentElement('beforebegin', banner);
        }
        banner.innerHTML = `<span>${escHtml(msg)}</span><button onclick="document.getElementById('order-error-banner').remove()">✕</button>`;
    }

    function clearErrorBanner() {
        document.getElementById('order-error-banner')?.remove();
    }

    // ── Escape HTML ──
    function escHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Toast ──
    function showToast(msg) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }

    // ── Public API ──
    return {
        renderList,
        renderNew,
        renderEdit,
        renderDetail,
        handleXeroQueryParams() {
            const params = new URLSearchParams(location.search);
            if (params.get('xero_connected')) {
                showToast('Xero connected successfully');
                history.replaceState(null, '', location.pathname + location.hash);
            } else if (params.get('xero_error')) {
                showToast('Xero error: ' + params.get('xero_error'));
                history.replaceState(null, '', location.pathname + location.hash);
            }
        },
    };

})();
