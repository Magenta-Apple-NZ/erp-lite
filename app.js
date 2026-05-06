// ── State ──
let allGroups = [];
let pinnedItems = [];
let currentConfig = {};
let collapsedGroups = JSON.parse(localStorage.getItem('hub-collapsed') || '{}');
let editMode = false;
let dragGroupIdx = null;
let dragItemInfo = null;
let modalCallback = null;

// ── Chart.js registry ──
window._chartQ    = {};
window._chartInst = {};

function initCharts(container) {
    if (typeof Chart === 'undefined') return;
    (container || document).querySelectorAll('canvas[data-chart-id]').forEach(canvas => {
        const id = canvas.dataset.chartId;
        const cfg = window._chartQ[id];
        if (!cfg) return;
        if (window._chartInst[id]) {
            try { window._chartInst[id].destroy(); } catch (_) {}
            delete window._chartInst[id];
        }
        window._chartInst[id] = new Chart(canvas, cfg);
        delete window._chartQ[id];
    });
}

// ── SVG icons for item types ──
const TYPE_ICONS = {
    file: '<svg class="type-icon-svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    folder: '<svg class="type-icon-svg" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    link: null
};

// ── Config load ──
function loadConfig() {
    const override = localStorage.getItem('hub-config-override');
    if (override) {
        try { applyConfig(JSON.parse(override)); return; } catch(e) { localStorage.removeItem('hub-config-override'); }
    }
    fetch('config.json?_=' + Date.now())
        .then(r => r.json())
        .then(applyConfig)
        .catch(err => {
            console.error('Error loading config:', err);
            document.getElementById('dashboard').innerHTML =
                '<p style="padding:2rem;color:#ef4444;">Error loading config.json — check the console.</p>';
        });
}

function applyConfig(config) {
    currentConfig = config;
    allGroups = JSON.parse(JSON.stringify(config.groups || []));
    pinnedItems = JSON.parse(JSON.stringify(config.pinned || []));
    renderPinned(pinnedItems);
    renderGroups(allGroups);
    renderDashboardWidgets(config);
    updateTimestamp();
}

function saveConfigOverride() {
    const config = Object.assign({}, currentConfig, { groups: allGroups, pinned: pinnedItems });
    localStorage.setItem('hub-config-override', JSON.stringify(config));
}

