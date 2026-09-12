// GET /api/payroll/payslip?employee=<id>&start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Aggregates the three pay inputs for one employee over the date range:
//   - Boxes dispatched : derived from dispatched orders attributed to
//                        the employee (dispatchedBy === employee.name,
//                        dispatchedAt within range). Same kg → boxes
//                        rule the Dispatch Log uses (total kg / 10).
//   - Boxes packed     : sum of boxes10kg + boxes1kg from packing_log
//                        rows for the employee in range.
//   - Hours worked     : sum of hours from timesheets in range.
//
// Multiplies by the rates from payroll_config, returns the breakdown.

import { jsonResponse, errResponse } from '../_xero.js';
import { nzYmd } from '../_dates.js';
import { rowFromOrder } from '../sales-history/_writer.js';
import { loadItemsMap } from '../catalog/items.js';

// Boxes come from the sales-history writer's classification (catalogue
// Type/Size, then SKU prefix) so payroll counts exactly what Sales History
// and the stock engine count — never a kg-per-unit guess (Hessian is 1 kg/unit).

function orderProductKg(order, itemsMap) {
    const r = rowFromOrder(order, itemsMap);
    return r ? r.bundlesKg + r.looseKg + r.ecoTiesKg : 0;
}

async function loadJson(env, key, fallback = []) {
    const raw = await env.ORDERS_KV.get(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

// The pay month an order belongs to: an explicit manual reassignment
// (order.payslipMonth = 'YYYY-MM') wins; otherwise the month it was dispatched.
function orderPayMonth(o) {
    const m = String(o?.payslipMonth || '');
    if (/^\d{4}-\d{2}$/.test(m)) return m;
    const ts = o?.dispatchedAt || o?.updatedAt || '';
    return ts ? nzYmd(ts).slice(0, 7) : '';
}

export async function onRequestGet({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const empId = searchParams.get('employee');
        const month = searchParams.get('month'); // YYYY-MM
        if (!empId || !/^\d{4}-\d{2}$/.test(String(month || ''))) {
            return errResponse('employee and month=YYYY-MM query params required', 400);
        }
        const start = `${month}-01`;
        const end   = `${month}-31`;

        const config = await loadJson(env, 'payroll_config', { employees: [] });
        const employee = (config.employees || []).find(e => e.id === empId);
        if (!employee) return errResponse('Employee not found', 404);
        const rates = employee.rates || {};

        // ── Boxes dispatched (auto, from the dispatch log) ──
        // Attributed to the pay month by dispatch date, or a manual reassignment.
        const idxRaw = await env.ORDERS_KV.get('orders_index');
        const ids = idxRaw ? [...new Set(JSON.parse(idxRaw))] : [];
        const [orders, itemsMap] = await Promise.all([
            Promise.all(ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' }))),
            loadItemsMap(env).catch(() => null),
        ]);

        let boxesDispatched = 0;
        const dispatchOrderIds = [];
        for (const o of orders) {
            if (!o) continue;
            if (o.status !== 'dispatched' && o.status !== 'paid') continue;
            if (o.dispatchedBy !== employee.name) continue;
            if (orderPayMonth(o) !== month) continue;
            boxesDispatched += orderProductKg(o, itemsMap) / 10;
            dispatchOrderIds.push(o.id);
        }

        // ── Manual monthly inputs (packed boxes + hours) ──
        const monthly = await loadJson(env, 'payroll_monthly', {});
        const manual = monthly[`${empId}:${month}`] || {};
        const packed10kg = Number(manual.packed10kg) || 0;
        const packed1kg  = Number(manual.packed1kg)  || 0;
        const hours      = Number(manual.hours)      || 0;

        // ── Build payslip lines ──
        const lines = [];
        if (Number(rates.baseRate)) lines.push({ label: 'Base rate', qty: null, rate: null, amount: Number(rates.baseRate) });
        lines.push({
            label: 'Boxes dispatched', qty: Math.round(boxesDispatched * 100) / 100,
            rate: Number(rates.perBoxDispatched) || 0, amount: 0,
            note: `${dispatchOrderIds.length} order${dispatchOrderIds.length === 1 ? '' : 's'} · from dispatch log`,
        });
        lines.push({ label: 'Boxes packed (10kg)', qty: packed10kg, rate: Number(rates.perBox10kgPacked) || 0, amount: 0 });
        lines.push({ label: 'Boxes packed (1kg)',  qty: packed1kg,  rate: Number(rates.perBox1kgPacked)  || 0, amount: 0 });
        lines.push({ label: 'Hours worked',        qty: Math.round(hours * 100) / 100, rate: Number(rates.perHour) || 0, amount: 0 });
        if (Number(rates.petrol)) lines.push({ label: 'Petrol', qty: null, rate: null, amount: Number(rates.petrol) });

        for (const l of lines) {
            if (l.qty != null && l.rate != null) l.amount = Math.round(l.qty * l.rate * 100) / 100;
        }
        const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

        return jsonResponse({
            employee: { id: employee.id, name: employee.name },
            month, period: { start, end },
            inputs: { boxesDispatched: Math.round(boxesDispatched * 100) / 100, dispatchOrders: dispatchOrderIds.length, packed10kg, packed1kg, hours },
            lines,
            total,
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
