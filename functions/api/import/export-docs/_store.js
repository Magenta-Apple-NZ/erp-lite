// KV layout for shipment export documents (ORDERS_KV). The shipment itself
// stays in `import:forecast`; this is the per-shipment extension holding the
// bales, supplier figures, export invoice, LC details and generated files.
//
//   shipdocs:<shipmentId>        record (see ../_exportdocs.js header)
//   shipdocs:index               [shipmentId]
//   shipdocs:settings            document settings (letterhead, JPS, terms…)
//   shipdocs:asset:<name>        { mediaType, data }  signature / seal images
//   shipdocs:file:<key>          supplier PDF, base64   key = <shipId>:<kind>:<ts>
//   shipdocs:out:<key>           generated document { html, data }

import { getJson, putJson, whoami } from '../../stock/_store.js';
import { shipNumber, shipLabel } from '../../stock/_engine.js';
import {
    mergeSettings, emptyReview, runChecks, baleTotals, invoiceAmount, exportInvoiceDefaults,
    generationIssues, lcCrossChecks, deriveStatus, STATUS_LABELS, hasUnconfirmedChanges, missingSettings, blockingFailures,
} from '../_exportdocs.js';
import { jpsChecks, jpsSplit, xeroDocs, costPlan } from '../_shipxero.js';
import { nzToday } from '../../_dates.js';

export { getJson, putJson, whoami };

export const K = {
    record:   id   => 'shipdocs:' + id,
    index:    'shipdocs:index',
    settings: 'shipdocs:settings',
    asset:    name => 'shipdocs:asset:' + name,
    file:     key  => 'shipdocs:file:' + key,
    out:      key  => 'shipdocs:out:' + key,
};
export const ASSET_NAMES = ['signature', 'seal'];
export const KINDS = ['packingList', 'proforma', 'jpsInvoice'];

export function blankRecord(shipmentId) {
    return { shipmentId, files: {}, fileHistory: [], extractions: {}, review: null, confirmed: null, exportInvoice: null, jps: null, xero: {}, lc: {}, outputs: [], log: [] };
}

export async function loadRecord(env, shipmentId) {
    const r = await getJson(env, K.record(shipmentId), null);
    return r ? { ...blankRecord(shipmentId), ...r } : blankRecord(shipmentId);
}

export async function saveRecord(env, record, who, action) {
    const now = new Date().toISOString();
    if (action) record.log = [{ at: now, by: who || 'unknown', action }, ...(record.log || [])].slice(0, 200);
    record.updatedAt = now;
    record.updatedBy = who || 'unknown';
    await putJson(env, K.record(record.shipmentId), record);
    const idx = await getJson(env, K.index, []);
    if (!idx.includes(record.shipmentId)) { idx.push(record.shipmentId); await putJson(env, K.index, idx); }
}

export async function loadAllRecords(env) {
    const idx = await getJson(env, K.index, []);
    return (await Promise.all(idx.map(id => getJson(env, K.record(id), null)))).filter(Boolean);
}

export async function loadSettings(env) {
    return mergeSettings(await getJson(env, K.settings, null));
}

export async function loadAssets(env) {
    const out = {};
    for (const n of ASSET_NAMES) out[n] = await getJson(env, K.asset(n), null);
    return out;
}

// Shipments as the Imports view stores them (raw, not costed).
export async function loadShipments(env) {
    const fc = await getJson(env, 'import:forecast', null);
    return fc && Array.isArray(fc.shipments) ? fc.shipments : [];
}

// The LC linked to this shipment on its Letter of Credit tab, if any.
export async function loadLinkedLc(env, shipmentId) {
    const ids = await getJson(env, 'lc_index', []);
    for (const id of ids) {
        const lc = await getJson(env, 'lc:' + id, null);
        if (lc && lc.linkedShipmentId === shipmentId) return lc;
    }
    return null;
}

export class NotFound extends Error {}

