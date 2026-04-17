// ── State ──
let allGroups = [];
let pinnedItems = [];
let collapsedGroups = JSON.parse(localStorage.getItem('hub-collapsed') || '{}');

// ── SVG icons for item types ──
const TYPE_ICONS = {
    file: '<svg class="type-icon-svg" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    folder: '<svg class="type-icon-svg" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    link: null // will use favicon instead
};

// ── Load & render ──
function loadConfig() {
    fetch('config.json?_=' + Date.now())
        .then(r => r.json())
        .then(config => {
            allGroups = config.groups || [];
            pinnedItems = config.pinned || [];
            renderPinned(pinnedItems);
            renderGroups(allGroups);
            if (config.currencies) {
                renderHeaderCurrencies(config.currencies);
            }
            updateTimestamp();
        })
        .catch(err => {
            console.error('Error loading config:', err);
            document.getElementById('dashboard').innerHTML =
                '<p style="padding:2rem;color:#ef4444;">Error loading config.json — check the console.</p>';
        });
}

function updateTimestamp() {
    const el = document.getElementById('last-updated');
    const now = new Date();
    el.textContent = 'Loaded ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Pinned items ──
function renderPinned(items) {
    const section = document.getElementById('pinned-section');
    const container = document.getElementById('pinned-items');
    if (!items || items.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';
    container.innerHTML = '';
    items.forEach(item => {
        const el = document.createElement('a');
        el.className = 'pinned-item';
        el.href = '#';

        if (item.type === 'link' && item.url) {
            const domain = getDomain(item.url);
            if (domain) {
                const img = document.createElement('img');
                img.className = 'favicon';
                img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' + domain;
                img.alt = '';
                img.onerror = function() { this.style.display = 'none'; };
                el.appendChild(img);
            }
        }

        el.appendChild(document.createTextNode(item.label));
        el.addEventListener('click', e => { e.preventDefault(); openItem(item); });
        container.appendChild(el);
    });
}

// ── Groups ──
function renderGroups(groups) {
    const dashboard = document.getElementById('dashboard');
    dashboard.innerHTML = '';
    groups.forEach(group => {
        const card = document.createElement('div');
        card.className = 'group' + (collapsedGroups[group.name] ? ' collapsed' : '');

        // Header (clickable to collapse/expand)
        const header = document.createElement('div');
        header.className = 'group-header';

        const heading = document.createElement('h2');
        if (group.colour) {
            const dot = document.createElement('span');
            dot.className = 'accent-dot';
            dot.style.backgroundColor = group.colour;
            heading.appendChild(dot);
        }
        heading.appendChild(document.createTextNode(group.name));
        header.appendChild(heading);

        const chevron = document.createElement('span');
        chevron.className = 'collapse-icon';
        chevron.textContent = '▼';
        header.appendChild(chevron);

        header.addEventListener('click', () => {
            card.classList.toggle('collapsed');
            collapsedGroups[group.name] = card.classList.contains('collapsed');
            localStorage.setItem('hub-collapsed', JSON.stringify(collapsedGroups));
        });
        card.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'group-body';

        const list = document.createElement('ul');
        group.items.forEach(item => {
            const li = document.createElement('li');

            // Seasonal awareness
            if (item.season) {
                const active = isSeasonActive(item.season);
                if (!active) li.classList.add('off-season');
            }

            const link = document.createElement('a');
            link.href = '#';

            // Type icon or favicon
            if (item.type === 'link' && item.url) {
                const domain = getDomain(item.url);
                if (domain) {
                    const img = document.createElement('img');
                    img.className = 'type-icon favicon';
                    img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' + domain;
                    img.alt = '';
                    img.onerror = function() { this.style.display = 'none'; };
                    link.appendChild(img);
                }
            } else if (TYPE_ICONS[item.type]) {
                const iconSpan = document.createElement('span');
                iconSpan.innerHTML = TYPE_ICONS[item.type];
                link.appendChild(iconSpan.firstChild);
            }

            link.appendChild(document.createTextNode(item.label));
            link.addEventListener('click', e => { e.preventDefault(); openItem(item); });
            li.appendChild(link);

            // Tag badge
            if (item.tag) {
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.textContent = item.tag;
                li.appendChild(tag);
            }

            // Season badge
            if (item.season) {
                const tag = document.createElement('span');
                const active = isSeasonActive(item.season);
                tag.className = 'tag ' + (active ? 'season-active' : 'season-inactive');
                tag.textContent = active ? 'In season' : item.season;
                li.appendChild(tag);
            }

            // Copy path button for file/folder items
            if (item.type === 'file' || item.type === 'folder') {
                const copyBtn = document.createElement('button');
                copyBtn.className = 'copy-path-btn';
                copyBtn.textContent = 'Copy path';
                copyBtn.title = 'Copy file path to clipboard';
                copyBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(item.path).then(() => showToast('Path copied'));
                });
                li.appendChild(copyBtn);
            }

            list.appendChild(li);
        });

        body.appendChild(list);
        card.appendChild(body);
        dashboard.appendChild(card);
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
// Format: "oct-mar" means October through March (wraps around new year)
function isSeasonActive(season) {
    const parts = season.toLowerCase().split('-');
    if (parts.length !== 2) return true;
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    const start = months[parts[0]];
    const end = months[parts[1]];
    if (start === undefined || end === undefined) return true;
    const now = new Date().getMonth();
    if (start <= end) {
        return now >= start && now <= end;
    }
    // Wraps around year boundary (e.g. oct-mar)
    return now >= start || now <= end;
}

// ── Currency rates (header) ──
function renderHeaderCurrencies(config) {
    const container = document.getElementById('header-currencies');
    container.innerHTML = '<span class="currency-loading">Loading rates...</span>';
    fetchCurrencyRates(config.base, config.targets, container);
}

function fetchCurrencyRates(base, targets, container) {
    const url = 'https://api.frankfurter.dev/v1/latest?base=' + base + '&symbols=' + targets.join(',');
    fetch(url)
        .then(r => r.json())
        .then(data => {
            container.innerHTML = '';
            const date = document.createElement('div');
            date.className = 'currency-date';
            date.textContent = 'As at ' + data.date;
            container.appendChild(date);
            const grid = document.createElement('div');
            grid.className = 'currency-pairs';
            targets.forEach(code => {
                const rate = data.rates[code];
                if (rate === undefined) return;
                const pair = document.createElement('div');
                pair.className = 'currency-pair';
                pair.innerHTML =
                    '<span class="currency-code">' + code + '</span>' +
                    '<span class="currency-rate">' + rate.toFixed(4) + '</span>';
                grid.appendChild(pair);
            });
            container.appendChild(grid);
        })
        .catch(() => {
            container.innerHTML = '<span class="currency-loading">Could not load rates</span>';
        });
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

// ── Reload button ──
document.getElementById('reload-btn').addEventListener('click', () => {
    loadConfig();
    showToast('Config reloaded');
});

// ── Init ──
loadConfig();
