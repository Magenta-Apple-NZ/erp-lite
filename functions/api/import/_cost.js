// Shipment landed cost, server-side. A port of the Imports view's
// computeShipTotalsV3 / computeShipTotalsNew / legacy costLines maths so the
// stock engine can cost each received shipment (FIFO lot) at its landed $/kg:
//
//   landed $/kg = total landed NZD ÷ kg that actually lands (yield kg for V3,
//                 s.kg otherwise)
//
// Keep the schemas in step with warehouse.js (FIXED_LINE_SCHEMA_V3 /
// FIXED_LINE_SCHEMA). Forex: open.er-api.com NZD base, edge-cached an hour,
// with the last good snapshot kept in KV as a fallback.

// ── V3 ──────────────────────────────────────────────────────────────────
const FIXED_LINE_SCHEMA_V3 = [
    { key: 'rawWhite',       section: 'raw',        kind: 'perKg', kgField: 'whiteRawKg',  defaultCcy: 'EUR' },
    { key: 'rawColour',      section: 'raw',        kind: 'perKg', kgField: 'colourRawKg', defaultCcy: 'EUR' },
    { key: 'inspection',     section: 'raw',        kind: 'flat',  defaultCcy: 'EUR' },
    { key: 'handlingA',      section: 'bangladesh', kind: 'perKg', kgField: 'netKg',    defaultCcy: 'USD' },
    { key: 'handlingB',      section: 'bangladesh', kind: 'perKg', kgField: 'netKg',    defaultCcy: 'USD' },
    { key: 'lcRefund',       section: 'bangladesh', kind: 'perKg', kgField: 'netKg',    defaultCcy: 'NZD' },
    { key: 'bundling',       section: 'bangladesh', kind: 'perKg', kgField: 'yieldKg',  defaultCcy: 'BDT' },
    { key: 'rent',           section: 'bangladesh', kind: 'allocation', defaultCcy: 'BDT' },
    { key: 'salaries',       section: 'bangladesh', kind: 'allocation', defaultCcy: 'BDT' },
    { key: 'bankFees',       section: 'bangladesh', kind: 'flat',  defaultCcy: 'NZD' },
    { key: 'freightItalyBd', section: 'freight',    kind: 'flat',  defaultCcy: 'NZD' },
    { key: 'freightBdNz',    section: 'freight',    kind: 'flat',  defaultCcy: 'NZD' },
    { key: 'freightTgaKati', section: 'freight',    kind: 'flat',  defaultCcy: 'NZD' },
    { key: 'rubbish',        section: 'misc',       kind: 'flat',  defaultCcy: 'NZD' },
    { key: 'otherExpenses',  section: 'misc',       kind: 'flat',  defaultCcy: 'NZD' },
    { key: 'interest',       section: 'misc',       kind: 'flat',  defaultCcy: 'NZD' },
];

function clampPct(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, n));
}

export function derivedV3(s) {
    const whiteRawKg  = Number(s.whiteRawKg) || 0;
    const colourRawKg = Number(s.colourRawKg) || 0;
    const wastePct    = clampPct(s.wastePct, 10);
    const netKg       = whiteRawKg + colourRawKg;
    const yieldKg     = netKg * (100 - wastePct) / 100;
    return { whiteRawKg, colourRawKg, netKg, wastePct, yieldKg };
}

function toNzd(amount, ccy, forex) {
    if (!amount) return 0;
    if (!ccy || ccy === 'NZD') return amount;
    const rate = forex && forex[ccy];
    return rate ? amount / rate : amount;
}

function totalsV3(s, forex) {
    const d = derivedV3(s);
    let total = 0;
    for (const def of FIXED_LINE_SCHEMA_V3) {
        const line = (s.fixedLines || {})[def.key];
        if (!line) continue;
        let amount = 0;
        if (def.kind === 'flat') amount = Number(line.amount) || 0;
        else if (def.kind === 'perKg') {
            const rate = line.rate != null ? Number(line.rate) : Number(line.amount) || 0;
            amount = rate * (Number(d[def.kgField]) || 0);
        } else if (def.kind === 'allocation') amount = (Number(line.allocFactor) || 0) * (Number(line.annualAmount) || 0);
        total += toNzd(amount, line.ccy || def.defaultCcy, forex);
    }
    for (const l of (s.extraLines || [])) {
        const kg  = l.kind === 'perKg' ? (Number(d[l.kgField || 'netKg']) || 0) : 0;
        const raw = l.kind === 'flat' ? (Number(l.amount) || 0) : (Number(l.rate) || 0) * kg;
        total += toNzd(raw, l.ccy || 'NZD', forex);
    }
    return { total, kg: d.yieldKg };
}

