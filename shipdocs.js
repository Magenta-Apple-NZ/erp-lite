// ── Shipment export documents ──
// The first stage of a shipment: Pistoni's packing list + proforma → review
// the bales → confirm → Enviroware's draft packing list and proforma invoice
// → LC details → final packing list. Mounted as the "Export documents" tab
// of a shipment in Imports (warehouse.js). Server: /api/import/export-docs/*.
// Nothing here emails anything or writes to Drive: sharing stays manual.

const ShipDocs = (() => {
    const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const toast = msg => (typeof showToast === 'function' ? showToast(msg) : console.log(msg));
    const base = id => `/api/import/export-docs/${encodeURIComponent(id)}`;

    async function api(path, opts = {}) {
        const res = await fetch(path, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { const e = new Error(body.error || body.extractError || res.statusText); e.body = body; e.status = res.status; throw e; }
        return body;
    }
    const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const fmtKg = n => (Number(n) || 0).toLocaleString('en-NZ', { maximumFractionDigits: 3 });
    const fmtMoney = n => (Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtRate = n => (Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    const amountOf = (kg, rate) => Math.round((Number(kg) || 0) * Math.round((Number(rate) || 0) * 10000) / 100) / 100;
    const when = iso => iso ? new Date(iso).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    const who = e => String(e || '').split('@')[0];
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const longDate = ymd => { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return ''; const d = Number(m[3]); const t = d % 100; const suf = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th'); return `${d}${suf} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`; };
    const num = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);

    // Editing a supplier figure by hand drops the "as printed" string the
    // model read, so the printed-number check doesn't compare stale text.
    const RAW_OF = { whiteTotalKg: 'whiteTotalRaw', colouredTotalKg: 'colouredTotalRaw', packages: 'packagesRaw', netKg: 'netKgRaw', total: 'totalRaw', kg: 'kgRaw', unitPrice: 'unitPriceRaw', amount: 'amountRaw' };

    // ── Panel ────────────────────────────────────────────────────────────
    // opts.applyShipPatch(patch) → Promise: write weights, cost-line rates,
    // actuals and paid flags to the shipment through the Imports view's own
    // save (V3 shipments only; null otherwise).
    function renderPanel(panel, ship, opts = {}) {
        const st = { panel, ship, opts, view: null, review: null, jps: null, saveTimer: null, jpsTimer: null };
        panel.innerHTML = '<div class="ship-lc-loading">Loading export documents…</div>';
        wireOnce(st);
        load(st);
        return { reload: () => load(st) };
    }

    async function load(st) {
        try {
            setView(st, await api(base(st.ship.id)));
            draw(st);
        } catch (e) {
            st.panel.innerHTML = `<p class="ship-lc-err">Could not load export documents: ${esc(e.message)}</p>`;
        }
    }

    function setView(st, view) {
        st.view = view;
        st.review = structuredClone(view.record.review || { shipmentNumber: null, bales: [], packing: {}, supplierInvoice: null });
        st.review.packing = st.review.packing || {};
        st.jps = view.record.jps ? structuredClone(view.record.jps) : null;
    }

    const $ = (st, sel) => st.panel.querySelector(sel);

    function draw(st) {
        const v = st.view;
        st.panel.innerHTML = `
        <div class="sd">
            ${stepsHtml(v)}
            ${settingsBannerHtml(v)}
            <section class="ship-det-section">
                <div class="ship-det-hd"><h3 class="ship-det-title">1 · Supplier documents</h3>
                    <span class="sd-muted">From Pistoni — read by AI, checked by you</span></div>
                <div class="sd-uploads">
                    ${uploadCardHtml(v, 'packingList', 'Supplier packing list', 'The PACKING LIST TOECLIPS sheet with the WHITE and COLORED tables')}
                    ${uploadCardHtml(v, 'proforma', 'Supplier proforma invoice', 'Pistoni\'s proforma addressed to Enviroware')}
                </div>
            </section>
            <section class="ship-det-section" id="sd-review">${reviewHtml(st)}</section>
            <section class="ship-det-section" id="sd-invoice">${invoiceHtml(st)}</section>
            <section class="ship-det-section" id="sd-docs">${docsHtml(st)}</section>
            <section class="ship-det-section" id="sd-jps">${jpsHtml(st)}</section>
            <section class="ship-det-section" id="sd-xero">${xeroHtml(st)}</section>
            ${v.costPlanApplies ? `<section class="ship-det-section" id="sd-cost">${costHtml(st)}</section>` : ''}
            <section class="ship-det-section" id="sd-final">${finalHtml(st)}</section>
            ${historyHtml(st)}
        </div>`;
        wire(st);
    }

    function stepsHtml(v) {
        const r = v.record, outs = r.outputs || [];
        const has = (doc, stage) => outs.some(o => o.doc === doc && o.stage === stage);
        const steps = [
            ['Supplier documents', !!(r.files?.packingList && r.files?.proforma)],
            ['Bales confirmed', !!r.confirmed],
            ['Draft documents', has('packing', 'draft') && has('proforma', 'draft')],
            ['JPS invoice', !!(r.jps && Number(r.jps.total) > 0 && !(v.jpsChecks || []).some(c => c.level === 'block' && c.ok === false))],
            ['In Xero', (v.xero?.docs || []).every(d => d.inXero)],
            ['LC details', v.status === 'lc_issued' || v.status === 'final'],
            ['Final packing list', has('packing', 'final')],
        ];
        return `<div class="sd-top">
            <div class="sd-steps">${steps.map(([l, done], i) => `<span class="sd-step${done ? ' sd-step--done' : ''}"><span class="sd-step-n">${done ? '✓' : i + 1}</span>${esc(l)}</span>`).join('<span class="sd-step-sep"></span>')}</div>
            <div class="sd-top-right"><span class="sd-chip sd-chip--${esc(v.status)}">${esc(v.statusLabel)}</span>
            <button class="btn-link" data-act="settings">Document settings</button></div>
        </div>`;
    }

    function settingsBannerHtml(v) {
        const st = v.settingsStatus;
        const miss = [...new Set([...(st.missingPacking || []), ...(st.missingProforma || [])])];
        if (!miss.length) return '';
        return `<div class="sd-banner sd-banner--warn">
            <strong>Still needed before the documents can be generated: ${esc(miss.join(', '))}.</strong>
            <button class="btn-secondary btn-sm" data-act="settings">Open document settings</button>
        </div>`;
    }

    function uploadCardHtml(v, kind, title, hint) {
        const f = v.record.files?.[kind];
        const x = v.record.extractions?.[kind];
        const ok = x && !x.error && x.fileKey === f?.key;
        const summary = !ok ? '' : kind === 'packingList'
            ? `${(x.result?.bales || []).length} bales read${x.result?.shipmentNumber != null ? ` · shipment ${esc(x.result.shipmentNumber)}` : ''}`
            : kind === 'jpsInvoice'
                ? `Invoice ${esc(x.result?.invoiceNumber || '?')} · ${esc(x.result?.currency || '')} ${fmtMoney(x.result?.total)}`
                : `Document ${esc(x.result?.documentNumber || '?')} · ${esc(x.result?.currency || '')} ${fmtMoney(x.result?.total)}`;
        return `<label class="sd-upload" data-kind="${kind}">
            <input type="file" accept="application/pdf" hidden data-upload="${kind}">
            <div class="sd-upload-title">${esc(title)}</div>
            ${f ? `<div class="sd-upload-file">📄 <a href="${base(v.shipment.id)}/file?key=${encodeURIComponent(f.key)}" target="_blank" rel="noopener" data-stop>${esc(f.filename)}</a></div>
                   <div class="sd-muted">${esc(when(f.uploadedAt))} · ${esc(who(f.by))}</div>
                   ${ok ? `<div class="sd-ok">✓ ${summary}</div>` : ''}
                   ${x?.error && x.fileKey === f.key ? `<div class="sd-err">✗ ${esc(x.error)} — try again or enter the figures by hand below</div>` : ''}
                   <span class="btn-link sd-upload-cta">Replace PDF</span>`
                : `<div class="sd-muted">${esc(hint)}</div><span class="btn-secondary btn-sm sd-upload-cta">Choose PDF</span><div class="sd-muted sd-drop-hint">or drop it here</div>`}
            <div class="sd-upload-busy" hidden>Reading with AI… this can take up to a minute</div>
        </label>`;
    }

    // ── Review ───────────────────────────────────────────────────────────
    function checkListHtml(list, extraClass = '') {
        const icon = c => c.ok === true ? '✓' : c.ok === false ? (c.level === 'block' ? '✗' : '!') : '–';
        const cls = c => c.ok === true ? 'ok' : c.ok === false ? (c.level === 'block' ? 'fail' : 'warn') : 'na';
        return `<ul class="sd-checks ${extraClass}">${list.map(c => `
            <li class="sd-check sd-check--${cls(c)}"><span class="sd-check-i">${icon(c)}</span>
            <span><strong>${esc(c.title)}</strong>${c.level === 'block' ? '' : ' <span class="sd-muted">(warning)</span>'}<br><span class="sd-check-d">${esc(c.detail)}</span></span></li>`).join('')}</ul>`;
    }

    function checksHtml(st) {
        const r = st.review;
        const p = r.packing || {};
        const started = (r.bales || []).length || r.supplierInvoice || p.whiteTotalKg != null || p.colouredTotalKg != null || p.packages != null;
        if (!started) return '<p class="sd-muted">The checks run once there is something to check: upload Pistoni\'s two PDFs above, or enter the bales and supplier figures below.</p>';
        return checkListHtml(st.view.checks.filter(c => !['rate-confirmed', 'number-confirmed'].includes(c.id)));
    }

    function totalsLine(t) {
        if (!t || !t.count) return 'No bales yet';
        return `${t.count} bales · white ${fmtKg(t.whiteKg)} kg (${t.whiteCount}) · coloured ${fmtKg(t.colouredKg)} kg (${t.colouredCount}) · <strong>net ${fmtKg(t.netKg)} kg</strong>`;
    }

    function reviewHtml(st) {
        const v = st.view, r = st.review, p = r.packing || {};
        const rawHint = raw => raw ? `<span class="sd-raw" title="As printed on the supplier document">printed “${esc(raw)}”</span>` : '';
        const field = (label, path, val, raw, attrs = '') => `<label class="sd-field"><span class="imp-field-label">${esc(label)}</span>
            <input class="sd-input" data-path="${path}" value="${val ?? ''}" ${attrs}>${rawHint(raw)}</label>`;
        return `
            <div class="ship-det-hd"><h3 class="ship-det-title">2 · Review bales and supplier figures</h3>
                <span class="sd-muted" id="sd-savestate"></span></div>
            <div id="sd-checks">${checksHtml(st)}</div>
            <h4 class="sd-h4">Supplier packing list</h4>
            <div class="sd-grid4">
                ${field('Shipment no. (as printed)', 'shipmentNumber', r.shipmentNumber, null, 'type="number" step="1"')}
                ${field('White total kg', 'packing.whiteTotalKg', p.whiteTotalKg, p.whiteTotalRaw, 'type="number" step="any"')}
                ${field('Coloured total kg', 'packing.colouredTotalKg', p.colouredTotalKg, p.colouredTotalRaw, 'type="number" step="any"')}
                ${field('Packages', 'packing.packages', p.packages, p.packagesRaw, 'type="number" step="1"')}
            </div>
            <div class="sd-bales-hd">
                <h4 class="sd-h4">Bales <span class="sd-muted" id="sd-bale-totals">${totalsLine(v.reviewTotals)}</span></h4>
                <span><button class="btn-link" data-act="add-bale">+ Add bale</button> · <button class="btn-link" data-act="paste-bales">Paste bales…</button></span>
            </div>
            <div class="sd-paste" hidden>
                <textarea class="sd-paste-ta" rows="6" placeholder="One bale per line: number, kg, colour — e.g.&#10;1, 442, white&#10;2, 495, coloured"></textarea>
                <div><button class="btn-secondary btn-sm" data-act="paste-apply">Replace bales with these</button> <button class="btn-link" data-act="paste-cancel">Cancel</button></div>
            </div>
            <div class="sd-bales" id="sd-bales">${balesHtml(st)}</div>
            <h4 class="sd-h4">Supplier proforma <span class="sd-internal">Internal — never printed on Enviroware's documents</span></h4>
            ${supplierInvoiceHtml(st)}
            <div id="sd-confirm">${confirmHtml(st)}</div>`;
    }

    function balesHtml(st) {
        const { min, max } = st.view.baleRange || { min: 150, max: 650 };
        const bales = st.review.bales || [];
        if (!bales.length) return '<p class="sd-muted">Upload the supplier packing list, or add / paste bales by hand.</p>';
        return bales.map((b, i) => {
            const odd = b.kg != null && (b.kg < min || b.kg > max);
            return `<div class="sd-bale sd-bale--${b.colour || 'none'}${odd ? ' sd-bale--odd' : ''}" title="${odd ? 'Outside ' + min + '–' + max + ' kg — check for a misread' : ''}">
                <input class="sd-bale-n" data-path="bales.${i}.n" type="number" step="1" value="${b.n ?? ''}" aria-label="Bale number">
                <input class="sd-bale-kg" data-path="bales.${i}.kg" type="number" step="any" value="${b.kg ?? ''}" aria-label="Net kg">
                <select class="sd-bale-c" data-path="bales.${i}.colour" aria-label="Colour">
                    <option value="" ${!b.colour ? 'selected' : ''}>?</option>
                    <option value="white" ${b.colour === 'white' ? 'selected' : ''}>White</option>
                    <option value="coloured" ${b.colour === 'coloured' ? 'selected' : ''}>Coloured</option>
                </select>
                <button class="sd-bale-x" data-act="del-bale" data-i="${i}" title="Remove bale">×</button>
            </div>`;
        }).join('');
    }

    function supplierInvoiceHtml(st) {
        const inv = st.review.supplierInvoice;
        if (!inv) return `<p class="sd-muted">Upload the supplier proforma, or <button class="btn-link" data-act="manual-invoice">enter its figures by hand</button>.</p>`;
        const raw = r => r ? `<span class="sd-raw">“${esc(r)}”</span>` : '';
        return `<div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">Document no.</span><input class="sd-input" data-path="supplierInvoice.number" value="${esc(inv.number)}"></label>
                <label class="sd-field"><span class="imp-field-label">Date</span><input class="sd-input" type="date" data-path="supplierInvoice.date" value="${esc(inv.date)}">${raw(inv.dateRaw)}</label>
                <label class="sd-field"><span class="imp-field-label">Currency</span><input class="sd-input" data-path="supplierInvoice.currency" value="${esc(inv.currency)}" maxlength="3"></label>
                <label class="sd-field"><span class="imp-field-label">Net weight kg</span><input class="sd-input" type="number" step="any" data-path="supplierInvoice.netKg" value="${inv.netKg ?? ''}">${raw(inv.netKgRaw)}</label>
            </div>
            <table class="sd-lines">
                <thead><tr><th>Line</th><th>Colour</th><th class="r">kg</th><th class="r">Unit price</th><th class="r">Amount</th><th></th></tr></thead>
                <tbody>${(inv.lines || []).map((l, i) => `<tr>
                    <td><input class="sd-input" data-path="supplierInvoice.lines.${i}.description" value="${esc(l.description)}"></td>
                    <td><select class="sd-input" data-path="supplierInvoice.lines.${i}.colour">
                        <option value="" ${!l.colour ? 'selected' : ''}>—</option><option value="white" ${l.colour === 'white' ? 'selected' : ''}>White</option><option value="coloured" ${l.colour === 'coloured' ? 'selected' : ''}>Coloured</option></select></td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-path="supplierInvoice.lines.${i}.kg" value="${l.kg ?? ''}">${raw(l.kgRaw)}</td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-path="supplierInvoice.lines.${i}.unitPrice" value="${l.unitPrice ?? ''}">${raw(l.unitPriceRaw)}</td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-path="supplierInvoice.lines.${i}.amount" value="${l.amount ?? ''}">${raw(l.amountRaw)}</td>
                    <td><button class="sd-bale-x" data-act="del-line" data-i="${i}" title="Remove line">×</button></td></tr>`).join('')}
                </tbody>
                <tfoot><tr><td colspan="4" class="r"><button class="btn-link" data-act="add-line">+ Add line</button> &nbsp; <strong>Total</strong></td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-path="supplierInvoice.total" value="${inv.total ?? ''}">${raw(inv.totalRaw)}</td><td></td></tr></tfoot>
            </table>
            ${inv.destination || inv.deliveryTerms ? `<p class="sd-muted">Destination: ${esc(inv.destination || '—')} · Terms: ${esc(inv.deliveryTerms || '—')}${inv.hsCode ? ' · HS ' + esc(inv.hsCode) : ''}</p>` : ''}`;
    }

    function confirmHtml(st) {
        const v = st.view;
        const fails = v.checks.filter(c => c.level === 'block' && c.ok === false);
        const c = v.record.confirmed;
        const t = v.reviewTotals;
        const s = v.shipment;
        const weightsDiffer = st.opts.applyShipPatch && t.count && (Math.round(s.whiteRawKg) !== Math.round(t.whiteKg) || Math.round(s.colourRawKg) !== Math.round(t.colouredKg));
        if (c && !v.unconfirmedChanges) {
            return `<div class="sd-confirmed">✓ Confirmed ${esc(when(c.confirmedAt))} by ${esc(who(c.confirmedBy))} — ${totalsLine(v.confirmedTotals)}
                ${weightsDiffer ? `<div class="sd-muted">This shipment's Net Weight Breakdown still shows white ${fmtKg(s.whiteRawKg)} / coloured ${fmtKg(s.colourRawKg)} kg. <button class="btn-link" data-act="apply-weights">Update it to ${fmtKg(t.whiteKg)} / ${fmtKg(t.colouredKg)} kg</button></div>` : ''}</div>`;
        }
        return `<div class="sd-confirm-bar">
            ${c ? '<div class="sd-warn-text">You have changes since the last confirm. Documents use the confirmed figures until you confirm again.</div>' : ''}
            ${weightsDiffer ? `<label class="sd-check-line"><input type="checkbox" id="sd-apply-weights" checked>
                Also update this shipment's Net Weight Breakdown: white ${fmtKg(s.whiteRawKg)} → <strong>${fmtKg(t.whiteKg)}</strong> kg, coloured ${fmtKg(s.colourRawKg)} → <strong>${fmtKg(t.colouredKg)}</strong> kg</label>` : ''}
            <button class="btn-primary" data-act="confirm" ${fails.length || !t.count ? 'disabled' : ''}>Confirm ${t.count || ''} bales</button>
            ${fails.length ? `<span class="sd-err">Fix ${fails.length} failing check${fails.length > 1 ? 's' : ''} first</span>` : ''}
        </div>`;
    }

    // ── Export invoice ───────────────────────────────────────────────────
    function invoiceHtml(st) {
        const v = st.view, ei = v.record.exportInvoice, d = v.defaults, t = v.confirmedTotals;
        if (!v.record.confirmed) return `<div class="ship-det-hd"><h3 class="ship-det-title">3 · Export invoice</h3></div><p class="sd-muted">Confirm the bales first.</p>`;
        return `<div class="ship-det-hd"><h3 class="ship-det-title">3 · Export invoice to JPS</h3></div>
            <div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">Invoice no.</span><input class="sd-input" id="sd-ei-number" value="${esc(ei.number)}">
                    <span class="sd-muted">Suggested ${esc(d.number)} (previous + 1)</span></label>
                <label class="sd-field"><span class="imp-field-label">Document date</span><input class="sd-input" type="date" id="sd-ei-date" value="${esc(ei.date)}">
                    <span class="sd-muted">${esc(longDate(ei.date))} · both documents</span></label>
                <label class="sd-field"><span class="imp-field-label">Rate (${esc(ei.currency)}/kg)</span><input class="sd-input" type="number" step="0.0001" id="sd-ei-rate" value="${ei.rate ?? ''}">
                    <span class="sd-muted">Default ${fmtRate(d.rate)} from ${esc(d.rateSource)}</span></label>
                <div class="sd-field"><span class="imp-field-label">Amount</span>
                    <div class="sd-amount" id="sd-ei-amount">${fmtKg(t.netKg)} kg × ${esc(ei.currency)} ${fmtRate(ei.rate)} = <strong>${esc(ei.currency)} ${fmtMoney(amountOf(t.netKg, ei.rate))}</strong></div></div>
            </div>
            <div class="sd-ticks">
                <label class="sd-check-line ${ei.numberConfirmed ? '' : 'sd-unconfirmed'}"><input type="checkbox" id="sd-ei-numok" ${ei.numberConfirmed ? 'checked' : ''}> Invoice number ${esc(ei.number)} is right${ei.numberConfirmed ? '' : ' <em>(not yet confirmed)</em>'}</label>
                <label class="sd-check-line ${ei.rateConfirmed ? '' : 'sd-unconfirmed'}"><input type="checkbox" id="sd-ei-rateok" ${ei.rateConfirmed ? 'checked' : ''}> Export rate ${esc(ei.currency)} ${fmtRate(ei.rate)}/kg is right for this shipment${ei.rateConfirmed ? '' : ' <em>(not yet confirmed)</em>'}</label>
            </div>`;
    }

    // ── Draft documents ──────────────────────────────────────────────────
    function issuesHtml(list) {
        return list.length ? `<ul class="sd-issues">${list.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<div class="sd-ok">✓ Ready to generate</div>';
    }
    function docsHtml(st) {
        const v = st.view, g = v.generation, b = base(v.shipment.id);
        if (!v.record.confirmed) return `<div class="ship-det-hd"><h3 class="ship-det-title">4 · Draft documents</h3></div><p class="sd-muted">Confirm the bales first.</p>`;
        const ready = !g.packingDraft.length && !g.proforma.length;
        return `<div class="ship-det-hd"><h3 class="ship-det-title">4 · Draft documents for Paul</h3></div>
            <div class="sd-docrow"><div><strong>Draft packing list</strong>${issuesHtml(g.packingDraft)}</div>
                <div class="sd-docrow-act"><a class="btn-secondary btn-sm" href="${b}/render?doc=packing&stage=draft" target="_blank" rel="noopener">Preview</a>
                <a class="btn-secondary btn-sm" href="${b}/xlsx">.xlsx</a></div></div>
            <div class="sd-docrow"><div><strong>Proforma invoice</strong>${issuesHtml(g.proforma)}</div>
                <div class="sd-docrow-act"><a class="btn-secondary btn-sm" href="${b}/render?doc=proforma" target="_blank" rel="noopener">Preview</a></div></div>
            <div class="sd-gen"><button class="btn-primary" data-act="gen-draft" ${ready ? '' : 'disabled'}>Generate draft documents</button>
                <span class="sd-muted">Keeps a fixed copy of each. Open one, then Print → Save as PDF to share. Nothing is emailed or put in Drive.</span></div>`;
    }

    // ── LC details and final ─────────────────────────────────────────────
    function finalHtml(st) {
        const v = st.view, lc = v.record.lc || {}, g = v.generation, b = base(v.shipment.id), L = v.linkedLc;
        if (!v.record.confirmed) return `<div class="ship-det-hd"><h3 class="ship-det-title">7 · LC details and final packing list</h3></div><p class="sd-muted">After the draft documents have gone to Paul and JPS has opened the LC.</p>`;
        const useLc = L && (L.lcNumber !== lc.number || (L.issuedDate && L.issuedDate !== lc.date));
        return `<div class="ship-det-hd"><h3 class="ship-det-title">7 · LC details and final packing list</h3></div>
            ${L ? `<p class="sd-muted">Linked LC on the Letter of Credit tab: <strong>${esc(L.lcNumber)}</strong>${L.issuedDate ? `, issued ${esc(longDate(L.issuedDate))}` : ''}${useLc ? ` · <button class="btn-link" data-act="use-lc">Use these</button>` : ''}</p>` : '<p class="sd-muted">No LC is linked to this shipment yet (Letter of Credit tab). You can still enter the details here.</p>'}
            <div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">LC no.</span><input class="sd-input" id="sd-lc-number" value="${esc(lc.number || '')}"></label>
                <label class="sd-field"><span class="imp-field-label">LC date of issue</span><input class="sd-input" type="date" id="sd-lc-date" value="${esc(lc.date || '')}"></label>
                <label class="sd-field"><span class="imp-field-label">Gross weight kg</span><input class="sd-input" type="number" step="any" id="sd-lc-gross" value="${lc.grossKg ?? ''}">
                    <span class="sd-muted">Net is ${fmtKg(v.confirmedTotals.netKg)} kg</span></label>
                <div class="sd-field sd-field--btn"><button class="btn-secondary btn-sm" data-act="save-lc">Save LC details</button></div>
            </div>
            ${v.lcChecks.length ? `<ul class="sd-checks sd-checks--compact">${v.lcChecks.map(c => `<li class="sd-check sd-check--${c.ok ? 'ok' : 'warn'}"><span class="sd-check-i">${c.ok ? '✓' : '!'}</span><span><strong>${esc(c.title)}</strong><br><span class="sd-check-d">${esc(c.detail)}</span></span></li>`).join('')}</ul>` : ''}
            <div class="sd-docrow"><div><strong>Final packing list</strong>${issuesHtml(g.packingFinal)}</div>
                <div class="sd-docrow-act"><a class="btn-secondary btn-sm" href="${b}/render?doc=packing&stage=final" target="_blank" rel="noopener">Preview</a>
                <a class="btn-secondary btn-sm" href="${b}/xlsx">.xlsx</a>
                <button class="btn-primary btn-sm" data-act="gen-final" ${g.packingFinal.length ? 'disabled' : ''}>Generate final</button></div></div>`;
    }

    // ── JPS invoice ──────────────────────────────────────────────────────
    function splitHtml(v) {
        const sp = v.jpsSplit, ei = v.record.exportInvoice || {};
        if (!sp) return '';
        return `<div class="sd-split">
            <div><strong>${esc(sp.currency)} ${fmtMoney(sp.total)}</strong> on the JPS invoice =</div>
            <div class="sd-split-row"><span>LC deposit</span><span>${esc(sp.currency)} ${fmtMoney(sp.depositAmount)}</span><span class="sd-muted">${fmtKg(sp.netKg)} kg × ${fmtRate(sp.depositRate)} — our invoice ${esc(ei.number || '')}; the LC pays this back</span></div>
            <div class="sd-split-row"><span>Handling &amp; sorting</span><span>${esc(sp.currency)} ${fmtMoney(sp.handlingAmount)}</span><span class="sd-muted">${esc(sp.currency)} ${fmtRate(sp.handlingRate)}/kg — JPS's margin, the real cost</span></div>
        </div>`;
    }

    function jpsHtml(st) {
        const v = st.view, j = st.jps;
        const hd = `<div class="ship-det-hd"><h3 class="ship-det-title">5 · JPS invoice</h3><span class="sd-muted">Paying it gets JPS to open the LC</span></div>`;
        if (!v.record.confirmed) return hd + '<p class="sd-muted">Confirm the bales first.</p>';
        const raw = r => r ? `<span class="sd-raw">“${esc(r)}”</span>` : '';
        const typical = v.jpsTypical?.rate != null ? `Usual handling & sorting: ${esc(v.record.exportInvoice?.currency || 'USD')} ${fmtRate(v.jpsTypical.rate)}/kg${v.jpsTypical.shipment ? ` (Shipment #${v.jpsTypical.shipment})` : ' (settings)'}` : '';
        return `${hd}
            <div class="sd-uploads sd-uploads--one">${uploadCardHtml(v, 'jpsInvoice', 'JPS invoice', "JPS Enterprise's invoice to Enviroware: our proforma amount plus handling & sorting")}</div>
            ${!j ? `<p class="sd-muted">Or <button class="btn-link" data-act="manual-jps">enter it by hand</button>. ${esc(typical)}</p>` : `
            <div class="sd-grid4" style="margin-top:0.75rem">
                <label class="sd-field"><span class="imp-field-label">Invoice no.</span><input class="sd-input" data-jps="number" value="${esc(j.number)}"></label>
                <label class="sd-field"><span class="imp-field-label">Date</span><input class="sd-input" type="date" data-jps="date" value="${esc(j.date)}">${raw(j.dateRaw)}</label>
                <label class="sd-field"><span class="imp-field-label">Currency</span><input class="sd-input" data-jps="currency" value="${esc(j.currency)}" maxlength="3"></label>
                <label class="sd-field"><span class="imp-field-label">Total</span><input class="sd-input sd-num" type="number" step="any" data-jps="total" value="${j.total ?? ''}">${raw(j.totalRaw)}</label>
            </div>
            ${(j.lines || []).length ? `<table class="sd-lines">
                <thead><tr><th>Line</th><th class="r">kg</th><th class="r">Unit price</th><th class="r">Amount</th><th></th></tr></thead>
                <tbody>${j.lines.map((l, i) => `<tr>
                    <td><input class="sd-input" data-jps="lines.${i}.description" value="${esc(l.description)}"></td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-jps="lines.${i}.kg" value="${l.kg ?? ''}">${raw(l.kgRaw)}</td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-jps="lines.${i}.unitPrice" value="${l.unitPrice ?? ''}">${raw(l.unitPriceRaw)}</td>
                    <td class="r"><input class="sd-input sd-num" type="number" step="any" data-jps="lines.${i}.amount" value="${l.amount ?? ''}">${raw(l.amountRaw)}</td>
                    <td><button class="sd-bale-x" data-act="jps-del-line" data-i="${i}" title="Remove line">×</button></td></tr>`).join('')}</tbody>
            </table>` : ''}
            <div class="sd-muted"><button class="btn-link" data-act="jps-add-line">+ Add line</button> <span id="sd-jps-savestate"></span></div>
            <div id="sd-jps-checks">${checkListHtml(v.jpsChecks || [], 'sd-checks--compact')}</div>
            <div id="sd-jps-split">${splitHtml(v)}</div>`}`;
    }

    // ── Xero ─────────────────────────────────────────────────────────────
    const XERO_WORDS = { DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', AUTHORISED: 'Awaiting payment', PAID: 'Paid', VOIDED: 'Voided', DELETED: 'Deleted' };
    function xeroHtml(st) {
        const v = st.view, docs = v.xero?.docs || [];
        const any = docs.some(d => d.inXero);
        const statusWord = XERO_WORDS[v.xero?.status] || 'Draft';
        return `<div class="ship-det-hd"><h3 class="ship-det-title">6 · Invoices in Xero</h3>
                ${any ? `<span><span class="sd-muted">${v.xero.refreshedAt ? 'Checked ' + esc(when(v.xero.refreshedAt)) : ''}</span> <button class="btn-link" data-act="xero-refresh">Refresh from Xero</button></span>` : ''}</div>
            <p class="sd-muted">Created as <strong>${esc(statusWord.toLowerCase())}</strong> when you click — approve and pay them in Xero; the Hub reads back what was paid in NZD.</p>
            <table class="sd-xero"><tbody>${docs.map(d => `<tr>
                <td><strong>${esc(d.label)}</strong><div class="sd-muted">${esc(d.contactName || '—')} · ${d.type === 'ACCREC' ? 'sales invoice' : 'bill'}</div></td>
                <td>${d.number ? esc(d.number) : '<span class="sd-muted">—</span>'}${d.date ? `<div class="sd-muted">${esc(longDate(d.date))}</div>` : ''}</td>
                <td class="r">${d.total != null ? `${esc(d.currency || '')} ${fmtMoney(d.total)}` : '<span class="sd-muted">—</span>'}</td>
                <td>${d.inXero
                    ? `<span class="sd-xs sd-xs--${esc((d.pushed.status || '').toLowerCase())}">${esc(XERO_WORDS[d.pushed.status] || d.pushed.status)}</span>
                       ${d.pushed.nzdPaid ? `<div class="sd-muted">NZD ${fmtMoney(d.pushed.nzdPaid)} paid${d.pushed.paidOn ? ' · ' + esc(longDate(d.pushed.paidOn)) : ''}</div>` : ''}
                       ${d.changedSincePush ? `<div class="sd-warn-text">Hub total now ${esc(d.currency)} ${fmtMoney(d.total)} — update it in Xero</div>` : ''}`
                    : (d.issues.length ? `<ul class="sd-issues">${d.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="sd-ok">Ready</span>')}</td>
                <td class="r">${d.inXero
                    ? `<a class="btn-link" href="${esc(d.url)}" target="_blank" rel="noopener">Open in Xero ↗</a>`
                    : `<button class="btn-secondary btn-sm" data-act="xero-push" data-doc="${esc(d.key)}" ${d.issues.length ? 'disabled' : ''}>Create in Xero</button>`}</td>
            </tr>`).join('')}</tbody></table>`;
    }

    // ── Cost breakdown ───────────────────────────────────────────────────
    function costHtml(st) {
        const plan = st.view.costPlan || { changes: [] };
        const hd = `<div class="ship-det-hd"><h3 class="ship-det-title">Cost breakdown</h3><span class="sd-muted">The shipment's Overview, filled from these documents</span></div>`;
        if (!st.view.record.confirmed) return hd + '<p class="sd-muted">Confirm the bales first.</p>';
        if (!plan.changes.length) return hd + '<div class="sd-ok">✓ The cost breakdown matches these documents and Xero.</div>';
        return `${hd}
            <table class="sd-xero"><tbody>${plan.changes.map(c => `<tr>
                <td><strong>${esc(c.label)}</strong><div class="sd-muted">from ${esc(c.source)}</div></td>
                <td class="sd-muted">${esc(c.from)}</td><td>→</td><td><strong>${esc(c.to)}</strong></td></tr>`).join('')}</tbody></table>
            ${st.opts.applyShipPatch ? `<div class="sd-gen"><button class="btn-primary btn-sm" data-act="apply-cost">Update cost breakdown</button></div>` : ''}`;
    }

    function historyHtml(st) {
        const v = st.view, r = v.record, b = base(v.shipment.id);
        const outs = r.outputs || [];
        return `<section class="ship-det-section">
            <div class="ship-det-hd"><h3 class="ship-det-title">Generated documents</h3></div>
            ${outs.length ? `<table class="sd-outs"><tbody>${outs.map(o => `<tr>
                <td><strong>${esc(o.name)}</strong><div class="sd-muted">${esc(o.filename)}</div></td>
                <td>${o.invoiceNumber ? `${esc(o.invoiceNumber)} · ${esc(o.currency || '')} ${fmtMoney(o.amount)}` : ''}${o.lcNumber ? `LC ${esc(o.lcNumber)} · gross ${fmtKg(o.grossKg)} kg` : ''}${!o.invoiceNumber && !o.lcNumber ? `${o.packages} bales · ${fmtKg(o.netKg)} kg` : ''}</td>
                <td class="sd-muted">${esc(when(o.at))} · ${esc(who(o.by))}</td>
                <td class="r"><a class="btn-link" href="${b}/render?out=${encodeURIComponent(o.key)}" target="_blank" rel="noopener">Open</a>${o.doc === 'packing' ? ` · <a class="btn-link" href="${b}/xlsx?out=${encodeURIComponent(o.key)}">.xlsx</a>` : ''}</td></tr>`).join('')}</tbody></table>`
                : '<p class="sd-muted">None yet.</p>'}
            <details class="sd-details"><summary>Supplier files and activity</summary>
                ${(r.fileHistory || []).map(f => `<div class="sd-muted">📄 <a href="${b}/file?key=${encodeURIComponent(f.key)}" target="_blank" rel="noopener">${esc(f.filename)}</a> · ${esc(f.kind === 'proforma' ? 'proforma' : 'packing list')} · ${esc(when(f.uploadedAt))} · ${esc(who(f.by))}</div>`).join('') || '<div class="sd-muted">No files yet.</div>'}
                <ul class="sd-log">${(r.log || []).map(l => `<li><span class="sd-muted">${esc(when(l.at))} · ${esc(who(l.by))}</span> ${esc(l.action)}</li>`).join('')}</ul>
            </details>
        </section>`;
    }

    // ── Behaviour ────────────────────────────────────────────────────────
    function wire(st) {
        const p = st.panel;
        p.querySelectorAll('[data-upload]').forEach(inp => inp.addEventListener('change', e => {
            const f = e.target.files && e.target.files[0];
            if (f) upload(st, inp.dataset.upload, f);
        }));
        p.querySelectorAll('.sd-upload').forEach(card => {
            card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('sd-upload--over'); });
            card.addEventListener('dragleave', () => card.classList.remove('sd-upload--over'));
            card.addEventListener('drop', e => {
                e.preventDefault(); card.classList.remove('sd-upload--over');
                const f = e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) upload(st, card.dataset.kind, f);
            });
        });
        p.querySelectorAll('[data-stop]').forEach(a => a.addEventListener('click', e => e.stopPropagation()));
        // Export invoice
        const rate = $(st, '#sd-ei-rate');
        if (rate) {
            const t = st.view.confirmedTotals, ccy = st.view.record.exportInvoice.currency;
            rate.addEventListener('input', () => { $(st, '#sd-ei-amount').innerHTML = `${fmtKg(t.netKg)} kg × ${esc(ccy)} ${fmtRate(rate.value)} = <strong>${esc(ccy)} ${fmtMoney(amountOf(t.netKg, rate.value))}</strong>`; });
            rate.addEventListener('change', () => saveInvoice(st, { rate: num(rate.value), rateConfirmed: false }));
            $(st, '#sd-ei-number').addEventListener('change', e => saveInvoice(st, { number: e.target.value.trim(), numberConfirmed: false }));
            $(st, '#sd-ei-date').addEventListener('change', e => saveInvoice(st, { date: e.target.value }));
            $(st, '#sd-ei-numok').addEventListener('change', e => saveInvoice(st, { numberConfirmed: e.target.checked }));
            $(st, '#sd-ei-rateok').addEventListener('change', e => saveInvoice(st, { rateConfirmed: e.target.checked }));
        }
    }

    // Delegated listeners live on the panel element, which survives redraws,
    // so they are attached exactly once.
    function wireOnce(st) {
        const p = st.panel;
        p.addEventListener('input', e => {
            if (e.target.dataset.path) onEdit(st, e.target);
            else if (e.target.dataset.jps) onJpsEdit(st, e.target);
        });
        p.addEventListener('change', e => { if (e.target.dataset.path && e.target.tagName === 'SELECT') onEdit(st, e.target); });
        p.addEventListener('click', e => {
            const btn = e.target.closest('[data-act]');
            if (btn && p.contains(btn)) { e.preventDefault(); act(st, btn.dataset.act, btn); }
        });
    }

    function setPath(obj, path, value) {
        const parts = path.split('.');
        let o = obj;
        for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
        const k = parts.at(-1);
        o[k] = value;
        if (RAW_OF[k]) o[RAW_OF[k]] = null;
    }

    function onEdit(st, el) {
        const path = el.dataset.path;
        const numeric = el.type === 'number';
        setPath(st.review, path, numeric ? num(el.value) : el.value);
        if (/^bales\.\d+\.colour$/.test(path)) el.closest('.sd-bale').className = `sd-bale sd-bale--${el.value || 'none'}`;
        scheduleSave(st);
    }

    function scheduleSave(st, delay = 600) {
        clearTimeout(st.saveTimer);
        const ss = $(st, '#sd-savestate'); if (ss) ss.textContent = 'Unsaved…';
        st.saveTimer = setTimeout(() => saveReview(st), delay);
    }

    async function saveReview(st) {
        const ss = $(st, '#sd-savestate');
        try {
            if (ss) ss.textContent = 'Saving…';
            const view = await send(base(st.ship.id), 'PATCH', { review: st.review });
            st.view = view; // keep st.review (the user may have typed more meanwhile)
            refreshReviewBits(st);
            if (ss) ss.textContent = 'Saved';
        } catch (e) {
            if (ss) ss.textContent = 'Save failed: ' + e.message;
        }
    }

    // Re-render checks, totals and the confirm bar without touching inputs.
    function refreshReviewBits(st) {
        const c = $(st, '#sd-checks'); if (c) c.innerHTML = checksHtml(st);
        const t = $(st, '#sd-bale-totals'); if (t) t.innerHTML = totalsLine(st.view.reviewTotals);
        const cf = $(st, '#sd-confirm'); if (cf) cf.innerHTML = confirmHtml(st);
        const { min, max } = st.view.baleRange || { min: 150, max: 650 };
        st.panel.querySelectorAll('.sd-bale').forEach((el, i) => {
            const kg = st.review.bales[i]?.kg;
            el.classList.toggle('sd-bale--odd', kg != null && (kg < min || kg > max));
        });
    }

    async function flushSave(st) {
        if (st.saveTimer) { clearTimeout(st.saveTimer); st.saveTimer = null; await saveReview(st); }
        if (st.jpsTimer) { clearTimeout(st.jpsTimer); st.jpsTimer = null; await saveJps(st); }
    }

    function onJpsEdit(st, el) {
        setPath(st.jps, el.dataset.jps, el.type === 'number' ? num(el.value) : el.value);
        clearTimeout(st.jpsTimer);
        const ss = $(st, '#sd-jps-savestate'); if (ss) ss.textContent = 'Unsaved…';
        st.jpsTimer = setTimeout(() => { st.jpsTimer = null; saveJps(st); }, 600);
    }

    async function saveJps(st) {
        const ss = $(st, '#sd-jps-savestate');
        try {
            if (ss) ss.textContent = 'Saving…';
            st.view = await send(base(st.ship.id), 'PATCH', { jps: st.jps });
            const c = $(st, '#sd-jps-checks'); if (c) c.innerHTML = checkListHtml(st.view.jpsChecks || [], 'sd-checks--compact');
            const sp = $(st, '#sd-jps-split'); if (sp) sp.innerHTML = splitHtml(st.view);
            const x = $(st, '#sd-xero'); if (x) x.innerHTML = xeroHtml(st);
            const co = $(st, '#sd-cost'); if (co) co.innerHTML = costHtml(st);
            if (ss) ss.textContent = 'Saved';
        } catch (e) {
            if (ss) ss.textContent = 'Save failed: ' + e.message;
        }
    }

    async function upload(st, kind, file) {
        if (file.type && file.type !== 'application/pdf') { toast('Upload the supplier PDF'); return; }
        await flushSave(st);
        const card = st.panel.querySelector(`.sd-upload[data-kind="${kind}"]`);
        card?.classList.add('sd-upload--busy');
        const busy = card?.querySelector('.sd-upload-busy'); if (busy) busy.hidden = false;
        try {
            const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file); });
            const view = await send(`${base(st.ship.id)}/extract`, 'POST', { kind, filename: file.name, data, mediaType: 'application/pdf' });
            setView(st, view); draw(st);
            toast(kind === 'packingList' ? `Read ${view.reviewTotals.count} bales — check them below` : 'Read the supplier proforma — check it below');
        } catch (e) {
            if (e.body && e.body.record) { setView(st, e.body); draw(st); }
            toast('Could not read the PDF: ' + e.message);
            card?.classList.remove('sd-upload--busy');
            if (busy) busy.hidden = true;
        }
    }

    async function saveInvoice(st, patch) {
        await flushSave(st);
        try {
            const ei = { ...st.view.record.exportInvoice, ...patch };
            const view = await send(base(st.ship.id), 'PATCH', { exportInvoice: ei });
            setView(st, view); draw(st);
        } catch (e) { toast('Save failed: ' + e.message); }
    }

    function parsePasted(text) {
        return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
            const parts = l.split(/[\t,;]+|\s{2,}|\s(?=[a-zA-Z])/).map(s => s.trim()).filter(Boolean);
            const n = parseInt(parts[0], 10), kg = Number(String(parts[1] || '').replace(/[^\d.]/g, ''));
            const c = String(parts[2] || '').toLowerCase();
            return { n: Number.isFinite(n) ? n : null, kg: Number.isFinite(kg) && parts[1] ? kg : null, colour: /^w|^bianc/.test(c) ? 'white' : /^c|^col/.test(c) ? 'coloured' : '' };
        }).filter(b => b.n != null || b.kg != null);
    }

    async function act(st, a, btn) {
        if (['settings', 'save-lc', 'gen-draft', 'gen-final', 'apply-weights', 'apply-cost', 'xero-push', 'xero-refresh'].includes(a)) await flushSave(st);
        const r = st.review;
        if (a === 'settings') return openSettings(() => load(st));
        if (a === 'add-bale') {
            const max = Math.max(0, ...(r.bales || []).map(b => Number(b.n) || 0));
            r.bales = [...(r.bales || []), { n: max + 1, kg: null, colour: '' }];
            $(st, '#sd-bales').innerHTML = balesHtml(st);
            st.panel.querySelector('.sd-bale:last-child .sd-bale-kg')?.focus();
            return scheduleSave(st);
        }
        if (a === 'del-bale') { r.bales.splice(Number(btn.dataset.i), 1); $(st, '#sd-bales').innerHTML = balesHtml(st); return scheduleSave(st, 0); }
        if (a === 'paste-bales') { $(st, '.sd-paste').hidden = false; $(st, '.sd-paste-ta').focus(); return; }
        if (a === 'paste-cancel') { $(st, '.sd-paste').hidden = true; return; }
        if (a === 'paste-apply') {
            const bales = parsePasted($(st, '.sd-paste-ta').value);
            if (!bales.length) { toast('Nothing to paste — one bale per line: number, kg, colour'); return; }
            if (r.bales?.length && !confirm(`Replace the ${r.bales.length} bales with ${bales.length} pasted ones?`)) return;
            r.bales = bales;
            $(st, '.sd-paste').hidden = true;
            $(st, '#sd-bales').innerHTML = balesHtml(st);
            return scheduleSave(st, 0);
        }
        if (a === 'manual-invoice') {
            r.supplierInvoice = { number: '', date: '', currency: 'EUR', lines: [
                { description: 'White toeclips', colour: 'white', kg: null, unitPrice: null, amount: null },
                { description: 'Coloured toeclips', colour: 'coloured', kg: null, unitPrice: null, amount: null },
            ], netKg: null, total: null };
            $(st, '#sd-review').innerHTML = reviewHtml(st);
            return scheduleSave(st, 0);
        }
        if (a === 'add-line') { r.supplierInvoice.lines.push({ description: '', colour: '', kg: null, unitPrice: null, amount: null }); $(st, '#sd-review').innerHTML = reviewHtml(st); return scheduleSave(st, 0); }
        if (a === 'del-line') { r.supplierInvoice.lines.splice(Number(btn.dataset.i), 1); $(st, '#sd-review').innerHTML = reviewHtml(st); return scheduleSave(st, 0); }
        if (a === 'manual-jps') {
            st.jps = { number: '', date: '', currency: st.view.record.exportInvoice?.currency || 'USD', lines: [], netKg: null, total: null };
            $(st, '#sd-jps').innerHTML = jpsHtml(st);
            return saveJps(st);
        }
        if (a === 'jps-add-line') { st.jps.lines = [...(st.jps.lines || []), { description: '', kg: null, unitPrice: null, amount: null }]; $(st, '#sd-jps').innerHTML = jpsHtml(st); return saveJps(st); }
        if (a === 'jps-del-line') { st.jps.lines.splice(Number(btn.dataset.i), 1); $(st, '#sd-jps').innerHTML = jpsHtml(st); return saveJps(st); }
        if (a === 'xero-push') {
            const d = st.view.xero.docs.find(x => x.key === btn.dataset.doc);
            const word = (XERO_WORDS[st.view.xero.status] || 'Draft').toLowerCase();
            if (!confirm(`Create in Xero as ${word}?\n\n${d.label} ${d.number || ''} — ${d.currency} ${fmtMoney(d.total)}, ${d.type === 'ACCREC' ? 'sales invoice to' : 'bill from'} ${d.contactName}`)) return;
            btn.disabled = true; btn.textContent = 'Creating…';
            try {
                setView(st, await send(`${base(st.ship.id)}/xero`, 'POST', { doc: d.key }));
                draw(st);
                toast(`${d.label} created in Xero`);
            } catch (e) { toast('Not created in Xero: ' + e.message); btn.disabled = false; btn.textContent = 'Create in Xero'; }
            return;
        }
        if (a === 'xero-refresh') {
            btn.disabled = true; btn.textContent = 'Checking Xero…';
            try { setView(st, await send(`${base(st.ship.id)}/xero`, 'POST', { refresh: true })); draw(st); }
            catch (e) { toast('Could not read Xero: ' + e.message); btn.disabled = false; btn.textContent = 'Refresh from Xero'; }
            return;
        }
        if (a === 'apply-cost') {
            if (!st.opts.applyShipPatch) return;
            btn.disabled = true; btn.textContent = 'Updating…';
            try { await st.opts.applyShipPatch(st.view.costPlan.patch); toast('Cost breakdown updated'); }
            catch (e) { toast('Could not update the cost breakdown: ' + e.message); btn.disabled = false; btn.textContent = 'Update cost breakdown'; }
            return;
        }
        if (a === 'confirm') return confirmBales(st, btn);
        if (a === 'apply-weights') return applyWeights(st, st.view.confirmedTotals);
        if (a === 'use-lc') {
            const L = st.view.linkedLc;
            $(st, '#sd-lc-number').value = L.lcNumber || '';
            if (L.issuedDate) $(st, '#sd-lc-date').value = L.issuedDate;
            return;
        }
        if (a === 'save-lc') {
            btn.disabled = true;
            try {
                const view = await send(base(st.ship.id), 'PATCH', { lc: { number: $(st, '#sd-lc-number').value.trim(), date: $(st, '#sd-lc-date').value, grossKg: num($(st, '#sd-lc-gross').value) } });
                setView(st, view); draw(st); toast('LC details saved');
            } catch (e) { toast('Save failed: ' + e.message); btn.disabled = false; }
            return;
        }
        if (a === 'gen-draft' || a === 'gen-final') {
            btn.disabled = true; const label = btn.textContent; btn.textContent = 'Generating…';
            try {
                const docs = a === 'gen-draft' ? [{ doc: 'packing', stage: 'draft' }, { doc: 'proforma' }] : [{ doc: 'packing', stage: 'final' }];
                const view = await send(`${base(st.ship.id)}/render`, 'POST', { docs });
                setView(st, view); draw(st);
                toast(`Generated ${view.generated.map(g => g.name.toLowerCase()).join(' and ')} — open each below to print or save as PDF`);
            } catch (e) { toast('Not generated: ' + e.message); btn.disabled = false; btn.textContent = label; }
        }
    }

    async function confirmBales(st, btn) {
        await flushSave(st);
        const applyBox = $(st, '#sd-apply-weights');
        const apply = !!(applyBox && applyBox.checked);
        btn.disabled = true; btn.textContent = 'Confirming…';
        try {
            const view = await send(`${base(st.ship.id)}/confirm`, 'POST', {});
            setView(st, view);
            if (apply) await applyWeights(st, { whiteKg: view.weights.whiteRawKg, colouredKg: view.weights.colourRawKg }, true);
            else draw(st);
            toast(`Confirmed ${view.confirmedTotals.count} bales, ${fmtKg(view.confirmedTotals.netKg)} kg`);
        } catch (e) {
            if (e.body?.checks) { st.view.checks = e.body.checks; refreshReviewBits(st); }
            toast('Not confirmed: ' + e.message);
            btn.disabled = false; btn.textContent = 'Confirm bales';
        }
    }

    // The shipment record is saved by the Imports view (it holds the whole
    // shipment list); it re-renders this shipment afterwards.
    async function applyWeights(st, t, quiet) {
        if (!st.opts.applyShipPatch) { draw(st); return; }
        try {
            await st.opts.applyShipPatch({ whiteRawKg: t.whiteKg, colourRawKg: t.colouredKg });
            if (!quiet) toast('Shipment weights updated');
        } catch (e) {
            toast('Could not update the shipment weights: ' + e.message);
            draw(st);
        }
    }

    // ── Settings modal ───────────────────────────────────────────────────
    // Four tabs, one per party: only what can change between shipments.
    // Labels, wording templates, sign-off and defaults live in code
    // (SETTINGS_SEED in functions/api/import/_exportdocs.js).
    const SETTINGS_TABS = [['enviroware', 'Enviroware'], ['jps', 'JPS Enterprise'], ['documents', 'Documents'], ['xero', 'Xero']];

    function settingsGaps(s) {
        const blank = v => !String(Array.isArray(v) ? v.join('') : (v ?? '')).trim();
        const gaps = { enviroware: [], jps: [], documents: [], xero: [] };
        [['Phone', s.seller.phone], ['Email', s.seller.email], ['GST no.', s.seller.gstNumber], ['Bank name', s.bank.name], ['Bank SWIFT', s.bank.swift]]
            .forEach(([l, v]) => blank(v) && gaps.enviroware.push(l));
        [['Address', s.buyer.addressLines], ['IRC no.', s.identifiers.irc], ['Applicant TIN', s.identifiers.applicantTin], ['Applicant BIN', s.identifiers.applicantBin], ['Bank TIN', s.identifiers.bankTin], ['Bank BIN / VAT reg no.', s.identifiers.bankBin]]
            .forEach(([l, v]) => blank(v) && gaps.jps.push(l));
        [['HS code', s.hsCode], ['Terms', s.terms]].forEach(([l, v]) => blank(v) && gaps.documents.push(l));
        const a = s.xero.accounts || {};
        if (['rawProduct', 'lcDeposit', 'handling', 'exportSale'].some(k => blank(a[k]))) gaps.xero.push('Account codes');
        return gaps;
    }

    async function openSettings(onSaved) {
        let data;
        try { data = await api('/api/import/export-docs/settings'); } catch (e) { toast('Could not load settings: ' + e.message); return; }
        const s = data.settings;
        const gaps = settingsGaps(s);
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const inp = (label, path, val, attrs = '') => `<label class="sd-field"><span class="imp-field-label">${esc(label)}</span><input class="sd-input" data-s="${path}" value="${esc(val ?? '')}" ${attrs}></label>`;
        const ta = (label, path, arr, rows = 3) => `<label class="sd-field"><span class="imp-field-label">${esc(label)}</span><textarea class="sd-input" data-s="${path}" data-lines rows="${rows}">${esc((arr || []).join('\n'))}</textarea></label>`;
        const image = n => `<div class="sd-image" data-asset="${n}"><span class="imp-field-label">${n === 'seal' ? 'Official seal' : 'Signature'}</span>
            <div class="sd-image-prev">${data.assets[n] ? `<img src="/api/import/export-docs/settings/${n}?v=${Date.now()}" alt="">` : '<span class="sd-muted">None</span>'}</div>
            <span><label class="btn-secondary btn-sm">Upload<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-asset-file="${n}"></label>
            ${data.assets[n] ? ` <button class="btn-link" data-asset-del="${n}">Remove</button>` : ''}</span></div>`;
        const panels = {
            enviroware: `
                <div class="sd-grid3">${inp('Company', 'seller.name', s.seller.name)}${inp('Strapline', 'seller.strapline', s.seller.strapline)}${inp('GST no.', 'seller.gstNumber', s.seller.gstNumber)}
                    ${inp('Phone', 'seller.phone', s.seller.phone)}${inp('Email', 'seller.email', s.seller.email)}${ta('Address (one line each)', 'seller.addressLines', s.seller.addressLines)}</div>
                <h4 class="sd-h4">Bank <span class="sd-muted">printed on the proforma</span></h4>
                <div class="sd-grid3">${inp('Bank', 'bank.name', s.bank.name, 'placeholder="ANZ Bank New Zealand Ltd"')}${inp('SWIFT', 'bank.swift', s.bank.swift)}${inp('Account no.', 'bank.accountNumber', s.bank.accountNumber)}
                    ${ta('Bank address (optional)', 'bank.addressLines', s.bank.addressLines, 2)}</div>
                <h4 class="sd-h4">Signature and seal <span class="sd-muted">on the proforma</span></h4>
                <div class="sd-images">${image('signature')}${image('seal')}</div>`,
            jps: `
                <div class="sd-grid3">${inp('Name', 'buyer.name', s.buyer.name)}${ta('Address (one line each)', 'buyer.addressLines', s.buyer.addressLines, 4)}</div>
                <h4 class="sd-h4">Applicant numbers <span class="sd-muted">checked against each shipment's LC</span></h4>
                <div class="sd-grid3">${inp('IRC no.', 'identifiers.irc', s.identifiers.irc)}${inp('Applicant TIN', 'identifiers.applicantTin', s.identifiers.applicantTin)}${inp('Applicant BIN', 'identifiers.applicantBin', s.identifiers.applicantBin)}
                    ${inp("Applicant's bank", 'identifiers.bankName', s.identifiers.bankName)}${inp('Bank TIN', 'identifiers.bankTin', s.identifiers.bankTin)}${inp('Bank BIN / VAT reg no.', 'identifiers.bankBin', s.identifiers.bankBin)}</div>`,
            documents: `
                <div class="sd-grid3">${inp('HS code', 'hsCode', s.hsCode)}${inp('Packing — draft packing list', 'packingSpec.draft', s.packingSpec.draft)}${inp('Packing — final packing list', 'packingSpec.final', s.packingSpec.final)}</div>
                <p class="sd-warn-text">Match the packing wording in this shipment's LC — earlier LCs required exactly “export standard seaworthy packaging”.</p>
                <div class="sd-grid1">${ta('Proforma terms & conditions (one per line)', 'terms', s.terms, 7)}</div>`,
            xero: `
                <div class="sd-grid3">${inp('Pistoni contact', 'xero.supplierContact', s.xero.supplierContact)}${inp('JPS contact', 'xero.buyerContact', s.xero.buyerContact)}
                    <label class="sd-field"><span class="imp-field-label">Create invoices as</span><select class="sd-input" data-s="xero.status">
                    ${[['DRAFT', 'Draft'], ['SUBMITTED', 'Awaiting approval'], ['AUTHORISED', 'Awaiting payment']].map(([v, l]) => `<option value="${v}" ${s.xero.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
                <h4 class="sd-h4">Account codes <span class="sd-muted">your accountant's choice — nothing goes to Xero until they're set</span></h4>
                <div class="sd-grid4">${inp('Raw product (Pistoni bill)', 'xero.accounts.rawProduct', s.xero.accounts.rawProduct)}${inp('LC deposit (JPS bill)', 'xero.accounts.lcDeposit', s.xero.accounts.lcDeposit)}
                    ${inp('Handling & sorting (JPS bill)', 'xero.accounts.handling', s.xero.accounts.handling)}${inp('Export sale (our proforma)', 'xero.accounts.exportSale', s.xero.accounts.exportSale)}</div>`,
        };
        const first = SETTINGS_TABS.find(([k]) => gaps[k].length)?.[0] || 'enviroware';
        overlay.innerHTML = `<div class="modal-box sd-settings">
            <h3 class="modal-title">Document settings</h3>
            <p class="sd-muted">Taken from Commercial Invoice 101/2026 (Shipment 42). They rarely change — each shipment's LC is checked against them.</p>
            <div class="sd-stabs">${SETTINGS_TABS.map(([k, l]) => `<button class="sd-stab${k === first ? ' sd-stab--active' : ''}" data-stab="${k}" title="${esc(gaps[k].length ? 'Still blank: ' + gaps[k].join(', ') : '')}">${esc(l)}${gaps[k].length ? '<span class="sd-stab-dot"></span>' : ''}</button>`).join('')}</div>
            ${SETTINGS_TABS.map(([k]) => `<div class="sd-spanel" data-spanel="${k}" ${k === first ? '' : 'hidden'}>
                ${gaps[k].length ? `<p class="sd-warn-text">Still blank: ${esc(gaps[k].join(', '))}</p>` : ''}${panels[k]}</div>`).join('')}
            <div class="modal-actions"><button class="btn-secondary" data-close>Cancel</button><button class="btn-primary" data-save>Save</button></div>
        </div>`;
        document.body.appendChild(overlay);
        const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', e => {
            if (e.target === overlay || e.target.closest('[data-close]')) return close();
            const tab = e.target.closest('[data-stab]');
            if (tab) {
                overlay.querySelectorAll('[data-stab]').forEach(b => b.classList.toggle('sd-stab--active', b === tab));
                overlay.querySelectorAll('[data-spanel]').forEach(p => { p.hidden = p.dataset.spanel !== tab.dataset.stab; });
            }
        });

        overlay.querySelectorAll('[data-asset-file]').forEach(inpEl => inpEl.addEventListener('change', async e => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            try {
                const { data: b64, mediaType } = await downsizeImage(f, 900);
                await send(`/api/import/export-docs/settings/${inpEl.dataset.assetFile}`, 'POST', { data: b64, mediaType });
                overlay.querySelector(`[data-asset="${inpEl.dataset.assetFile}"] .sd-image-prev`).innerHTML = `<img src="data:${mediaType};base64,${b64}" alt="">`;
                toast('Image saved');
            } catch (err) { toast('Upload failed: ' + err.message); }
        }));
        overlay.querySelectorAll('[data-asset-del]').forEach(b => b.addEventListener('click', async () => {
            await api(`/api/import/export-docs/settings/${b.dataset.assetDel}`, { method: 'DELETE' }).catch(() => {});
            overlay.querySelector(`[data-asset="${b.dataset.assetDel}"] .sd-image-prev`).innerHTML = '<span class="sd-muted">None</span>';
            b.remove();
        }));

        overlay.querySelector('[data-save]').addEventListener('click', async e => {
            const next = structuredClone(s);
            overlay.querySelectorAll('[data-s]').forEach(el => {
                const parts = el.dataset.s.split('.');
                let o = next;
                for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
                o[parts.at(-1)] = el.dataset.lines !== undefined ? el.value.split('\n').map(x => x.trim()).filter(Boolean) : (el.type === 'number' ? num(el.value) : el.value);
            });
            e.target.disabled = true;
            try {
                await send('/api/import/export-docs/settings', 'PUT', { settings: next });
                toast('Document settings saved');
                close();
                if (onSaved) onSaved();
            } catch (err) { toast('Save failed: ' + err.message); e.target.disabled = false; }
        });
    }

    // Keep PNG (transparent signatures/seals); shrink to maxW wide.
    function downsizeImage(file, maxW) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxW / img.width);
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                const mediaType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
                const url = c.toDataURL(mediaType, 0.9);
                URL.revokeObjectURL(img.src);
                resolve({ data: url.split(',')[1], mediaType });
            };
            img.onerror = () => reject(new Error('Not an image'));
            img.src = URL.createObjectURL(file);
        });
    }

    return { renderPanel, openSettings };
})();
