// POST /api/orders/import
//
// Body: CSV in the same shape as /api/orders/export.csv. Rows match
// existing orders by `order_id` and lines within by `line_index`.
//
// Defaults to a DRY RUN — returns a per-order summary of what would change
// without writing anything. Add `?apply=true` to commit.
//
// Edits only (no adds, no deletes):
//   - Rows whose order_id doesn't exist in KV are reported as errors
//   - Rows whose line_index is out of range are reported as errors
//   - Rows missing from the CSV but present in KV are left untouched
//   - Non-editable columns (created_at, source, locked, dispatched_*) are
//     ignored even if present
//
// On apply, each modified order is snapshotted to a backup KV key before
// the new value is written, keyed by timestamp + order id.

import { jsonResponse, errResponse } from '../_xero.js';

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
                if (field.length || row.length) {
                    row.push(field);
                    rows.push(row);
                    row = []; field = '';
                }
                if (c === '\r' && next === '\n') i++;
            } else field += c;
        }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
}

function num(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[,$\s]/g, ''));
    return isNaN(n) ? null : n;
}

function trimOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

export async function onRequestPost({ env, request }) {
    try {
        const { searchParams } = new URL(request.url);
        const apply = searchParams.get('apply') === 'true';

        const csv = await request.text();
        if (!csv || !csv.trim()) return errResponse('Empty CSV body', 400);

        const rows = parseCsv(csv);
        if (rows.length < 2) return errResponse('CSV has no data rows', 400);

        const header = rows[0].map(h => h.trim().toLowerCase());
        const col = name => header.findIndex(h => h === name);

        const c = {
            orderId:     col('order_id'),
            lineIndex:   col('line_index'),
            status:      col('status'),
            customer:    col('customer'),
            branch:      col('branch'),
            sku:         col('sku'),
            description: col('description'),
            quantity:    col('quantity'),
            kgPerUnit:   col('kg_per_unit'),
            unitPrice:   col('unit_price'),
            xeroInvoice: col('xero_invoice'),
        };
        if (c.orderId < 0 || c.lineIndex < 0) {
            return errResponse('CSV must include order_id and line_index columns', 400);
        }

        // Group rows by order_id, preserving CSV row numbers for error refs.
        const byOrder = new Map();
        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            const orderId = trimOrNull(r[c.orderId]);
            if (!orderId) continue;
            const entry = {
                csvRow: i + 1,
                lineIndex:   trimOrNull(r[c.lineIndex]),
                status:      c.status      >= 0 ? trimOrNull(r[c.status])      : null,
                customer:    c.customer    >= 0 ? trimOrNull(r[c.customer])    : null,
                branch:      c.branch      >= 0 ? trimOrNull(r[c.branch])      : null,
                sku:         c.sku         >= 0 ? trimOrNull(r[c.sku])         : null,
                description: c.description >= 0 ? trimOrNull(r[c.description]) : null,
                quantity:    c.quantity    >= 0 ? trimOrNull(r[c.quantity])    : null,
                kgPerUnit:   c.kgPerUnit   >= 0 ? trimOrNull(r[c.kgPerUnit])   : null,
                unitPrice:   c.unitPrice   >= 0 ? trimOrNull(r[c.unitPrice])   : null,
                xeroInvoice: c.xeroInvoice >= 0 ? trimOrNull(r[c.xeroInvoice]) : null,
            };
            if (!byOrder.has(orderId)) byOrder.set(orderId, []);
            byOrder.get(orderId).push(entry);
        }

        const changes = []; // { orderId, fieldsChanged: ['status', 'line[0].quantity', ...] }
        const errors  = []; // { orderId?, csvRow?, error }
        const writes  = []; // { orderId, before, after }

        for (const [orderId, csvRows] of byOrder) {
            const original = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
            if (!original) {
                errors.push({ orderId, csvRow: csvRows[0]?.csvRow, error: 'Order not found' });
                continue;
            }

            const updated = JSON.parse(JSON.stringify(original));
            const fieldsChanged = [];

            // Order-level fields — take from the first row for that order id.
            const first = csvRows[0];
            if (first.status && updated.status !== first.status) {
                fieldsChanged.push('status'); updated.status = first.status;
            }
            if (first.customer && updated.customer?.name !== first.customer) {
                fieldsChanged.push('customer');
                updated.customer = { ...(updated.customer || {}), name: first.customer };
            }
            if (first.branch && updated.shipTo?.branch !== first.branch) {
                fieldsChanged.push('branch');
                updated.shipTo = { ...(updated.shipTo || {}), branch: first.branch };
            }
            if (first.xeroInvoice && updated.xeroInvoiceNumber !== first.xeroInvoice) {
                fieldsChanged.push('xero_invoice');
                updated.xeroInvoiceNumber = first.xeroInvoice;
            }

            // Line-level edits.
            for (const r of csvRows) {
                if (r.lineIndex == null) continue; // blank index = ignore (no-add policy)
                const idx = parseInt(r.lineIndex, 10);
                if (isNaN(idx)) {
                    errors.push({ orderId, csvRow: r.csvRow, error: `Invalid line_index "${r.lineIndex}"` });
                    continue;
                }
                if (!Array.isArray(updated.lines) || idx < 0 || idx >= updated.lines.length) {
                    errors.push({ orderId, csvRow: r.csvRow, error: `line_index ${idx} out of range` });
                    continue;
                }
                const line = updated.lines[idx];
                if (r.sku && line.sku !== r.sku) {
                    fieldsChanged.push(`line[${idx}].sku`); line.sku = r.sku;
                }
                if (r.description && line.description !== r.description) {
                    fieldsChanged.push(`line[${idx}].description`); line.description = r.description;
                }
                const q = num(r.quantity);
                if (q != null && Number(line.quantity) !== q) {
                    fieldsChanged.push(`line[${idx}].quantity`); line.quantity = q;
                }
                const kg = num(r.kgPerUnit);
                if (kg != null && Number(line.kgPerUnit) !== kg) {
                    fieldsChanged.push(`line[${idx}].kg_per_unit`); line.kgPerUnit = kg;
                }
                const up = num(r.unitPrice);
                if (up != null && Number(line.unitPrice) !== up) {
                    fieldsChanged.push(`line[${idx}].unit_price`); line.unitPrice = up;
                }
            }

            if (fieldsChanged.length) {
                updated.updatedAt = new Date().toISOString();
                changes.push({ orderId, fieldsChanged });
                writes.push({ orderId, before: original, after: updated });
            }
        }

        const summary = {
            rows: rows.length - 1,
            orders: byOrder.size,
            changes: changes.length,
            errors: errors.length,
        };

        if (!apply) {
            return jsonResponse({ mode: 'dry-run', summary, changes, errors });
        }

        // Apply: snapshot every modified order to a backup key, then write.
        const backupTs = new Date().toISOString().replace(/[:.]/g, '-');
        await env.ORDERS_KV.put(
            `backup:orders:${backupTs}:manifest`,
            JSON.stringify({
                timestamp: new Date().toISOString(),
                modifiedIds: writes.map(w => w.orderId),
            })
        );
        for (const { orderId, before, after } of writes) {
            await env.ORDERS_KV.put(`backup:orders:${backupTs}:order:${orderId}`, JSON.stringify(before));
            await env.ORDERS_KV.put('order:' + orderId, JSON.stringify(after));
        }

        return jsonResponse({
            mode: 'apply',
            summary: { ...summary, backupTs },
            changes,
            errors,
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
