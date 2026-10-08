// Shared NZ-local date helpers.
//
// The Hub is an NZ business but stores UTC ISO timestamps. Every business
// date (sales day, count date, movement date) is a Pacific/Auckland calendar
// date as a 'YYYY-MM-DD' string, and ranges compare those strings directly.
// Never `new Date(x).toISOString().slice(0,10)` — that is the UTC day and
// drifts by one at NZ evening / early morning.

export function nzYmd(iso) {
    try {
        return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
    } catch {
        return String(iso || '').slice(0, 10);
    }
}

export function nzToday() {
    return nzYmd(new Date());
}

export function isYmd(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

// Calendar arithmetic on 'YYYY-MM-DD' strings, done in UTC on the components
// so the host timezone can never leak in.
export function addDays(ymd, n) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
    const p = v => String(v).padStart(2, '0');
    return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// Whole days from a to b ('YYYY-MM-DD' each); positive when b is later.
export function daysBetween(a, b) {
    const [ay, am, ad] = String(a).split('-').map(Number);
    const [by, bm, bd] = String(b).split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ISO 8601 instant (UTC) for 12:00am Pacific/Auckland on a 'YYYY-MM-DD'.
// Used wherever an external consumer wants a real timestamp for a business
// date (e.g. the notification feed's due_at). Tries NZDT (+13) then NZST
// (+12) and keeps the candidate that lands on that calendar day at 00:00.
export function nzMidnightIso(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    const base = Date.UTC(y, m - 1, d);
    for (const offsetHours of [13, 12]) {
        const t = new Date(base - offsetHours * 3600000);
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', hourCycle: 'h23',
        }).formatToParts(t);
        const get = type => (parts.find(p => p.type === type) || {}).value;
        if (`${get('year')}-${get('month')}-${get('day')}` === ymd && get('hour') === '00') {
            return t.toISOString();
        }
    }
    return new Date(base - 12 * 3600000).toISOString();
}