// Everything the Export documents tab needs, derived on read. Read-only:
// the MCP server calls this with a KV that refuses writes.
export async function buildView(env, shipmentId) {
    const [record, settings, shipments, lc, all] = await Promise.all([
        loadRecord(env, shipmentId), loadSettings(env), loadShipments(env), loadLinkedLc(env, shipmentId), loadAllRecords(env),
    ]);
    const ship = shipments.find(s => s.id === shipmentId);
    if (!ship) throw new NotFound('Shipment not found');
    const number = shipNumber(ship);
    const numberOf = id => { const s = shipments.find(x => x.id === id); return s ? shipNumber(s) : null; };
    const others = all.filter(r => r.shipmentId !== shipmentId).map(r => ({ shipmentNumber: numberOf(r.shipmentId), exportInvoice: r.exportInvoice }));
    const defaults = exportInvoiceDefaults({ others, shipmentNumber: number, settings, today: nzToday() });
    const exportInvoice = record.exportInvoice || { number: defaults.number, date: defaults.date, rate: defaults.rate, currency: defaults.currency, numberConfirmed: false, rateConfirmed: false };
    const rec = { ...record, exportInvoice };
    const otherInvoiceNumbers = others.filter(o => o.exportInvoice?.number).map(o => ({ shipmentNumber: o.shipmentNumber, number: o.exportInvoice.number }));
    const review = record.review || emptyReview();
    const confirmedTotals = record.confirmed ? baleTotals(record.confirmed.bales) : null;
    const gen = (doc, stage) => generationIssues({ record: rec, settings, doc, stage, shipmentNumber: number, otherInvoiceNumbers });
    const status = deriveStatus(rec);

    // JPS invoice: judged against the previous shipment's handling rate.
    const prior = all
        .filter(r => r.shipmentId !== shipmentId && r.jps && r.confirmed)
        .map(r => ({ n: numberOf(r.shipmentId), split: jpsSplit(r) }))
        .filter(x => x.split && x.n != null && (number == null || x.n < number))
        .sort((a, b) => b.n - a.n)[0];
    const jChecks = jpsChecks(rec, { settings, typicalMargin: prior ? prior.split.handlingRate : null });
    const confirmedOk = record.confirmed ? !blockingFailures(runChecks(record.confirmed, { settings, shipmentNumber: number })).length : false;
    const jpsOk = !blockingFailures(jChecks).length;
    return {
        shipment: {
            id: ship.id, number, label: shipLabel(ship), startDate: ship.startDate || null,
            whiteRawKg: Number(ship.whiteRawKg) || 0, colourRawKg: Number(ship.colourRawKg) || 0,
        },
        status, statusLabel: STATUS_LABELS[status],
        record: rec,
        defaults,
        checks: runChecks(review, { settings, shipmentNumber: number, exportInvoice }),
        reviewTotals: baleTotals(review.bales),
        confirmedTotals,
        amount: confirmedTotals ? invoiceAmount(confirmedTotals.netKg, exportInvoice.rate) : null,
        unconfirmedChanges: hasUnconfirmedChanges(record),
        generation: { packingDraft: gen('packing', 'draft'), proforma: gen('proforma'), packingFinal: gen('packing', 'final') },
        linkedLc: lc ? {
            id: lc.id, lcNumber: lc.lcNumber || '', issuedDate: lc.issuedDate || '', proformaRef: lc.proformaRef || '',
            proformaDate: lc.proformaDate || '', amount: lc.amount || null, currency: lc.currency || '',
        } : null,
        lcChecks: lcCrossChecks(rec, lc, settings),
        otherInvoiceNumbers,
        jpsChecks: jChecks,
        jpsSplit: jpsSplit(rec),
        jpsTypical: prior ? { shipment: prior.n, rate: prior.split.handlingRate } : { shipment: null, rate: Number(settings.jpsMarginPerKg) || null },
        xero: {
            docs: xeroDocs({ record: rec, settings, shipmentNumber: number, confirmedOk, jpsOk }),
            status: settings.xero?.status || 'DRAFT',
            refreshedAt: record.xeroRefreshedAt || null,
        },
        // Only V3 shipments have the cost lines the documents fill.
        costPlan: costPlan({ shipment: ship, record: rec }),
        costPlanApplies: ship.schema === 3,
        baleRange: { min: Number(settings.baleMinKg) || 150, max: Number(settings.baleMaxKg) || 650 },
        settingsStatus: {
            reviewedAt: settings.reviewedAt || null, reviewedBy: settings.reviewedBy || null,
            missingPacking: missingSettings(settings, 'packing'), missingProforma: missingSettings(settings, 'proforma'),
        },
    };
}

export function viewError(e) {
    const status = e instanceof NotFound ? 404 : 500;
    return new Response(JSON.stringify({ error: e.message || String(e) }), { status, headers: { 'Content-Type': 'application/json' } });
}
