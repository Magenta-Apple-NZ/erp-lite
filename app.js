// ── State ──
let allGroups = [];
let pinnedItems = [];
let currentConfig = {};
let collapsedGroups = JSON.parse(localStorage.getItem('hub-collapsed') || '{}');
let editMode = false;
let dragGroupIdx = null;
let dragItemInfo = null;
let modalCallback = null;

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
    // FX rates now live on the Imports page
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
        window.open(item.url, '_blank');
    } else if (item.type === 'file' || item.type === 'folder') {
        window.open('file://' + item.path);
    }
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
            const values = extractMonthlyRates(histData, code);
            if (values.length < 2) return;
            pairEl.insertAdjacentHTML('beforeend', drawSparkline(values));
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
    return Object.values(byMonth);
}

function drawSparkline(values) {
    const W = 100, H = 22, PAD = 2;
    const min = Math.min(...values), max = Math.max(...values);
    const range = max - min || 0.0001;
    const pts = values.map((v, i) => {
        const x = PAD + (i / (values.length - 1)) * (W - PAD * 2);
        const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const trending = values[values.length - 1] >= values[0] ? 'up' : 'down';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="sparkline sparkline-' + trending + '" preserveAspectRatio="none">' +
        '<polyline points="' + pts + '" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>';
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
document.getElementById('search').addEventListener('input', e => {
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
const VIEWS = ['view-dashboard', 'view-orders', 'view-orders-new', 'view-orders-detail', 'view-orders-edit', 'view-warehouse', 'view-admin', 'view-imports', 'view-sales'];

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

async function handleRoute() {
    const hash = location.hash.replace(/^#\/?/, '');

    if (!hash || hash === 'dashboard') {
        setActiveView('view-dashboard');
        setActiveNav('nav-dashboard');
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

    if (hash === 'sales') {
        setActiveView('view-sales');
        setActiveNav('nav-sales');
        await SalesView.render(document.getElementById('sales-container'));
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

// Remaining coming-soon nav items
document.querySelectorAll('.nav-item--soon').forEach(el => {
    el.addEventListener('click', e => {
        e.preventDefault();
        const label = el.textContent.replace(/\s*Soon\s*/gi, '').trim();
        showToast(label + ' — ' + el.dataset.phase + ', coming soon');
    });
});

// ── Init ──
loadConfig();
handleRoute();
