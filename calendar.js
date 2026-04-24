// ── Calendar module ──
// Current-year monthly view: NZ holidays, tax dates, shipments, Google Calendar

const CalendarView = (() => {

    const MONTH_NAMES = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // NZ Public Holidays — hardcoded for 2025 and 2026
    const NZ_HOLIDAYS = {
        '2025-01-01': "New Year's Day",
        '2025-01-02': 'Day after New Year',
        '2025-02-06': 'Waitangi Day',
        '2025-04-18': 'Good Friday',
        '2025-04-21': 'Easter Monday',
        '2025-04-25': 'Anzac Day',
        '2025-06-02': "King's Birthday",
        '2025-06-20': 'Matariki',
        '2025-10-27': 'Labour Day',
        '2025-12-25': 'Christmas Day',
        '2025-12-26': 'Boxing Day',
        '2026-01-01': "New Year's Day",
        '2026-01-02': 'Day after New Year',
        '2026-02-06': 'Waitangi Day',
        '2026-04-03': 'Good Friday',
        '2026-04-06': 'Easter Monday',
        '2026-04-27': 'Anzac Day (observed)',
        '2026-06-01': "King's Birthday",
        '2026-06-26': 'Matariki',
        '2026-10-26': 'Labour Day',
        '2026-12-25': 'Christmas Day',
        '2026-12-28': 'Boxing Day (observed)',
    };

    // NZ key tax dates — GST bi-monthly (28th of month after period end),
    // Provisional Tax (3 instalments), Income Tax Return (7 Jul)
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

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Calendar</h1>
                <p class="view-subtitle">NZ public holidays, tax dates, shipments, and your Google Calendar.</p>
            </div>
        </div>
        <div id="cal-body"><div class="orders-loading">Loading…</div></div>`;

        renderCalendar();
    }

    async function renderCalendar() {
        const body = document.getElementById('cal-body');
        const now = new Date();
        const currentYear = now.getFullYear();
        const yearStr = String(currentYear);

        // Fetch shipment config + GCal status in parallel
        let config = {}, gcalConnected = false, gcalEvents = [];
        try {
            const [configData, statusData] = await Promise.all([
                fetch('/api/import/forecast').then(r => r.ok ? r.json() : {}).catch(() => ({})),
                fetch('/api/calendar/status').then(r => r.ok ? r.json() : {}).catch(() => ({})),
            ]);
            config = configData || {};
            gcalConnected = !!(statusData && statusData.connected);

            if (gcalConnected) {
                const tMin = new Date(currentYear, 0, 1).toISOString();
                const tMax = new Date(currentYear, 11, 31, 23, 59, 59).toISOString();
                gcalEvents = await fetch(`/api/calendar/events?timeMin=${encodeURIComponent(tMin)}&timeMax=${encodeURIComponent(tMax)}`)
                    .then(r => r.ok ? r.json() : []).catch(() => []);
            }
        } catch (e) { /* render with what we have */ }

        // Build event map: 'YYYY-MM-DD' → [{type, label}]
        const eventsByDate = {};

        // NZ public holidays for current year
        for (const [date, label] of Object.entries(NZ_HOLIDAYS)) {
            if (date.startsWith(yearStr)) addEvent(eventsByDate, date, { type: 'holiday', label });
        }

        // NZ tax dates for current year
        for (const [date, labels] of Object.entries(NZ_TAX)) {
            if (date.startsWith(yearStr)) {
                for (const label of labels) addEvent(eventsByDate, date, { type: 'tax', label });
            }
        }

        // Shipments for current year (use arrival date if set, else 1st of month)
        for (const s of (config.shipments || [])) {
            if (!s.ym || !s.ym.startsWith(yearStr)) continue;
            const date = s.arrivalDate || (s.ym + '-01');
            const label = s.campaign || (s.kg ? fmtKg(s.kg) + ' kg' : 'Shipment');
            addEvent(eventsByDate, date.slice(0, 10), { type: 'shipment', label });
        }

        // Google Calendar events
        for (const ev of gcalEvents) {
            const date = (ev.start?.date || ev.start?.dateTime || '').slice(0, 10);
            if (!date || !date.startsWith(yearStr)) continue;
            const label = ev.summary || 'Event';
            addEvent(eventsByDate, date, { type: 'gcal', label });
        }

        // Render 12 month cards (4×3)
        const monthCards = [];
        for (let mo = 0; mo < 12; mo++) {
            monthCards.push(renderMonthCard(currentYear, mo, now, eventsByDate));
        }

        // Pending milestones from shipment config
        const shipments = config.shipments || [];
        const pending = shipments
            .flatMap(s => (s.milestones || [])
                .filter(m => !m.done)
                .map(m => ({ ship: s, label: m.label, date: m.date }))
            )
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
            .slice(0, 15);

        const pendingHtml = pending.length ? `
        <div class="cal-pending-section">
            <div class="cat-section">
                <div class="cat-section-head">
                    <div>
                        <h2 class="cat-title">Pending Milestones</h2>
                        <p class="cat-sub">Unresolved tasks across all shipments.</p>
                    </div>
                </div>
                <table class="sales-table" style="margin-top:0.5rem">
                    <thead><tr><th>Milestone</th><th>Shipment</th><th>Due</th></tr></thead>
                    <tbody>
                        ${pending.map(item => `<tr>
                            <td>${escHtml(item.label)}</td>
                            <td style="color:#64748b">${escHtml(item.ship.campaign || item.ship.ym)}</td>
                            <td style="color:#94a3b8;font-size:0.8rem">${item.date || '—'}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>` : '';

        const gcalStatusHtml = gcalConnected
            ? '<span class="cal-gcal-status--on">● Google Calendar connected</span>'
            : '<a href="/api/calendar/auth" class="btn-primary btn-sm">Connect Google Calendar</a>';

        body.innerHTML = `
        <div class="cat-section">
            <div class="cal-year-header">
                <h2 class="cal-year-title">${currentYear}</h2>
                <div>${gcalStatusHtml}</div>
            </div>
            <div class="cal-legend">
                <span class="cal-legend-item cal-legend-item--holiday">Public Holiday</span>
                <span class="cal-legend-item cal-legend-item--tax">Tax Date</span>
                <span class="cal-legend-item cal-legend-item--shipment">Shipment</span>
                ${gcalConnected ? '<span class="cal-legend-item cal-legend-item--gcal">Google Calendar</span>' : ''}
            </div>
            <div class="cal-months-4col">
                ${monthCards.join('')}
            </div>
        </div>
        ${pendingHtml}`;
    }

    function renderMonthCard(year, mo, now, eventsByDate) {
        const isCurrentMonth = year === now.getFullYear() && mo === now.getMonth();
        const isPastMonth = year < now.getFullYear() || (year === now.getFullYear() && mo < now.getMonth());
        const daysInMonth = new Date(year, mo + 1, 0).getDate();

        // Collect all events for this month sorted by day
        const monthEvents = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const date = `${year}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            if (eventsByDate[date]) {
                for (const ev of eventsByDate[date]) monthEvents.push({ day: d, ...ev });
            }
        }

        const eventsHtml = monthEvents.length
            ? monthEvents.map(ev =>
                `<div class="cal-ev cal-ev--${escHtml(ev.type)}">` +
                `<span class="cal-ev-day">${ev.day}</span>` +
                `<span class="cal-ev-label" title="${escHtml(ev.label)}">${escHtml(ev.label)}</span>` +
                `</div>`
            ).join('')
            : '<span class="cal-no-events">No events</span>';

        const todayBadge = isCurrentMonth
            ? `<span class="cal-today-badge">${now.getDate()} ${MONTH_SHORT[mo]}</span>`
            : '';

        const cardClass = ['cal-month-card',
            isCurrentMonth ? 'cal-month-card--current' : '',
            isPastMonth    ? 'cal-month-card--past'    : '',
        ].filter(Boolean).join(' ');

        return `<div class="${cardClass}">
            <div class="cal-month-header">
                <span class="cal-month-name">${MONTH_NAMES[mo]}</span>
                ${todayBadge}
            </div>
            <div class="cal-month-events">${eventsHtml}</div>
        </div>`;
    }

    return { render };
})();
