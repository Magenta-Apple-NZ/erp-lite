// Shared GoSweetSpot (Post Haste / NZ Couriers) helper.
// Imported by the courier API functions.
//
// Credentials live in Cloudflare Pages env vars (never in the repo):
//   GSS_ACCESS_KEY    — API access key (ship.gosweetspot.com → Preferences → Advanced)
//   GSS_SITE_ID       — site id for the account
//   GSS_SUPPORT_EMAIL — developer contact email (required header)
//   COURIER_TEST_MODE — "true" to mock all calls (no live billable consignments)
//
// GoSweetSpot has NO sandbox — every live POST /api/shipments creates a real,
// billable Post Haste consignment. Mock mode returns a synthetic connote so the
// whole UI + print path can be exercised without spending money. Mock is forced
// on whenever credentials are absent, so we can never accidentally go live.

const GSS_BASE = 'https://api.gosweetspot.com';

export function isMockMode(env) {
    return env.COURIER_TEST_MODE === 'true' || !env.GSS_ACCESS_KEY || !env.GSS_SITE_ID;
}

export function courierConfigured(env) {
    return !!(env.GSS_ACCESS_KEY && env.GSS_SITE_ID);
}

function gssHeaders(env) {
    return {
        'Content-Type': 'application/json',
        'access_key':   env.GSS_ACCESS_KEY,
        'site_id':      String(env.GSS_SITE_ID),
        'supportemail': env.GSS_SUPPORT_EMAIL || 'dev@primetie.co.nz',
    };
}

// Create a shipment. `body` is the GSS POST /api/shipments payload.
// Returns { connote, trackingUrl, consignmentId, cost, carrier, raw }.
export async function createShipment(env, body) {
    if (isMockMode(env)) {
        const stamp = String(Date.now()).slice(-6);
        return {
            connote:       'TEST' + stamp,
            trackingUrl:   'https://www.gosweetspot.com/track/TEST' + stamp,
            consignmentId: Number(stamp),
            cost:          0,
            carrier:       body.Carrier || 'Post Haste',
            mock:          true,
            raw:           { Message: 'MOCK — no live consignment created' },
        };
    }

    const res = await fetch(GSS_BASE + '/api/shipments', {
        method:  'POST',
        headers: gssHeaders(env),
        body:    JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    // GSS errors come back in several shapes — a top-level Message, or arrays
    // of strings OR objects (e.g. { Property, Message }). Flatten them all to
    // readable text so the real reason isn't lost as "[object Object]".
    const errText = () => {
        const one = e => typeof e === 'string' ? e
            : (e && (e.Message || e.message || e.ErrorMessage || e.Error || [e.Property, e.Reason].filter(Boolean).join(': ')))
              || JSON.stringify(e);
        const parts = [];
        if (data && data.Message) parts.push(data.Message);
        for (const key of ['Errors', 'ValidationErrors', 'ModelState']) {
            const v = data && data[key];
            if (Array.isArray(v)) parts.push(...v.map(one));
            else if (v && typeof v === 'object') parts.push(...Object.values(v).flat().map(one));
        }
        return parts.filter(Boolean).join('; ') || `HTTP ${res.status} ${res.statusText}`;
    };

    if (!res.ok) {
        throw new Error(`GoSweetSpot ${res.status}: ${errText()}`);
    }
    if ((Array.isArray(data.Errors) && data.Errors.length) ||
        (Array.isArray(data.ValidationErrors) && data.ValidationErrors.length)) {
        throw new Error('GoSweetSpot: ' + errText());
    }
    const c = (data.Consignments || [])[0];
    if (!c || !c.Connote) {
        throw new Error('GoSweetSpot returned no consignment: ' + (data.Message || 'unknown error'));
    }
    return {
        connote:       c.Connote,
        trackingUrl:   c.TrackingUrl || null,
        consignmentId: c.ConsignmentId || null,
        cost:          c.Cost != null ? c.Cost : (c.Charge != null ? c.Charge : null),
        carrier:       data.CarrierName || body.Carrier || 'Post Haste',
        mock:          false,
        raw:           data,
    };
}

// Fetch the label PDF for a connote. Returns base64 (no data: prefix) or null.
export async function getLabelPdf(env, connote, format = 'LABEL_PDF_100X150') {
    if (isMockMode(env)) return null; // no printable label in mock mode

    const url = `${GSS_BASE}/api/labels?connote=${encodeURIComponent(connote)}&format=${encodeURIComponent(format)}`;
    const res = await fetch(url, { headers: gssHeaders(env) });
    if (!res.ok) {
        throw new Error(`GoSweetSpot label ${res.status}: ${res.statusText}`);
    }
    const data = await res.json().catch(() => null);
    // Response is an array of base64-encoded binaries (PDF consolidates all parts).
    if (Array.isArray(data) && data.length) return data[0];
    if (typeof data === 'string') return data;
    return null;
}
