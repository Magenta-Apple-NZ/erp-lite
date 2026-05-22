#!/usr/bin/env node
// One-shot importer for the historical Prime Tie sales CSV.
//
// Usage:
//   node scripts/import-historical.js <path-to-csv>
//     → dry run: prints stats, writes scripts/historical-orders-bulk.json
//
//   node scripts/import-historical.js <path-to-csv> --apply --namespace-id <id>
//     → reads existing orders_index via wrangler, merges HST-* IDs into it,
//       then bulk-writes everything to ORDERS_KV in one call.
//
// The CSV is expected to have columns:
//   Month, Year, Financial Year, Date, Customer, Branch, PO#, Invoice,
//   Prime Tie Bundles Volume, Prime Tie Loose Volume, eco Ties Volume
//
// Each non-empty data row becomes one locked, historical order. Rows with
// no date, no customer, all-zero volumes, or invoice = CANCELLED are skipped.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Args ──
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const nsIdx = args.indexOf('--namespace-id');
const namespaceId = nsIdx >= 0 ? args[nsIdx + 1] : null;
const csvPath = args.find(a => !a.startsWith('--') && a !== namespaceId);

if (!csvPath) {
    console.error('Usage: node scripts/import-historical.js <path-to-csv> [--apply --namespace-id <id>]');
    process.exit(1);
}
if (apply && !namespaceId) {
    console.error('--apply requires --namespace-id <ORDERS_KV namespace id>');
    process.exit(1);
}

// ── CSV parser (RFC-4180-ish: handles quoted fields with embedded commas) ──
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

