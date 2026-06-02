// ── Calendar module ──
// Two-pane layout: 60% focused month detail, 40% scrollable month sidebar

const CalendarView = (() => {

    const MONTH_NAMES = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAY_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    const NZ_HOLIDAYS = {
        '2025-01-01': "New Year's Day",       '2025-01-02': 'Day after New Year',
        '2025-02-06': 'Waitangi Day',          '2025-04-18': 'Good Friday',
        '2025-04-21': 'Easter Monday',         '2025-04-25': 'Anzac Day',
        '2025-06-02': "King's Birthday",       '2025-06-20': 'Matariki',
        '2025-10-27': 'Labour Day',            '2025-12-25': 'Christmas Day',
        '2025-12-26': 'Boxing Day',
        '2026-01-01': "New Year's Day",        '2026-01-02': 'Day after New Year',
        '2026-02-06': 'Waitangi Day',          '2026-04-03': 'Good Friday',
        '2026-04-06': 'Easter Monday',         '2026-04-27': 'Anzac Day (observed)',
        '2026-06-01': "King's Birthday",       '2026-06-26': 'Matariki',
        '2026-10-26': 'Labour Day',            '2026-12-25': 'Christmas Day',
        '2026-12-28': 'Boxing Day (observed)',
    };

    const NZ_TAX = {
        '2025-02-28': ['GST Return due'],
        '2025-04-28': ['GST Return due'],
        '2025-05-07': ['Provisional Tax (3rd)'],
        '2025-06-28': ['GST Return due'],
        '2025-08-28': ['GST Return due', 'Provisional Tax (1st)'],
        '2025-10-28': ['GST Return due'],
        '2025-12-28': ['GST Return due'],
        '2026-01-15': ['Provisional Tax (2nd)'],
        '2026-02-28': ['GST Return due'],
        '2026-04-28': ['GST Return due'],
        '2026-05-07': ['Provisional Tax (3rd)'],
        '2026-06-28': ['GST Return due'],
        '2026-07-07': ['Income Tax Return due'],
        '2026-08-28': ['GST Return due', 'Provisional Tax (1st)'],
        '2026-10-28': ['GST Return due'],
        '2026-12-28': ['GST Return due'],
    };

    const TYPE_LABELS = {
        holiday:  'Public Holidays',
        tax:      'Tax Dates',
        shipment: 'Shipments',
        gcal:     'Google Calendar',
    };

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmtKg(n) {
        const v = Math.round(n);
        if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
        if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(v);
    }

    function addEvent(map, date, ev) {
        if (!map[date]) map[date] = [];
        map[date].push(ev);
    }

    // Friendly shipment label: "#43 — LC ready" or "#43 ETA (18,888 kg)".
    // Falls back to the shipment id when there's no seq.
    function shipPrefix(s) {
        const seq = s.seq;
        const tag = seq ? `#${seq}` : (s.id ? s.id.slice(0, 6) : 'Ship');
        const sub = s.note || s.campaign || '';
        return sub ? `${tag} ${sub}` : tag;
    }

    // Load everything the calendar shows into a single events-by-date map.
    // Exposed so the dashboard widget renders the same dataset as the
    // dedicated /calendar view — no second copy of shipment / holiday /
    // tax / Google Calendar fetching.
    //
    // Returns { eventsByDate, gcalConnected, availableTypes }.
    async function loadEvents({ rangeDays = 365 } = {}) {
        const now = new Date();
        const eventsByDate = {};

        // Holidays + tax dates from the constants above.
        for (const [date, label] of Object.entries(NZ_HOLIDAYS))
            addEvent(eventsByDate, date, { type: 'holiday', label });
        for (const [date, labels] of Object.entries(NZ_TAX))
            for (const label of labels) addEvent(eventsByDate, date, { type: 'tax', label });

        // Shipments (from /api/import/forecast) and Google Calendar
        // (when connected). Fetched in parallel — both are optional.
        let config = {}, gcalConnected = false, gcalEvents = [];
        try {
            const [configData, statusData] = await Promise.all([
                fetch('/api/import/forecast').then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch('/api/calendar/status').then(r => r.ok ? r.json() : {}).catch(() => ({})),
            ]);
            config = configData || {};
            gcalConnected = !!(statusData?.connected);

            if (gcalConnected) {
                const tMin = encodeURIComponent(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).toISOString());
                const tMax = encodeURIComponent(new Date(now.getFullYear(), now.getMonth(), now.getDate() + rangeDays).toISOString());
                const resp = await fetch(`/api/calendar/events?timeMin=${tMin}&timeMax=${tMax}`).then(r => r.ok ? r.json() : null).catch(() => null);
                gcalEvents = Array.isArray(resp?.items) ? resp.items : Array.isArray(resp) ? resp : [];
            }
        } catch (e) { /* render with what we have */ }

        // V3 shipments carry milestones[] — each becomes its own event,
        // tagged with shipId so the row can deep-link to the Imports view.
        // Legacy shipments fall back to a single ETA event.
        for (const s of (config.shipments || [])) {
            const prefix = shipPrefix(s);
            const milestones = (s.milestones || []).filter(m => m && m.date);
            if (milestones.length) {
                for (const m of milestones) {
                    const stageLabel = m.label === 'Order placed' ? 'Start LC' : m.label;
                    addEvent(eventsByDate, m.date.slice(0, 10), {
                        type: 'shipment',
                        label: `${prefix} — ${stageLabel}${m.done ? ' ✓' : ''}`,
                        shipId: s.id,
                    });
                }
                continue;
            }
            const date = (s.arrivalDate || (s.ym ? s.ym + '-01' : '')).slice(0, 10);
            if (!date) continue;
            const kg = Number(s.kg) || 0;
            const tail = s.campaign || (kg ? fmtKg(kg) + ' kg' : 'ETA');
            addEvent(eventsByDate, date, {
                type: 'shipment',
                label: `${prefix} — ${tail}`,
                shipId: s.id,
            });
        }

        for (const ev of gcalEvents) {
            const date = (ev.start?.date || ev.start?.dateTime || '').slice(0, 10);
            if (!date) continue;
            addEvent(eventsByDate, date, {
                type: 'gcal',
                label: ev.summary || 'Event',
                url: ev.htmlLink || null,
            });
        }

        const availableTypes = ['holiday', 'tax', 'shipment', ...(gcalConnected ? ['gcal'] : [])];
        return { eventsByDate, gcalConnected, availableTypes };
    }

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Calendar</h1>
                <p class="view-subtitle">NZ public holidays, tax dates, shipments, and your Google Calendar.</p>
            </div>
        </div>
        <div id="cal-body"><div class="orders-loading">Loading…</div></div>`;
        loadAndRender();
    }

    async function loadAndRender() {
        const body = document.getElementById('cal-body');
        const now  = new Date();

        const { eventsByDate, gcalConnected, availableTypes } = await loadEvents({ rangeDays: 365 });

        // Session state — persists while the view is open
        const state = {
            focusMo: now.getMonth(),
            focusYr: now.getFullYear(),
            toggles: new Set(availableTypes),
        };

        function visibleEvents(date) {
            return (eventsByDate[date] || []).filter(ev => state.toggles.has(ev.type));
        }

        // ── Rebuild both panes ──
        function rebuild() {
            // Scaffold
            body.innerHTML = `
            <div class="cal-layout">
                <div class="cal-detail-pane" id="cal-detail-pane"></div>
                <div class="cal-sidebar-pane" id="cal-sidebar-pane"></div>
            </div>`;
            buildDetail();
            buildSidebar();
        }

        // ── Detail pane (60%) ──
        function buildDetail() {
            const pane = document.getElementById('cal-detail-pane');
            const { focusMo, focusYr } = state;
            const daysInMonth = new Date(focusYr, focusMo + 1, 0).getDate();
            const firstDow    = new Date(focusYr, focusMo, 1).getDay();
            const isThisMonth = focusYr === now.getFullYear() && focusMo === now.getMonth();

            // Toggle bar
            const togglesHtml = availableTypes.map(t =>
                `<button class="cal-toggle-btn${state.toggles.has(t) ? ' active' : ''}" data-toggle="${t}">
                    <span class="cal-td cal-td--${t}"></span>${escHtml(TYPE_LABELS[t])}
                </button>`
            ).join('');

            const gcalBtn = gcalConnected
                ? `<span class="cal-gcal-status--on" style="font-size:0.75rem">● Connected</span>`
                : `<a href="/api/calendar/auth" class="btn-sm btn-primary" style="white-space:nowrap">Connect Google Calendar</a>`;

            // Day grid cells
            const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;
            let dayCells = DAY_SHORT.map(d => `<div class="cal-day-hdr">${d}</div>`).join('');
            for (let i = 0; i < totalCells; i++) {
                const d = i - firstDow + 1;
                if (d < 1 || d > daysInMonth) {
                    dayCells += '<div class="cal-day cal-day--empty"></div>';
                    continue;
                }
                const date = `${focusYr}-${String(focusMo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                const evs  = visibleEvents(date);
                const isToday = isThisMonth && d === now.getDate();
                const isPast  = focusYr < now.getFullYear() ||
                    (focusYr === now.getFullYear() && focusMo < now.getMonth()) ||
                    (isThisMonth && d < now.getDate());

                const shown    = evs.slice(0, 2);
                const overflow = evs.length - shown.length;
                const chips    = shown.map(ev =>
                    `<div class="cal-day-ev cal-day-ev--${ev.type}" title="${escHtml(ev.label)}">${escHtml(ev.label)}</div>`
                ).join('') + (overflow > 0 ? `<div class="cal-day-more">+${overflow}</div>` : '');

                dayCells += `<div class="cal-day${isToday ? ' cal-day--today' : ''}${isPast ? ' cal-day--past' : ''}">
                    <span class="cal-day-num${isToday ? ' cal-day-num--today' : ''}">${d}</span>
                    ${chips}
                </div>`;
            }

            // Month event list (scrollable, below grid)
            const monthEvs = [];
            for (let d = 1; d <= daysInMonth; d++) {
                const date = `${focusYr}-${String(focusMo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                for (const ev of visibleEvents(date)) monthEvs.push({ d, ...ev });
            }
            const evRow = ev => {
                const inner = `<span class="cal-ev-day">${ev.d}</span><span class="cal-ev-label">${escHtml(ev.label)}</span>`;
                if (ev.shipId) {
                    return `<a class="cal-ev cal-ev--${ev.type} cal-ev--link" href="#imports/ship/${encodeURIComponent(ev.shipId)}">${inner}</a>`;
                }
                if (ev.url) {
                    return `<a class="cal-ev cal-ev--${ev.type} cal-ev--link" href="${escHtml(ev.url)}" target="_blank" rel="noopener">${inner}<span class="cal-ev-ext">↗</span></a>`;
                }
                return `<div class="cal-ev cal-ev--${ev.type}">${inner}</div>`;
            };
            const evListHtml = monthEvs.length
                ? monthEvs.map(evRow).join('')
                : '<span class="cal-no-events">No events this month</span>';

            pane.innerHTML = `
            <div class="cal-detail-head">
                <div class="cal-detail-nav">
                    <button class="cal-nav-btn" id="cal-prev">&#8249;</button>
                    <h2 class="cal-detail-title">${MONTH_NAMES[focusMo]} ${focusYr}</h2>
                    <button class="cal-nav-btn" id="cal-next">&#8250;</button>
                </div>
                <div class="cal-controls-row">
                    <div class="cal-toggles">${togglesHtml}</div>
                    <div>${gcalBtn}</div>
                </div>
            </div>
            <div class="cal-month-ev-list">${evListHtml}</div>
            <div class="cal-day-grid">${dayCells}</div>`;

            // Nav buttons
            pane.querySelector('#cal-prev').addEventListener('click', () => {
                state.focusMo--;
                if (state.focusMo < 0) { state.focusMo = 11; state.focusYr--; }
                rebuild();
            });
            pane.querySelector('#cal-next').addEventListener('click', () => {
                state.focusMo++;
                if (state.focusMo > 11) { state.focusMo = 0; state.focusYr++; }
                rebuild();
            });

            // Toggle buttons
            pane.querySelectorAll('.cal-toggle-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const t = btn.dataset.toggle;
                    if (state.toggles.has(t)) state.toggles.delete(t);
                    else state.toggles.add(t);
                    rebuild();
                });
            });
        }

        // ── Sidebar pane (40%, scrollable) ──
        function buildSidebar() {
            const pane = document.getElementById('cal-sidebar-pane');
            const { focusMo, focusYr } = state;
            const startYr = now.getFullYear();
            const years = [startYr, startYr + 1, startYr + 2];

            let html = '';
            for (const yr of years) {
                html += `<div class="cal-sidebar-yr">${yr}</div>`;
                for (let mo = 0; mo < 12; mo++) {
                    const isSelected = mo === focusMo && yr === focusYr;
                    const isNow      = mo === now.getMonth() && yr === now.getFullYear();
                    const dim        = new Date(yr, mo + 1, 0).getDate();
                    const typesSeen  = new Set();
                    for (let d = 1; d <= dim; d++) {
                        const date = `${yr}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                        for (const ev of (eventsByDate[date] || [])) {
                            if (state.toggles.has(ev.type)) typesSeen.add(ev.type);
                        }
                    }
                    const dots = [...typesSeen].map(t =>
                        `<span class="cal-sd-dot cal-sd-dot--${t}"></span>`
                    ).join('');
                    html += `<button class="cal-sidebar-mo${isSelected ? ' selected' : ''}${isNow ? ' is-now' : ''}"
                                data-mo="${mo}" data-yr="${yr}">
                        <span class="cal-sd-name">${MONTH_SHORT[mo]}</span>
                        <span class="cal-sd-dots">${dots}</span>
                        ${isNow ? '<span class="cal-sd-now">Today</span>' : ''}
                    </button>`;
                }
            }

            pane.innerHTML = html;

            pane.querySelectorAll('.cal-sidebar-mo').forEach(btn => {
                btn.addEventListener('click', () => {
                    state.focusMo = parseInt(btn.dataset.mo);
                    state.focusYr = parseInt(btn.dataset.yr);
                    rebuild();
                    // Scroll selected into view after rebuild
                    setTimeout(() => {
                        document.querySelector('.cal-sidebar-mo.selected')
                            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    }, 0);
                });
            });

            // Scroll current selection into view on first load
            setTimeout(() => {
                pane.querySelector('.cal-sidebar-mo.selected')
                    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }, 0);
        }

        rebuild();
    }

    return { render, loadEvents };
})();
