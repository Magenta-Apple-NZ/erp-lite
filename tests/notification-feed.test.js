// Notification feed builder — mirrors the Overview's notification list.
// Run under TZ=UTC and TZ=Pacific/Auckland (npm test does both).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeed, buildFeedItems, SOURCE } from '../functions/api/feeds/_notifications.js';
import { nzMidnightIso } from '../functions/api/_dates.js';

const TODAY = '2026-10-09';
const BASE = 'https://hub.example.com';

test('nzMidnightIso lands on NZ midnight in both NZDT and NZST', () => {
    assert.equal(nzMidnightIso('2026-10-09'), '2026-10-08T11:00:00.000Z'); // NZDT +13
    assert.equal(nzMidnightIso('2026-06-28'), '2026-06-27T12:00:00.000Z'); // NZST +12
});

test('envelope is spec v1 with a stable source', () => {
    const feed = buildFeed({ today: TODAY, baseUrl: BASE });
    assert.equal(feed.version, 1);
    assert.deepEqual(feed.source, SOURCE);
    assert.equal(SOURCE.id, 'businesshub');
    assert.deepEqual(feed.notifications, []);
});

test('orders not yet in Xero become one low-priority card that expires at next NZ midnight', () => {
    const orders = [
        { id: 'PKS-0001', status: 'new' },
        { id: 'PKS-0002', status: 'dispatched', xeroInvoiceId: 'x' },
        { id: 'PKS-0003', status: 'cancelled' },
        { id: 'PKS-0004', status: 'packed' },
    ];
    const items = buildFeedItems({ orders, today: TODAY, baseUrl: BASE });
    assert.equal(items.length, 1);
    const [it] = items;
    assert.equal(it.id, `orders-pending-xero-${TODAY}`);
    assert.equal(it.title, '2 orders not yet sent to Xero');
    assert.equal(it.body, 'PKS-0001, PKS-0004');
    assert.equal(it.priority, 'low');
    assert.equal(it.category, 'work');
    assert.equal(it.url, `${BASE}/#orders`);
    assert.equal(it.expires_at, nzMidnightIso('2026-10-10'));
});

test('shipments: overdue last milestone is high, arriving within 60 days is normal, beyond or done is skipped', () => {
    const shipments = [
        { id: 'ship-41', seq: 41, milestones: [{ label: 'Left Italy', date: '2026-09-01', done: true }, { label: 'Arrived in New Zealand', date: '2026-10-01', done: false }] },
        { id: 'ship-42', seq: 42, milestones: [{ label: 'Arrived in New Zealand', date: '2026-10-19', done: false }] },
        { id: 'ship-43', seq: 43, milestones: [{ label: 'Arrived in New Zealand', date: '2027-01-15', done: false }] },
        { id: 'ship-40', seq: 40, milestones: [{ label: 'Arrived in New Zealand', date: '2026-08-01', done: true }] },
        { id: 'ship-44', seq: 44, milestones: [] },
    ];
    const items = buildFeedItems({ shipments, today: TODAY, baseUrl: BASE });
    assert.deepEqual(items.map(i => i.id), [
        `shipment-overdue-ship-41-${TODAY}`,
        `shipment-arriving-ship-42-${TODAY}`,
    ]);
    assert.equal(items[0].title, 'Shipment #41 Arrived in New Zealand was due 8 days ago');
    assert.equal(items[0].priority, 'high');
    assert.equal(items[0].due_at, nzMidnightIso('2026-10-01'));
    assert.equal(items[0].url, `${BASE}/#imports/ship/ship-41`);
    assert.equal(items[1].title, 'Shipment #42 Arrived in New Zealand arriving in 10 days');
    assert.equal(items[1].priority, 'normal');
});

test('sticky calendar reminders: tax dates and keyword events inside the window, one id per occurrence', () => {
    const taxDates = {
        '2026-10-28': ['GST Return due'],      // 19 days ahead → outside 7-day lookahead
        '2026-10-10': ['Provisional Tax (x)'], // tomorrow → normal
        '2026-09-28': ['GST Return due'],      // 11 days ago → overdue, within 30-day lookback
        '2026-08-01': ['GST Return due'],      // outside lookback
    };
    const gcalEvents = [
        { summary: 'Pay Suppliers', start: { date: '2026-10-20' }, htmlLink: 'https://cal/1' }, // 11 days ahead → outside lookahead
        { summary: 'Pay Suppliers', start: { date: '2026-10-12' }, htmlLink: 'https://cal/2' },
        { summary: 'Dentist', start: { dateTime: '2026-10-12T09:00:00+13:00' } },
    ];
    const items = buildFeedItems({ taxDates, gcalEvents, today: TODAY, baseUrl: BASE });
    assert.deepEqual(items.map(i => i.id), [
        'cal-tax-2026-09-28-gst-return-due',
        'cal-tax-2026-10-10-provisional-tax-x',
        'cal-gcal-2026-10-12-pay-suppliers',
    ]);
    assert.equal(items[0].priority, 'high');
    assert.match(items[0].body, /overdue/);
    assert.equal(items[1].priority, 'normal');
    assert.equal(items[2].priority, 'low');
    assert.equal(items[2].url, 'https://cal/2');
    assert.equal(items[0].url, `${BASE}/#calendar`);
    assert.equal(items[2].category, 'finance');
    // Lingers lookbackDays past its date, then expires.
    assert.equal(items[1].expires_at, nzMidnightIso('2026-11-10'));
});

test('settings: stickyTaxDates=false drops tax dates; custom keywords and window are honoured', () => {
    const taxDates = { '2026-10-10': ['GST Return due'] };
    const gcalEvents = [{ summary: 'Stocktake', start: { date: '2026-10-20' } }];
    const items = buildFeedItems({
        taxDates, gcalEvents, today: TODAY, baseUrl: BASE,
        settings: { stickyTaxDates: false, stickyEventKeywords: ['stocktake'], lookaheadDays: 14 },
    });
    assert.deepEqual(items.map(i => i.id), ['cal-gcal-2026-10-20-stocktake']);
});

test('every item has a string id and title; the dashboard skips anything else', () => {
    const items = buildFeedItems({
        orders: [{ id: 'PKS-0009', status: 'new' }],
        shipments: [{ id: 'ship-9', milestones: [{ label: 'ETA', date: '2026-10-20', done: false }] }],
        taxDates: { '2026-10-10': ['GST Return due'] },
        today: TODAY, baseUrl: BASE,
    });
    for (const it of items) {
        assert.equal(typeof it.id, 'string');
        assert.equal(typeof it.title, 'string');
        assert.ok(['high', 'normal', 'low'].includes(it.priority));
        assert.ok(['work', 'finance'].includes(it.category));
    }
    assert.equal(items[1].title, 'Shipment ship-9 ETA arriving in 11 days');
});
