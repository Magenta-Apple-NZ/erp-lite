// GET /api/integrations — live health of every outside service the Hub uses
// (Settings → Integrations). Read-only apart from the token refreshes a normal
// Xero / Google call would make anyway. See _integrations.js.

import { jsonResponse, errResponse } from './_xero.js';
import { checkAll } from './_integrations.js';

export async function onRequestGet({ env, request }) {
    try {
        return jsonResponse(await checkAll(env, { origin: new URL(request.url).origin }));
    } catch (e) {
        return errResponse(e.message || String(e));
    }
}