function updateTimestamp() {
    const el = document.getElementById('last-updated');
    const now = new Date();
    el.textContent = 'Loaded ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Edit mode ──
function toggleEditMode() {
    editMode = !editMode;
    const btn = document.getElementById('edit-btn');
    btn.querySelector('.sidebar-btn-label').textContent = editMode ? 'Done' : 'Edit Layout';
    btn.classList.toggle('edit-active', editMode);
    document.getElementById('export-btn').style.display = editMode ? '' : 'none';
    document.getElementById('reset-btn').style.display = editMode ? '' : 'none';
    renderGroups(allGroups);
    renderPinned(pinnedItems);
}

function exportConfig() {
    const config = Object.assign({}, currentConfig, { groups: allGroups, pinned: pinnedItems });
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('config.json downloaded');
}

function resetConfig() {
    if (!confirm('Reset to the deployed config? Local edits will be lost.')) return;
    localStorage.removeItem('hub-config-override');
    editMode = false;
    document.getElementById('edit-btn').querySelector('.sidebar-btn-label').textContent = 'Edit Layout';
    document.getElementById('edit-btn').classList.remove('edit-active');
    document.getElementById('export-btn').style.display = 'none';
    document.getElementById('reset-btn').style.display = 'none';
    fetch('config.json?_=' + Date.now()).then(r => r.json()).then(applyConfig);
}

// ── Item modal ──
function openItemModal(item, onSave) {
    modalCallback = onSave;
    document.getElementById('modal-label').value = item.label || '';
    document.getElementById('modal-type').value = item.type || 'link';
    document.getElementById('modal-url').value = item.url || '';
    document.getElementById('modal-path').value = item.path || '';
    document.getElementById('modal-tag').value = item.tag || '';
    document.getElementById('modal-season').value = item.season || '';
    updateModalTypeFields();
    document.getElementById('item-modal').style.display = 'flex';
    document.getElementById('modal-label').focus();
}

function updateModalTypeFields() {
    const type = document.getElementById('modal-type').value;
    document.getElementById('modal-url-field').style.display = type === 'link' ? '' : 'none';
    document.getElementById('modal-path-field').style.display = (type === 'file' || type === 'folder') ? '' : 'none';
}

function saveModal() {
    const type = document.getElementById('modal-type').value;
    const label = document.getElementById('modal-label').value.trim();
    if (!label) { showToast('Label is required'); return; }
    const item = { label, type };
    if (type === 'link') {
        item.url = document.getElementById('modal-url').value.trim();
    } else {
        item.path = document.getElementById('modal-path').value.trim();
    }
    const tag = document.getElementById('modal-tag').value.trim();
    const season = document.getElementById('modal-season').value.trim();
    if (tag) item.tag = tag;
    if (season) item.season = season;
    if (modalCallback) modalCallback(item);
    closeModal();
}

function closeModal() {
    document.getElementById('item-modal').style.display = 'none';
    modalCallback = null;
}

// ── Pinned items ──
function renderPinned(items) {
    const section = document.getElementById('pinned-section');
    const container = document.getElementById('pinned-items');
    if (!items || (items.length === 0 && !editMode)) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';
    container.innerHTML = '';

    items.forEach((item, iIdx) => {
        if (editMode) {
            const wrapper = document.createElement('div');
            wrapper.className = 'pinned-edit-wrapper';
            const label = document.createElement('span');
            label.className = 'pinned-item';
            if (item.type === 'link' && item.url) {
                const domain = getDomain(item.url);
                if (domain) {
                    const img = document.createElement('img');
                    img.className = 'favicon';
                    img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' + domain;
                    img.alt = ''; img.onerror = function() { this.style.display = 'none'; };
                    label.appendChild(img);
                }
            }
            label.appendChild(document.createTextNode(item.label));
            wrapper.appendChild(label);

            const editBtn = document.createElement('button');
            editBtn.className = 'edit-action-btn'; editBtn.textContent = '✎'; editBtn.title = 'Edit';
            editBtn.addEventListener('click', () => openItemModal(item, updated => {
                pinnedItems[iIdx] = updated; saveConfigOverride(); renderPinned(pinnedItems);
            }));
            wrapper.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'edit-action-btn delete-btn'; delBtn.textContent = '×'; delBtn.title = 'Remove';
            delBtn.addEventListener('click', () => { pinnedItems.splice(iIdx, 1); saveConfigOverride(); renderPinned(pinnedItems); });
            wrapper.appendChild(delBtn);
            container.appendChild(wrapper);
        } else {
            const el = document.createElement('a');
            el.className = 'pinned-item'; el.href = '#';
            if (item.type === 'link' && item.url) {
                const domain = getDomain(item.url);
                if (domain) {
                    const img = document.createElement('img');
                    img.className = 'favicon';
                    img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' + domain;
                    img.alt = ''; img.onerror = function() { this.style.display = 'none'; };
                    el.appendChild(img);
                }
            }
            el.appendChild(document.createTextNode(item.label));
            el.addEventListener('click', e => { e.preventDefault(); openItem(item); });
            container.appendChild(el);
        }
    });

    if (editMode) {
        const addBtn = document.createElement('button');
        addBtn.className = 'pinned-item add-pinned-btn';
        addBtn.textContent = '+ Pin item';
        addBtn.addEventListener('click', () => openItemModal({ label: '', type: 'link', url: '' }, item => {
            pinnedItems.push(item); saveConfigOverride(); renderPinned(pinnedItems);
        }));
        container.appendChild(addBtn);
    }
}

// ── Groups ──
function renderGroups(groups) {
    const dashboard = document.getElementById('dashboard');
    dashboard.innerHTML = '';
    groups.forEach((group, gIdx) => dashboard.appendChild(buildGroupCard(group, gIdx)));
    if (editMode) {
        const addGroupBtn = document.createElement('button');
        addGroupBtn.className = 'add-group-btn';
        addGroupBtn.textContent = '+ Add Group';
        addGroupBtn.addEventListener('click', () => {
            allGroups.push({ name: 'New Group', colour: '#64748b', items: [] });
            saveConfigOverride();
            renderGroups(allGroups);
        });
        dashboard.appendChild(addGroupBtn);
    }
}

function buildGroupCard(group, gIdx) {
    const card = document.createElement('div');
    card.className = 'group' +
        (collapsedGroups[group.name] ? ' collapsed' : '') +
        (editMode ? ' edit-mode' : '');
    if (group.colour) card.style.setProperty('--group-colour', group.colour);

    const header = document.createElement('div');
    header.className = 'group-header';

    if (editMode) {
        const dragHandle = document.createElement('span');
        dragHandle.className = 'drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.draggable = true;
        setupGroupDragHandle(dragHandle, card, gIdx);
        header.appendChild(dragHandle);
    }

    const heading = document.createElement('h2');
    if (group.colour) {
        const dot = document.createElement('span');
        dot.className = 'accent-dot';
        dot.style.backgroundColor = group.colour;
        heading.appendChild(dot);
    }

    if (editMode) {
        const nameInput = document.createElement('input');
        nameInput.className = 'group-name-input';
        nameInput.value = group.name;
        nameInput.addEventListener('change', e => {
            const oldName = group.name;
            const newName = e.target.value.trim() || oldName;
            allGroups[gIdx].name = newName;
            if (collapsedGroups[oldName] !== undefined) {
                collapsedGroups[newName] = collapsedGroups[oldName];
                delete collapsedGroups[oldName];
            }
            saveConfigOverride();
        });
        heading.appendChild(nameInput);
    } else {
        heading.appendChild(document.createTextNode(group.name));
        header.addEventListener('click', () => {
            card.classList.toggle('collapsed');
            collapsedGroups[group.name] = card.classList.contains('collapsed');
            localStorage.setItem('hub-collapsed', JSON.stringify(collapsedGroups));
        });
    }
    header.appendChild(heading);

    if (!editMode) {
        const chevron = document.createElement('span');
        chevron.className = 'collapse-icon';
        chevron.textContent = '▼';
        header.appendChild(chevron);
    } else {
        const colourInput = document.createElement('input');
        colourInput.type = 'color';
        colourInput.value = group.colour || '#64748b';
        colourInput.className = 'group-colour-picker';
        colourInput.title = 'Group colour';
        colourInput.addEventListener('input', e => {
            allGroups[gIdx].colour = e.target.value;
            const dot = heading.querySelector('.accent-dot');
            if (dot) dot.style.backgroundColor = e.target.value;
        });
        colourInput.addEventListener('change', () => saveConfigOverride());
        header.appendChild(colourInput);

        const delBtn = document.createElement('button');
        delBtn.className = 'edit-action-btn delete-btn';
        delBtn.textContent = '×'; delBtn.title = 'Delete group';
        delBtn.addEventListener('click', () => {
            if (confirm(`Delete group "${group.name}" and all its items?`)) {
                allGroups.splice(gIdx, 1); saveConfigOverride(); renderGroups(allGroups);
            }
        });
        header.appendChild(delBtn);
    }

    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'group-body';
    const list = document.createElement('ul');
    if (editMode) setupItemDropZone(list, gIdx);
    group.items.forEach((item, iIdx) => list.appendChild(buildItemLi(item, gIdx, iIdx)));
    body.appendChild(list);

    if (editMode) {
        const addItemBtn = document.createElement('button');
        addItemBtn.className = 'add-item-btn';
        addItemBtn.textContent = '+ Add item';
        addItemBtn.addEventListener('click', () => openItemModal({ label: '', type: 'link', url: '' }, item => {
            allGroups[gIdx].items.push(item); saveConfigOverride(); renderGroups(allGroups);
        }));
        body.appendChild(addItemBtn);
    }

    card.appendChild(body);
    return card;
}

function buildItemLi(item, gIdx, iIdx) {
    const li = document.createElement('li');
    if (item.season && !isSeasonActive(item.season)) li.classList.add('off-season');

    if (editMode) {
        const dragHandle = document.createElement('span');
        dragHandle.className = 'drag-handle item-drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.draggable = true;
        setupItemDragHandle(dragHandle, li, gIdx, iIdx);
        li.appendChild(dragHandle);
    }

    const link = document.createElement('a');
    link.href = '#';

    if (item.type === 'link' && item.url) {
        const domain = getDomain(item.url);
        if (domain) {
            const img = document.createElement('img');
            img.className = 'type-icon favicon';
            img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' + domain;
            img.alt = ''; img.onerror = function() { this.style.display = 'none'; };
            link.appendChild(img);
        }
    } else if (TYPE_ICONS[item.type]) {
        const iconSpan = document.createElement('span');
        iconSpan.innerHTML = TYPE_ICONS[item.type];
        link.appendChild(iconSpan.firstChild);
    }

    link.appendChild(document.createTextNode(item.label));
    if (!editMode) link.addEventListener('click', e => { e.preventDefault(); openItem(item); });
    li.appendChild(link);

    if (item.tag) {
        const tag = document.createElement('span');
        tag.className = 'tag'; tag.textContent = item.tag;
        li.appendChild(tag);
    }
    if (item.season) {
        const active = isSeasonActive(item.season);
        const tag = document.createElement('span');
        tag.className = 'tag ' + (active ? 'season-active' : 'season-inactive');
        tag.textContent = active ? 'In season' : item.season;
        li.appendChild(tag);
    }
    if (!editMode && (item.type === 'file' || item.type === 'folder')) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-path-btn';
        copyBtn.textContent = 'Copy path';
        copyBtn.addEventListener('click', e => {
            e.stopPropagation();
            navigator.clipboard.writeText(item.path).then(() => showToast('Path copied'));
        });
        li.appendChild(copyBtn);
    }

    if (editMode) {
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-action-btn'; editBtn.textContent = '✎'; editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => openItemModal(item, updated => {
            allGroups[gIdx].items[iIdx] = updated; saveConfigOverride(); renderGroups(allGroups);
        }));
        li.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'edit-action-btn delete-btn'; delBtn.textContent = '×'; delBtn.title = 'Delete';
        delBtn.addEventListener('click', () => {
            allGroups[gIdx].items.splice(iIdx, 1); saveConfigOverride(); renderGroups(allGroups);
        });
        li.appendChild(delBtn);
    }

    return li;
}

