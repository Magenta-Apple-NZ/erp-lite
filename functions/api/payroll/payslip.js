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

// Reuse the classifier from the sales-history writer so dispatched-
// boxes count matches what each order contributes elsewhere.
function classifyLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    if (/^PT[-_]?L/.test(sku))   return 'loose';
    if (/^PT[-_]?B/.test(sku))   return 'bundles';
    if (/^ET([-_]|$)/.test(sku)) return 'ecoTies';
    if (/eco\s*ti/.test(desc)) return 'ecoTies';
    if (/bundle/.test(desc))   return 'bundles';
    if (/loose/.test(desc))    return 'loose';
    const kpu = Number(l?.kgPerUnit);
    if (kpu === 10) return 'bundles';
    if (kpu === 1)  return 'loose';
    return 'other';
}

function inferKgPerUnit(l) {
    if (l?.kgPerUnit != null && !isNaN(Number(l.kgPerUnit))) return Number(l.kgPerUnit);
    const sku = String(l?.sku || '').toUpperCase();
    if (/-10$/.test(sku))    return 10;
    if (/-1B?$/.test(sku))   return 1;
    const desc = String(l?.description || '');
    const m = desc.match(/\b(\d+)\s*kg\b/i);
    if (m) {
        const v = parseInt(m[1], 10);
        if (v === 10 || v === 1) return v;
    }
    return 0;
}

function orderProductKg(order) {
    let kg = 0;
    for (const l of (order.lines || [])) {
        if (classifyLine(l) === 'other') continue;
        kg += (Number(l.quantity) || 0) * inferKgPerUnit(l);
    }
    return kg;
}

async function loadJson(env, key, fallback = []) {
    const raw = await env.ORDERS_KV.get(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
}

export async function onRequestGet({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const empId = searchParams.get('employee');
        const start = searchParams.get('start');
        const end   = searchParams.get('end');
        if (!empId || !start || !end) {
            return errResponse('employee, start, end query params required', 400);
        }

        const config = await loadJson(env, 'payroll_config', { employees: [] });
        const employee = (config.employees || []).find(e => e.id === empId);
        if (!employee) return errResponse('Employee not found', 404);

        const rates = employee.rates || {};
        const inRange = (iso) => iso && iso >= start && iso <= end;

        // ── Boxes dispatched ──
        // Walk orders_index, count orders dispatched by this employee in range.
        const idxRaw = await env.ORDERS_KV.get('orders_index');
        const ids = idxRaw ? [...new Set(JSON.parse(idxRaw))] : [];
        const orders = await Promise.all(ids.map(id => env.ORDERS_KV.get('order:' + id, { type: 'json' })));

        let boxesDispatched = 0;
        const dispatchOrderIds = [];
        for (const o of orders) {
            if (!o) continue;
            if (o.status !== 'dispatched' && o.status !== 'paid') continue;
            if (o.dispatchedBy !== employee.name) continue;
            const day = (o.dispatchedAt || o.updatedAt || '').slice(0, 10);
            if (!inRange(day)) continue;
            boxesDispatched += orderProductKg(o) / 10;
            dispatchOrderIds.push(o.id);
        }

        // ── Boxes packed ──
        const packing = await loadJson(env, 'packing_log', []);
        let boxes10kgPacked = 0, boxes1kgPacked = 0;
        for (const p of packing) {
            if (p.employee !== employee.name) continue;
            if (!inRange(p.date)) continue;
            boxes10kgPacked += Number(p.boxes10kg) || 0;
            boxes1kgPacked  += Number(p.boxes1kg)  || 0;
        }

        // ── Hours worked ──
        const timesheets = await loadJson(env, 'timesheets', []);
        let hoursWorked = 0;
        for (const t of timesheets) {
            if (t.employee !== employee.name) continue;
            if (!inRange(t.date)) continue;
            hoursWorked += Number(t.hours) || 0;
        }

        const lines = [
            {
                label: 'Boxes dispatched',
                qty:    Math.round(boxesDispatched * 100) / 100,
                rate:   Number(rates.perBoxDispatched) || 0,
                amount: 0,
                note:   `${dispatchOrderIds.length} order${dispatchOrderIds.length === 1 ? '' : 's'}`,
            },
            {
                label: 'Boxes packed (10kg)',
                qty:    boxes10kgPacked,
                rate:   Number(rates.perBox10kgPacked) || 0,
                amount: 0,
            },
            {
                label: 'Boxes packed (1kg)',
                qty:    boxes1kgPacked,
                rate:   Number(rates.perBox1kgPacked) || 0,
                amount: 0,
            },
            {
                label: 'Hours worked',
                qty:    Math.round(hoursWorked * 100) / 100,
                rate:   Number(rates.perHour) || 0,
                amount: 0,
            },
        ];
        for (const l of lines) l.amount = Math.round(l.qty * l.rate * 100) / 100;
        const total = lines.reduce((s, l) => s + l.amount, 0);

        return jsonResponse({
            employee: { id: employee.id, name: employee.name },
            period:   { start, end },
            lines,
            total:    Math.round(total * 100) / 100,
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
