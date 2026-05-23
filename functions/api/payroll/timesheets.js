// GET  /api/payroll/timesheets             — JSON
// GET  /api/payroll/timesheets?format=csv  — CSV download
// POST /api/payroll/timesheets             — CSV upload (round-trip);
//                                             ?apply=true commits

import { jsonResponse, errResponse } from '../_xero.js';

const HEADERS = ['Id', 'Date', 'Employee', 'Hours', 'Notes'];

function parseCsv(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i], next = text[i + 1];
        if (inQuotes) {
            if (c === '"' && next === '"') { field += '"'; i++; }
            else if (c === '"') inQuotes = false;
            else field += c;
        } else {
            if (c === '"') inQuotes = true;
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (field.length || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
                if (c === '\r' && next === '\n') i++;
            } else field += c;
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function csvEscape(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function parseAnyDate(s) {
    const raw = String(s || '').trim();
    if (!raw) return null;
    const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) {
        const yr = parseInt(iso[1], 10), mo = parseInt(iso[2], 10), dy = parseInt(iso[3], 10);
        if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) return `${yr}-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')}`;
    }
    const slash = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (slash) {
        let dy = parseInt(slash[1], 10), mo = parseInt(slash[2], 10), yr = parseInt(slash[3], 10);
        if (yr < 100) yr += 2000;
        if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
        return `${yr}-${String(mo).padStart(2,'0')}-${String(dy).padStart(2,'0')}`;
    }
    return null;
}

function parseNum(s) {
    if (s == null || s === '') return 0;
    const n = parseFloat(String(s).replace(/[,$\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

async function loadAll(env) {
    const raw = await env.ORDERS_KV.get('timesheets');
    return raw ? JSON.parse(raw) : [];
}

function rowsToCsv(rows) {
    const sorted = rows.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const out = [HEADERS.join(',')];
    for (const r of sorted) {
        out.push([r.id, r.date, r.employee, r.hours, r.notes || ''].map(csvEscape).join(','));
    }
    return out.join('\n') + '\n';
}

function nextSeq(rows) {
    let max = 0;
    for (const r of rows) {
        const m = String(r.id || '').match(/^ts-(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max + 1;
}

export async function onRequestGet({ env, request }) {
    try {
        const rows = await loadAll(env);
        if (new URL(request.url).searchParams.get('format') === 'csv') {
            return new Response(rowsToCsv(rows), {
                headers: {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="timesheets.csv"',
                },
            });
        }
        return jsonResponse(rows);
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const csv = await request.text();
        if (!csv || !csv.trim()) return errResponse('Empty CSV body', 400);

        const lines = parseCsv(csv);
        if (lines.length < 2) return errResponse('CSV has no data rows', 400);

        const header = lines[0].map(h => h.trim().toLowerCase());
        const col = name => header.indexOf(name.toLowerCase());
        const idCol    = col('id');
        const dateCol  = col('date');
        const empCol   = col('employee');
        const hoursCol = col('hours');
        const notesCol = col('notes');

        if (dateCol < 0) return errResponse('CSV must include a Date column', 400);

        const existing = await loadAll(env);
        const byId = new Map(existing.map(r => [r.id, r]));

        const parsed = [];
        const skipped = { blank: 0, noDate: 0 };
        let seq = nextSeq(existing);

        for (let i = 1; i < lines.length; i++) {
            const r = lines[i];
            if (!r.length || r.every(c => !String(c || '').trim())) { skipped.blank++; continue; }
            const iso = parseAnyDate(r[dateCol] || '');
            if (!iso) { skipped.noDate++; continue; }
            let id = idCol >= 0 ? String(r[idCol] || '').trim() : '';
            if (!id) id = 'ts-' + String(seq++).padStart(4, '0');
            parsed.push({
                id,
                date:     iso,
                employee: empCol   >= 0 ? String(r[empCol] || '').trim() : '',
                hours:    hoursCol >= 0 ? parseNum(r[hoursCol]) : 0,
                notes:    notesCol >= 0 ? String(r[notesCol] || '').trim() : '',
            });
        }

        const adds = [], updates = [];
        for (const row of parsed) {
            const prev = byId.get(row.id);
            if (!prev) { adds.push(row); continue; }
            const changed = ['date','employee','hours','notes']
                .some(k => (prev[k] ?? '') !== (row[k] ?? ''));
            if (changed) updates.push(row);
        }

        const summary = {
            csvRowsParsed: parsed.length,
            skipped,
            adds: adds.length,
            updates: updates.length,
            unchanged: parsed.length - adds.length - updates.length,
        };

        if (!apply) return jsonResponse({ mode: 'dry-run', summary });

        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        await env.ORDERS_KV.put(`backup:timesheets:${backupTs}`, JSON.stringify(existing));
        for (const r of adds) byId.set(r.id, r);
        for (const r of updates) byId.set(r.id, r);
        const merged = [...byId.values()];
        await env.ORDERS_KV.put('timesheets', JSON.stringify(merged));

        return jsonResponse({ mode: 'apply', summary: { ...summary, backupTs, totalRowsAfter: merged.length } });
    } catch (e) {
        return errResponse(e.message);
    }
}