// ── Drag and drop — groups ──
function setupGroupDragHandle(handle, card, gIdx) {
    handle.addEventListener('dragstart', e => {
        dragGroupIdx = gIdx;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => card.classList.add('dragging'), 0);
    });
    handle.addEventListener('dragend', () => {
        dragGroupIdx = null;
        document.querySelectorAll('.group.dragging, .group.drag-over').forEach(el => el.classList.remove('dragging', 'drag-over'));
    });
    card.addEventListener('dragover', e => {
        if (dragGroupIdx === null || dragGroupIdx === gIdx) return;
        e.preventDefault();
        card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', e => {
        if (!card.contains(e.relatedTarget)) card.classList.remove('drag-over');
    });
    card.addEventListener('drop', e => {
        if (dragGroupIdx === null || dragGroupIdx === gIdx) return;
        e.preventDefault();
        card.classList.remove('drag-over');
        const [moved] = allGroups.splice(dragGroupIdx, 1);
        allGroups.splice(gIdx > dragGroupIdx ? gIdx - 1 : gIdx, 0, moved);
        saveConfigOverride();
        renderGroups(allGroups);
    });
}

// ── Drag and drop — items ──
function setupItemDragHandle(handle, li, gIdx, iIdx) {
    handle.addEventListener('dragstart', e => {
        dragItemInfo = { gIdx, iIdx };
        e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
        setTimeout(() => li.classList.add('dragging'), 0);
    });
    handle.addEventListener('dragend', () => {
        dragItemInfo = null;
        document.querySelectorAll('li.dragging, li.drag-over').forEach(el => el.classList.remove('dragging', 'drag-over'));
    });
    li.addEventListener('dragover', e => {
        if (!dragItemInfo) return;
        e.preventDefault(); e.stopPropagation();
        li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', e => {
        if (!li.contains(e.relatedTarget)) li.classList.remove('drag-over');
    });
    li.addEventListener('drop', e => {
        if (!dragItemInfo) return;
        const { gIdx: srcG, iIdx: srcI } = dragItemInfo;
        if (srcG === gIdx && srcI === iIdx) return;
        e.preventDefault(); e.stopPropagation();
        li.classList.remove('drag-over');
        const [moved] = allGroups[srcG].items.splice(srcI, 1);
        allGroups[gIdx].items.splice(srcG === gIdx && iIdx > srcI ? iIdx - 1 : iIdx, 0, moved);
        saveConfigOverride();
        renderGroups(allGroups);
    });
}

function setupItemDropZone(list, gIdx) {
    list.addEventListener('dragover', e => { if (dragItemInfo) e.preventDefault(); });
    list.addEventListener('drop', e => {
        if (!dragItemInfo) return;
        const { gIdx: srcG, iIdx: srcI } = dragItemInfo;
        if (srcG === gIdx) return;
        e.preventDefault();
        const [moved] = allGroups[srcG].items.splice(srcI, 1);
        allGroups[gIdx].items.push(moved);
        saveConfigOverride();
        renderGroups(allGroups);
    });
}

// ── Open item ──
function openItem(item) {
    if (item.type === 'link') {
        if (item.url && item.url.startsWith('#')) {
            location.hash = item.url.slice(1);
        } else {
            window.open(item.url, '_blank');
        }
    } else if (item.type === 'file' || item.type === 'folder') {
        window.open('file://' + item.path);
    }
}

// ── Dashboard module helpers ────────────────────────────────────────────

function _ehDb(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DB_STATUS_LABELS = {
    new: 'New', reviewed: 'Reviewed', sent_to_xero: 'Xero', dispatched: 'Dispatched', paid: 'Paid',
};
const DB_STATUS_COLOURS = {
    new: '#3b82f6', reviewed: '#f59e0b', sent_to_xero: '#8b5cf6', dispatched: '#64748b', paid: '#10b981',
};

// Latest 6 orders by createdAt descending.
function renderLatestOrdersBody(orders) {
    if (!Array.isArray(orders) || !orders.length) {
        return '<p class="db-mod-empty">No orders yet.</p>';
    }
    const sorted = orders.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const rows = sorted.slice(0, 6).map(o => {
        const status = o.status || 'new';
        const colour = DB_STATUS_COLOURS[status] || '#94a3b8';
        const label  = DB_STATUS_LABELS[status]  || status;
        const cust   = o.customer?.name || 'Unknown customer';
        const ref    = o.xeroInvoiceNumber || o.id;
        const date   = (o.createdAt || '').slice(0, 10);
        return `<a class="db-row" href="#orders/${_ehDb(o.id)}">
            <span class="db-row-main">${_ehDb(cust)}</span>
            <span class="db-row-meta">${_ehDb(ref)}</span>
            <span class="db-row-date">${_ehDb(date)}</span>
            <span class="db-row-tag" style="color:${colour};background:${colour}18;border-color:${colour}30">${label}</span>
        </a>`;
    }).join('');
    return `<div class="db-rows">${rows}</div>`;
}

// Next 4 shipments by ym (ascending), reading config.shipments synchronously.
// "Incoming" = ym ≥ current month.
function renderIncomingShipmentsBody(config) {
    const all = (config?.shipments || []).slice();
    if (!all.length) return '<p class="db-mod-empty">No shipments scheduled.</p>';

    const now    = new Date();
    const curYm  = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const upcoming = all
        .filter(s => (s.ym || '') >= curYm)
        .sort((a, b) => (a.ym || '').localeCompare(b.ym || ''))
        .slice(0, 4);

    if (!upcoming.length) return '<p class="db-mod-empty">No upcoming shipments.</p>';

    const STATUS_C = { planning:'#94a3b8', ordered:'#3b82f6', 'in-transit':'#f59e0b', customs:'#8b5cf6', delivered:'#10b981' };
    const STATUS_L = { planning:'Planning', ordered:'Ordered', 'in-transit':'In transit', customs:'Customs', delivered:'Delivered' };

    const rows = upcoming.map(s => {
        const title = s.seq ? `Shipment #${s.seq}` : (s.campaign || 'Shipment');
        const sub   = s.campaign && s.seq ? s.campaign : '';
        const kg    = Number(s.kg) || 0;
        const ymTxt = s.ym ? new Date(s.ym + '-01').toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' }) : '';
        const st    = s.status || 'planning';
        const c     = STATUS_C[st] || '#94a3b8';
        return `<div class="db-row">
            <span class="db-row-main">${_ehDb(title)}${sub ? ' · <span class="db-row-sub">' + _ehDb(sub) + '</span>' : ''}</span>
            <span class="db-row-meta">${kg ? kg.toLocaleString('en-NZ') + ' kg' : ''}</span>
            <span class="db-row-date">${_ehDb(ymTxt)}</span>
            <span class="db-row-tag" style="color:${c};background:${c}18;border-color:${c}30">${STATUS_L[st] || st}</span>
        </div>`;
    }).join('');
    return `<div class="db-rows">${rows}</div>`;
}

// Format a Google Calendar event into { date: 'YYYY-MM-DD', time: 'HH:MM' or '', title }.
function _parseGcalEvent(ev) {
    const startObj = ev.start || {};
    if (startObj.date) {
        return { date: startObj.date, time: '', title: ev.summary || '(no title)', allDay: true };
    }
    if (startObj.dateTime) {
        const d = new Date(startObj.dateTime);
        if (isNaN(d)) return null;
        const yyyy = d.getFullYear();
        const mm   = String(d.getMonth() + 1).padStart(2, '0');
        const dd   = String(d.getDate()).padStart(2, '0');
        const hh   = String(d.getHours()).padStart(2, '0');
        const mi   = String(d.getMinutes()).padStart(2, '0');
        return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}`, title: ev.summary || '(no title)', allDay: false };
    }
    return null;
}

function _dayLabel(d, today) {
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short' });
}

// 14-day list, grouped by date. Empty days are skipped except Today.
function renderCalendar14dBody(events, shipments) {
    const today = new Date(); today.setHours(0,0,0,0);
    const horizonMs = 14 * 86400000;

    const map = {}; // 'YYYY-MM-DD' → [{type, time, title}]
    for (const ev of (events || [])) {
        const parsed = _parseGcalEvent(ev);
        if (!parsed) continue;
        const d = new Date(parsed.date + 'T00:00:00');
        if (d < today || (d - today) >= horizonMs) continue;
        (map[parsed.date] = map[parsed.date] || []).push({ type: 'gcal', ...parsed });
    }
    for (const s of (shipments || [])) {
        const tag = s.seq ? `#${s.seq}` : '';
        const milestones = (s.milestones || []).filter(m => m && m.date);
        if (milestones.length) {
            for (const m of milestones) {
                const date = m.date.slice(0, 10);
                const d = new Date(date + 'T00:00:00');
                if (d < today || (d - today) >= horizonMs) continue;
                const stage = m.label === 'Order placed' ? 'Start LC' : m.label;
                const title = `${tag ? tag + ' · ' : ''}${stage}${m.done ? ' ✓' : ''}`;
                (map[date] = map[date] || []).push({ type: 'shipment', time: '', title, allDay: true });
            }
            continue;
        }
        if (!s.ym) continue;
        const date = s.ym + '-01';
        const d = new Date(date + 'T00:00:00');
        if (d < today || (d - today) >= horizonMs) continue;
        const title = tag ? `Shipment ${tag} ETA` : `Shipment ETA · ${s.campaign || s.ym}`;
        (map[date] = map[date] || []).push({ type: 'shipment', time: '', title, allDay: true });
    }

    const dates = Object.keys(map).sort();
    if (!dates.length) return '<p class="db-mod-empty">No events in the next 14 days.</p>';

    let totalShown = 0;
    const MAX = 8;
    let truncated = 0;

    const blocks = dates.map(date => {
        const d = new Date(date + 'T00:00:00');
        const items = map[date].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
        const slice = totalShown < MAX ? items.slice(0, MAX - totalShown) : [];
        truncated += items.length - slice.length;
        totalShown += slice.length;
        if (!slice.length) return '';
        return `<div class="db-cal-day">
            <div class="db-cal-day-hd">${_ehDb(_dayLabel(d, today))}</div>
            ${slice.map(it => `<div class="db-cal-event db-cal-event--${it.type}">
                ${it.time ? `<span class="db-cal-time">${it.time}</span>` : '<span class="db-cal-time db-cal-time--all">·</span>'}
                <span class="db-cal-title">${_ehDb(it.title)}</span>
            </div>`).join('')}
        </div>`;
    }).filter(Boolean).join('');

    const footer = truncated > 0
        ? `<div class="db-cal-more">… and ${truncated} more</div>`
        : '';
    return blocks + footer;
}

