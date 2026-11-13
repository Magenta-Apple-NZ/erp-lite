// MCP tools — read-only views of the Hub. Each tool either reads KV directly
// or calls an existing endpoint handler in-process, so the numbers are the
// same ones the Hub's own screens show (no second copy of the logic).
//
// Read-only is enforced, not just intended: the server hands tools a
// readOnlyEnv() whose ORDERS_KV throws on put/delete. XERO_KV stays writable
// because a Xero call may refresh the OAuth token (and Xero rotates refresh
// tokens: dropping the write would disconnect the Hub) and caches alerts.

import { nzYmd, nzToday, isYmd } from '../_dates.js';
import { onRequestGet as stockLevelsGet } from '../stock/levels.js';
import { onRequestGet as stockLedgerGet } from '../stock/items/[id]/ledger.js';
import { onRequestGet as consumablesGet } from '../stock/consumables-forecast.js';
import { onRequestGet as shipmentsGet } from '../stock/shipments.js';
import { onRequestGet as xeroAlertsGet } from '../xero/alerts.js';
import { buildView as exportDocsView, loadShipments as loadRawShipments, loadAllRecords as loadExportDocRecords } from '../import/export-docs/_store.js';
import { shipNumber } from '../stock/_engine.js';

const STATUS_LABELS = { new: 'New', reviewed: 'Reviewed', sent_to_xero: 'Sent to Xero', dispatched: 'Complete' };

export function readOnlyEnv(env) {
    const deny = name => async () => { throw new Error(`Read-only: ${name} writes are disabled over MCP`); };
    const ro = kv => kv && {
        get: (...a) => kv.get(...a),
        list: (...a) => kv.list(...a),
        getWithMetadata: (...a) => kv.getWithMetadata(...a),
        put: deny('ORDERS_KV'),
        delete: deny('ORDERS_KV'),
    };
    return { ...env, ORDERS_KV: ro(env.ORDERS_KV) };
}

