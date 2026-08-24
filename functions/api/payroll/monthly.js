// GET   /api/payroll/monthly?employee=<id>&month=YYYY-MM
//        → { employee, month, packed10kg, packed1kg, hours }
// PATCH /api/payroll/monthly  { employee, month, packed10kg, packed1kg, hours }
//        → saves the manual monthly inputs for one employee + month.
//
// The manual pay inputs (boxes packed 10kg / 1kg, hours) are entered once per
// month on the consolidated payslip view (dispatched boxes come from the
// dispatch log; base rate + petrol come from payroll_config). Stored in one KV
// blob `payroll_monthly` keyed by `${employeeId}:${YYYY-MM}`.

import { jsonResponse, errResponse } from '../_xero.js';

const KEY = 'payroll_monthly';
const monthOk = m => /^\d{4}-\d{2}$/.test(String(m || ''));

async function loadAll(env) {
    const raw = await env.ORDERS_KV.get(KEY);
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch { return {}; }
}

export async function onRequestGet({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const employee = searchParams.get('employee');
        const month = searchParams.get('month');
        if (!employee || !monthOk(month)) return errResponse('employee and month=YYYY-MM required', 400);
        const all = await loadAll(env);
        const row = (all[`${employee}:${month}`]) || { packed10kg: 0, packed1kg: 0, hours: 0 };
        return jsonResponse({ employee, month, packed10kg: Number(row.packed10kg) || 0, packed1kg: Number(row.packed1kg) || 0, hours: Number(row.hours) || 0 });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPatch({ env, request }) {
    try {
        const body = await request.json();
        const { employee, month } = body;
        if (!employee || !monthOk(month)) return errResponse('employee and month=YYYY-MM required', 400);
        const all = await loadAll(env);
        all[`${employee}:${month}`] = {
            packed10kg: Number(body.packed10kg) || 0,
            packed1kg:  Number(body.packed1kg)  || 0,
            hours:      Number(body.hours)      || 0,
            updatedAt:  new Date().toISOString(),
        };
        await env.ORDERS_KV.put(KEY, JSON.stringify(all));
        return jsonResponse({ employee, month, ...all[`${employee}:${month}`] });
    } catch (e) {
        return errResponse(e.message);
    }
}