// Build a per-date map of events keyed by 'YYYY-MM-DD' for the 28-day expand.
// Cached on window so the click handler can read it without re-fetching.
function _buildDayMap(events, shipments) {
    const map = {};
    for (const ev of (events || [])) {
        const parsed = _parseGcalEvent(ev);
        if (!parsed) continue;
        (map[parsed.date] = map[parsed.date] || []).push({ type: 'gcal', ...parsed });
    }
    for (const s of (shipments || [])) {
        const tag = s.seq ? `#${s.seq}` : '';
        const milestones = (s.milestones || []).filter(m => m && m.date);
        if (milestones.length) {
            for (const m of milestones) {
                const date = m.date.slice(0, 10);
                const stage = m.label === 'Order placed' ? 'Start LC' : m.label;
                const title = `${tag ? tag + ' · ' : ''}${stage}${m.done ? ' ✓' : ''}`;
                (map[date] = map[date] || []).push({ type: 'shipment', time: '', title, allDay: true });
            }
            continue;
        }
        if (!s.ym) continue;
        const date = s.ym + '-01';
        const title = tag ? `Shipment ${tag} ETA` : `Shipment ETA · ${s.campaign || s.ym}`;
        (map[date] = map[date] || []).push({ type: 'shipment', time: '', title, allDay: true });
    }
    return map;
}

// 28-day strip: one cell per day, dot if events. Click expands details inline.
function renderCalendar28dBody(events, shipments) {
    const today = new Date(); today.setHours(0,0,0,0);
    const dayMap = _buildDayMap(events, shipments);
    window._dbDayMap = dayMap; // shared with the click handler below

    const cells = [];
    for (let i = 0; i < 28; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i);
        const yyyy = d.getFullYear();
        const mm   = String(d.getMonth() + 1).padStart(2, '0');
        const dd   = String(d.getDate()).padStart(2, '0');
        const key  = `${yyyy}-${mm}-${dd}`;
        const items = dayMap[key] || [];
        const n    = items.length;
        const dow  = d.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const cls  = `db-strip-cell${i === 0 ? ' db-strip-cell--today' : ''}${isWeekend ? ' db-strip-cell--weekend' : ''}${n > 0 ? ' db-strip-cell--has' : ''}`;
        const dotsHtml = n > 0
            ? '<span class="db-strip-dots">' + '●'.repeat(Math.min(n, 3)) + '</span>'
            : '';
        cells.push(`<button type="button" class="${cls}" data-date="${key}" title="${key}${n ? ' · ' + n + ' event' + (n > 1 ? 's' : '') : ''}">
            <span class="db-strip-dow">${'SMTWTFS'[dow]}</span>
            <span class="db-strip-dom">${d.getDate()}</span>
            ${dotsHtml}
        </button>`);
    }
    return `<div class="db-strip">${cells.join('')}</div>`;
}

// Render the expanded detail panel for a given day.
function _renderStripDetailFor(date) {
    const items = (window._dbDayMap || {})[date] || [];
    const d = new Date(date + 'T00:00:00');
    const heading = d.toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const body = items.length
        ? items.sort((a, b) => (a.time || '').localeCompare(b.time || '')).map(it => `
            <div class="db-cal-event db-cal-event--${it.type}">
                ${it.time ? `<span class="db-cal-time">${it.time}</span>` : '<span class="db-cal-time db-cal-time--all">·</span>'}
                <span class="db-cal-title">${_ehDb(it.title)}</span>
            </div>`).join('')
        : '<p class="db-mod-empty">Nothing scheduled.</p>';
    return `<div class="db-strip-detail-hd">
            <span>${_ehDb(heading)}</span>
            <button type="button" class="db-strip-detail-close" title="Close">×</button>
        </div>
        <div class="db-strip-detail-body">${body}</div>`;
}

