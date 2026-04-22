// GET /api/xero/auth — redirect browser to Xero OAuth consent screen

import { saveOAuthState } from '../_xero.js';

const SCOPES = [
    'openid',
    'accounting.transactions',
    'accounting.contacts.read',
    'offline_access',
].join(' ');

export async function onRequestGet({ env }) {
    const state = crypto.randomUUID();
    await saveOAuthState(env, state);

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
