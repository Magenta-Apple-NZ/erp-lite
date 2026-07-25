// POST /api/courier/label
// Create a courier consignment for an order via GoSweetSpot and store the
// tracking details back on the order. Mock mode returns a synthetic connote.
//
// Body: {
//   orderId,
//   destination: { name, contactPerson, phone, email, street, suburb, city,
//                  postcode, countryCode, isRural, instructions },
//   packages: [ { name, length, width, height, kg } ],
//   carrier,                      // default "Post Haste"
//   reference,                    // DeliveryReference (max 50)
//   signatureRequired, saturday   // booleans
// }
//
// Returns { connote, trackingUrl, consignmentId, cost, carrier, mock,
//           labelBase64 (or null), courier } and persists `courier` on the order.
import { jsonResponse, errResponse } from '../_xero.js';
import { createShipment, getLabelPdf, isMockMode } from '../_courier.js';

// GET /api/courier/label?orderId=PKS-0001 — refetch the label PDF for an
// order's existing consignment (reprint). Does NOT create a new consignment.
export async function onRequestGet({ env, request }) {
    try {
        const orderId = new URL(request.url).searchParams.get('orderId');
        if (!orderId) return errResponse('orderId required', 400);
        const order = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);
        if (!order.courier || !order.courier.connote) return errResponse('No courier label on this order', 404);

        let labelBase64 = null, labelError = null;
        try {
            labelBase64 = await getLabelPdf(env, order.courier.connote);
        } catch (e) { labelError = e.message; }

        return jsonResponse({ ...order.courier, labelBase64, labelError, mock: isMockMode(env) });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    let step = 'init';
    try {
        step = 'parse';
        const body = await request.json();
        const { orderId, destination = {}, packages = [], carrier, reference } = body;
        if (!orderId) return errResponse('orderId required', 400);
        if (!destination.street || !destination.city || !destination.postcode) {
            return errResponse('Destination street, city, and postcode are required', 400);
        }
        if (!packages.length) return errResponse('At least one package is required', 400);

        step = 'load-order';
        const order = await env.ORDERS_KV.get('order:' + orderId, { type: 'json' });
        if (!order) return errResponse('Order not found', 404);

        // Build the GoSweetSpot shipment payload
        const gssBody = {
            Origin: null, // site default
            Destination: {
                Name: destination.name || (order.customer && order.customer.name) || orderId,
                Address: {
                    BuildingName:  destination.buildingName || '',
                    StreetAddress: destination.street,
                    Suburb:        destination.suburb || '',
                    City:          destination.city,
                    PostCode:      String(destination.postcode),
                    CountryCode:   destination.countryCode || 'NZ',
                },
                Email:                destination.email || '',
                ContactPerson:        destination.contactPerson || destination.name || '',
                PhoneNumber:          destination.phone || '',
                IsRural:              !!destination.isRural,
                DeliveryInstructions: destination.instructions || '',
            },
            Packages: packages.map((p, i) => ({
                Name:   p.name || 'Package ' + (i + 1),
                Length: Number(p.length) || 10,
                Width:  Number(p.width)  || 10,
                Height: Number(p.height) || 10,
                Kg:     Number(p.kg)     || 1,
            })),
            IsSaturdayDelivery:      !!body.saturday,
            IsSignatureRequired:     body.signatureRequired !== false,
            DutiesAndTaxesByReceiver: false,
            DeliveryReference:       (reference || order.poNumber || orderId).slice(0, 50),
            PrintToPrinter:          'false',
            Carrier:                 carrier || 'Post Haste',
        };

        step = 'create-shipment';
        const shipment = await createShipment(env, gssBody);

        step = 'fetch-label';
        let labelBase64 = null;
        try {
            labelBase64 = await getLabelPdf(env, shipment.connote);
        } catch (e) {
            // Non-fatal: consignment exists even if label fetch fails. Surfaced in courier.labelError.
            shipment.labelError = e.message;
        }

        step = 'persist';
        const courier = {
            carrier:       shipment.carrier,
            connote:       shipment.connote,
            trackingUrl:   shipment.trackingUrl,
            consignmentId: shipment.consignmentId,
            cost:          shipment.cost,
            mock:          !!shipment.mock,
            reference:     gssBody.DeliveryReference,
            packages:      gssBody.Packages,
            createdAt:     new Date().toISOString(),
            labelError:    shipment.labelError || null,
        };
        order.courier = courier;
        order.updatedAt = new Date().toISOString();
        order.events = order.events || [];
        order.events.unshift({
            ts: order.updatedAt,
            msg: `Courier label created — ${courier.carrier} ${courier.connote}${courier.mock ? ' (TEST)' : ''}`,
        });
        await env.ORDERS_KV.put('order:' + orderId, JSON.stringify(order));

        return jsonResponse({ ...courier, labelBase64, mock: isMockMode(env) });
    } catch (e) {
        return errResponse(`[${step}] ${e.message || String(e)}`, 500);
    }
}
