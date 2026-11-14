// GET /api/xero/auth — redirect browser to Xero OAuth consent screen
//   ?return=integrations  land back on Settings → Integrations afterwards

import { saveOAuthState, XERO_SCOPES } from '../_xero.js';

// The scope list and what each is for live in _xero.js (granular scopes only).
const SCOPES = XERO_SCOPES.map(s => s.scope).join(' ');

export async function onRequestGet({ env, request }) {
    const state = crypto.randomUUID();
    const ret = new URL(request.url).searchParams.get('return') === 'integrations' ? 'integrations' : '1';
    await saveOAuthState(env, state, ret);

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: env.XERO_CLIENT_ID,
        redirect_uri: 'https://hub.primetie.co.nz/api/xero/callback',
        scope: SCOPES,
        state,
    });

    return Response.redirect(
        'https://login.xero.com/identity/connect/authorize?' + params.toString(),
        302
    );
}
