// POST /api/import/export-docs/:shipmentId/xero — stage-1 invoices in Xero.
//   { doc: 'supplierBill' | 'salesInvoice' | 'jpsBill' }  create that invoice
//       (status from Document settings → Xero, Draft by default)
//   { refresh: true }  re-read every created invoice: status, payments, NZD paid
// Only ever on a click. Amounts come from the confirmed bales, our export
// invoice and the checked JPS invoice (see ../../_shipxero.js).
//
// With Document settings → Xero → currency "NZD" (the default: this Xero has
// no multi-currency) EUR / USD documents go in as NZD at the day's rate from
// the Hub's forex feed; the original amount and rate are kept on each line
// and in record.xero[doc].fx.
//
// Every failure is recorded on the shipment (record.xeroErrors[doc], shown
// under the invoice in section 6 until an attempt succeeds), in its activity
// log and in the Functions log: what Xero said, what was sent, how far it got.

import { getValidToken, xeroHeaders, jsonResponse, errResponse, XeroAuthError } from '../../../_xero.js';
import { buildView, loadRecord, saveRecord, loadSettings, whoami, viewError, NotFound } from '../_store.js';
import { XERO_DOCS, xeroPayload, xeroState, xeroErrorDetails, xeroValidationMessage, xeroSentSummary, convertDocToNzd } from '../../_shipxero.js';
import { fmtMoney } from '../../_exportdocs.js';
import { loadForex } from '../../_cost.js';
import { nzToday } from '../../../_dates.js';

const API = 'https://api.xero.com/api.xro/2.0/';
const STATUS_WORDS = { DRAFT: 'draft', SUBMITTED: 'awaiting approval', AUTHORISED: 'awaiting payment', PAID: 'paid', VOIDED: 'voided', DELETED: 'deleted' };
const STEP_WORDS = { check: 'checking the invoice', rate: 'getting the exchange rate', auth: 'signing in to Xero', contact: 'finding the contact', create: 'creating the invoice', refresh: 'reading back from Xero' };

class XeroRefused extends Error {}

// A refused request keeps Xero's HTTP status, every validation message and
// the start of the raw reply.
async function xeroFetch(token, path, opts = {}) {
    const request = `${opts.method || 'GET'} ${path.split('?')[0]}`;
    let res;
    try {
        res = await fetch(API + path, { ...opts, headers: { ...xeroHeaders(token), ...(opts.headers || {}) } });
    } catch (err) {
        const e = new XeroRefused(`Could not reach Xero: ${err.message || err}`);
        Object.assign(e, { status: 0, request, details: [] });
        throw e;
    }
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) {
        const e = new XeroRefused(`Xero ${res.status}: ${xeroValidationMessage(body) || res.statusText || text.slice(0, 200) || 'no reason given'}`);
        Object.assign(e, { status: res.status, request, details: xeroErrorDetails(body), response: text.slice(0, 3000) });
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
    if (exact.length > 1) throw new Error(`More than one Xero contact is named "${name}" — merge or archive one in Xero`);
    if (list.length === 1) return list[0].ContactID;
    if (list.length > 1) throw new Error(`Several Xero contacts match "${name}" (${list.slice(0, 5).map(c => c.Name).join(', ')}) — set the exact name in Document settings → Xero`);
    const created = await xeroFetch(token, 'Contacts', { method: 'POST', body: JSON.stringify({ Contacts: [{ Name: name }] }) });
    const id = created.Contacts?.[0]?.ContactID;
    if (!id) throw new Error('Xero did not return the new contact');
    return id;
}

async function refresh(env, params, who, ctx) {
    const rec = await loadRecord(env, params.id);
    const keys = Object.keys(rec.xero || {}).filter(k => rec.xero[k]?.invoiceId);
    if (!keys.length) return;
    ctx.step = 'auth';
    const token = await getValidToken(env);
    ctx.step = 'refresh';
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
    if (rec.xeroErrors?.refresh) delete rec.xeroErrors.refresh;
    await saveRecord(env, rec, who, notes.join('; ') || null);
}

