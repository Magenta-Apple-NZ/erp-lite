// GET  /api/payroll/config  — list of employees + their pay rates
// POST /api/payroll/config  — replace the config (JSON body: { employees: [...] })
//
// Single KV blob `payroll_config`. Currently one employee (Jake), but the
// shape is a list so adding more later is just an upsert in this UI.

import { jsonResponse, errResponse } from '../_xero.js';

const DEFAULT_CONFIG = {
    employees: [
        {
            id: 'jake',
            name: 'Jake',
            rates: {
                perBoxDispatched: 0,
                perBox10kgPacked: 0,
                perBox1kgPacked:  0,
                perHour:          0,
            },
            archived: false,
        },
    ],
};

export async function onRequestGet({ env }) {
    try {
        const raw = await env.ORDERS_KV.get('payroll_config');
        if (!raw) return jsonResponse(DEFAULT_CONFIG);
        return jsonResponse(JSON.parse(raw));
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        if (!body || !Array.isArray(body.employees)) {
            return errResponse('Body must include an employees array', 400);
        }
        const employees = body.employees.map(e => ({
            id: String(e.id || '').trim(),
            name: String(e.name || '').trim(),
            rates: {
                perBoxDispatched: Number(e.rates?.perBoxDispatched) || 0,
                perBox10kgPacked: Number(e.rates?.perBox10kgPacked) || 0,
                perBox1kgPacked:  Number(e.rates?.perBox1kgPacked)  || 0,
                perHour:          Number(e.rates?.perHour)          || 0,
            },
            archived: !!e.archived,
        })).filter(e => e.id && e.name);
        await env.ORDERS_KV.put('payroll_config', JSON.stringify({ employees }));
        return jsonResponse({ employees });
    } catch (e) {
        return errResponse(e.message);
    }
}
