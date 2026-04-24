// ── Calendar module ──
// Handles #calendar view — 3-year shipment grid + Google Calendar integration

const CalendarView = (() => {

    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    async function api(path) {
        const resp = await fetch(path);
        if (!resp.ok) throw new Error(resp.statusText);
        return resp.json();
    }

    function fmtKg(n) {
        const v = Math.round(n);
        if (Math.abs(v) >= 10000) return (v / 1000).toFixed(0) + 'k';
        if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return String(v);
    }

    function escHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    async function render(container) {
        container.innerHTML = `
        <div class="view-header">
            <div>
                <h1 class="view-title">Calendar</h1>
                <p class="view-subtitle">Shipment schedule and milestones across the next three years.</p>
            </div>
        </div>
        <div id="cal-body"><div class="orders-loading">Loading…</div></div>`;

        await renderCalendar();
    }

    async function renderCalendar() {
        const body = document.getElementById('cal-body');

        let config = {};
        try { config = (await api('/api/import/forecast')) || {}; } catch (e) { /* ok */ }

        const shipments = config.shipments || [];
        const now = new Date();
        const currentYear = now.getFullYear();
        const years = [currentYear, currentYear + 1, currentYear + 2];

        // Index shipments by ym
        const shipByYm = {};
        for (const s of shipments) {
            if (!shipByYm[s.ym]) shipByYm[s.ym] = [];
            shipByYm[s.ym].push(s);
        }

        const gridHtml = years.map(yr => {
            const monthCells = MONTH_NAMES.map((m, mo) => {
                const ym = `${yr}-${String(mo + 1).padStart(2, '0')}`;
                const ships = shipByYm[ym] || [];
                const isToday = yr === now.getFullYear() && mo === now.getMonth();
                const isPast  = yr < now.getFullYear() || (yr === now.getFullYear() && mo < now.getMonth());

                const badges = ships.map(s => {
                    const undone = (s.milestones || []).filter(m => !m.done).length;
                    const label  = s.campaign || fmtKg(s.kg) + ' kg';
                    return `<div class="cal-ship-badge${isPast ? ' cal-ship-badge--past' : ''}">
                        ${escHtml(label)}
                        ${undone ? `<span class="cal-milestone-flag">⚑${undone}</span>` : ''}
                    </div>`;
                }).join('');

                return `<div class="cal-month-cell${isToday ? ' cal-month-cell--today' : ''}${isPast ? ' cal-month-cell--past' : ''}${ships.length ? ' cal-month-cell--has-ship' : ''}">
                    <div class="cal-month-label">${m}</div>
                    <div class="cal-month-content">${badges}</div>
                </div>`;
            }).join('');

            return `<div class="cal-year-row">
                <div class="cal-year-label">${yr}</div>
                <div class="cal-months-grid">${monthCells}</div>
            </div>`;
        }).join('');

        const upcomingMilestones = shipments
            .flatMap(s => (s.milestones || [])
                .filter(m => !m.done)
                .map(m => ({ ship: s, label: m.label, date: m.date }))
            )
            .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        const pendingHtml = upcomingMilestones.length ? `
        <div class="cat-section" style="margin-bottom:1.5rem">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Pending Milestones</h2>
                    <p class="cat-sub">Unresolved tasks across all shipments.</p>
                </div>
            </div>
            <table class="sales-table" style="margin-top:0.5rem">
                <thead><tr><th>Milestone</th><th>Shipment</th><th>Due</th></tr></thead>
                <tbody>
                    ${upcomingMilestones.slice(0, 20).map(item => `<tr>
                        <td>${escHtml(item.label)}</td>
                        <td style="color:#64748b">${escHtml(item.ship.campaign || item.ship.ym)}</td>
                        <td style="color:#94a3b8;font-size:0.8rem">${item.date || '—'}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>` : '';

        body.innerHTML = `
        <div class="cat-section" style="margin-bottom:1.5rem">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">3-Year Shipment Schedule</h2>
                    <p class="cat-sub">⚑ = unresolved milestones. <a href="#imports" class="btn-link">Manage shipments →</a></p>
                </div>
            </div>
            <div class="cal-grid">${gridHtml}</div>
        </div>

        ${pendingHtml}

        <div class="cat-section" style="max-width:640px">
            <div class="cat-section-head">
                <div>
                    <h2 class="cat-title">Google Calendar</h2>
                    <p class="cat-sub">Sync shipment milestones with <strong>andrew@primetie.co.nz</strong>.</p>
                </div>
            </div>
            <div class="imp-connect-panel">
                <h3 class="imp-connect-title">Connect Google Calendar</h3>
                <ol class="imp-connect-steps">
                    <li>Create a Google Cloud project and enable the Calendar API</li>
                    <li>Create OAuth 2.0 credentials (web app) — set redirect URI to <code>https://hub.primetie.co.nz/api/calendar/callback</code></li>
                    <li>Add <code>GCAL_CLIENT_ID</code> and <code>GCAL_CLIENT_SECRET</code> to the Cloudflare Worker environment</li>
                    <li>Click Connect to authorise — tokens will be stored in KV</li>
                </ol>
                <div class="imp-connect-row">
                    <button class="btn-primary btn-sm" disabled>Connect Google Calendar</button>
                    <span style="font-size:0.78rem;color:#94a3b8;margin-left:0.5rem">Worker env vars required</span>
                </div>
                <p class="imp-connect-note">Once connected, shipment arrivals and undone milestones will push to your calendar. External events will appear in the schedule grid above.</p>
            </div>
        </div>`;
    }

    return { render };
})();