// One-time delegated click handler for the 28-day strip cells + close button.
if (!window._dbStripWired) {
    window._dbStripWired = true;
    document.addEventListener('click', e => {
        const closeBtn = e.target.closest('.db-strip-detail-close');
        if (closeBtn) {
            const panel = document.getElementById('db-strip-detail');
            if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
            document.querySelectorAll('.db-strip-cell--open').forEach(c => c.classList.remove('db-strip-cell--open'));
            return;
        }
        const cell = e.target.closest('.db-strip-cell');
        if (!cell) return;
        const date = cell.dataset.date;
        if (!date) return;
        const panel = document.getElementById('db-strip-detail');
        if (!panel) return;
        document.querySelectorAll('.db-strip-cell--open').forEach(c => c.classList.remove('db-strip-cell--open'));
        cell.classList.add('db-strip-cell--open');
        panel.innerHTML = _renderStripDetailFor(date);
        panel.style.display = '';
    });
}

// Fetch /api/calendar/events for the next 28 days, populate both calendar modules.
function loadDashboardCalendar(config) {
    const now = new Date(); now.setHours(0,0,0,0);
    const max = new Date(now); max.setDate(max.getDate() + 28);
    const url = `/api/calendar/events?timeMin=${now.toISOString()}&timeMax=${max.toISOString()}`;
    const shipments = config?.shipments || [];

    fetch(url).then(r => {
        if (!r.ok) return r.status === 401 ? 'unconnected' : 'error';
        return r.json();
    }).then(events => {
        const fourteenEl = document.querySelector('#db-mod-cal-14d .db-mod-body');
        const stripEl    = document.querySelector('#db-mod-cal-28d .db-mod-body');

        if (events === 'unconnected') {
            const msg = '<p class="db-mod-empty">Connect Google Calendar in <a href="#calendar">Calendar</a> to see events here.</p>';
            if (fourteenEl) fourteenEl.innerHTML = msg;
            if (stripEl)    stripEl.innerHTML = renderCalendar28dBody([], shipments); // strip still shows shipment ticks
            return;
        }
        if (events === 'error' || !Array.isArray(events)) events = [];

        if (fourteenEl) fourteenEl.innerHTML = renderCalendar14dBody(events, shipments);
        if (stripEl)    stripEl.innerHTML    = renderCalendar28dBody(events, shipments);
    }).catch(() => {
        const fourteenEl = document.querySelector('#db-mod-cal-14d .db-mod-body');
        const stripEl    = document.querySelector('#db-mod-cal-28d .db-mod-body');
        if (fourteenEl) fourteenEl.innerHTML = '<p class="db-mod-empty">Could not load calendar.</p>';
        if (stripEl)    stripEl.innerHTML    = renderCalendar28dBody([], shipments);
    });
}

