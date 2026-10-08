// Notification feed builder — the Overview's notification list, as data.
//
// Mirrors fetchNotificationItems() in app.js item for item:
//   1. orders not yet sent to Xero            (info     → low)
//   2. shipments overdue / arriving ≤60 days  (critical / warning → high / normal)
//   3. sticky calendar reminders: tax dates + keyword-matched Google Calendar
//      events, lookback/lookahead from config.json → notifications
//                                             (by distance → high / normal / low)
//
// Output follows the New Tab Dashboard "Notification Feed Spec v1". The
// dashboard dismisses an id permanently, so ids carry the same lifetime the
// Hub gives them: daily items (1, 2) are suffixed with today's date and come
// back tomorrow, exactly like the Hub's 24h dismissal; sticky calendar items
// (3) keep one id per occurrence, exactly like the Hub's sticky dismissal.
//
// Pure: no fetch, no KV, no clock — the caller passes `today` (NZ YYYY-MM-DD).

import { addDays, daysBetween, nzMidnightIso } from '../_dates.js';

export const SOURCE = { id: 'businesshub', name: 'Business Hub', icon: '💼' };

export const DEFAULT_SETTINGS = {
    stickyEventKeywords: ['pay suppliers'],
    stickyTaxDates: true,
    lookaheadDays: 7,
    lookbackDays: 30,
};

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function relative(days) {
    if (days === 0)  return 'today';
    if (days === 1)  return 'tomorrow';
    if (days === -1) return 'yesterday';
    return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

function longDate(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-NZ', {
        weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
    });
}

function shipTag(s) {
    return s.seq ? `Shipment #${s.seq}` : `Shipment ${String(s.id || '').slice(0, 6)}`;
}

/**
 * @param {object} p
 * @param {Array}  p.orders       Hub orders (KV order:* records)
 * @param {Array}  p.shipments    forecast.shipments (import:forecast)
 * @param {object} p.taxDates     { 'YYYY-MM-DD': [label, …] }
 * @param {Array|null} p.gcalEvents raw Google Calendar items, or null when not connected
 * @param {object} p.settings     config.json → notifications
 * @param {string} p.today        NZ YYYY-MM-DD
 * @param {string} p.baseUrl      e.g. https://hub.primetie.co.nz
 */
export function buildFeedItems({ orders = [], shipments = [], taxDates = {}, gcalEvents = null, settings = {}, today, baseUrl = '' }) {
    const cfg = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const base = String(baseUrl).replace(/\/$/, '');
    const hub = hash => `${base}/#${hash}`;
    const items = [];

    // 1. Orders pending Xero push — one card, back tomorrow if dismissed.
    const pending = (orders || []).filter(o => o && !o.xeroInvoiceId && o.status !== 'cancelled');
    if (pending.length) {
        items.push({
            id: `orders-pending-xero-${today}`,
            title: `${pending.length} order${pending.length === 1 ? '' : 's'} not yet sent to Xero`,
            body: pending.slice(0, 5).map(o => o.id).filter(Boolean).join(', ') + (pending.length > 5 ? ', …' : ''),
            category: 'work',
            priority: 'low',
            expires_at: nzMidnightIso(addDays(today, 1)),
            url: hub('orders'),
        });
    }

    // 2. Shipments — last milestone undone: overdue (any age) or arriving ≤60 days.
    const overdue = [], arriving = [];
    for (const s of (shipments || [])) {
        const ms = s.milestones || [];
        const last = ms[ms.length - 1];
        if (!last || !last.date || last.done) continue;
        const date = String(last.date).slice(0, 10);
        const days = daysBetween(today, date);
        const row = { ship: s, label: last.label, date, days };
        if (days < 0) overdue.push(row);
        else if (days <= 60) arriving.push(row);
    }
    overdue.sort((a, b) => a.days - b.days);
    arriving.sort((a, b) => a.days - b.days);
    for (const r of overdue) {
        items.push({
            id: `shipment-overdue-${r.ship.id}-${today}`,
            title: `${shipTag(r.ship)} ${r.label} was due ${relative(r.days)}`,
            body: 'Confirm arrival in Imports to clear this reminder.',
            category: 'work',
            priority: 'high',
            due_at: nzMidnightIso(r.date),
            expires_at: nzMidnightIso(addDays(today, 1)),
            url: hub(`imports/ship/${encodeURIComponent(r.ship.id || '')}`),
        });
    }
    for (const r of arriving) {
        items.push({
            id: `shipment-arriving-${r.ship.id}-${today}`,
            title: `${shipTag(r.ship)} ${r.label} arriving ${relative(r.days)}`,
            body: longDate(r.date),
            category: 'work',
            priority: 'normal',
            due_at: nzMidnightIso(r.date),
            expires_at: nzMidnightIso(addDays(today, 1)),
            url: hub(`imports/ship/${encodeURIComponent(r.ship.id || '')}`),
        });
    }

    // 3. Sticky calendar reminders — one id per occurrence, linger lookbackDays.
    const keywords = (cfg.stickyEventKeywords || []).map(k => String(k).toLowerCase()).filter(Boolean);
    const ahead = Number(cfg.lookaheadDays) || 7;
    const back  = Number(cfg.lookbackDays)  || 30;
    const fromStr = addDays(today, -back), toStr = addDays(today, ahead);
    const sticky = [];

    if (cfg.stickyTaxDates !== false) {
        for (const [date, labels] of Object.entries(taxDates || {})) {
            for (const label of labels) sticky.push({ type: 'tax', date, label, url: null });
        }
    }
    for (const ev of (gcalEvents || [])) {
        const date = (ev.start?.date || ev.start?.dateTime || '').slice(0, 10);
        const label = String(ev.summary || 'Event');
        if (!date) continue;
        if (!keywords.some(k => label.toLowerCase().includes(k))) continue;
        sticky.push({ type: 'gcal', date, label, url: ev.htmlLink || null });
    }

    sticky.sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label));
    for (const ev of sticky) {
        if (ev.date < fromStr || ev.date > toStr) continue;
        const days = daysBetween(today, ev.date);
        items.push({
            id: `cal-${ev.type}-${ev.date}-${slug(ev.label)}`,
            title: ev.label,
            body: `${longDate(ev.date)} (${relative(days)})${days < 0 ? ' · overdue' : ''}`,
            category: 'finance',
            priority: days < 0 ? 'high' : days <= 1 ? 'normal' : 'low',
            due_at: nzMidnightIso(ev.date),
            expires_at: nzMidnightIso(addDays(ev.date, back + 1)),
            url: ev.url || hub('calendar'),
        });
    }

    return items;
}

export function buildFeed(params) {
    return { version: 1, source: SOURCE, notifications: buildFeedItems(params) };
}
