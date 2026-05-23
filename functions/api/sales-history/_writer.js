// Shared helpers for appending rows to the sales_history table from
// elsewhere in the codebase (currently: the Xero push handler). Kept in
// an underscore-prefixed file so Pages doesn't treat it as a route.

const HUB_LIVE_YM = '2026-04'; // (Reference; sales_history doesn't gate on it)

// Classify an order line into one of three product buckets, or 'other'
// for freight / fees / anything not in the catalog. Looks at SKU first
// (catalog items have stable SKUs) then falls back to description text
// and finally to kgPerUnit, so manually-entered lines still get binned.
function classifyLine(l) {
    const sku  = String(l?.sku || '').toUpperCase();
    const desc = String(l?.description || '').toLowerCase();
    if (sku.includes('ECOTIE') || /eco\s*ti/.test(desc)) return 'ecoTies';
    if (sku.includes('BUNDLE') || /bundle/.test(desc)) return 'bundles';
    if (sku.includes('LOOSE')  || /loose/.test(desc))  return 'loose';
    // kgPerUnit fallback for catalog lines that don't expose obvious text.
    const kpu = Number(l?.kgPerUnit);
    if (kpu === 10) return 'bundles';
    if (kpu === 1)  return 'loose';
    return 'other';
}

function lineKg(l) {
    const q   = Number(l?.quantity)  || 0;
    const kpu = Number(l?.kgPerUnit) || 0;
    return q * kpu;
}

function fyLabel(year, month) {
    const endY = month >= 4 ? year + 1 : year;
    const startY = endY - 1;
    return `${String(startY).slice(-2)}/${String(endY).slice(-2)}`;
}

// Build the sales_history row for an order. Returns null when the order
// has no countable product kg (e.g. freight-only or empty lines).
export function rowFromOrder(order) {
    if (!order || !Array.isArray(order.lines)) return null;
    const buckets = { bundles: 0, loose: 0, ecoTies: 0 };
    for (const l of order.lines) {
        const cat = classifyLine(l);
        if (cat === 'other') continue;
        const kg = lineKg(l);
        if (kg !== 0) buckets[cat] += kg;
    }
    if (buckets.bundles === 0 && buckets.loose === 0 && buckets.ecoTies === 0) {
        return null;
    }
    const dateIso = (order.createdAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const [yr, mo] = dateIso.split('-').map(n => parseInt(n, 10));
    return {
        id:        order.id,
        source:    'hub',
        date:      dateIso,
        month:     mo,
        year:      yr,
        fy:        fyLabel(yr, mo),
        customer:  order.customer?.name || '',
        branch:    order.shipTo?.branch || '',
        poNumber:  order.poNumber || '',
        invoice:   order.xeroInvoiceNumber || '',
        bundlesKg: buckets.bundles,
        looseKg:   buckets.loose,
        ecoTiesKg: buckets.ecoTies,
    };
}

// Append or update one row in sales_history. Idempotent by row.id, so
// re-pushing a Xero invoice (e.g. after a manual correction) overwrites
// the existing hub row rather than duplicating.
export async function upsertRow(env, row) {
    if (!row || !row.id) return;
    const raw = await env.ORDERS_KV.get('sales_history');
    const rows = raw ? JSON.parse(raw) : [];
    const idx = rows.findIndex(r => r.id === row.id);
    if (idx >= 0) rows[idx] = row;
    else rows.push(row);
    await env.ORDERS_KV.put('sales_history', JSON.stringify(rows));
}

// Drop a row from sales_history by id. No-op if not present.
export async function removeRow(env, id) {
    if (!id) return;
    const raw = await env.ORDERS_KV.get('sales_history');
    if (!raw) return;
    const rows = JSON.parse(raw);
    const filtered = rows.filter(r => r.id !== id);
    if (filtered.length !== rows.length) {
        await env.ORDERS_KV.put('sales_history', JSON.stringify(filtered));
    }
}

// Single canonical sync hook. Called from every order write path so
// sales_history stays in lock-step with ORDERS_KV — irrespective of
// whether the order arrived via /api/orders (manual), /api/orders/inbound
// (API webhook), or /api/xero/push (invoice creation). An order with no
// countable product kg (e.g. freight-only) has its sales_history row
// removed if one exists.
export async function syncSalesHistory(env, order) {
    if (!order || !order.id) return;
    const row = rowFromOrder(order);
    if (row) {
        try { await upsertRow(env, row); }
        catch (err) { console.error('sales_history upsert failed for', order.id, err); }
    } else {
        try { await removeRow(env, order.id); }
        catch (err) { console.error('sales_history remove failed for', order.id, err); }
    }
}

export { HUB_LIVE_YM };