// ── V2 (s.seq, no schema) ────────────────────────────────────────────────
const FIXED_LINE_SCHEMA_V2 = [
    { key: 'rawA',           kind: 'rawProduct', kgField: 'rawWhiteKg',  defaultCcy: 'EUR', alias: 'rawWhite' },
    { key: 'rawB',           kind: 'rawProduct', kgField: 'rawColourKg', defaultCcy: 'EUR', alias: 'rawColour' },
    { key: 'processing',     kind: 'flat', defaultCcy: 'USD' },
    { key: 'management',     kind: 'flat', defaultCcy: 'USD' },
    { key: 'freightItalyBd', kind: 'flat', defaultCcy: 'USD' },
    { key: 'freightBdTga',   kind: 'flat', defaultCcy: 'USD' },
    { key: 'freightTgaKati', kind: 'flat', defaultCcy: 'NZD' },
];

function totalsV2(s, forex) {
    const fl = s.fixedLines || {};
    let total = 0;
    for (const def of FIXED_LINE_SCHEMA_V2) {
        const line = fl[def.key] || (def.alias ? fl[def.alias] : undefined);
        if (!line) continue;
        let amount = 0;
        if (def.kind === 'flat') amount = Number(line.amount) || 0;
        else if (def.kind === 'perKg') amount = (Number(line.rate) || 0) * (Number(s.kg) || 0);
        else if (def.kind === 'rawProduct') amount = (Number(line.rate) || 0) * (Number(s[def.kgField]) || 0);
        total += toNzd(amount, line.ccy || def.defaultCcy, forex);
    }
    for (const l of (s.costLines || [])) total += toNzd(Number(l.amount) || 0, l.ccy, forex);
    return { total, kg: Number(s.kg) || 0 };
}

function totalsLegacy(s, forex) {
    const total = (s.costLines || []).reduce((t, l) => t + toNzd(Number(l.amount) || 0, l.ccy, forex), 0);
    return { total, kg: Number(s.kg) || 0 };
}

// ── Public ──────────────────────────────────────────────────────────────
// Kg that lands on the shelf (what the forecast and the engine count).
export function shipmentKgIn(s) {
    if (s && s.schema === 3) {
        const y = derivedV3(s).yieldKg;
        if (y > 0) return y;
    }
    return Number(s?.kg) || 0;
}

// { unitCost, basis, total, kg } — landed $/kg where cost lines exist,
// else the listed pricePerKg, else null.
export function shipmentCost(s, forex) {
    const t = s.schema === 3 ? totalsV3(s, forex) : (s.seq ? totalsV2(s, forex) : totalsLegacy(s, forex));
    if (t.total > 0 && t.kg > 0) {
        return { unitCost: Math.round((t.total / t.kg) * 10000) / 10000, basis: 'landed', total: Math.round(t.total * 100) / 100, kg: Math.round(t.kg * 100) / 100 };
    }
    if (Number(s.pricePerKg) > 0) return { unitCost: Number(s.pricePerKg), basis: 'listed', total: null, kg: shipmentKgIn(s) };
    return null;
}

// NZD-base rates. Edge-cached for an hour; last good copy kept in KV.
const FX_KEY = 'fx:nzd:latest';
export async function loadForex(env) {
    try {
        const res = await fetch('https://open.er-api.com/v6/latest/NZD', { cf: { cacheTtl: 3600, cacheEverything: true } });
        if (res.ok) {
            const data = await res.json();
            if (data && data.rates && data.rates.USD) {
                env.ORDERS_KV.put(FX_KEY, JSON.stringify({ rates: data.rates, at: new Date().toISOString() })).catch(() => {});
                return data.rates;
            }
        }
    } catch { /* fall through to snapshot */ }
    try {
        const snap = await env.ORDERS_KV.get(FX_KEY, { type: 'json' });
        if (snap && snap.rates) return snap.rates;
    } catch { /* none */ }
    return {};
}

// Stamp unitCost / costBasis / kgIn onto each shipment for the engine.
export async function costShipments(env, shipments) {
    if (!shipments || !shipments.length) return shipments || [];
    const forex = await loadForex(env);
    return shipments.map(s => {
        const c = shipmentCost(s, forex);
        return { ...s, kgIn: shipmentKgIn(s), unitCost: c ? c.unitCost : null, costBasis: c ? c.basis : null, landedTotal: c ? c.total : null };
    });
}
