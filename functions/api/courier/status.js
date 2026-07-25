// GET /api/courier/status — courier integration health for the UI.
import { jsonResponse, errResponse } from '../_xero.js';
import { isMockMode, courierConfigured } from '../_courier.js';

export async function onRequestGet({ env }) {
    try {
        return jsonResponse({
            configured: courierConfigured(env),
            mock:       isMockMode(env),
            carrier:    'Post Haste',
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
