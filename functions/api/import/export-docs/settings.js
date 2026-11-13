// /api/import/export-docs/settings — constants printed on the export
// documents: letterhead, bank, JPS address and identifiers, HS code, terms,
// packing wording, sign-off. Saving stamps reviewedAt; documents can't be
// generated until settings have been saved once.
//   GET → { settings, seed, assets: { signature, seal } }
//   PUT { settings } → same

import { jsonResponse, errResponse } from '../../_xero.js';
import { K, ASSET_NAMES, loadSettings, getJson, putJson, whoami } from './_store.js';
import { SETTINGS_SEED, IDENTIFIER_FIELDS, sanitiseSettings } from '../_exportdocs.js';

async function payload(env) {
    const settings = await loadSettings(env);
    const assets = {};
    for (const n of ASSET_NAMES) assets[n] = !!(await getJson(env, K.asset(n), null));
    return { settings, seed: SETTINGS_SEED, identifierFields: IDENTIFIER_FIELDS, assets };
}

export async function onRequestGet({ env }) {
    try {
        return jsonResponse(await payload(env));
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPut({ env, request }) {
    try {
        const body = await request.json();
        if (!body || typeof body.settings !== 'object') return errResponse('settings required', 400);
        const clean = sanitiseSettings(body.settings);
        await putJson(env, K.settings, { ...clean, reviewedAt: new Date().toISOString(), reviewedBy: whoami(request) });
        return jsonResponse(await payload(env));
    } catch (e) {
        return errResponse(e.message);
    }
}