// Record the failure on the shipment, log it, and answer the page.
async function fail(env, shipmentId, key, e, who, ctx) {
    if (e instanceof NotFound) return viewError(e);
    const auth = e instanceof XeroAuthError;
    const message = auth ? `${e.message.replace(/\s*—\s*reconnect Xero at \/api\/xero\/auth$/, '')} — reconnect Xero in Settings → Integrations` : (e.message || String(e));
    const entry = {
        at: new Date().toISOString(), by: who, step: auth ? 'auth' : ctx.step, message,
        details: e.details || ctx.issues || [], xeroStatus: e.status ?? null, request: e.request || null,
        response: e.response || null, sent: ctx.sent || null,
    };
    const label = key === 'refresh' ? 'Refresh from Xero' : (XERO_DOCS[key]?.label || key);
    console.error(JSON.stringify({ event: 'shipdocs_xero_failed', shipmentId, doc: key, ...entry, response: entry.response?.slice(0, 1000) }));
    try {
        const rec = await loadRecord(env, shipmentId);
        rec.xeroErrors = { ...(rec.xeroErrors || {}), [key]: entry };
        await saveRecord(env, rec, who, key === 'refresh'
            ? `Refresh from Xero failed (${STEP_WORDS[entry.step] || entry.step}): ${message}`
            : `${label} not created in Xero (${STEP_WORDS[entry.step] || entry.step}): ${message}`);
    } catch (logErr) {
        console.error('shipdocs: could not record the Xero failure', logErr);
    }
    const status = auth ? 401 : ctx.issues ? 422 : e instanceof XeroRefused ? 502 : 500;
    return jsonResponse({ error: message, xeroError: entry, ...(ctx.issues && { issues: ctx.issues }) }, status);
}

export async function onRequestPost({ env, params, request }) {
    const body = await request.json().catch(() => ({}));
    const who = whoami(request);
    const ctx = { step: 'check', sent: null, issues: null };

    if (body.refresh) {
        try {
            await refresh(env, params, who, ctx);
            return jsonResponse(await buildView(env, params.id));
        } catch (e) {
            return fail(env, params.id, 'refresh', e, who, ctx);
        }
    }

    if (!XERO_DOCS[body.doc]) return errResponse('doc must be supplierBill, salesInvoice or jpsBill', 400);
    try {
        const view = await buildView(env, params.id);
        const d = view.xero.docs.find(x => x.key === body.doc);
        if (d.inXero) return errResponse(`${d.label} is already in Xero (${STATUS_WORDS[d.pushed.status] || d.pushed.status}). Void it in Xero and refresh to create it again.`, 409);
        if (d.issues.length) {
            ctx.issues = d.issues;
            throw new Error(d.issues.join('; '));
        }

        const settings = await loadSettings(env);
        let doc = d, fx = null;
        if ((settings.xero?.currencyMode || 'nzd') === 'nzd' && d.currency && d.currency !== 'NZD') {
            ctx.step = 'rate';
            const rates = await loadForex(env);
            ({ doc, fx } = convertDocToNzd(d, rates?.[d.currency], nzToday()));
        }
        ctx.step = 'auth';
        const token = await getValidToken(env);
        ctx.step = 'contact';
        const contactId = await findOrCreateContact(token, d.contactName);
        const payload = xeroPayload(doc, contactId, settings.xero?.status);
        ctx.sent = xeroSentSummary(payload, d.contactName);
        ctx.step = 'create';
        const data = await xeroFetch(token, 'Invoices?unitdp=4', { method: 'POST', body: JSON.stringify({ Invoices: [payload] }) });
        const inv = data.Invoices?.[0];
        if (!inv?.InvoiceID || inv.HasErrors) {
            const details = xeroErrorDetails({ Elements: inv ? [inv] : [] });
            const e = new XeroRefused('Xero did not create the invoice' + (details.length ? ': ' + details.join('; ') : ''));
            Object.assign(e, { status: 200, request: 'POST Invoices', details, response: JSON.stringify(data).slice(0, 3000) });
            throw e;
        }

        const rec = await loadRecord(env, params.id);
        const st = xeroState(inv);
        rec.xero = { ...(rec.xero || {}), [d.key]: { ...st, type: d.type, contactName: d.contactName, pushedAt: new Date().toISOString(), by: who, ...(fx && { fx }) } };
        if (rec.xeroErrors?.[d.key]) delete rec.xeroErrors[d.key];
        await saveRecord(env, rec, who, `Created the ${d.label} in Xero (${STATUS_WORDS[st.status] || st.status}): ${st.currency || doc.currency} ${fmtMoney(st.total ?? doc.total)}`
            + (fx ? ` (${fx.currency} ${fmtMoney(fx.foreignTotal)} @ 1 NZD = ${fx.rate.toFixed(4)} ${fx.currency})` : ''));
        return jsonResponse(await buildView(env, params.id));
    } catch (e) {
        return fail(env, params.id, body.doc, e, who, ctx);
    }
}