// Call a Pages handler in-process and unwrap its JSON (throws on non-2xx).
async function callHandler(handler, env, path, params = {}) {
    const res = await handler({ env, params, request: new Request('https://hub.internal' + path) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

async function loadOrders(env) {
    const ids = [...new Set(JSON.parse(await env.ORDERS_KV.get('orders_index') || '[]'))];
    const orders = await Promise.all(ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' })));
    return orders.filter(o => o && o.id && !String(o.id).startsWith('HST-'));
}

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const lineTotal = l => (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n)); };
const ymOk = s => /^\d{4}-\d{2}$/.test(String(s || ''));
const has = (hay, needle) => String(hay || '').toLowerCase().includes(String(needle).toLowerCase());

function orderSummary(o) {
    return {
        id: o.id,
        status: STATUS_LABELS[o.status] || o.status,
        created: o.createdAt ? nzYmd(o.createdAt) : null,
        dispatched: o.dispatchedAt ? nzYmd(o.dispatchedAt) : null,
        dispatchedBy: o.dispatchedBy || null,
        customer: o.customer?.name || '',
        branch: o.shipTo?.branch || '',
        po: o.poNumber || '',
        invoice: o.xeroInvoiceNumber || null,
        paid: o.paidAt ? nzYmd(o.paidAt) : null,
        fulfilment: o.fulfilmentMethod || 'courier',
        lines: (o.lines || []).length,
        totalExGst: round2((o.lines || []).reduce((s, l) => s + lineTotal(l), 0)),
        connote: o.courier?.connote || null,
    };
}

// "123", "pks123", "PKS-0123" → "PKS-0123"
function normaliseOrderId(s) {
    const m = String(s || '').trim().match(/^(?:PKS-?)?0*(\d+)$/i);
    return m ? `PKS-${m[1].padStart(4, '0')}` : String(s || '').trim().toUpperCase();
}

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
    {
        name: 'search_orders',
        title: 'Search orders',
        description: 'Find Hub orders (Prime Ties / Enviroware). Matches the query against order id, PO, customer, branch, Xero invoice number and line SKUs/descriptions. Dates are NZ calendar dates (YYYY-MM-DD) on the order\'s created date, or its dispatch date when date_field is "dispatched". Newest first. Returns summaries; use get_order for lines and the activity log.',
        inputSchema: {
            type: 'object',
            properties: {
                query:      { type: 'string', description: 'Free text, e.g. "Ashburton", "INV-1234", "PT-B-10"' },
                status:     { type: 'string', enum: ['new', 'reviewed', 'sent_to_xero', 'dispatched'], description: 'dispatched = Complete' },
                paid:       { type: 'boolean', description: 'true = paid in Xero, false = not yet paid' },
                from:       { type: 'string', description: 'YYYY-MM-DD inclusive' },
                to:         { type: 'string', description: 'YYYY-MM-DD inclusive' },
                date_field: { type: 'string', enum: ['created', 'dispatched'], default: 'created' },
                limit:      { type: 'integer', minimum: 1, maximum: 200, default: 25 },
            },
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            const field = args.date_field === 'dispatched' ? 'dispatchedAt' : 'createdAt';
            const limit = clampInt(args.limit, 1, 200, 25);
            const q = String(args.query || '').trim();
            const matches = (await loadOrders(env)).filter(o => {
                if (args.status && o.status !== args.status) return false;
                if (args.paid === true && !o.paidAt) return false;
                if (args.paid === false && o.paidAt) return false;
                if (args.from || args.to) {
                    if (!o[field]) return false;
                    const d = nzYmd(o[field]);
                    if (isYmd(args.from) && d < args.from) return false;
                    if (isYmd(args.to) && d > args.to) return false;
                }
                if (q) {
                    const fields = [o.id, o.poNumber, o.customer?.name, o.shipTo?.branch, o.xeroInvoiceNumber,
                        ...(o.lines || []).flatMap(l => [l.sku, l.description])];
                    if (!fields.some(f => has(f, q))) return false;
                }
                return true;
            }).sort((a, b) => String(b[field] || b.createdAt || '').localeCompare(String(a[field] || a.createdAt || '')));
            return { total: matches.length, returned: Math.min(limit, matches.length), orders: matches.slice(0, limit).map(orderSummary) };
        },
    },
    {
        name: 'get_order',
        title: 'Get order',
        description: 'One order in full: customer, ship-to, lines (qty, unit price ex GST, SKU), packing notes, Xero invoice, courier label, and its activity log (who changed, printed or downloaded what, when). Look up by Hub order id (e.g. PKS-0123 or 123) or by customer PO number.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Hub order id, e.g. PKS-0123' },
                po: { type: 'string', description: 'Customer PO number (exact, case-insensitive)' },
            },
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            let order = null;
            if (args.id) order = await env.ORDERS_KV.get('order:' + normaliseOrderId(args.id), { type: 'json' });
            if (!order && args.po) {
                const po = String(args.po).trim().toLowerCase();
                const hits = (await loadOrders(env)).filter(o => String(o.poNumber || '').trim().toLowerCase() === po);
                if (hits.length > 1) return { error: `PO matches ${hits.length} orders`, orders: hits.map(orderSummary) };
                order = hits[0] || null;
            }
            if (!order) throw new Error('Order not found');
            const { events, ...rest } = order;
            return {
                summary: orderSummary(order),
                order: rest,
                activity: (events || []).map(e => ({
                    at: e.timestamp || e.ts || null, user: e.user || null, action: e.action || e.msg || '',
                    ...(e.detail && { detail: e.detail }), ...(e.changes && { changes: e.changes }),
                    ...(e.kind && { kind: e.kind }),
                })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))),
            };
        },
    },
    {
        name: 'sales_summary',
        title: 'Sales summary (kg)',
        description: 'Kilograms sold from Sales History (the historical seed plus every Hub order), grouped by month, NZ financial year (Apr–Mar), customer or branch. Each group gives total kg, kg by product type (bundles = Prime Tie Bundled, loose, ecoTies) and by bag size (oneKg, tenKg), and the order count. Months are NZ calendar months (YYYY-MM).',
        inputSchema: {
            type: 'object',
            properties: {
                group_by:   { type: 'string', enum: ['month', 'fy', 'customer', 'branch'], default: 'month' },
                from_month: { type: 'string', description: 'YYYY-MM inclusive' },
                to_month:   { type: 'string', description: 'YYYY-MM inclusive' },
                customer:   { type: 'string', description: 'Substring filter on customer' },
                branch:     { type: 'string', description: 'Substring filter on branch / store' },
                limit:      { type: 'integer', minimum: 1, maximum: 500, default: 60, description: 'Customer/branch groups are ranked by kg; month/fy groups are chronological' },
            },
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            const rows = JSON.parse(await env.ORDERS_KV.get('sales_history') || '[]');
            const by = ['fy', 'customer', 'branch'].includes(args.group_by) ? args.group_by : 'month';
            const groups = new Map();
            let matched = 0;
            for (const r of rows) {
                const ym = `${r.year}-${String(r.month).padStart(2, '0')}`;
                if (ymOk(args.from_month) && ym < args.from_month) continue;
                if (ymOk(args.to_month) && ym > args.to_month) continue;
                if (args.customer && !has(r.customer, args.customer)) continue;
                if (args.branch && !has(r.branch, args.branch)) continue;
                const key = by === 'month' ? ym : by === 'fy' ? (r.fy || '') : (r[by] || '(none)');
                const g = groups.get(key) || { [by]: key, kg: 0, bundlesKg: 0, looseKg: 0, ecoTiesKg: 0, oneKg: 0, tenKg: 0, orders: 0 };
                for (const f of ['bundlesKg', 'looseKg', 'ecoTiesKg', 'oneKg', 'tenKg']) g[f] += Number(r[f]) || 0;
                g.kg += (Number(r.bundlesKg) || 0) + (Number(r.looseKg) || 0) + (Number(r.ecoTiesKg) || 0);
                g.orders++;
                groups.set(key, g);
                matched++;
            }
            let out = [...groups.values()].map(g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, typeof v === 'number' ? round2(v) : v])));
            out.sort(by === 'month' || by === 'fy' ? (a, b) => String(a[by]).localeCompare(String(b[by])) : (a, b) => b.kg - a.kg);
            const limit = clampInt(args.limit, 1, 500, 60);
            const totalKg = round2(out.reduce((s, g) => s + g.kg, 0));
            if (by === 'month' || by === 'fy') out = out.slice(-limit); else out = out.slice(0, limit);
            return { groupBy: by, rows: matched, totalKg, groups: out };
        },
    },
    {
        name: 'stock_levels',
        title: 'Stock levels',
        description: 'Stock on hand per active item as at a date (default today, NZ): products in kg and consumables (boxes, bags, labels…) in units, with on order, average daily use, days of cover, reorder point and status (out / critical / low / watch / ok). Stock is derived from the last committed count plus shipments and sales since; worst status first.',
        inputSchema: {
            type: 'object',
            properties: { as_of: { type: 'string', description: 'YYYY-MM-DD' } },
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            const asOf = isYmd(args.as_of) ? args.as_of : nzToday();
            return callHandler(stockLevelsGet, env, `/api/stock/levels?asOf=${asOf}`);
        },
    },
    {
        name: 'stock_item_ledger',
        title: 'Stock item ledger',
        description: 'The audit trail behind one item\'s on hand: the baseline count, each order that consumed it, shipments landed, receipts, adjustments and wastage, with a running balance. item_id comes from stock_levels (e.g. "prime-tie-bundled").',
        inputSchema: {
            type: 'object',
            properties: { item_id: { type: 'string' }, as_of: { type: 'string', description: 'YYYY-MM-DD' } },
            required: ['item_id'],
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            const asOf = isYmd(args.as_of) ? args.as_of : nzToday();
            return callHandler(stockLedgerGet, env, `/api/stock/items/${encodeURIComponent(args.item_id)}/ledger?asOf=${asOf}`, { id: args.item_id });
        },
    },
    {
        name: 'consumables_forecast',
        title: 'Consumables run-out forecast',
        description: 'When each consumable runs out under the Average / Good / Great sales scenarios, from the same seasonal forecast as the Imports page.',
        inputSchema: {
            type: 'object',
            properties: { months: { type: 'integer', minimum: 1, maximum: 36, default: 13 } },
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            return callHandler(consumablesGet, env, `/api/stock/consumables-forecast?months=${clampInt(args.months, 1, 36, 13)}`);
        },
    },
    {
        name: 'shipments',
        title: 'Import shipments',
        description: 'Prime Tie import shipments, newest first: shipment number, kg landing, landed (or listed) cost per kg, status and ETA.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: RO,
        async run(_args, { env }) {
            return { shipments: await callHandler(shipmentsGet, env, '/api/stock/shipments') };
        },
    },
    {
        name: 'shipment_export_docs',
        title: 'Shipment export documents',
        description: 'The export-document stage of an import shipment (Pistoni packing list + proforma → Enviroware packing list + proforma invoice to JPS Enterprise). For one shipment: status (In review / Draft / LC issued / Final), the confirmed bales (bale number, net kg, white or coloured), totals, the supplier invoice (internal: EUR lines), the export invoice (number, date, USD rate per kg, amount), the JPS invoice split into LC deposit and handling & sorting, the three stage-1 invoices in Xero (Pistoni bill, our proforma, JPS bill) with status and NZD paid, cost-breakdown lines the documents would change, LC details, failing checks, what still blocks each document, and links to the generated documents and supplier PDFs (paths on the Hub). Omit shipment for a one-line summary of every shipment that has export documents.',
        inputSchema: {
            type: 'object',
            properties: { shipment: { type: 'integer', description: 'Shipment number, e.g. 43' } },
            additionalProperties: false,
        },
        annotations: RO,
        async run(args, { env }) {
            const ships = await loadRawShipments(env);
            const base = id => `/api/import/export-docs/${encodeURIComponent(id)}`;
            if (args.shipment == null) {
                const records = await loadExportDocRecords(env);
                const rows = [];
                for (const r of records) {
                    if (!ships.some(s => s.id === r.shipmentId)) continue;
                    const v = await exportDocsView(env, r.shipmentId);
                    rows.push({
                        shipment: v.shipment.number, status: v.statusLabel,
                        bales: v.confirmedTotals?.count ?? null, netKg: v.confirmedTotals?.netKg ?? null,
                        exportInvoice: v.record.exportInvoice?.number || null, amount: v.amount,
                        lcNumber: v.record.lc?.number || null, documents: (v.record.outputs || []).length,
                    });
                }
                return { shipments: rows.sort((a, b) => (b.shipment ?? 0) - (a.shipment ?? 0)) };
            }
            const ship = ships.find(s => shipNumber(s) === Number(args.shipment));
            if (!ship) throw new Error(`Shipment #${args.shipment} not found`);
            const v = await exportDocsView(env, ship.id);
            const r = v.record, c = r.confirmed, inv = c?.supplierInvoice;
            return {
                shipment: v.shipment.number, status: v.statusLabel,
                confirmed: c ? { at: c.confirmedAt ? nzYmd(c.confirmedAt) : null, by: c.confirmedBy || null } : null,
                unconfirmedChanges: v.unconfirmedChanges,
                totals: v.confirmedTotals,
                bales: c ? c.bales : [],
                supplierInvoice: inv ? { number: inv.number, date: inv.date, currency: inv.currency, total: inv.total, netKg: inv.netKg, lines: (inv.lines || []).map(l => ({ description: l.description, colour: l.colour, kg: l.kg, unitPrice: l.unitPrice, amount: l.amount })) } : null,
                exportInvoice: { number: r.exportInvoice.number, date: r.exportInvoice.date, currency: r.exportInvoice.currency, ratePerKg: r.exportInvoice.rate, amount: v.amount, numberConfirmed: r.exportInvoice.numberConfirmed, rateConfirmed: r.exportInvoice.rateConfirmed },
                lc: { number: r.lc?.number || null, date: r.lc?.date || null, grossKg: r.lc?.grossKg ?? null, linkedLc: v.linkedLc?.lcNumber || null },
                jpsInvoice: r.jps ? {
                    number: r.jps.number, date: r.jps.date, currency: r.jps.currency, total: r.jps.total,
                    lcDeposit: v.jpsSplit?.depositAmount ?? null, handlingAndSorting: v.jpsSplit?.handlingAmount ?? null, handlingPerKg: v.jpsSplit?.handlingRate ?? null,
                } : null,
                xero: v.xero.docs.map(d => ({
                    document: d.label, inXero: d.inXero, status: d.pushed?.status || null, number: d.number || null,
                    currency: d.currency || null, total: d.total ?? null, nzdPaid: d.pushed?.nzdPaid ?? null, link: d.url || null,
                    ...(!d.inXero && d.issues.length && { blockedBy: d.issues }),
                })),
                costBreakdownChanges: (v.costPlan?.changes || []).map(c => `${c.label}: ${c.from} → ${c.to} (from ${c.source})`),
                failingChecks: [...v.checks, ...(v.jpsChecks || []), ...v.lcChecks].filter(x => x.ok === false).map(x => ({ check: x.title, level: x.level, detail: x.detail })),
                blockedBy: v.generation,
                documents: (r.outputs || []).map(o => ({
                    name: o.name, generated: nzYmd(o.at), by: o.by, filename: o.filename,
                    ...(o.invoiceNumber && { invoiceNumber: o.invoiceNumber, amount: o.amount }),
                    link: `${base(ship.id)}/render?out=${encodeURIComponent(o.key)}`,
                    ...(o.doc === 'packing' && { xlsx: `${base(ship.id)}/xlsx?out=${encodeURIComponent(o.key)}` }),
                })),
                supplierFiles: Object.values(r.files || {}).map(f => ({ kind: f.kind, filename: f.filename, uploaded: nzYmd(f.uploadedAt), link: `${base(ship.id)}/file?key=${encodeURIComponent(f.key)}` })),
            };
        },
    },
    {
        name: 'receivables',
        title: 'Unpaid and overdue invoices',
        description: 'Accounts receivable from Xero: count and NZD total of unpaid invoices, and of those past due. Cached for 5 minutes. For which orders are unpaid, use search_orders with paid=false and status=dispatched.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { ...RO, openWorldHint: true },
        async run(_args, { env }) {
            return callHandler(xeroAlertsGet, env, '/api/xero/alerts');
        },
    },
];
