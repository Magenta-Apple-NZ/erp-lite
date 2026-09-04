// GET /api/stock/shipments — shipments as the stock side sees them: number
// (#41), landed/listed $/kg, kg that lands, status and ETA. Used by the
// count editor's per-shipment sub-count. Newest number first.

import { jsonResponse, errResponse } from '../_xero.js';
import { loadShipments } from './_store.js';
import { shipNumber, shipLabel, shipUnitCost, shipKg, deriveShipStatus, shipmentEta } from './_engine.js';

export async function onRequestGet({ env }) {
    try {
        const ships = await loadShipments(env);
        const out = ships.map(s => ({
            id: s.id, number: shipNumber(s), label: shipLabel(s), note: s.note || '',
            unitCost: shipUnitCost(s), costBasis: s.costBasis || (Number(s.pricePerKg) > 0 ? 'listed' : null),
            kgIn: shipKg(s), status: deriveShipStatus(s), eta: shipmentEta(s), ym: s.ym || null,
        })).sort((a, b) => (b.number ?? -1) - (a.number ?? -1) || String(b.ym || '').localeCompare(String(a.ym || '')));
        return jsonResponse(out);
    } catch (e) {
        return errResponse(e.message);
    }
}
