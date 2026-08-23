// GET /api/xero/auth — redirect browser to Xero OAuth consent screen

import { saveOAuthState } from '../_xero.js';

// This Xero app was created after 2 Mar 2026, so it only has the NEW granular
// scopes — the broad scopes (accounting.transactions / accounting.reports.read)
// are NOT available to it and cause invalid_scope. Use the granular equivalents.
const SCOPES = [
    'openid',
    'accounting.invoices',                   // create + read invoices (push, alerts, reconcile)
    'accounting.contacts',                   // create + read contacts (push.js creates missing ones)
    'accounting.reports.profitandloss.read', // P&L dashboard widget
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