// Module-grid dashboard. Skeleton renders immediately; modules populate
// asynchronously as their data lands. Order on the page (top → bottom):
// FX strip · Needs Review (if any) · 2-column grid (Latest Orders, Calendar
// 14-day) · 3-column grid (Incoming Shipments, Sales mini, Orders mini) ·
// Calendar 28-day strip · Quick Actions (demoted to a slim footer row).
function renderDashboardWidgets(config) {
    const el = document.getElementById('db-widgets');
    if (!el) return;

    const QUICK_ACTIONS = [
        { label: 'Create New Order', hash: 'orders/new',
          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' },
        { label: 'All Orders', hash: 'orders',
          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>' },
        { label: 'Stock Forecast', hash: 'imports',
          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' },
        { label: 'Sales History', hash: 'sales',
          icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' },
    ];

    // Quick Actions sit at the very top of the dashboard — primary
    // navigation shortcut row, not a footer.
    const actionsHtml = `<div class="db-quick-actions">${QUICK_ACTIONS.map(a =>
        `<a class="db-quick-card" href="#${a.hash}">${a.icon}<span>${a.label}</span></a>`
    ).join('')}</div>`;

    // Forex from today's cache (or fetch live)
    let fxHtml = '';
    const currencies = config?.currencies;
    if (currencies?.base && Array.isArray(currencies?.targets)) {
        const buildFx = data => {
            if (!data?.rates) return '';
            const pairs = currencies.targets
                .filter(c => data.rates[c] !== undefined)
                .map(c => `<span class="db-fx-pair"><span class="db-fx-code">${c}</span><span class="db-fx-rate">${data.rates[c].toFixed(4)}</span></span>`)
                .join('');
            return `<div class="db-forex-bar"><span class="db-fx-label">${currencies.base}</span>${pairs}<span class="db-fx-date">${data.date}</span></div>`;
        };
        const today = new Date().toISOString().split('T')[0];
        const cached = localStorage.getItem('hub-fx-' + today);
        if (cached) {
            fxHtml = buildFx(JSON.parse(cached));
        } else {
            const url = 'https://api.frankfurter.dev/v1/latest?base=' + currencies.base + '&symbols=' + currencies.targets.join(',');
            fetch(url).then(r => r.json()).then(data => {
                localStorage.setItem('hub-fx-' + today, JSON.stringify(data));
                const fxEl = document.getElementById('db-forex-bar');
                if (fxEl) fxEl.outerHTML = buildFx(data);
            }).catch(() => {});
            fxHtml = '<div class="db-forex-bar" id="db-forex-bar"><span class="db-fx-label" style="opacity:0.4">Loading rates…</span></div>';
        }
    }

    // New module-grid skeleton. Module bodies are filled in by the async
    // fetches below — orders feed Latest Orders / alerts / mini charts;
    // calendar events feed the two calendar modules; config.shipments
    // feeds Incoming Shipments synchronously.
    el.innerHTML =
        actionsHtml +
        fxHtml +
        '<div id="db-alerts-container"></div>' +
        '<div class="db-grid db-grid-2">' +
            '<section class="db-mod" id="db-mod-latest-orders">' +
                '<div class="db-mod-hd"><h3 class="db-mod-title">Latest Orders</h3><a class="db-mod-link" href="#orders">All →</a></div>' +
                '<div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>' +
            '</section>' +
            '<section class="db-mod" id="db-mod-cal-14d">' +
                '<div class="db-mod-hd"><h3 class="db-mod-title">Next 14 days</h3><a class="db-mod-link" href="#calendar">All →</a></div>' +
                '<div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>' +
            '</section>' +
        '</div>' +
        '<div class="db-grid db-grid-3">' +
            '<section class="db-mod" id="db-mod-incoming-ships">' +
                '<div class="db-mod-hd"><h3 class="db-mod-title">Incoming Shipments</h3><a class="db-mod-link" href="#imports">All →</a></div>' +
                '<div class="db-mod-body">' + renderIncomingShipmentsBody(config) + '</div>' +
            '</section>' +
            '<section class="db-mod db-mod--chart" id="db-sales-chart"><span class="db-mod-loading">Loading sales…</span></section>' +
            '<section class="db-mod db-mod--chart" id="db-orders-chart"><span class="db-mod-loading">Loading orders…</span></section>' +
        '</div>' +
        '<section class="db-mod db-mod--strip" id="db-mod-cal-28d">' +
            '<div class="db-mod-hd"><h3 class="db-mod-title">Next 28 days</h3><span class="db-mod-hint">Click a day for events</span></div>' +
            '<div class="db-mod-body"><span class="db-mod-loading">Loading…</span></div>' +
            '<div class="db-strip-detail" id="db-strip-detail" style="display:none"></div>' +
        '</section>';

    // Calendar fetches in parallel with orders (independent endpoints).
    loadDashboardCalendar(config);

    // Async: load orders and draw mini charts
    fetch('/api/orders').then(r => r.ok ? r.json() : []).then(orders => {
        const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const now = new Date();
        // Build last 6 months
        const months = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
        }
        const kgByMonth = {}, cntByMonth = {};
        months.forEach(m => { kgByMonth[m] = 0; cntByMonth[m] = 0; });
        (orders || []).forEach(o => {
            const ym = (o.createdAt || '').slice(0, 7);
            if (!kgByMonth.hasOwnProperty(ym)) return;
            const kg = (o.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
            kgByMonth[ym] += kg;
            cntByMonth[ym]++;
        });

        const drawMiniBar = (vals, labels, colour, title, unit) => {
            const W = 260, H = 80, padL = 28, padB = 18, padT = 8, padR = 8;
            const cW = W - padL - padR, cH = H - padT - padB;
            const maxV = Math.max(...vals, 1);
            const barW = Math.max(Math.floor(cW / vals.length) - 4, 6);
            const bars = vals.map((v, i) => {
                const bh = Math.max(Math.round((v / maxV) * cH), v > 0 ? 2 : 0);
                const x = padL + (i / vals.length) * cW + (cW / vals.length - barW) / 2;
                const y = padT + cH - bh;
                return `<rect x="${x.toFixed(1)}" y="${y}" width="${barW}" height="${bh}" fill="${colour}" rx="2" opacity="0.85"/>`;
            }).join('');
            const xLabels = labels.map((l, i) => {
                const x = padL + (i / vals.length) * cW + cW / vals.length / 2;
                return `<text x="${x.toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="7.5" fill="#94a3b8">${l}</text>`;
            }).join('');
            const yMax = `<text x="${padL - 2}" y="${padT + 6}" text-anchor="end" font-size="7" fill="#94a3b8">${maxV >= 1000 ? (maxV/1000).toFixed(0)+'k' : maxV}</text>`;
            return `<div class="db-chart-inner">
                <div class="db-chart-title">${title}</div>
                <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" xmlns="http://www.w3.org/2000/svg">
                    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT+cH}" stroke="#e2e8f0" stroke-width="1"/>
                    <line x1="${padL}" y1="${padT+cH}" x2="${W-padR}" y2="${padT+cH}" stroke="#e2e8f0" stroke-width="1"/>
                    ${bars}${xLabels}${yMax}
                </svg>
            </div>`;
        };

        const moLabels = months.map(m => MO[parseInt(m.slice(5)) - 1]);
        const kgVals = months.map(m => kgByMonth[m]);
        const cntVals = months.map(m => cntByMonth[m]);
        const totalKg = kgVals.reduce((a, b) => a + b, 0);
        const thisMonthKg = kgVals[kgVals.length - 1];

        const salesEl = document.getElementById('db-sales-chart');
        if (salesEl) salesEl.innerHTML = drawMiniBar(kgVals, moLabels, '#2563eb', `Sales (kg) · ${thisMonthKg > 0 ? thisMonthKg.toLocaleString('en-NZ') + ' kg this month' : 'last 6 months'}`, 'kg');

        const ordersEl = document.getElementById('db-orders-chart');
        if (ordersEl) ordersEl.innerHTML = drawMiniBar(cntVals, moLabels, '#7c3aed', `Orders · ${cntVals[cntVals.length-1]} this month`, 'orders');

        // Latest Orders module — last 6 orders by createdAt, regardless of status.
        const latestEl = document.querySelector('#db-mod-latest-orders .db-mod-body');
        if (latestEl) latestEl.innerHTML = renderLatestOrdersBody(orders || []);

        // Alerts: orders needing attention
        const eh = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const needsAction = (orders || []).filter(o => o.status === 'new');
        const badge = document.getElementById('nav-orders-badge');
        if (badge) { badge.textContent = needsAction.length; badge.style.display = needsAction.length ? '' : 'none'; }
        const alertsEl = document.getElementById('db-alerts-container');
        if (alertsEl && needsAction.length > 0) {
            const statusLabel = s => s === 'new' ? 'New' : 'Awaiting Review';
            alertsEl.innerHTML = `<div class="db-alerts">
                <div class="db-alerts-header">
                    <span class="db-alerts-title">Needs Attention</span>
                    <span class="db-alerts-count">${needsAction.length} order${needsAction.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="db-alerts-list">
                    ${needsAction.slice(0, 5).map(o => `<a class="db-alert-item" href="#orders/${o.id}">
                        <span class="db-alert-label">${eh(o.customer?.name || 'Unknown customer')}</span>
                        <span class="db-alert-status db-alert-status--${o.status}">${statusLabel(o.status)}</span>
                        <span class="db-alert-meta">${(o.createdAt || '').slice(0, 10)}</span>
                    </a>`).join('')}
                    ${needsAction.length > 5 ? `<span class="db-alert-more">+${needsAction.length - 5} more — <a href="#orders">view all</a></span>` : ''}
                </div>
            </div>`;
        }
    }).catch(() => {
        ['db-sales-chart','db-orders-chart'].forEach(id => {
            const el2 = document.getElementById(id);
            if (el2) el2.innerHTML = '';
        });
    });
}

// ── Season logic ──
function isSeasonActive(season) {
    const parts = season.toLowerCase().split('-');
    if (parts.length !== 2) return true;
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const start = months[parts[0]], end = months[parts[1]];
    if (start === undefined || end === undefined) return true;
    const now = new Date().getMonth();
    if (start <= end) return now >= start && now <= end;
    return now >= start || now <= end;
}

// ── Currency rates (header) ──
function renderHeaderCurrencies(config) {
    const container = document.getElementById('header-currencies');
    container.innerHTML = '<span class="currency-loading">Loading rates...</span>';

    const today = new Date().toISOString().split('T')[0];
    const todayCacheKey = 'hub-fx-' + today;
    const cached = localStorage.getItem(todayCacheKey);

    const renderAndFetchHistory = data => {
        renderCurrencyGrid(data, config.targets, container);
        fetchAndRenderSparklines(config.base, config.targets);
    };

    if (cached) {
        renderAndFetchHistory(JSON.parse(cached));
    } else {
        const url = 'https://api.frankfurter.dev/v1/latest?base=' + config.base + '&symbols=' + config.targets.join(',');
        fetch(url)
            .then(r => r.json())
            .then(data => {
                for (const key of Object.keys(localStorage)) {
                    if (key.startsWith('hub-fx-2') && key !== todayCacheKey) localStorage.removeItem(key);
                }
                localStorage.setItem(todayCacheKey, JSON.stringify(data));
                renderAndFetchHistory(data);
            })
            .catch(() => { container.innerHTML = '<span class="currency-loading">Could not load rates</span>'; });
    }
}

function renderCurrencyGrid(data, targets, container) {
    container.innerHTML = '';
    const dateEl = document.createElement('div');
    dateEl.className = 'currency-date';
    dateEl.textContent = 'As at ' + data.date;
    container.appendChild(dateEl);

    const grid = document.createElement('div');
    grid.className = 'currency-pairs';
    targets.forEach(code => {
        const rate = data.rates[code];
        if (rate === undefined) return;
        const pair = document.createElement('div');
        pair.className = 'currency-pair';
        pair.id = 'currency-pair-' + code;
        pair.innerHTML =
            '<span class="currency-code">' + code + '</span>' +
            '<span class="currency-rate">' + rate.toFixed(4) + '</span>';
        grid.appendChild(pair);
    });
    container.appendChild(grid);
}

function fetchAndRenderSparklines(base, targets) {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const cacheKey = 'hub-fx-hist-' + monthKey;
    const cached = localStorage.getItem(cacheKey);

    const applySparklines = histData => {
        targets.forEach(code => {
            const pairEl = document.getElementById('currency-pair-' + code);
            if (!pairEl) return;
            const { values, months } = extractMonthlyRates(histData, code);
            if (values.length < 2) return;
            pairEl.insertAdjacentHTML('beforeend', drawSparkline(values, months));
            initCharts(pairEl);
        });
    };

    if (cached) { applySparklines(JSON.parse(cached)); return; }

    const start = new Date(now);
    start.setMonth(start.getMonth() - 13);
    const url = 'https://api.frankfurter.dev/v1/' +
        start.toISOString().split('T')[0] + '..' + now.toISOString().split('T')[0] +
        '?base=' + base + '&symbols=' + targets.join(',');

    fetch(url)
        .then(r => r.json())
        .then(histData => {
            localStorage.setItem(cacheKey, JSON.stringify(histData));
            applySparklines(histData);
        })
        .catch(() => {}); // sparklines are non-critical
}

function extractMonthlyRates(histData, code) {
    const byMonth = {};
    Object.keys(histData.rates).sort().forEach(d => {
        const month = d.slice(0, 7);
        if (histData.rates[d][code] !== undefined) byMonth[month] = histData.rates[d][code];
    });
    return { values: Object.values(byMonth), months: Object.keys(byMonth) };
}

function drawSparkline(values, months) {
    const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const id = 'spark-' + Math.random().toString(36).slice(2, 9);
    const trending = values[values.length - 1] >= values[0] ? 'up' : 'down';
    const color = trending === 'up' ? '#10b981' : '#ef4444';
    const labels = (months || []).map(m => {
        const mo = MO[parseInt(m.slice(5)) - 1] || '';
        return mo + ' ' + m.slice(0, 4);
    });
    window._chartQ[id] = {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data: values,
                borderColor: color,
                borderWidth: 1.5,
                pointRadius: 2,
                pointHoverRadius: 4,
                pointBackgroundColor: color,
                pointBorderColor: 'transparent',
                fill: false,
                tension: 0.3,
            }],
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            // Padding keeps the spline + 4px hover dots inside the canvas
            // so they don't clip at the wrapper edge.
            layout: { padding: { top: 5, bottom: 5, left: 3, right: 3 } },
            interaction: { mode: 'nearest', intersect: false, axis: 'x' },
            plugins: {
                legend: { display: false },
                // Canvas-drawn tooltips would be clipped to the ~30px sparkline
                // height, so we render an HTML tooltip into the wrapper instead.
                tooltip: {
                    enabled: false,
                    external: ctx => {
                        const { chart, tooltip } = ctx;
                        const wrap = chart.canvas.parentNode;
                        let tt = wrap.querySelector('.fx-spark-tt');
                        if (!tt) {
                            tt = document.createElement('div');
                            tt.className = 'fx-spark-tt';
                            wrap.appendChild(tt);
                        }
                        if (tooltip.opacity === 0) { tt.style.opacity = 0; return; }
                        const dp = tooltip.dataPoints?.[0];
                        if (!dp) return;
                        tt.innerHTML =
                            '<span class="fx-spark-tt-label">' + dp.label + '</span>' +
                            '<span class="fx-spark-tt-val">' + dp.parsed.y.toFixed(4) + '</span>';
                        tt.style.opacity = 1;
                        tt.style.left = tooltip.caretX + 'px';
                        tt.style.top  = tooltip.caretY + 'px';
                    },
                },
            },
            scales: { x: { display: false }, y: { display: false } },
        },
    };
    return `<div class="fx-spark-wrap"><canvas data-chart-id="${id}"></canvas></div>`;
}

// ── Helpers ──
function getDomain(url) {
    try { return new URL(url).hostname; } catch { return null; }
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

// ── Search ──
document.getElementById('search')?.addEventListener('input', e => {
    const query = e.target.value.toLowerCase();
    if (query === '') {
        renderGroups(allGroups);
        renderPinned(pinnedItems);
    } else {
        document.getElementById('pinned-section').style.display = 'none';
        const filtered = allGroups.map(group => ({
            ...group,
            items: group.items.filter(item =>
                item.label.toLowerCase().includes(query) ||
                group.name.toLowerCase().includes(query)
            )
        })).filter(group => group.items.length > 0);
        renderGroups(filtered);
    }
});

// ── Reload button — hard reload to pick up new JS/CSS deployments ──
document.getElementById('reload-btn').addEventListener('click', () => { location.reload(); });

// ── Edit / Export / Reset buttons ──
document.getElementById('edit-btn').addEventListener('click', toggleEditMode);
document.getElementById('export-btn').addEventListener('click', exportConfig);
document.getElementById('reset-btn').addEventListener('click', resetConfig);

// ── Modal events ──
document.getElementById('modal-type').addEventListener('change', updateModalTypeFields);
document.getElementById('modal-save').addEventListener('click', saveModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('item-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('item-modal')) closeModal();
});
document.addEventListener('keydown', e => {
    if (document.getElementById('item-modal').style.display === 'flex') {
        if (e.key === 'Escape') closeModal();
        if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); saveModal(); }
    }
});

