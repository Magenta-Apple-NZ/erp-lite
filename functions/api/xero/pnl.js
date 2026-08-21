// GET /api/xero/pnl — Profit & Loss summary for the dashboard widget.
//
// Returns:
//   {
//     fy:      { label, from, to, income, cogs, grossProfit, expenses, netProfit },
//     priorFy: { label, from, to, ...same for the same date-span one year earlier },
//     monthly: { labels: ['Sep 25', …, 'Aug 26'], income: [], expenses: [], netProfit: [] },
//     asOf
//   }
// NZ financial year: 1 Apr → 31 Mar. Three Xero report calls per refresh,
// cached in XERO_KV for an hour (reports count against the 60/min limit and
// every dashboard load would otherwise hit them).
//
// Needs the `accounting.reports.read` scope. Tokens granted before that
// scope was added get a 403 from Xero → we answer { needsReauth: true } so
// the widget can prompt a one-off reconnect.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../_xero.js';

const CACHE_KEY = 'pnl_cache';
const CACHE_TTL = 3600;

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fyBounds(today) {
    const y = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1; // Apr = 3
    return { from: new Date(y, 3, 1), to: today, label: `FY${String(y + 1).slice(-2)}` };
}

// Walk a Xero report, collecting { 'Total Income': [col values…], … } from
// Row / SummaryRow cells (first cell is the label, the rest are columns).
function collectRows(rows, out) {
    for (const r of rows || []) {
        if (r.RowType === 'Section') { collectRows(r.Rows, out); continue; }
        if ((r.RowType === 'SummaryRow' || r.RowType === 'Row') && Array.isArray(r.Cells) && r.Cells.length > 1) {
            const label = String(r.Cells[0]?.Value || '').trim();
            if (!label || out[label]) continue;
            out[label] = r.Cells.slice(1).map(c => {
                const n = parseFloat(String(c?.Value ?? '').replace(/[^0-9.\-]/g, ''));
                return isFinite(n) ? n : 0;
            });
        }
    }
}

function headerLabels(report) {
    const hdr = (report.Rows || []).find(r => r.RowType === 'Header');
    return hdr ? hdr.Cells.slice(1).map(c => String(c?.Value || '')) : [];
}

// Pick a metric by label, tolerating Xero's wording variants.
function metric(map, patterns) {
    for (const p of patterns) {
        const k = Object.keys(map).find(key => p.test(key));
        if (k) return map[k];
    }
    return null;
}

function summarise(report) {
    const map = {};
    collectRows(report.Rows, map);
    const col = arr => (arr && arr.length ? arr : [0]);
    const income   = col(metric(map, [/^total income$/i, /^total trading income$/i, /^total revenue$/i]));
    const cogs     = col(metric(map, [/^total cost of sales$/i, /^total direct costs$/i]));
    const gross    = col(metric(map, [/^gross profit/i]));
    const expenses = col(metric(map, [/^total operating expenses$/i, /^total expenses$/i]));
    const net      = col(metric(map, [/^net profit/i, /^net (income|earnings)/i]));
    return { income, cogs, gross, expenses, net, labels: headerLabels(report) };
}

// "31 Aug 26" / "Aug-26" / "Aug 2026" / "31 Aug 2026" → sortable YYYY-MM key + short label.
function parseMonthLabel(s) {
    const m = String(s || '').match(/([A-Za-z]{3})[a-z]*[\s\-]+(\d{2,4})$/);
    if (!m) return null;
    const mi = MO.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    let y = parseInt(m[2], 10); if (y < 100) y += 2000;
    return { key: `${y}-${String(mi + 1).padStart(2, '0')}`, label: `${MO[mi]} ${String(y).slice(-2)}` };
}

async function fetchReport(token, params) {
    const url = 'https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + new URLSearchParams(params).toString();
    const resp = await fetch(url, { headers: xeroHeaders(token) });
    if (resp.status === 401 || resp.status === 403) {
        const body = await resp.text();
        const e = new Error('scope'); e.scope = true; e.body = body; e.status = resp.status;
        throw e;
    }
    if (!resp.ok) throw new Error('Xero API error ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
    const data = await resp.json();
    return (data.Reports || [])[0] || { Rows: [] };
}

export async function onRequestGet({ env, request }) {
    try {
        const url  = new URL(request.url);
        const bust = url.searchParams.get('bust') === '1';
        if (!bust) {
            const cached = await env.XERO_KV.get(CACHE_KEY, { type: 'json' });
            if (cached) return jsonResponse(cached);
        }

        const token = await getValidToken(env);
        const today = new Date();
        const fy = fyBounds(today);
        const priorFrom = new Date(fy.from); priorFrom.setFullYear(priorFrom.getFullYear() - 1);
        const priorTo   = new Date(fy.to);   priorTo.setFullYear(priorTo.getFullYear() - 1);
        const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
        const monthEnd   = new Date(today.getFullYear(), today.getMonth() + 1, 0);

        const [curRep, priorRep, monthlyRep] = await Promise.all([
            fetchReport(token, { fromDate: ymd(fy.from), toDate: ymd(fy.to) }),
            fetchReport(token, { fromDate: ymd(priorFrom), toDate: ymd(priorTo) }),
            fetchReport(token, { fromDate: ymd(monthStart), toDate: ymd(monthEnd), periods: '11', timeframe: 'MONTH' }),
        ]);

        const cur = summarise(curRep), prior = summarise(priorRep), mon = summarise(monthlyRep);
        const first = a => Math.round((a[0] || 0) * 100) / 100;

        // Monthly columns come back newest-first; sort by parsed header date.
        const cols = mon.labels.map((lbl, i) => ({ i, parsed: parseMonthLabel(lbl), raw: lbl }))
            .filter(c => c.parsed)
            .sort((a, b) => a.parsed.key.localeCompare(b.parsed.key));
        const pick = arr => cols.map(c => Math.round((arr[c.i] || 0) * 100) / 100);

        const payload = {
            fy:      { label: fy.label, from: ymd(fy.from), to: ymd(fy.to),
                       income: first(cur.income), cogs: first(cur.cogs), grossProfit: first(cur.gross),
                       expenses: first(cur.expenses), netProfit: first(cur.net) },
            priorFy: { label: `FY${String(parseInt(fy.label.slice(2), 10) - 1).padStart(2, '0')}`, from: ymd(priorFrom), to: ymd(priorTo),
                       income: first(prior.income), cogs: first(prior.cogs), grossProfit: first(prior.gross),
                       expenses: first(prior.expenses), netProfit: first(prior.net) },
            monthly: { labels: cols.map(c => c.parsed.label), income: pick(mon.income), expenses: pick(mon.expenses), netProfit: pick(mon.net) },
            asOf: new Date().toISOString(),
        };

        await env.XERO_KV.put(CACHE_KEY, JSON.stringify(payload), { expirationTtl: CACHE_TTL });
        return jsonResponse(payload);

    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message, 401);
        if (e && e.scope) return jsonResponse({ error: 'Xero reports permission missing — reconnect Xero', needsReauth: true }, 403);
        return errResponse(e.message);
    }
}
