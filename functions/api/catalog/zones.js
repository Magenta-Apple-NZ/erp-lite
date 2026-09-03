// GET /api/catalog/zones — the fixed option lists for store zone fields.
//
//   courierZones: ["Local", "Inner Island", "Outer Island", "Inter Island"]
//   freightZones: [{ label, region }]  — one per freight-rate row on the
//                 published freight tab (current pricing year). `label` is
//                 what a store's zoneFreight should be set to (the sheet's
//                 zone_freight join column when present, else the region).
//
// The Stores tab renders <select>s from these so zone values always match
// what _freight.js can resolve — free text is how "inner" vs "Inner Island"
// mismatches crept in.

import { jsonResponse, errResponse } from '../_xero.js';
import { COURIER_ZONES, loadFreightRates } from '../_freight.js';

export async function onRequestGet({ env }) {
    try {
        // "None (no freight)" marks a store as exempt from auto freight
        // (local-run deliveries) — both calculators skip it deliberately.
        const courierZones = Object.values(COURIER_ZONES).map(z => z.name.replace(/^Courier - /, ''))
            .concat(['None (no freight)']);

        let rates = [];
        try { rates = await loadFreightRates(env); } catch (_) { rates = []; }
        const seen = new Set();
        const freightZones = [];
        for (const r of rates) {
            const label = (r.zoneFreight || r.region || '').trim();
            if (!label || seen.has(label.toLowerCase())) continue;
            seen.add(label.toLowerCase());
            freightZones.push({ label, region: r.region });
        }
        freightZones.sort((a, b) => a.label.localeCompare(b.label));

        return jsonResponse({ courierZones, freightZones });
    } catch (e) {
        return errResponse(e.message);
    }
}