// ── Hash router ──
const VIEWS = ['view-dashboard', 'view-orders', 'view-orders-new', 'view-orders-detail', 'view-orders-edit', 'view-warehouse', 'view-admin', 'view-imports', 'view-dispatch-log', 'view-sales', 'view-calendar'];

function setActiveView(viewId) {
    VIEWS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === viewId ? '' : 'none';
    });
    // Remove slip-view class from detail container when navigating away
    if (viewId !== 'view-orders-detail') {
        document.getElementById('orders-detail-container')?.classList.remove('slip-view');
    }
    const topbar = document.getElementById('dashboard-topbar');
    if (topbar) topbar.style.display = viewId === 'view-dashboard' ? '' : 'none';
}

function setActiveNav(navId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const el = document.getElementById(navId);
    if (el) el.classList.add('active');
}

// Worker mode: a sticky UI restriction (not a security boundary — Cloudflare
// Access still gates the site). Set by visiting #worker once, cleared via
// #worker-exit. Persists across reloads so Andrew can share #worker with Jake
// and Jake never needs to navigate sidebar tabs again.
function applyWorkerModeClass() {
    const on = localStorage.getItem('hub-worker-mode') === '1';
    document.body.classList.toggle('body--worker', on);
}
applyWorkerModeClass();

// Role-based UI hiding. Cloudflare Access verifies identity at the edge;
// /api/me reads that and returns a role. Anything tagged .nav-item--admin-only
// is hidden when the user's role is not 'admin'.
let currentRole = 'admin';
async function applyRole() {
    try {
        const me = await fetch('/api/me').then(r => r.json());
        currentRole = me?.role || 'admin';
        document.body.classList.toggle('role-warehouse', currentRole === 'warehouse');
        // Warehouse role lands on orders, not dashboard.
        if (currentRole === 'warehouse' && (!location.hash || location.hash === '#dashboard')) {
            location.hash = 'orders';
        }
    } catch (_) { /* default admin */ }
}

