// POST /api/import/export-docs/:shipmentId/xero — stage-1 invoices in Xero.
//   { doc: 'supplierBill' | 'salesInvoice' | 'jpsBill' }  create that invoice
//       (status from Document settings → Xero, Draft by default)
//   { refresh: true }  re-read every created invoice: status, payments, NZD paid
// Only ever on a click. Amounts come from the confirmed bales, our export
// invoice and the checked JPS invoice (see ../../_shipxero.js).

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../../../_xero.js';
import { buildView, loadRecord, saveRecord, loadSettings, whoami, viewError } from '../_store.js';
import { XERO_DOCS, xeroPayload, xeroState, xeroValidationMessage } from '../../_shipxero.js';
import { fmtMoney } from '../../_exportdocs.js';

const API = 'https://api.xero.com/api.xro/2.0/';
const STATUS_WORDS = { DRAFT: 'draft', SUBMITTED: 'awaiting approval', AUTHORISED: 'awaiting payment', PAID: 'paid', VOIDED: 'voided', DELETED: 'deleted' };

async function xeroFetch(token, path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { ...xeroHeaders(token), ...(opts.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const e = new Error(`Xero ${res.status}: ${xeroValidationMessage(body) || res.statusText}`);
        e.status = res.status;
        throw e;
    }
    return body;
}

// Exact (case-insensitive) name first; a single partial match is accepted;
// several matches are an error rather than a guess; none creates the contact.
async function findOrCreateContact(token, name) {
    const data = await xeroFetch(token, 'Contacts?SearchTerm=' + encodeURIComponent(name));
    const norm = s => String(s || '').trim().toLowerCase();
    const list = (data.Contacts || []).filter(c => c.ContactStatus !== 'ARCHIVED');
    const exact = list.filter(c => norm(c.Name) === norm(name));
    if (exact.length === 1) return exact[0].ContactID;
    if (exact.length > 1) throw new Error(`More than one Xero contact is named "${name}"`);
    if (list.length === 1) return list[0].ContactID;
    if (list.length > 1) throw new Error(`Several Xero contacts match "${name}" (${list.slice(0, 5).map(c => c.Name).join(', ')}) — set the exact name in Document settings → Xero`);
    const created = await xeroFetch(token, 'Contacts', { method: 'POST', body: JSON.stringify({ Contacts: [{ Name: name }] }) });
    const id = created.Contacts?.[0]?.ContactID;
    if (!id) throw new Error('Xero did not return the new contact');
    return id;
}

async function refresh(env, params, who) {
    const rec = await loadRecord(env, params.id);
    const keys = Object.keys(rec.xero || {}).filter(k => rec.xero[k]?.invoiceId);
    if (!keys.length) return;
    const token = await getValidToken(env);
    const now = new Date().toISOString();
    const notes = [];
    for (const k of keys) {
        const data = await xeroFetch(token, `Invoices/${encodeURIComponent(rec.xero[k].invoiceId)}?unitdp=4`);
        const inv = data.Invoices?.[0];
        if (!inv) continue;
        const prev = rec.xero[k];
        const next = { ...prev, ...xeroState(inv), refreshedAt: now };
        if (prev.status !== next.status) notes.push(`${XERO_DOCS[k]?.label || k} now ${STATUS_WORDS[next.status] || next.status} in Xero${next.nzdPaid ? ` (NZD ${fmtMoney(next.nzdPaid)} paid)` : ''}`);
        rec.xero[k] = next;
    }
    rec.xeroRefreshedAt = now;
    await saveRecord(env, rec, who, notes.join('; ') || null);
}

export async function onRequestPost({ env, params, request }) {
    try {
        const body = await request.json().catch(() => ({}));
        const who = whoami(request);

        if (body.refresh) {
            await refresh(env, params, who);
            return jsonResponse(await buildView(env, params.id));
        }

        if (!XERO_DOCS[body.doc]) return errResponse('doc must be supplierBill, salesInvoice or jpsBill', 400);
        const view = await buildView(env, params.id);
        const d = view.xero.docs.find(x => x.key === body.doc);
        if (d.inXero) return errResponse(`${d.label} is already in Xero (${STATUS_WORDS[d.pushed.status] || d.pushed.status}). Void it in Xero and refresh to create it again.`, 409);
        if (d.issues.length) return jsonResponse({ error: d.issues.join('; '), issues: d.issues }, 422);

        const settings = await loadSettings(env);
        const token = await getValidToken(env);
        const contactId = await findOrCreateContact(token, d.contactName);
        const payload = xeroPayload(d, contactId, settings.xero?.status);
        const data = await xeroFetch(token, 'Invoices?unitdp=4', { method: 'POST', body: JSON.stringify({ Invoices: [payload] }) });
        const inv = data.Invoices?.[0];
        if (!inv?.InvoiceID || inv.HasErrors) {
            const msg = (inv?.ValidationErrors || []).map(e => e.Message).join('; ');
            return errResponse('Xero did not create the invoice' + (msg ? ': ' + msg : ''), 502);
        }

        const rec = await loadRecord(env, params.id);
        const st = xeroState(inv);
        rec.xero = { ...(rec.xero || {}), [d.key]: { ...st, type: d.type, contactName: d.contactName, pushedAt: new Date().toISOString(), by: who } };
        await saveRecord(env, rec, who, `Created the ${d.label} in Xero (${STATUS_WORDS[st.status] || st.status}): ${st.currency || d.currency} ${fmtMoney(st.total ?? d.total)}`);
        return jsonResponse(await buildView(env, params.id));
    } catch (e) {
        if (e instanceof XeroAuthError) return errResponse(e.message + ' — reconnect Xero from the dashboard', 401);
        if (e.status) return errResponse(e.message, 502);
        return viewError(e);
    }
}