// NZ DD/MM/YY (or DD/MM/YYYY) → ISO YYYY-MM-DD.
function parseNzDate(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (!m) return null;
    const dy = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    let   yr = parseInt(m[3], 10);
    if (yr < 100) yr += 2000;
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    return `${yr}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
}

function parseNum(s) {
    if (s == null || s === '') return 0;
    const n = parseFloat(String(s).replace(/[,$\s]/g, ''));
    return isNaN(n) ? 0 : n;
}

// ── Main ──
const csvText = fs.readFileSync(csvPath, 'utf8');
const rows = parseCsv(csvText);
if (rows.length < 2) {
    console.error('CSV has no data rows');
    process.exit(1);
}

const header = rows[0].map(h => h.trim());
const col = name => header.findIndex(h => h.toLowerCase() === name.toLowerCase());

const dateCol     = col('Date');
const customerCol = col('Customer');
const branchCol   = col('Branch');
const poCol       = header.findIndex(h => /^po#?$/i.test(h.trim()));
const invCol      = col('Invoice');
// Tolerant of "Prime Tie Bundles Volume" (old) and "Prime Tie (Bundled) Volume" (current).
const bundleCol = header.findIndex(h => {
    const l = h.toLowerCase();
    return l.includes('prime tie') && /bundle/.test(l) && l.includes('volume');
});
const looseCol = header.findIndex(h => {
    const l = h.toLowerCase();
    return l.includes('prime tie') && /loose/.test(l) && l.includes('volume');
});
const ecoTieCol = header.findIndex(h => {
    const l = h.toLowerCase();
    return /eco\s*ties?/.test(l) && l.includes('volume');
});

if (dateCol < 0 || customerCol < 0) {
    console.error('CSV missing required Date / Customer columns');
    console.error('Found headers:', header);
    process.exit(1);
}

const orders = [];
const skipped = { blank: 0, noDate: 0, noCustomer: 0, allZero: 0, cancelled: 0 };
let rowIndex = 0;

for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every(c => !String(c || '').trim())) { skipped.blank++; continue; }
    rowIndex++;

    const isoDate  = parseNzDate(r[dateCol]);
    const customer = (r[customerCol] || '').trim();
    const branch   = (r[branchCol]   || '').trim();
    if (!isoDate)  { skipped.noDate++;     continue; }
    if (!customer) { skipped.noCustomer++; continue; }

    const invoice = (r[invCol] || '').trim();
    if (invoice.toUpperCase() === 'CANCELLED') { skipped.cancelled++; continue; }

    const bundleKg = bundleCol >= 0 ? parseNum(r[bundleCol]) : 0;
    const looseKg  = looseCol  >= 0 ? parseNum(r[looseCol])  : 0;
    const ecoTieKg = ecoTieCol >= 0 ? parseNum(r[ecoTieCol]) : 0;

    if (bundleKg === 0 && looseKg === 0 && ecoTieKg === 0) { skipped.allZero++; continue; }

    const lines = [];
    // Bundles: column is total kg, sold as 10kg boxes → quantity = kg / 10.
    if (bundleKg !== 0) {
        lines.push({
            sku: 'PT-BUNDLE-10',
            description: 'Prime Tie Bundles (10kg)',
            quantity:    bundleKg / 10,
            kgPerUnit:   10,
            unitPrice:   0,
            accountCode: '200',
        });
    }
    // Loose: column is total kg, sold as 1kg bags → quantity = kg.
    if (looseKg !== 0) {
        lines.push({
            sku: 'PT-LOOSE-1',
            description: 'Prime Tie Loose (1kg)',
            quantity:    looseKg,
            kgPerUnit:   1,
            unitPrice:   0,
            accountCode: '200',
        });
    }
    // eco Ties: per user, treat column as kg with kgPerUnit = 1.
    if (ecoTieKg !== 0) {
        lines.push({
            sku: 'ECOTIE',
            description: 'eco Ties',
            quantity:    ecoTieKg,
            kgPerUnit:   1,
            unitPrice:   0,
            accountCode: '200',
        });
    }

    // Deterministic ID by row index — re-running the script with the same
    // CSV produces the same IDs (idempotent write).
    const id = `HST-${String(rowIndex).padStart(4, '0')}`;
    const ts = `${isoDate}T00:00:00.000Z`;

    orders.push({
        id,
        createdAt:    ts,
        updatedAt:    ts,
        dispatchedAt: ts,
        dispatchedBy: 'historical',
        status:       'dispatched',
        source:       'historical-import',
        locked:       true,
        historical:   true,
        customer:     { name: customer },
        shipTo:       { branch },
        poNumber:     (r[poCol] || '').replace(/\s+/g, ''),
        xeroInvoiceNumber: invoice,
        xeroInvoiceId:     null,
        lines,
        packingNotes: '',
        events: [{
            user:      'system',
            action:    'Imported from historical CSV',
            timestamp: new Date().toISOString(),
        }],
    });
}

// ── Stats ──
console.log(`\nParsed ${orders.length} historical orders from ${csvPath}`);
console.log('Skipped rows:', skipped);

const byYear = {};
for (const o of orders) {
    const y = o.createdAt.slice(0, 4);
    if (!byYear[y]) byYear[y] = { count: 0, kg: 0 };
    byYear[y].count++;
    byYear[y].kg += o.lines.reduce((s, l) => s + l.quantity * l.kgPerUnit, 0);
}
console.log('\nBy calendar year:');
Object.keys(byYear).sort().forEach(y => {
    const { count, kg } = byYear[y];
    console.log(`  ${y}: ${String(count).padStart(4)} orders · ${Math.round(kg).toLocaleString('en-NZ').padStart(8)} kg`);
});

const negCount = orders.filter(o =>
    o.lines.some(l => l.quantity < 0)
).length;
if (negCount) console.log(`\nNote: ${negCount} orders contain negative-quantity lines (credit notes / returns)`);

// ── Bulk file ──
const bulk = orders.map(o => ({
    key: 'order:' + o.id,
    value: JSON.stringify(o),
}));

const bulkPath = path.join(__dirname, 'historical-orders-bulk.json');
fs.writeFileSync(bulkPath, JSON.stringify(bulk, null, 2));
console.log(`\nWrote ${bulk.length} keys → ${bulkPath}`);

if (!apply) {
    console.log(`
Dry run only. To commit:
  node ${path.relative(process.cwd(), __filename)} ${csvPath} --apply --namespace-id <ORDERS_KV_NAMESPACE_ID>

Find your namespace ID in the Cloudflare dashboard → Workers → KV → namespaces.
`);
    process.exit(0);
}

// ── Apply ──
console.log('\nFetching existing orders_index via wrangler…');
let existingIndex = [];
try {
    const out = execSync(
        `npx wrangler kv key get orders_index --namespace-id=${namespaceId} --remote`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
    ).trim();
    existingIndex = out ? JSON.parse(out) : [];
    console.log(`  ${existingIndex.length} existing IDs`);
} catch (e) {
    console.warn('  Could not read orders_index (may not exist yet); starting from empty.');
}

const newIds = orders.map(o => o.id);
const newIdSet = new Set(newIds);
// Live orders stay at the front (newest first); historical IDs appended.
// The UI doesn't rely on index order beyond what KV returns, but keeping
// live orders first preserves the existing "newest at top" feel.
const merged = [
    ...existingIndex.filter(id => !newIdSet.has(id)),
    ...newIds,
];

bulk.push({ key: 'orders_index', value: JSON.stringify(merged) });
fs.writeFileSync(bulkPath, JSON.stringify(bulk, null, 2));
console.log(`Merged index: ${existingIndex.length} live + ${newIds.length} historical = ${merged.length} total`);

console.log(`\nBulk-writing ${bulk.length} keys to ORDERS_KV…`);
execSync(
    `npx wrangler kv bulk put ${bulkPath} --namespace-id=${namespaceId} --remote`,
    { stdio: 'inherit' }
);

console.log('\nDone. Reload the Hub — historical orders should appear in Sales analytics.');