async function handleRoute() {
    const hash = location.hash.replace(/^#\/?/, '');

    // Worker-mode toggles. These set the flag and bounce to the orders list
    // so the URL the user actually lands on is #orders (cleaner share link).
    if (hash === 'worker') {
        localStorage.setItem('hub-worker-mode', '1');
        applyWorkerModeClass();
        location.hash = 'orders';
        return;
    }
    if (hash === 'worker-exit') {
        localStorage.removeItem('hub-worker-mode');
        applyWorkerModeClass();
        location.hash = '';
        return;
    }

    // In worker mode (or warehouse role), only orders/* and dispatch-log are
    // reachable; any other hash bounces to orders. UI restriction only;
    // Cloudflare Access remains the actual security boundary at email level.
    const inWorkerMode = localStorage.getItem('hub-worker-mode') === '1';
    const restrictedRole = currentRole === 'warehouse';
    const allowedForRestricted = (h) => h.startsWith('orders') || h === 'dispatch-log';
    if ((inWorkerMode || restrictedRole) && hash && !allowedForRestricted(hash)) {
        location.hash = 'orders';
        return;
    }

    if (!hash || hash === 'dashboard') {
        if (inWorkerMode || restrictedRole) {
            location.hash = 'orders';
            return;
        }
        setActiveView('view-dashboard');
        setActiveNav('nav-dashboard');
        // Silently prefetch data-heavy tabs so they open instantly
        SalesView?.prefetch?.();
        Warehouse?.prefetchImports?.();
        return;
    }

    if (hash === 'orders') {
        setActiveView('view-orders');
        setActiveNav('nav-orders');
        await Orders.renderList(document.getElementById('orders-list-container'));
        Orders.handleXeroQueryParams();
        return;
    }

    if (hash === 'orders/new') {
        setActiveView('view-orders-new');
        setActiveNav('nav-orders');
        await Orders.renderNew(document.getElementById('orders-new-container'));
        return;
    }

    const editMatch = hash.match(/^orders\/([^/]+)\/edit$/);
    if (editMatch) {
        setActiveView('view-orders-edit');
        setActiveNav('nav-orders');
        await Orders.renderEdit(document.getElementById('orders-edit-container'), editMatch[1]);
        return;
    }

    if (hash.startsWith('orders/')) {
        const orderId = hash.slice('orders/'.length);
        setActiveView('view-orders-detail');
        setActiveNav('nav-orders');
        await Orders.renderDetail(document.getElementById('orders-detail-container'), orderId);
        return;
    }

    if (hash === 'warehouse') {
        setActiveView('view-warehouse');
        setActiveNav('nav-warehouse');
        await Warehouse.render(document.getElementById('warehouse-container'));
        return;
    }

    if (hash === 'admin') {
        setActiveView('view-admin');
        setActiveNav('nav-admin');
        await Admin.renderAdmin(document.getElementById('admin-container'));
        return;
    }

    if (hash === 'imports') {
        setActiveView('view-imports');
        setActiveNav('nav-imports');
        await ImportsView.render(document.getElementById('imports-container'));
        return;
    }

    if (hash === 'dispatch-log') {
        setActiveView('view-dispatch-log');
        setActiveNav('nav-dispatch-log');
        await DispatchLog.render(document.getElementById('dispatch-log-container'));
        return;
    }

    if (hash === 'sales') {
        setActiveView('view-sales');
        setActiveNav('nav-sales');
        await SalesView.render(document.getElementById('sales-container'));
        return;
    }

    if (hash === 'calendar') {
        setActiveView('view-calendar');
        setActiveNav('nav-calendar');
        await CalendarView.render(document.getElementById('calendar-container'));
        return;
    }

    // Unknown hash — fall back to dashboard
    location.hash = '';
}

window.addEventListener('hashchange', handleRoute);

// ── Nav items ──
document.getElementById('nav-dashboard').addEventListener('click', e => {
    e.preventDefault();
    location.hash = '';
});

// Make Orders nav item active (it was nav-item--soon)
const ordersNavItem = document.querySelector('.nav-item--soon[data-phase="Phase 1"]');
if (ordersNavItem) {
    ordersNavItem.classList.remove('nav-item--soon');
    ordersNavItem.id = 'nav-orders';
    ordersNavItem.querySelector('.nav-soon-badge')?.remove();
    const ordersBadge = document.createElement('span');
    ordersBadge.className = 'nav-badge';
    ordersBadge.id = 'nav-orders-badge';
    ordersBadge.style.display = 'none';
    ordersNavItem.appendChild(ordersBadge);
    ordersNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'orders';
    });
}

// Make Warehouse nav item active (it was nav-item--soon Phase 2)
const warehouseNavItem = document.querySelector('.nav-item--soon[data-phase="Phase 2"]');
if (warehouseNavItem) {
    warehouseNavItem.classList.remove('nav-item--soon');
    warehouseNavItem.id = 'nav-warehouse';
    warehouseNavItem.querySelector('.nav-soon-badge')?.remove();
    warehouseNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'warehouse';
    });
}

document.getElementById('nav-admin')?.addEventListener('click', e => {
    e.preventDefault();
    location.hash = 'admin';
});

// Make Imports nav item active (Phase 5)
const importsNavItem = document.querySelector('.nav-item--soon[data-phase="Phase 5"]');
if (importsNavItem) {
    importsNavItem.classList.remove('nav-item--soon');
    importsNavItem.id = 'nav-imports';
    importsNavItem.querySelector('.nav-soon-badge')?.remove();
    importsNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'imports';
    });
}

// Make Sales History nav item active
const salesNavItem = document.querySelector('.nav-item--soon[data-phase="Sales"]');
if (salesNavItem) {
    salesNavItem.classList.remove('nav-item--soon');
    salesNavItem.id = 'nav-sales';
    salesNavItem.querySelector('.nav-soon-badge')?.remove();
    salesNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'sales';
    });
}

// Make Calendar nav item active
const calendarNavItem = document.querySelector('.nav-item--soon[data-phase="Calendar"]');
if (calendarNavItem) {
    calendarNavItem.classList.remove('nav-item--soon');
    calendarNavItem.id = 'nav-calendar';
    calendarNavItem.querySelector('.nav-soon-badge')?.remove();
    calendarNavItem.addEventListener('click', e => {
        e.preventDefault();
        location.hash = 'calendar';
    });
}

// Remaining coming-soon nav items
document.querySelectorAll('.nav-item--soon').forEach(el => {
    el.addEventListener('click', e => {
        e.preventDefault();
        const label = el.textContent.replace(/\s*Soon\s*/gi, '').trim();
        showToast(label + ' — ' + el.dataset.phase + ', coming soon');
    });
});

// ── GitHub version ──
async function fetchGitHubVersion() {
    const el = document.querySelector('.sidebar-version');
    if (!el) return;
    try {
        const d = await fetch('https://api.github.com/repos/Magenta-Apple-NZ/erp-lite/commits/main',
            { headers: { Accept: 'application/vnd.github.v3+json' } }).then(r => r.ok ? r.json() : null);
        if (!d?.sha) return;
        const sha  = d.sha.slice(0, 7);
        const date = (d.commit?.committer?.date || d.commit?.author?.date || '').slice(0, 10);
        el.textContent = date ? date + ' · ' + sha : sha;
    } catch (_) {}
}

// ── Init ──
loadConfig();
applyRole().then(handleRoute);
fetchGitHubVersion();
setTimeout(() => {
    SalesView?.prefetch?.();
    Warehouse?.prefetchImports?.();
}, 400);
