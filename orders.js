// ── Orders module ──
// Handles all views under #orders, #orders/new, #orders/<id>

const Orders = (() => {

    // ── State ──
    let xeroConnected = false;
    let customersCache = null;

    // ── Status helpers ──
    const STATUS_LABELS = {
        confirmed: 'New',
        ready:     'Ready to Pack',
        packing:   'Packing',
        packed:    'Packed',
        dispatched:'Dispatched',
    };
    const STATUS_COLOURS = {
        confirmed: '#3b82f6',
        ready:     '#f59e0b',
        packing:   '#8b5cf6',
        packed:    '#10b981',
        dispatched:'#64748b',
    };

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

        if (!xeroConnected) {
            body.insertAdjacentHTML('beforebegin', xeroConnectBanner());
        }

        if (orders.length === 0) {
            body.innerHTML = `
            <div class="orders-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">
                    <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                    <rect x="9" y="3" width="6" height="4" rx="1"/>
                    <line x1="9" y1="12" x2="15" y2="12"/>
                    <line x1="9" y1="16" x2="12" y2="16"/>
                </svg>
                <p>No orders yet. <a href="#orders/new">Create the first one.</a></p>
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
                        <th>Date</th>
                        <th>Total</th>
                        <th>Status</th>
                        <th>Xero</th>
                    </tr>
                </thead>
                <tbody>
                    ${orders.map(o => `
                    <tr class="order-row" data-id="${o.id}" onclick="location.hash='orders/${o.id}'">
                        <td class="order-id">${o.id}</td>
                        <td>${escHtml(o.customer.name)}</td>
                        <td class="order-ship-to">${escHtml(o.shipTo?.branch || '—')}</td>
                        <td class="order-date">${fmtDate(o.createdAt)}</td>
                        <td class="order-total">$${fmt(orderTotal(o))}</td>
                        <td>${statusBadge(o.status)}</td>
                        <td class="order-xero">${o.xeroInvoiceNumber
                            ? `<span class="xero-inv-num">${escHtml(o.xeroInvoiceNumber)}</span>`
                            : '<span class="xero-pending">—</span>'}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
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
        <div id="new-order-body"><div class="orders-loading">Loading customers…</div></div>`;

        await checkXeroStatus();

        let customers = [];
        try {
            if (xeroConnected) customers = await loadCustomers();
        } catch (e) {
            // Non-fatal — will show manual entry fallback
        }

        const body = document.getElementById('new-order-body');

        if (!xeroConnected) {
            body.insertAdjacentHTML('beforebegin', xeroConnectBanner());
        }

        body.innerHTML = `
        <form id="new-order-form" class="order-form" onsubmit="return false">
            <!-- Customer -->
            <section class="form-section">
                <h2 class="form-section-title">Customer</h2>
                <div class="form-row">
                    <div class="form-field" style="flex:2">
                        <label>Customer name <span class="required">*</span></label>
                        ${customers.length
                            ? `<div class="customer-search-wrap">
                                <input type="text" id="customer-search" placeholder="Search customers…" autocomplete="off">
                                <div id="customer-dropdown" class="customer-dropdown" style="display:none"></div>
                                <input type="hidden" id="customer-id">
                                <input type="hidden" id="customer-name-val">
                               </div>`
                            : `<input type="text" id="customer-name-val" placeholder="Customer name" required>`
                        }
                    </div>
                </div>
            </section>

            <!-- PO Number -->
            <section class="form-section">
                <h2 class="form-section-title">Order Reference</h2>
                <div class="form-row">
                    <div class="form-field" style="flex:2">
                        <label>PO Number <span class="form-hint">optional</span></label>
                        <input type="text" id="po-number" placeholder="e.g. 1529131-CONF-1776762069025">
                    </div>
                </div>
            </section>

            <!-- Ship To -->
            <section class="form-section">
                <h2 class="form-section-title">Ship To</h2>
                <div class="form-row">
                    <div class="form-field" style="flex:2">
                        <label>Branch / location</label>
                        <input type="text" id="ship-branch" placeholder="e.g. Martinborough Branch">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-field" style="flex:1">
                        <label>Delivery address <span class="form-hint">optional</span></label>
                        <textarea id="ship-address" rows="2" placeholder="Street address…"></textarea>
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
                                <th style="flex:1">SKU</th>
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
                    <div class="totals-row totals-grand">
                        <span>Total (excl. GST)</span>
                        <span id="form-total">$0.00</span>
                    </div>
                </div>
            </section>

            <!-- Packing Notes -->
            <section class="form-section">
                <h2 class="form-section-title">Packing Notes <span class="form-hint">optional</span></h2>
                <div class="form-field">
                    <textarea id="packing-notes" rows="3" placeholder="Any special handling, packaging instructions, or delivery notes…"></textarea>
                </div>
            </section>

            <div class="form-actions">
                <div id="form-error" class="form-error" style="display:none"></div>
                <button type="button" id="submit-order-btn" class="btn-primary btn-lg">
                    Create Order ${xeroConnected ? '+ Push to Xero' : ''}
                </button>
            </div>
        </form>`;

        // Wire up customer search
        if (customers.length) {
            wireCustomerSearch(customers);
        }

        // Add first line item
        addLineItem();

        // Wire add line button
        document.getElementById('add-line-btn').addEventListener('click', addLineItem);

        // Submit
        document.getElementById('submit-order-btn').addEventListener('click', submitNewOrder);
    }

    function wireCustomerSearch(customers) {
        const searchEl = document.getElementById('customer-search');
        const dropdown = document.getElementById('customer-dropdown');
        const idInput = document.getElementById('customer-id');
        const nameInput = document.getElementById('customer-name-val');

        searchEl.addEventListener('input', () => {
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

    let lineCount = 0;

    function addLineItem() {
        const idx = lineCount++;
        const tbody = document.getElementById('line-items-body');
        const tr = document.createElement('tr');
        tr.className = 'line-item-row';
        tr.dataset.idx = idx;
        tr.innerHTML = `
            <td style="flex:1">
                <input type="text" class="line-sku" placeholder="e.g. PT-I-10">
            </td>
            <td style="flex:3">
                <input type="text" class="line-desc" placeholder="Product / description" required>
            </td>
            <td style="flex:1">
                <input type="number" class="line-qty" value="1" min="0" step="any" required>
            </td>
            <td style="flex:1">
                <input type="number" class="line-price" value="" min="0" step="0.01" placeholder="0.00" required>
            </td>
            <td style="flex:1" class="line-total">$0.00</td>
            <td style="flex:none;width:36px">
                <button type="button" class="line-remove-btn" title="Remove">×</button>
            </td>`;

        tbody.appendChild(tr);

        const qtyEl = tr.querySelector('.line-qty');
        const priceEl = tr.querySelector('.line-price');
        const totalEl = tr.querySelector('.line-total');

        function updateRow() {
            const qty = parseFloat(qtyEl.value) || 0;
            const price = parseFloat(priceEl.value) || 0;
            totalEl.textContent = '$' + fmt(qty * price);
            updateFormTotal();
        }

        qtyEl.addEventListener('input', updateRow);
        priceEl.addEventListener('input', updateRow);
        tr.querySelector('.line-remove-btn').addEventListener('click', () => {
            tr.remove();
            updateFormTotal();
        });
    }

    function updateFormTotal() {
        let total = 0;
        document.querySelectorAll('.line-item-row').forEach(tr => {
            const qty = parseFloat(tr.querySelector('.line-qty').value) || 0;
            const price = parseFloat(tr.querySelector('.line-price').value) || 0;
            total += qty * price;
        });
        const el = document.getElementById('form-total');
        if (el) el.textContent = '$' + fmt(total);
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

    function showFormError(msg) {
        const el = document.getElementById('form-error');
        if (!el) return;
        el.textContent = msg;
        el.style.display = msg ? '' : 'none';
    }

    async function submitNewOrder() {
        showFormError('');

        const customerId = document.getElementById('customer-id')?.value;
        const customerName = document.getElementById('customer-name-val')?.value.trim()
            || document.getElementById('customer-search')?.value.trim();

        if (!customerName) { showFormError('Customer name is required.'); return; }

        const lines = getLineItems();
        if (!lines.length) { showFormError('Add at least one line item.'); return; }

        const btn = document.getElementById('submit-order-btn');
        btn.disabled = true;
        btn.textContent = 'Creating…';

        try {
            const payload = {
                customer: {
                    xeroContactId: customerId || '',
                    name: customerName,
                },
                poNumber: document.getElementById('po-number').value.trim(),
                shipTo: {
                    branch: document.getElementById('ship-branch').value.trim(),
                    address: document.getElementById('ship-address').value.trim(),
                },
                lines,
                packingNotes: document.getElementById('packing-notes').value.trim(),
            };

            const order = await api('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            // Push to Xero if connected
            if (xeroConnected && customerId) {
                try {
                    btn.textContent = 'Pushing to Xero…';
                    await api('/api/xero/push', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ orderId: order.id }),
                    });
                } catch (e) {
                    // Non-fatal — order is created; Xero push can be retried from detail view
                    console.warn('Xero push failed:', e.message);
                }
            }

            location.hash = 'orders/' + order.id;
        } catch (e) {
            showFormError(e.message);
            btn.disabled = false;
            btn.textContent = 'Create Order' + (xeroConnected ? ' + Push to Xero' : '');
        }
    }

    // ── Order detail / packing slip ──
    async function renderDetail(container, orderId) {
        container.innerHTML = `
        <div class="view-header">
            <a href="#orders" class="btn-secondary">← Orders</a>
        </div>
        <div id="order-detail-body"><div class="orders-loading">Loading…</div></div>`;

        let order;
        try {
            order = await api('/api/orders/' + orderId);
        } catch (e) {
            document.getElementById('order-detail-body').innerHTML =
                `<div class="orders-error">${e.message}</div>`;
            return;
        }

        await checkXeroStatus();

        const total = orderTotal(order);
        const gst = total * 0.15;
        const body = document.getElementById('order-detail-body');

        body.innerHTML = `
        <!-- Action bar (hidden when printing) -->
        <div class="order-actions no-print">
            <div class="order-actions-left">
                ${statusBadge(order.status)}
                ${order.xeroInvoiceNumber
                    ? `<span class="xero-inv-linked">Xero: ${escHtml(order.xeroInvoiceNumber)}</span>`
                    : (xeroConnected
                        ? `<button id="push-xero-btn" class="btn-secondary btn-sm">Push to Xero</button>`
                        : `<span class="xero-not-connected">Xero not connected</span>`)
                }
            </div>
            <div class="order-actions-right">
                <div class="status-update-wrap">
                    <label class="status-label">Update status:</label>
                    <select id="status-select" class="status-select">
                        ${Object.entries(STATUS_LABELS).map(([v, l]) =>
                            `<option value="${v}" ${order.status === v ? 'selected' : ''}>${l}</option>`
                        ).join('')}
                    </select>
                    <button id="status-save-btn" class="btn-primary btn-sm">Save</button>
                </div>
                <button onclick="window.print()" class="btn-secondary btn-sm">🖨 Print</button>
            </div>
        </div>

        <!-- Packing Slip (printable) -->
        <div class="packing-slip" id="packing-slip">

            <!-- Top bar: logo + title -->
            <div class="slip-top">
                <img src="enviroware_logo_clean.png" alt="Enviroware" class="slip-logo">
                <div class="slip-title">PACKING SLIP</div>
            </div>

            <hr class="slip-rule">

            <!-- FROM / SHIP TO two-column -->
            <div class="slip-body">
                <div class="slip-from">
                    <div class="slip-col-label">FROM</div>
                    <div class="slip-from-name">Enviroware</div>
                    <div class="slip-from-addr">93 Tetley Road,<br>Katikati<br>(07) 549-1716<br>orders@primetie.co.nz</div>

                    <div class="slip-inv-details">
                        <div class="slip-col-label">INVOICE DETAILS</div>
                        ${order.xeroInvoiceNumber
                            ? `<div class="slip-inv-row"><span>Invoice No.</span><strong>${escHtml(order.xeroInvoiceNumber)}</strong></div>`
                            : `<div class="slip-inv-row"><span>Order</span><strong>${escHtml(order.id)}</strong></div>`}
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

            <!-- Line items — no totals, matches PDF -->
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
                    ${order.lines.map(l => `
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
            </div>
        </div>`;

        // Status update
        document.getElementById('status-save-btn')?.addEventListener('click', async () => {
            const newStatus = document.getElementById('status-select').value;
            const btn = document.getElementById('status-save-btn');
            btn.disabled = true;
            try {
                const updated = await api('/api/orders/' + orderId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: newStatus }),
                });
                // Refresh the status badge inline
                const badge = document.querySelector('.order-actions-left .order-status-badge');
                if (badge) badge.outerHTML = statusBadge(updated.status);
                showToast('Status updated');
            } catch (e) {
                showToast('Error: ' + e.message);
            } finally {
                btn.disabled = false;
            }
        });

        // Xero push
        document.getElementById('push-xero-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('push-xero-btn');
            btn.disabled = true;
            btn.textContent = 'Pushing…';
            try {
                const result = await api('/api/xero/push', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId }),
                });
                btn.outerHTML = `<span class="xero-inv-linked">Xero: ${escHtml(result.invoiceNumber)}</span>`;
                // Add invoice number to the packing slip header
                const metaDiv = document.querySelector('.slip-meta');
                if (metaDiv) {
                    metaDiv.insertAdjacentHTML('beforeend',
                        `<div class="slip-meta-row"><span>Invoice</span><strong>${escHtml(result.invoiceNumber)}</strong></div>`);
                }
                showToast('Invoice created in Xero: ' + result.invoiceNumber);
            } catch (e) {
                showToast('Xero push failed: ' + e.message);
                btn.disabled = false;
                btn.textContent = 'Push to Xero';
            }
        });
    }

    // ── Escape HTML ──
    function escHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ── Public API ──
    return {
        renderList,
        renderNew,
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
