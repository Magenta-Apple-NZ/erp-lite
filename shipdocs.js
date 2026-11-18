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
        if (!res.ok) { const e = new Error(body.error || body.extractError || `${res.status} ${res.statusText || 'error'}`.trim()); e.body = body; e.status = res.status; throw e; }
        return body;
    }
    const send = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    // One way to show figures and dates everywhere on this tab: thousands
    // separators, money to 2 dp with its currency, weights with "kg", rates
    // per kg, dates as "17 Nov 2026" (timestamps add the time).
    const nf = (n, min, max) => (Number(n) || 0).toLocaleString('en-NZ', { minimumFractionDigits: min, maximumFractionDigits: max });
    const blank = v => v == null || v === '';
    const fmtKg = n => nf(n, 0, 3);
    const fmtMoney = n => nf(n, 2, 2);
    const fmtRate = n => nf(n, 2, 4);
    const kg = n => blank(n) ? '—' : `${fmtKg(n)} kg`;
    const money = (n, ccy) => blank(n) ? '—' : `${ccy ? ccy + ' ' : ''}${fmtMoney(n)}`;
    const perKg = (n, ccy) => blank(n) ? '—' : `${ccy ? ccy + ' ' : ''}${fmtRate(n)}/kg`;
    const amountOf = (kgs, rate) => Math.round((Number(kgs) || 0) * Math.round((Number(rate) || 0) * 10000) / 100) / 100;
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = ymd => { const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : ''; };
    const nzYmd = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
    const when = iso => iso ? `${day(nzYmd(iso))}, ${new Date(iso).toLocaleTimeString('en-NZ', { timeZone: 'Pacific/Auckland', hour: 'numeric', minute: '2-digit' })}` : '';
    // "andrew@primetie.co.nz" → "Andrew"; nobody recorded → nothing shown.
    const who = e => { const n = String(e || '').split('@')[0]; return !n || n === 'unknown' ? '' : n.split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); };
    const by = e => (who(e) ? ' by ' + who(e) : '');
    const longDate = day;
    const num = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);

    // Editing a supplier figure by hand drops the "as printed" string the
    // model read, so the printed-number check doesn't compare stale text.
    const RAW_OF = { whiteTotalKg: 'whiteTotalRaw', colouredTotalKg: 'colouredTotalRaw', packages: 'packagesRaw', netKg: 'netKgRaw', total: 'totalRaw', kg: 'kgRaw', unitPrice: 'unitPriceRaw', amount: 'amountRaw' };

    // ── Panel ────────────────────────────────────────────────────────────
    // opts.applyShipPatch(patch) → Promise: write weights, cost-line rates,
    // actuals and paid flags to the shipment through the Imports view's own
    // save (V3 shipments only; null otherwise).
    function renderPanel(panel, ship, opts = {}) {
        // editing: printed figures the user chose to correct (✎), shown as inputs.
        const st = { panel, ship, opts, view: null, review: null, jps: null, saveTimer: null, jpsTimer: null, editing: new Set() };
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
        if (st.jps) st.jps.contract = { lastShipmentDate: '', expiryDate: '', containers: '', ...(st.jps.contract || {}) };
    }

    const $ = (st, sel) => st.panel.querySelector(sel);

    function draw(st) {
        const v = st.view;
        st.panel.innerHTML = `
        <div class="sd">
            ${stepsHtml(v)}
            ${settingsBannerHtml(v)}
            ${reconHtml(v)}
            <section class="ship-det-section">
                ${sectionHd(1, "Pistoni's documents", sectionStatus(st)[1])}
                <p class="sd-muted sd-lead">Read by AI — you check the figures in section 2.</p>
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
            ["JPS's proforma", !!r.jpsConfirmed],
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

    // ── Section status ───────────────────────────────────────────────────
    // Every numbered section says where it stands: done (a real check passed
    // or the step is confirmed / generated), needs attention, to do, or
    // waiting for an earlier section. Green is only ever "done".
    const STAT_ICON = { done: '✓', attention: '!', open: '○', waiting: '…' };
    function sectionHd(n, title, stat, extra = '') {
        return `<div class="ship-det-hd"><h3 class="ship-det-title">${n ? n + ' · ' : ''}${esc(title)}</h3>
            <span class="sd-hd-right">${stat ? `<span class="sd-sstat sd-sstat--${stat.kind}" id="sd-stat-${n}">${STAT_ICON[stat.kind]} ${esc(stat.text)}</span>` : ''}${extra}</span></div>`;
    }
    const failing = list => (list || []).filter(c => c.ok === false && !c.dismissed);
    const REVIEW_CHECKS = c => !['rate-confirmed', 'number-confirmed'].includes(c.id);
    const eiConfirmed = ei => !!(ei && ei.numberConfirmed && ei.rateConfirmed);
    const latestOut = (r, doc, stage) => (r.outputs || []).find(o => o.doc === doc && (o.stage || 'draft') === stage);

    function sectionStatus(st) {
        const v = st.view, r = v.record, s = {};
        const needs = n => ({ kind: 'attention', text: `Needs attention (${n})` });
        // 1 · Pistoni's documents
        const files = ['packingList', 'proforma'].map(k => ({ f: r.files?.[k], x: r.extractions?.[k] }));
        s[1] = files.some(({ f, x }) => f && x?.error && x.fileKey === f.key) ? { kind: 'attention', text: "A PDF couldn't be read" }
            : files.every(({ f }) => f) ? { kind: 'done', text: 'Both read' }
            : { kind: 'open', text: files.some(({ f }) => f) ? '1 of 2 uploaded' : 'To do' };
        // 2 · Bales and Pistoni's figures
        const started = (st.review.bales || []).length || st.review.supplierInvoice;
        const f2 = failing(v.checks.filter(REVIEW_CHECKS));
        s[2] = r.confirmed && !v.unconfirmedChanges ? { kind: 'done', text: `Confirmed ${day(nzYmd(r.confirmed.confirmedAt))}` }
            : !started ? { kind: 'waiting', text: "Waiting for Pistoni's documents" }
            : f2.length ? needs(f2.length) : { kind: 'open', text: r.confirmed ? 'Changed since confirmed' : 'Ready to confirm' };
        // 3 · Our proforma invoice
        const ei = r.exportInvoice;
        s[3] = !r.confirmed ? { kind: 'waiting', text: 'Waiting for section 2' }
            : eiConfirmed(ei) ? { kind: 'done', text: `Confirmed${ei.confirmedAt ? ' ' + day(nzYmd(ei.confirmedAt)) : ''}` }
            : { kind: 'open', text: 'Not confirmed' };
        // 4 · Draft documents
        const g = v.generation || {};
        const pd = latestOut(r, 'packing', 'draft'), pf = latestOut(r, 'proforma', 'draft');
        const g4 = [...(g.packingDraft || []), ...(g.proforma || [])];
        s[4] = !r.confirmed || !eiConfirmed(ei) ? { kind: 'waiting', text: 'Waiting for sections 2 and 3' }
            : pd && pf ? { kind: 'done', text: `Generated ${day(nzYmd(pd.at < pf.at ? pf.at : pd.at))}` }
            : g4.length ? needs(new Set(g4).size) : { kind: 'open', text: 'Ready to generate' };
        // 5 · JPS's proforma invoice
        const f5 = failing(v.jpsChecks);
        s[5] = !r.confirmed ? { kind: 'waiting', text: 'Waiting for section 2' }
            : r.jpsConfirmed ? { kind: 'done', text: `Confirmed ${day(nzYmd(r.jpsConfirmed.at))}` }
            : !r.jps ? { kind: 'open', text: 'To do' }
            : f5.length ? needs(f5.length) : { kind: 'open', text: 'Ready to confirm' };
        // 6 · Xero
        const docs = v.xero?.docs || [], errs = v.xero?.errors || {};
        const inX = docs.filter(d => d.inXero).length;
        s[6] = inX === docs.length && docs.length ? { kind: 'done', text: 'All three in Xero' }
            : docs.some(d => !d.inXero && errs[d.key]) || errs.refresh ? { kind: 'attention', text: 'Last attempt failed' }
            : docs.some(d => d.inXero && d.changedSincePush) ? { kind: 'attention', text: 'Changed since sent' }
            : { kind: inX ? 'open' : (docs.every(d => d.issues.length) ? 'waiting' : 'open'), text: `${inX} of ${docs.length} in Xero` };
        // 7 · Final
        const fin = latestOut(r, 'packing', 'final');
        s[7] = fin ? { kind: 'done', text: `Generated ${day(nzYmd(fin.at))}` }
            : !r.confirmed ? { kind: 'waiting', text: 'Waiting for section 2' }
            : (g.packingFinal || []).length ? { kind: 'open', text: 'Waiting for the LC' } : { kind: 'open', text: 'Ready to generate' };
        // Cost breakdown
        const ch = (v.costPlan?.changes || []).length;
        s.cost = !r.confirmed ? { kind: 'waiting', text: 'Waiting for section 2' }
            : ch ? { kind: 'attention', text: `${ch} change${ch === 1 ? '' : 's'} to apply` } : { kind: 'done', text: 'Matches' };
        return s;
    }

    // ── Figures side by side ─────────────────────────────────────────────
    // The three proforma invoices (and the packing list's weight) in one table,
    // with the differences worked out on the server (reconcile()). ✓ only for
    // a comparison that passed; ! when it doesn't match or can't be checked.
    function reconHtml(v) {
        const rc = v.reconciliation;
        if (!rc || !rc.docs.some(d => d.present)) return '';
        const ICON = { ok: '✓', warn: '!', wait: '…' };
        const row = d => d.present
            ? `<tr><th>${esc(d.label)}${d.internal ? ' <span class="sd-internal">internal</span>' : ''}</th>
                <td>${esc(d.number || '—')}</td><td>${esc(day(d.date) || '—')}</td>
                <td class="r">${kg(d.kg)}${d.bales ? `<div class="sd-muted">${d.bales} bales</div>` : ''}</td>
                <td class="r">${perKg(d.rate, d.currency)}${d.rate != null && d.rateIsAverage ? '<div class="sd-muted">average</div>' : ''}</td>
                <td class="r"><strong>${money(d.amount, d.currency)}</strong></td>
                <td class="r sd-muted">${money(d.nzd, 'NZD')}</td></tr>`
            : `<tr class="sd-rc-wait"><th>${esc(d.label)}</th><td colspan="6">Not in yet</td></tr>`;
        return `<section class="ship-det-section sd-rc" id="sd-rc">
            ${sectionHd('', 'Figures side by side', null, `<span class="sd-muted">${rc.usesConfirmed ? 'From the confirmed bales' : 'From the bales as reviewed — not confirmed yet'}</span>`)}
            <div class="sd-table-wrap"><table class="sd-rc-table">
                <thead><tr><th>Document</th><th>Number</th><th>Date</th><th class="r">Weight</th><th class="r">Rate</th><th class="r">Amount</th><th class="r">≈ NZD today</th></tr></thead>
                <tbody>${rc.docs.map(row).join('')}</tbody></table></div>
            <ul class="sd-rc-diffs">${rc.diffs.map(d => `<li class="sd-rc-${d.status}"><span class="sd-rc-i">${ICON[d.status]}</span><span><strong>${esc(d.label)}</strong> — ${esc(d.text)}</span></li>`).join('')}</ul>
        </section>`;
    }

    function uploadCardHtml(v, kind, title, hint) {
        const f = v.record.files?.[kind];
        const x = v.record.extractions?.[kind];
        const ok = x && !x.error && x.fileKey === f?.key;
        // Plain facts about what was read (not a check, so no tick); JPS's
        // figures are shown once, in the fields below.
        const summary = !ok || kind === 'jpsInvoice' ? '' : kind === 'packingList'
            ? `${(x.result?.bales || []).length} bales read${x.result?.shipmentNumber != null ? ` · shipment ${esc(x.result.shipmentNumber)}` : ''}`
            : `Document ${esc(x.result?.documentNumber || '?')} · ${esc(money(x.result?.total, x.result?.currency))}`;
        return `<label class="sd-upload${f ? ' sd-upload--has' : ''}" data-kind="${kind}">
            <input type="file" accept="application/pdf" hidden data-upload="${kind}">
            <div class="sd-upload-title">${esc(title)}</div>
            ${f ? `<div class="sd-upload-file">📄 <a href="${base(v.shipment.id)}/file?key=${encodeURIComponent(f.key)}" target="_blank" rel="noopener" data-stop>${esc(f.filename)}</a></div>
                   <div class="sd-muted">Uploaded ${esc(when(f.uploadedAt))}${esc(by(f.by))}</div>
                   ${summary ? `<div class="sd-upload-sum">${summary}</div>` : ''}
                   ${x?.error && x.fileKey === f.key ? `<div class="sd-err">✗ ${esc(x.error)} — try again or enter the figures by hand below</div>` : ''}
                   <span class="btn-link sd-upload-cta">Replace PDF</span>`
                : `<div class="sd-muted">${esc(hint)}</div><span class="btn-secondary btn-sm sd-upload-cta">Choose PDF</span><div class="sd-muted sd-drop-hint">or drop it here</div>`}
            <div class="sd-upload-busy" hidden>Reading with AI… this can take up to a minute</div>
        </label>`;
    }

    // ── Review ───────────────────────────────────────────────────────────
    // A failing check that still stops confirm / generation (not dismissed).
    const blocking = c => c.level === 'block' && c.ok === false && !c.dismissed;

    // Only failing checks are listed (with Dismiss, or greyed with Undo once
    // dismissed); the ones that pass sit behind a "✓ N checks passed" button
    // that opens them in a popover.
    function checkListHtml(list, extraClass = '') {
        const failingList = list.filter(c => c.ok === false);
        const passed = list.filter(c => c.ok !== false);
        const nOk = passed.filter(c => c.ok === true).length, nNa = passed.length - nOk;
        const label = [nOk && `${!failingList.length && nOk > 1 ? 'All ' : ''}${nOk} check${nOk === 1 ? '' : 's'} passed`, nNa && `${nNa} not applicable`].filter(Boolean).join(' · ');
        const pop = passed.length ? `<div class="sd-passed">
            <button type="button" class="sd-passed-btn" data-act="toggle-passed" aria-expanded="false">✓ ${esc(label)}</button>
            <div class="sd-passed-pop" hidden>${checkRowsHtml(passed, 'sd-checks--compact')}</div></div>` : '';
        return (failingList.length ? checkRowsHtml(failingList, extraClass) : '') + pop;
    }

    function checkRowsHtml(list, extraClass = '') {
        const icon = c => c.dismissed ? '–' : c.ok === true ? '✓' : c.ok === false ? (c.level === 'block' ? '✗' : '!') : '–';
        const cls = c => c.dismissed ? 'dismissed' : c.ok === true ? 'ok' : c.ok === false ? (c.level === 'block' ? 'fail' : 'warn') : 'na';
        const tail = c => c.dismissed
            ? `<div class="sd-check-dis">Dismissed${esc(by(c.dismissed.by))}${c.dismissed.at ? ' · ' + esc(when(c.dismissed.at)) : ''} · <button class="btn-link" data-act="restore-check" data-check="${esc(c.id)}">Undo</button></div>`
            : c.ok === false && c.dismissible ? `<button class="btn-link sd-check-x" data-act="dismiss-check" data-check="${esc(c.id)}" title="Leave it as it is — this stops it ${c.level === 'block' ? 'blocking' : 'showing as a warning'}">Dismiss</button>` : '';
        return `<ul class="sd-checks ${extraClass}">${list.map(c => `
            <li class="sd-check sd-check--${cls(c)}"><span class="sd-check-i">${icon(c)}</span>
            <span class="sd-check-body"><strong>${esc(c.title)}</strong>${c.level === 'block' ? '' : ' <span class="sd-muted">(warning)</span>'}<br><span class="sd-check-d">${esc(c.detail)}</span>${c.dismissed ? tail(c) : ''}</span>
            ${c.dismissed ? '' : tail(c)}</li>`).join('')}</ul>`;
    }

    function checksHtml(st) {
        const r = st.review;
        const p = r.packing || {};
        const started = (r.bales || []).length || r.supplierInvoice || p.whiteTotalKg != null || p.colouredTotalKg != null || p.packages != null;
        if (!started) return '<p class="sd-muted">The checks run once there is something to check: upload Pistoni\'s two PDFs above, or enter the bales and figures below.</p>';
        return checkListHtml(st.view.checks.filter(REVIEW_CHECKS));
    }

    function totalsLine(t) {
        if (!t || !t.count) return 'No bales yet';
        return `${t.count} bales · white ${kg(t.whiteKg)} in ${t.whiteCount} bales · coloured ${kg(t.colouredKg)} in ${t.colouredCount} bales · <strong>net ${kg(t.netKg)}</strong>`;
    }

    // A figure printed on a PDF: shown as text with ✎ to correct it (a
    // deliberate override, tagged "corrected" afterwards). Typed figures and
    // ones being corrected are inputs; a locked section shows text only.
    function figure(st, store, path, value, raw, fmt, { fromPdf = false, locked = false } = {}) {
        const key = store + ':' + path;
        const attr = store === 'jps' ? 'data-jps' : 'data-path';
        if (locked) return `<span class="sd-val">${blank(value) ? '—' : esc(fmt(value))}</span>`;
        if (!blank(raw) && !blank(value) && !st.editing.has(key)) {
            return `<span class="sd-val">${esc(fmt(value))}</span><button class="sd-pencil" data-act="edit-field" data-field="${esc(key)}" title="Correct this figure (read from the PDF)" aria-label="Correct">✎</button>`;
        }
        const corrected = fromPdf && blank(raw) && !blank(value);
        const dp = /amount|total/i.test(path) ? 2 : /unitPrice/.test(path) ? 4 : 3;
        return `${numInput(attr, path, value, dp)}${corrected ? '<span class="sd-tag">corrected</span>' : ''}`;
    }

    // A typed figure: a text box that shows "7,330.50" and plain digits while
    // you type in it (see the focus handlers in wireOnce). dp = decimals shown
    // (2 for money, up to 3 for kg, up to 4 for rates).
    const showNum = (v, dp) => blank(v) || !Number.isFinite(Number(v)) ? (v ?? '') : nf(v, dp === 2 ? 2 : 0, dp);
    function numInput(attr, path, value, dp) {
        return `<input class="sd-input sd-num" type="text" inputmode="decimal" data-num="${dp}" ${attr}="${esc(path)}" value="${esc(showNum(value, dp))}">`;
    }
    const readNum = el => num(String(el.value).replace(/[,\s]/g, ''));
    // A printed figure opened with ✎ and changed is tagged "corrected" straight away.
    function markCorrected(st, el, key) {
        if (!st.editing.has(key) || el.nextElementSibling?.classList.contains('sd-tag')) return;
        el.insertAdjacentHTML('afterend', '<span class="sd-tag">corrected</span>');
    }

    // Description and colour: one name per line (the colour only when the
    // description doesn't already say it).
    const colourTag = (desc, colour) => colour && !/bianc|white|color|colour/i.test(desc || '') ? ` <span class="sd-tag">${esc(colour)}</span>` : '';

    function reviewHtml(st) {
        const v = st.view, r = st.review, p = r.packing || {}, c = v.record.confirmed;
        const locked = !!(c && !v.unconfirmedChanges);
        const fromPdf = !!v.record.extractions?.packingList;
        const extra = locked ? '<button class="btn-secondary btn-sm" data-act="unlock-bales">Unlock to edit</button>' : '<span class="sd-muted" id="sd-savestate"></span>';
        const fld = (label, path, val, raw, fmt) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${figure(st, 'review', path, val, raw, fmt, { fromPdf, locked })}</div></div>`;
        return `${sectionHd(2, "Bales and Pistoni's figures", sectionStatus(st)[2], extra)}
            ${locked ? `<p class="sd-lockline">🔒 Confirmed ${esc(when(c.confirmedAt))}${esc(by(c.confirmedBy))}. These are the figures the documents use; unlocking clears the confirmation until you confirm again.</p>` : ''}
            <div id="sd-checks">${checksHtml(st)}</div>
            <h4 class="sd-h4">Pistoni's packing list</h4>
            <div class="sd-grid4">
                ${locked ? `<div class="sd-field"><span class="imp-field-label">Shipment no. (as printed)</span><div class="sd-fig"><span class="sd-val">${esc(r.shipmentNumber ?? '—')}</span></div></div>`
                    : `<label class="sd-field"><span class="imp-field-label">Shipment no. (as printed)</span><input class="sd-input sd-num" data-path="shipmentNumber" type="number" step="1" value="${r.shipmentNumber ?? ''}"></label>`}
                ${fld('White total (as printed)', 'packing.whiteTotalKg', p.whiteTotalKg, p.whiteTotalRaw, kg)}
                ${fld('Coloured total (as printed)', 'packing.colouredTotalKg', p.colouredTotalKg, p.colouredTotalRaw, kg)}
                ${fld('Packages (as printed)', 'packing.packages', p.packages, p.packagesRaw, n => `${fmtKg(n)} bales`)}
            </div>
            <div class="sd-bales-hd">
                <h4 class="sd-h4">Bales <span class="sd-muted" id="sd-bale-totals">${totalsLine(v.reviewTotals)}</span></h4>
                ${locked ? '' : '<span><button class="btn-link" data-act="add-bale">+ Add bale</button> · <button class="btn-link" data-act="paste-bales">Paste bales…</button></span>'}
            </div>
            ${locked ? '' : `<div class="sd-paste" hidden>
                <textarea class="sd-paste-ta" rows="6" placeholder="One bale per line: number, kg, colour — e.g.&#10;1, 442, white&#10;2, 495, coloured"></textarea>
                <div><button class="btn-secondary btn-sm" data-act="paste-apply">Replace bales with these</button> <button class="btn-link" data-act="paste-cancel">Cancel</button></div>
            </div>`}
            <div class="sd-bales${locked ? ' sd-bales--locked' : ''}" id="sd-bales">${balesHtml(st, locked)}</div>
            <h4 class="sd-h4">Pistoni's proforma invoice <span class="sd-internal">Internal — never printed on Enviroware's documents</span></h4>
            ${supplierInvoiceHtml(st, locked)}
            <div id="sd-confirm">${confirmHtml(st)}</div>`;
    }

    function balesHtml(st, locked = false) {
        const { min, max } = st.view.baleRange || { min: 150, max: 650 };
        const bales = st.review.bales || [];
        if (!bales.length) return '<p class="sd-muted">Upload Pistoni\'s packing list, or add / paste bales by hand.</p>';
        return bales.map((b, i) => {
            const odd = b.kg != null && (b.kg < min || b.kg > max);
            const cls = `sd-bale sd-bale--${b.colour || 'none'}${odd ? ' sd-bale--odd' : ''}`;
            const title = odd ? `Outside ${min}–${max} kg — check for a misread` : '';
            if (locked) {
                return `<div class="${cls} sd-bale--ro" title="${title}"><span class="sd-bale-n">${esc(b.n ?? '')}</span><span class="sd-bale-kgv">${esc(kg(b.kg))}</span><span class="sd-bale-cv">${b.colour === 'white' ? 'White' : b.colour === 'coloured' ? 'Coloured' : '?'}</span></div>`;
            }
            return `<div class="${cls}" title="${title}">
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

    function supplierInvoiceHtml(st, locked = false) {
        const inv = st.review.supplierInvoice;
        if (!inv) return locked ? '<p class="sd-muted">None entered.</p>' : `<p class="sd-muted">Upload Pistoni's proforma, or <button class="btn-link" data-act="manual-invoice">enter its figures by hand</button>.</p>`;
        const fromPdf = !!st.view.record.extractions?.proforma;
        const ccy = inv.currency || '';
        const fig = (path, val, raw, fmt) => figure(st, 'review', path, val, raw, fmt, { fromPdf, locked });
        const txt = (label, html) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${html}</div></div>`;
        return `<div class="sd-grid4">
                ${locked ? txt('Document no.', `<span class="sd-val">${esc(inv.number || '—')}</span>`) : `<label class="sd-field"><span class="imp-field-label">Document no.</span><input class="sd-input" data-path="supplierInvoice.number" value="${esc(inv.number)}"></label>`}
                ${locked ? txt('Date', `<span class="sd-val">${esc(day(inv.date) || '—')}</span>`) : `<label class="sd-field"><span class="imp-field-label">Date</span><input class="sd-input" type="date" data-path="supplierInvoice.date" value="${esc(inv.date)}"></label>`}
                ${locked ? txt('Currency', `<span class="sd-val">${esc(ccy || '—')}</span>`) : `<label class="sd-field"><span class="imp-field-label">Currency</span><input class="sd-input" data-path="supplierInvoice.currency" value="${esc(ccy)}" maxlength="3"></label>`}
                ${txt('Net weight (as printed)', fig('supplierInvoice.netKg', inv.netKg, inv.netKgRaw, kg))}
            </div>
            <table class="sd-lines">
                <thead><tr><th>Line (as printed)</th><th class="r">Weight</th><th class="r">Unit price</th><th class="r">Amount</th>${locked ? '' : '<th class="sd-x-col"></th>'}</tr></thead>
                <tbody>${(inv.lines || []).map((l, i) => `<tr>
                    <td>${locked ? `${esc(l.description || '—')}${colourTag(l.description, l.colour)}`
                        : `<div class="sd-line-desc"><input class="sd-input" data-path="supplierInvoice.lines.${i}.description" value="${esc(l.description)}" placeholder="As printed, e.g. TOECLIPS BIANCHI">
                           <select class="sd-input sd-colour" data-path="supplierInvoice.lines.${i}.colour" aria-label="Colour"><option value="" ${!l.colour ? 'selected' : ''}>Colour?</option><option value="white" ${l.colour === 'white' ? 'selected' : ''}>White</option><option value="coloured" ${l.colour === 'coloured' ? 'selected' : ''}>Coloured</option></select></div>`}</td>
                    <td class="r">${fig(`supplierInvoice.lines.${i}.kg`, l.kg, l.kgRaw, kg)}</td>
                    <td class="r">${fig(`supplierInvoice.lines.${i}.unitPrice`, l.unitPrice, l.unitPriceRaw, n => perKg(n, ccy))}</td>
                    <td class="r">${fig(`supplierInvoice.lines.${i}.amount`, l.amount, l.amountRaw, n => money(n, ccy))}</td>
                    ${locked ? '' : `<td class="sd-x-col"><button class="sd-bale-x" data-act="del-line" data-i="${i}" title="Remove line">×</button></td>`}</tr>`).join('')}
                </tbody>
                <tfoot><tr><th colspan="3" class="r">Total (as printed)</th><td class="r">${fig('supplierInvoice.total', inv.total, inv.totalRaw, n => money(n, ccy))}</td>${locked ? '' : '<td></td>'}</tr></tfoot>
            </table>
            ${locked ? '' : '<div class="sd-table-foot"><button class="btn-link" data-act="add-line">+ Add line</button></div>'}
            ${inv.destination || inv.deliveryTerms ? `<p class="sd-muted">Destination: ${esc(inv.destination || '—')} · Terms: ${esc(inv.deliveryTerms || '—')}${inv.hsCode ? ' · HS ' + esc(inv.hsCode) : ''}</p>` : ''}`;
    }

    function confirmHtml(st) {
        const v = st.view;
        const fails = v.checks.filter(blocking);
        const c = v.record.confirmed;
        const t = v.reviewTotals;
        const s = v.shipment;
        const weightsDiffer = st.opts.applyShipPatch && t.count && (Math.round(s.whiteRawKg) !== Math.round(t.whiteKg) || Math.round(s.colourRawKg) !== Math.round(t.colouredKg));
        if (c && !v.unconfirmedChanges) {
            return weightsDiffer ? `<div class="sd-note">This shipment's Net Weight Breakdown still shows white ${kg(s.whiteRawKg)} / coloured ${kg(s.colourRawKg)}. <button class="btn-link" data-act="apply-weights">Update it to ${kg(t.whiteKg)} / ${kg(t.colouredKg)}</button></div>` : '';
        }
        return `<div class="sd-confirm-bar">
            ${c ? '<div class="sd-warn-text">Changed since the last confirm — the documents use the confirmed figures until you confirm again.</div>' : ''}
            ${weightsDiffer ? `<label class="sd-check-line"><input type="checkbox" id="sd-apply-weights" checked>
                Also update this shipment's Net Weight Breakdown: white ${kg(s.whiteRawKg)} → <strong>${kg(t.whiteKg)}</strong>, coloured ${kg(s.colourRawKg)} → <strong>${kg(t.colouredKg)}</strong></label>` : ''}
            <div class="sd-confirm-row"><button class="btn-primary" data-act="confirm" ${fails.length || !t.count ? 'disabled' : ''}>Confirm ${t.count || ''} bales</button>
                <span class="sd-muted">${fails.length ? `<span class="sd-err">Fix or dismiss ${fails.length} failing check${fails.length > 1 ? 's' : ''} first.</span> ` : ''}Locks this section; our proforma invoice (section 3) and the documents use these figures.</span></div>
        </div>`;
    }

    // ── Our proforma invoice ─────────────────────────────────────────────
    function invoiceHtml(st) {
        const v = st.view, r = v.record, ei = r.exportInvoice, d = v.defaults, t = v.confirmedTotals;
        const stat = sectionStatus(st)[3];
        if (!r.confirmed) return `${sectionHd(3, 'Our proforma invoice to JPS', stat)}<p class="sd-muted">Confirm the bales in section 2 first — the amount comes from their net weight.</p>`;
        const amount = `${kg(t.netKg)} × ${perKg(ei.rate, ei.currency)} = <strong>${money(amountOf(t.netKg, ei.rate), ei.currency)}</strong>`;
        const field = (label, html, note = '') => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${html}</div>${note ? `<span class="sd-muted">${note}</span>` : ''}</div>`;
        if (eiConfirmed(ei)) {
            return `${sectionHd(3, 'Our proforma invoice to JPS', stat, '<button class="btn-secondary btn-sm" data-act="unlock-ei">Unlock to edit</button>')}
                <p class="sd-lockline">🔒 Confirmed${ei.confirmedAt ? ' ' + esc(when(ei.confirmedAt)) : ''}${esc(by(ei.confirmedBy))}.</p>
                <div class="sd-grid4">
                    ${field('Invoice no.', `<span class="sd-val">${esc(ei.number)}</span>`)}
                    ${field('Date', `<span class="sd-val">${esc(day(ei.date))}</span>`, 'Printed on the draft packing list and our proforma')}
                    ${field('Rate', `<span class="sd-val">${esc(perKg(ei.rate, ei.currency))}</span>`)}
                    ${field('Amount (calculated)', `<span class="sd-val">${amount}</span>`)}
                </div>`;
        }
        const numOk = /^\d+\s*\/\s*\d{4}$/.test(String(ei.number || '').trim()), rateOk = Number(ei.rate) > 0;
        return `${sectionHd(3, 'Our proforma invoice to JPS', stat)}
            <div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">Invoice no.</span><input class="sd-input" id="sd-ei-number" value="${esc(ei.number)}">
                    ${d.number && d.number !== ei.number ? `<span class="sd-muted">Next in sequence: ${esc(d.number)} · <button class="btn-link" data-act="use-suggested">Use it</button></span>` : ''}</label>
                <label class="sd-field"><span class="imp-field-label">Date</span><input class="sd-input" type="date" id="sd-ei-date" value="${esc(ei.date)}">
                    <span class="sd-muted">Printed on the draft packing list and our proforma</span></label>
                <label class="sd-field"><span class="imp-field-label">Rate (${esc(ei.currency)}/kg)</span><input class="sd-input sd-num" type="number" step="0.0001" id="sd-ei-rate" value="${ei.rate ?? ''}">
                    ${d.rate != null && Number(d.rate) !== Number(ei.rate) ? `<span class="sd-muted">Usual ${esc(perKg(d.rate, ei.currency))} (${esc(d.rateSource || '')})</span>` : ''}</label>
                ${field('Amount (calculated)', `<span class="sd-val" id="sd-ei-amount">${amount}</span>`)}
            </div>
            <div class="sd-confirm-row"><button class="btn-primary" data-act="confirm-ei" ${numOk && rateOk ? '' : 'disabled'}>Confirm our proforma invoice</button>
                <span class="sd-muted">${!numOk ? '<span class="sd-err">The number must look like 102/2026.</span> ' : ''}${!rateOk ? '<span class="sd-err">Enter the rate.</span> ' : ''}Needed before generating the draft documents and creating it in Xero.</span></div>`;
    }

    // ── Documents ────────────────────────────────────────────────────────
    // Every document row is the same: what it is, whether a copy has been
    // generated, and Preview · Download PDF · .xlsx · Generate.
    function issuesHtml(list) {
        return list.length ? `<ul class="sd-issues">${list.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '';
    }
    function docRowHtml(st, { name, doc, stage, issues = [], xlsx = false, preview, gen, genLabel, note = '' }) {
        const v = st.view, b = base(v.shipment.id);
        const out = latestOut(v.record, doc, stage);
        return `<div class="sd-docrow">
            <div><strong>${esc(name)}</strong>
                <div class="sd-muted">${out ? `Copy generated ${esc(when(out.at))}${esc(by(out.by))}` : 'No copy generated yet'}${note ? ' · ' + note : ''}</div>
                ${issuesHtml(issues)}</div>
            <div class="sd-docrow-act">
                <a class="btn-secondary btn-sm" href="${b}/render?${preview}" target="_blank" rel="noopener" title="How it would print with today's figures — not an issued copy">Preview</a>
                ${out ? `<a class="btn-secondary btn-sm" href="${b}/render?out=${encodeURIComponent(out.key)}&download=1" target="_blank" rel="noopener" title="${esc(out.filename || '')}">Download PDF</a>` : ''}
                ${xlsx ? `<a class="btn-secondary btn-sm" href="${b}/xlsx${out ? '?out=' + encodeURIComponent(out.key) : ''}">.xlsx</a>` : ''}
                ${gen ? `<button class="btn-primary btn-sm" data-act="${gen}" ${issues.length ? 'disabled' : ''}>${out ? 'Generate again' : esc(genLabel)}</button>` : ''}
            </div></div>`;
    }

    function docsHtml(st) {
        const v = st.view, r = v.record, g = v.generation;
        const stat = sectionStatus(st)[4];
        if (!r.confirmed || !eiConfirmed(r.exportInvoice)) {
            return `${sectionHd(4, 'Draft documents for Paul', stat)}<p class="sd-muted">${!r.confirmed ? 'Confirm the bales (section 2) and our proforma invoice (section 3) first.' : 'Confirm our proforma invoice (section 3) first.'}</p>`;
        }
        const ready = !g.packingDraft.length && !g.proforma.length;
        return `${sectionHd(4, 'Draft documents for Paul', stat)}
            ${docRowHtml(st, { name: 'Draft packing list', doc: 'packing', stage: 'draft', issues: g.packingDraft, xlsx: true, preview: 'doc=packing&stage=draft' })}
            ${docRowHtml(st, { name: 'Our proforma invoice', doc: 'proforma', stage: 'draft', issues: g.proforma, preview: 'doc=proforma' })}
            <div class="sd-gen"><button class="btn-primary" data-act="gen-draft" ${ready ? '' : 'disabled'}>${latestOut(r, 'packing', 'draft') ? 'Generate both again' : 'Generate both'}</button>
                <span class="sd-muted">Keeps a fixed copy of each to download and send to Paul. Nothing is emailed or put in Drive.</span></div>`;
    }

    // ── LC details and final ─────────────────────────────────────────────
    function finalHtml(st) {
        const v = st.view, lc = v.record.lc || {}, g = v.generation, L = v.linkedLc;
        const stat = sectionStatus(st)[7];
        if (!v.record.confirmed) return `${sectionHd(7, 'LC details and final packing list', stat)}<p class="sd-muted">After the draft documents have gone to Paul and JPS has opened the LC.</p>`;
        const useLc = L && (L.lcNumber !== lc.number || (L.issuedDate && L.issuedDate !== lc.date));
        return `${sectionHd(7, 'LC details and final packing list', stat)}
            ${L ? `<p class="sd-muted">Linked LC on the Letter of Credit tab: <strong>${esc(L.lcNumber)}</strong>${L.issuedDate ? `, issued ${esc(day(L.issuedDate))}` : ''}${useLc ? ` · <button class="btn-link" data-act="use-lc">Use these</button>` : ''}</p>` : '<p class="sd-muted">No LC is linked to this shipment yet (Letter of Credit tab). You can still enter the details here.</p>'}
            <div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">LC no.</span><input class="sd-input" id="sd-lc-number" value="${esc(lc.number || '')}"></label>
                <label class="sd-field"><span class="imp-field-label">LC date of issue</span><input class="sd-input" type="date" id="sd-lc-date" value="${esc(lc.date || '')}"></label>
                <label class="sd-field"><span class="imp-field-label">Gross weight (kg)</span><input class="sd-input sd-num" type="number" step="any" id="sd-lc-gross" value="${lc.grossKg ?? ''}">
                    <span class="sd-muted">Net is ${kg(v.confirmedTotals.netKg)}</span></label>
                <div class="sd-field sd-field--btn"><button class="btn-secondary btn-sm" data-act="save-lc">Save LC details</button></div>
            </div>
            ${v.lcChecks.length ? checkListHtml(v.lcChecks, 'sd-checks--compact') : ''}
            ${docRowHtml(st, { name: 'Final packing list', doc: 'packing', stage: 'final', issues: g.packingFinal, xlsx: true, preview: 'doc=packing&stage=final', gen: 'gen-final', genLabel: 'Generate final' })}`;
    }

    // ── JPS's proforma invoice ───────────────────────────────────────────
    function splitHtml(v) {
        const sp = v.jpsSplit, ei = v.record.exportInvoice || {};
        if (!sp) return '';
        return `<div class="sd-split">
            <div><strong>${money(sp.total, sp.currency)}</strong> on JPS's proforma invoice is made up of</div>
            <div class="sd-split-row"><span>LC deposit</span><span>${money(sp.depositAmount, sp.currency)}</span><span class="sd-muted">${kg(sp.netKg)} × ${perKg(sp.depositRate, sp.currency)} — our proforma invoice ${esc(ei.number || '')}; the LC pays this back</span></div>
            <div class="sd-split-row"><span>Handling &amp; sorting</span><span>${money(sp.handlingAmount, sp.currency)}</span><span class="sd-muted">${perKg(sp.handlingRate, sp.currency)} — JPS's margin, the real cost</span></div>
        </div>`;
    }

    function jpsHtml(st) {
        const v = st.view, j = st.jps, r = v.record;
        const locked = !!r.jpsConfirmed;
        const extra = locked ? '<button class="btn-secondary btn-sm" data-act="unlock-jps">Unlock to edit</button>' : '<span class="sd-muted" id="sd-jps-savestate"></span>';
        const hd = `${sectionHd(5, "JPS's proforma invoice", sectionStatus(st)[5], j ? extra : '')}
            <p class="sd-callout">Paying this invoice is what gets JPS to open the LC. It is our proforma amount (the LC deposit) plus JPS's handling &amp; sorting.</p>`;
        if (!r.confirmed) return hd + '<p class="sd-muted">Confirm the bales in section 2 first.</p>';
        const fromPdf = !!r.extractions?.jpsInvoice;
        const ccy = j?.currency || '';
        const fig = (path, val, raw, fmt) => figure(st, 'jps', path, val, raw, fmt, { fromPdf, locked });
        const txt = (label, html) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${html}</div></div>`;
        const inp = (label, path, val, attrs = '', placeholder = '') => locked
            ? txt(label, `<span class="sd-val">${esc(attrs.includes('date') ? day(val) || '—' : (val || '—'))}</span>`)
            : `<label class="sd-field"><span class="imp-field-label">${esc(label)}</span><input class="sd-input" data-jps="${path}" value="${esc(val || '')}" ${attrs}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}></label>`;
        const fails = (v.jpsChecks || []).filter(blocking);
        return `${hd}
            <div class="sd-uploads sd-uploads--one">${uploadCardHtml(v, 'jpsInvoice', "JPS's proforma invoice (PDF)", "JPS Enterprise's sales proforma invoice to Enviroware")}</div>
            ${!j ? `<p class="sd-muted">Or <button class="btn-link" data-act="manual-jps">enter it by hand</button>.</p>` : `
            ${locked ? `<p class="sd-lockline">🔒 Confirmed ${esc(when(r.jpsConfirmed.at))}${esc(by(r.jpsConfirmed.by))}. The JPS bill and the signed copy use these figures.</p>` : ''}
            <div class="sd-grid4">
                ${inp('Invoice no.', 'number', j.number)}
                ${inp('Date', 'date', j.date, 'type="date"')}
                ${inp('Currency', 'currency', j.currency, 'maxlength="3"')}
                ${txt('Total (as printed)', fig('total', j.total, j.totalRaw, n => money(n, ccy)))}
            </div>
            ${(j.lines || []).length ? `<table class="sd-lines">
                <thead><tr><th>Line (as printed)</th><th class="r">Weight</th><th class="r">Unit price</th><th class="r">Amount</th>${locked ? '' : '<th class="sd-x-col"></th>'}</tr></thead>
                <tbody>${j.lines.map((l, i) => `<tr>
                    <td>${locked ? esc(l.description || '—') : `<input class="sd-input" data-jps="lines.${i}.description" value="${esc(l.description)}">`}</td>
                    <td class="r">${fig(`lines.${i}.kg`, l.kg, l.kgRaw, kg)}</td>
                    <td class="r">${fig(`lines.${i}.unitPrice`, l.unitPrice, l.unitPriceRaw, n => perKg(n, ccy))}</td>
                    <td class="r">${fig(`lines.${i}.amount`, l.amount, l.amountRaw, n => money(n, ccy))}</td>
                    ${locked ? '' : `<td class="sd-x-col"><button class="sd-bale-x" data-act="jps-del-line" data-i="${i}" title="Remove line">×</button></td>`}</tr>`).join('')}</tbody>
            </table>` : ''}
            ${locked ? '' : '<div class="sd-table-foot"><button class="btn-link" data-act="jps-add-line">+ Add line</button></div>'}
            <div id="sd-jps-checks">${checkListHtml(v.jpsChecks || [], 'sd-checks--compact')}</div>
            <div id="sd-jps-split">${splitHtml(v)}</div>
            <h4 class="sd-h4">Contract terms <span class="sd-muted">read from their PDF, printed on the signed copy</span></h4>
            <div class="sd-grid3">
                ${inp('Last date of shipment', 'contract.lastShipmentDate', j.contract?.lastShipmentDate, 'type="date"')}
                ${inp('Expiry date', 'contract.expiryDate', j.contract?.expiryDate, 'type="date"')}
                ${inp('Containers', 'contract.containers', j.contract?.containers, '', "1 x 40' FCL")}
            </div>
            ${locked ? '' : `<div class="sd-confirm-row" id="sd-jps-confirm"><button class="btn-primary" data-act="confirm-jps" ${fails.length ? 'disabled' : ''}>Confirm JPS's proforma invoice</button>
                <span class="sd-muted">${fails.length ? `<span class="sd-err">Fix or dismiss ${fails.length} failing check${fails.length > 1 ? 's' : ''} first.</span> ` : ''}Needed before the JPS bill goes to Xero and before the signed copy.</span></div>`}
            <div id="sd-jps-doc">${jpsDocHtml(st)}</div>`}`;
    }

    // Our corrected, signed copy of JPS's sales proforma (their template has
    // the wrong street number, typos, duplicated terms).
    function jpsDocHtml(st) {
        const g = st.view.generation?.jpsContract || [];
        return docRowHtml(st, { name: "JPS's proforma invoice — signed copy", doc: 'jps', stage: 'contract', issues: g, preview: 'doc=jps', gen: 'gen-jps', genLabel: 'Generate signed copy',
            note: 'their document rewritten without the errors, signed and sealed by you — send it to Paul to sign' });
    }

    // ── Xero ─────────────────────────────────────────────────────────────
    const XERO_WORDS = { DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', AUTHORISED: 'Awaiting payment', PAID: 'Paid', VOIDED: 'Voided', DELETED: 'Deleted' };
    const XERO_STEPS = { check: 'checking the invoice', rate: 'getting the exchange rate', tax: 'checking the tax rates', auth: 'signing in to Xero', contact: 'finding the contact', create: 'creating the invoice', refresh: 'reading back from Xero' };

    // The last failed attempt, kept on the shipment until one succeeds: what
    // Xero said, what was sent, and how far it got.
    function xeroErrorHtml(e, what) {
        if (!e) return '';
        const sent = e.sent;
        const more = (e.details || []).length || e.request || sent || e.response;
        return `<div class="sd-xerr">
            <div><strong>✗ ${esc(what)}</strong> <span class="sd-muted">${esc(when(e.at))} · ${esc(who(e.by))} · while ${esc(XERO_STEPS[e.step] || e.step || '')}</span></div>
            <div>${esc(e.message)}</div>
            ${more ? `<details><summary>What Xero said and what was sent</summary>
                ${(e.details || []).length ? `<ul class="sd-issues">${e.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
                ${e.request || e.xeroStatus != null ? `<div class="sd-muted">${esc(e.request || '')}${e.xeroStatus != null ? ` → Xero ${e.xeroStatus === 0 ? 'unreachable' : 'HTTP ' + e.xeroStatus}` : ''}</div>` : ''}
                ${sent ? `<div class="sd-muted">Sent: ${esc(sent.type)} ${esc(sent.status)} · ${esc(sent.contact || '')} · no. ${esc(sent.number || '—')} · ${esc(sent.date || '')} · ${esc(sent.currency || '')} ${fmtMoney(sent.total)}</div>
                    <ul class="sd-xerr-lines">${(sent.lines || []).map(l => `<li>${esc(l.description)} — ${fmtKg(l.quantity)} × ${fmtRate(l.unitAmount)} · account ${esc(l.accountCode || '—')} · tax ${esc(l.taxType || '—')}</li>`).join('')}</ul>` : ''}
                ${e.response ? `<pre class="sd-xerr-raw">${esc(e.response)}</pre>` : ''}
            </details>` : ''}</div>`;
    }

    function xeroHtml(st) {
        const v = st.view, docs = v.xero?.docs || [];
        const errs = v.xero?.errors || {};
        const any = docs.some(d => d.inXero);
        const statusWord = XERO_WORDS[v.xero?.status] || 'Draft';
        return `${sectionHd(6, 'Invoices in Xero', sectionStatus(st)[6], any ? `<span class="sd-muted">${v.xero.refreshedAt ? 'Checked ' + esc(when(v.xero.refreshedAt)) : ''}</span> <button class="btn-link" data-act="xero-refresh">Refresh from Xero</button>` : '')}
            <p class="sd-muted">Created as <strong>${esc(statusWord.toLowerCase())}</strong> when you click${v.xero?.currencyMode === 'foreign' ? ', in their own currency' : ', in <strong>NZD</strong> at the day\'s exchange rate (the EUR / USD amount and rate are kept on each line)'} — approve and pay them in Xero; the Hub reads back what was paid in NZD.</p>
            ${xeroErrorHtml(errs.refresh, 'Refresh from Xero failed')}
            <table class="sd-xero"><tbody>${docs.map(d => `<tr>
                <td><strong>${esc(d.label)}</strong><div class="sd-muted">${esc(d.contactName || '—')} · ${d.type === 'ACCREC' ? 'sales invoice' : 'bill'}</div></td>
                <td>${d.number ? esc(d.number) : '<span class="sd-muted">—</span>'}${d.date ? `<div class="sd-muted">${esc(day(d.date))}</div>` : ''}</td>
                <td class="r">${d.total != null ? esc(money(d.total, d.currency)) : '<span class="sd-muted">—</span>'}
                    ${d.inXero && d.pushed.fx ? `<div class="sd-muted">${esc(money(d.pushed.total, 'NZD'))} in Xero (1 NZD = ${esc(d.pushed.fx.rate.toFixed(4))} ${esc(d.pushed.fx.currency)})</div>`
                        : !d.inXero && d.nzdEstimate ? `<div class="sd-muted">≈ ${esc(money(d.nzdEstimate.total, 'NZD'))} at today's rate</div>` : ''}</td>
                <td>${d.inXero
                    ? `<span class="sd-xs sd-xs--${esc((d.pushed.status || '').toLowerCase())}">${esc(XERO_WORDS[d.pushed.status] || d.pushed.status)}</span>
                       ${d.pushed.nzdPaid ? `<div class="sd-muted">${esc(money(d.pushed.nzdPaid, 'NZD'))} paid${d.pushed.paidOn ? ' · ' + esc(day(d.pushed.paidOn)) : ''}</div>` : ''}
                       ${d.changedSincePush ? `<div class="sd-warn-text">Hub total now ${esc(money(d.total, d.currency))} — update it in Xero</div>` : ''}`
                    : (d.issues.length ? `<ul class="sd-issues">${d.issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '<span class="sd-muted">Not in Xero yet</span>')}</td>
                <td class="r">${d.inXero
                    ? `<a class="btn-link" href="${esc(d.url)}" target="_blank" rel="noopener">Open in Xero ↗</a>`
                    : `<button class="btn-secondary btn-sm" data-act="xero-push" data-doc="${esc(d.key)}" ${d.issues.length ? 'disabled' : ''}>${errs[d.key] ? 'Try again' : 'Create in Xero'}</button>`}</td>
            </tr>${!d.inXero && errs[d.key] ? `<tr><td colspan="5">${xeroErrorHtml(errs[d.key], 'Not created in Xero')}</td></tr>` : ''}`).join('')}</tbody></table>`;
    }

    // ── Cost breakdown ───────────────────────────────────────────────────
    function costHtml(st) {
        const plan = st.view.costPlan || { changes: [] };
        const hd = `${sectionHd('', 'Cost breakdown', sectionStatus(st).cost)}<p class="sd-muted sd-lead">The shipment's Overview, filled from these documents and Xero.</p>`;
        if (!st.view.record.confirmed) return hd + '<p class="sd-muted">Confirm the bales first.</p>';
        if (!plan.changes.length) return hd + '<p class="sd-muted">Every cost line already matches these documents and Xero.</p>';
        return `${hd}
            <table class="sd-xero"><tbody>${plan.changes.map(c => `<tr>
                <td><strong>${esc(c.label)}</strong><div class="sd-muted">from ${esc(c.source)}</div></td>
                <td class="sd-muted">${esc(c.from)}</td><td>→</td><td><strong>${esc(c.to)}</strong></td></tr>`).join('')}</tbody></table>
            ${st.opts.applyShipPatch ? `<div class="sd-gen"><button class="btn-primary btn-sm" data-act="apply-cost">Update cost breakdown</button></div>` : ''}`;
    }

    const DOC_NAMES = { 'packing:draft': 'Draft packing list', 'packing:final': 'Final packing list', 'proforma:draft': 'Our proforma invoice', 'jps:contract': "JPS's proforma invoice — signed copy" };

    function historyHtml(st) {
        const v = st.view, r = v.record, b = base(v.shipment.id);
        const outs = r.outputs || [];
        return `<section class="ship-det-section">
            ${sectionHd('', 'Generated documents', null)}
            ${outs.length ? `<table class="sd-outs"><tbody>${outs.map(o => `<tr>
                <td><strong>${esc(DOC_NAMES[`${o.doc}:${o.stage || 'draft'}`] || o.name)}</strong><div class="sd-muted">${esc(o.filename)}</div></td>
                <td>${o.invoiceNumber ? `${esc(o.invoiceNumber)} · ${esc(money(o.amount, o.currency))}` : ''}${o.lcNumber ? `LC ${esc(o.lcNumber)} · gross ${esc(kg(o.grossKg))}` : ''}${!o.invoiceNumber && !o.lcNumber ? `${o.packages} bales · ${esc(kg(o.netKg))}` : ''}</td>
                <td class="sd-muted">${esc(when(o.at))}${esc(by(o.by))}</td>
                <td class="r sd-outs-act"><a class="btn-link" href="${b}/render?out=${encodeURIComponent(o.key)}" target="_blank" rel="noopener">Open</a> · <a class="btn-link" href="${b}/render?out=${encodeURIComponent(o.key)}&download=1" target="_blank" rel="noopener">Download PDF</a>${o.doc === 'packing' ? ` · <a class="btn-link" href="${b}/xlsx?out=${encodeURIComponent(o.key)}">.xlsx</a>` : ''}</td></tr>`).join('')}</tbody></table>`
                : '<p class="sd-muted">None yet.</p>'}
            <details class="sd-details"><summary>Supplier files and activity</summary>
                ${(r.fileHistory || []).map(f => `<div class="sd-muted">📄 <a href="${b}/file?key=${encodeURIComponent(f.key)}" target="_blank" rel="noopener">${esc(f.filename)}</a> · ${esc({ proforma: "Pistoni's proforma", packingList: "Pistoni's packing list", jpsInvoice: "JPS's proforma" }[f.kind] || f.kind)} · ${esc(when(f.uploadedAt))}${esc(by(f.by))}</div>`).join('') || '<div class="sd-muted">No files yet.</div>'}
                <ul class="sd-log">${(r.log || []).map(l => `<li><span class="sd-muted">${esc(when(l.at))}${esc(by(l.by))}</span> ${esc(l.action)}</li>`).join('')}</ul>
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
            rate.addEventListener('input', () => { $(st, '#sd-ei-amount').innerHTML = `${kg(t.netKg)} × ${esc(perKg(rate.value, ccy))} = <strong>${esc(money(amountOf(t.netKg, rate.value), ccy))}</strong>`; });
            rate.addEventListener('change', () => saveInvoice(st, { rate: num(rate.value) }));
            $(st, '#sd-ei-number').addEventListener('change', e => saveInvoice(st, { number: e.target.value.trim() }));
            $(st, '#sd-ei-date').addEventListener('change', e => saveInvoice(st, { date: e.target.value }));
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
        // Typed figures: plain digits while editing, separators otherwise.
        p.addEventListener('focusin', e => { const el = e.target; if (el.dataset?.num !== undefined) el.value = el.value.replace(/[,\s]/g, ''); });
        p.addEventListener('focusout', e => { const el = e.target; if (el.dataset?.num !== undefined) el.value = showNum(readNum(el), Number(el.dataset.num)); });
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
        const numeric = el.type === 'number' || el.dataset.num !== undefined;
        setPath(st.review, path, numeric ? (el.dataset.num !== undefined ? readNum(el) : num(el.value)) : el.value);
        if (/^bales\.\d+\.colour$/.test(path)) el.closest('.sd-bale').className = `sd-bale sd-bale--${el.value || 'none'}`;
        markCorrected(st, el, 'review:' + path);
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
    function refreshStatus(st) {
        const s = sectionStatus(st);
        for (const n of [2, 3, 4, 5, 6]) {
            const el = $(st, '#sd-stat-' + n);
            if (el && s[n]) { el.className = `sd-sstat sd-sstat--${s[n].kind}`; el.textContent = `${STAT_ICON[s[n].kind]} ${s[n].text}`; }
        }
        const rc = $(st, '#sd-rc'), html = reconHtml(st.view);
        if (rc && html) rc.outerHTML = html;
    }

    function refreshReviewBits(st) {
        refreshStatus(st);
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
        setPath(st.jps, el.dataset.jps, el.dataset.num !== undefined ? readNum(el) : el.type === 'number' ? num(el.value) : el.value);
        markCorrected(st, el, 'jps:' + el.dataset.jps);
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
            const jd = $(st, '#sd-jps-doc'); if (jd) jd.innerHTML = jpsDocHtml(st);
            const jc = $(st, '#sd-jps-confirm');
            if (jc) { const f = (st.view.jpsChecks || []).filter(blocking).length; jc.querySelector('button').disabled = !!f; }
            refreshStatus(st);
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
            const y = window.scrollY;
            const view = await send(base(st.ship.id), 'PATCH', { exportInvoice: ei });
            setView(st, view); draw(st);
            window.scrollTo(0, y);
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
        if (['settings', 'save-lc', 'gen-draft', 'gen-final', 'gen-jps', 'apply-weights', 'apply-cost', 'xero-push', 'xero-refresh', 'dismiss-check', 'restore-check',
            'unlock-bales', 'confirm-ei', 'unlock-ei', 'use-suggested', 'confirm-jps', 'unlock-jps'].includes(a)) await flushSave(st);
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
                { description: '', colour: 'white', kg: null, unitPrice: null, amount: null },
                { description: '', colour: 'coloured', kg: null, unitPrice: null, amount: null },
            ], netKg: null, total: null };
            $(st, '#sd-review').innerHTML = reviewHtml(st);
            return scheduleSave(st, 0);
        }
        if (a === 'add-line') { r.supplierInvoice.lines.push({ description: '', colour: '', kg: null, unitPrice: null, amount: null }); $(st, '#sd-review').innerHTML = reviewHtml(st); return scheduleSave(st, 0); }
        if (a === 'del-line') { r.supplierInvoice.lines.splice(Number(btn.dataset.i), 1); $(st, '#sd-review').innerHTML = reviewHtml(st); return scheduleSave(st, 0); }
        if (a === 'manual-jps') {
            st.jps = { number: '', date: '', currency: st.view.record.exportInvoice?.currency || 'USD', lines: [], netKg: null, total: null, contract: { lastShipmentDate: '', expiryDate: '', containers: '' } };
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
            } catch (e) {
                console.error('Xero: not created', d.key, e.body || e);
                toast('Not created in Xero: ' + e.message);
                await showLatest(st);
            }
            return;
        }
        if (a === 'xero-refresh') {
            btn.disabled = true; btn.textContent = 'Checking Xero…';
            try { setView(st, await send(`${base(st.ship.id)}/xero`, 'POST', { refresh: true })); draw(st); }
            catch (e) { console.error('Xero: refresh failed', e.body || e); toast('Could not read Xero: ' + e.message); await showLatest(st); }
            return;
        }
        if (a === 'apply-cost') {
            if (!st.opts.applyShipPatch) return;
            btn.disabled = true; btn.textContent = 'Updating…';
            try { await st.opts.applyShipPatch(st.view.costPlan.patch); toast('Cost breakdown updated'); }
            catch (e) { toast('Could not update the cost breakdown: ' + e.message); btn.disabled = false; btn.textContent = 'Update cost breakdown'; }
            return;
        }
        if (a === 'edit-field') {
            // ✎ on a printed figure: switch it to an input, keep the page where it is
            const [store, ...rest] = btn.dataset.field.split(':');
            const path = rest.join(':');
            st.editing.add(btn.dataset.field);
            if (store === 'jps') $(st, '#sd-jps').innerHTML = jpsHtml(st); else $(st, '#sd-review').innerHTML = reviewHtml(st);
            const inp = st.panel.querySelector(`[data-${store === 'jps' ? 'jps' : 'path'}="${CSS.escape(path)}"]`);
            if (inp) { inp.focus(); inp.select?.(); }
            return;
        }
        if (a === 'unlock-bales') {
            if (!confirm("Unlock section 2 to edit the bales and Pistoni's figures?\n\nThe confirmation is cleared: documents and Xero wait until you confirm again. Copies already generated and invoices already in Xero are not changed.")) return;
            return redrawWith(st, send(`${base(st.ship.id)}/confirm`, 'POST', { unlock: true }), 'Section 2 unlocked');
        }
        if (a === 'confirm-ei') return saveInvoice(st, { numberConfirmed: true, rateConfirmed: true });
        if (a === 'unlock-ei') {
            if (!confirm('Unlock our proforma invoice to edit it?\n\nIts confirmation is cleared until you confirm it again.')) return;
            return saveInvoice(st, { numberConfirmed: false, rateConfirmed: false });
        }
        if (a === 'use-suggested') return saveInvoice(st, { number: st.view.defaults.number });
        if (a === 'confirm-jps') return redrawWith(st, send(base(st.ship.id), 'PATCH', { jpsConfirm: true }), "JPS's proforma invoice confirmed");
        if (a === 'unlock-jps') {
            if (!confirm("Unlock JPS's proforma invoice to edit it?\n\nIts confirmation is cleared: the JPS bill and the signed copy wait until you confirm it again.")) return;
            return redrawWith(st, send(base(st.ship.id), 'PATCH', { jpsConfirm: false }), "JPS's proforma invoice unlocked");
        }
        if (a === 'toggle-passed') {
            const pop = btn.nextElementSibling;
            const open = pop.hidden;
            closePassedPopovers();
            pop.hidden = !open;
            btn.setAttribute('aria-expanded', String(open));
            return;
        }
        if (a === 'dismiss-check' || a === 'restore-check') {
            const id = btn.dataset.check;
            const all = [...(st.view.checks || []), ...(st.view.jpsChecks || []), ...(st.view.lcChecks || [])];
            const c = all.find(x => x.id === id);
            if (a === 'dismiss-check' && c && c.level === 'block'
                && !confirm(`Dismiss "${c.title}"?\n\n${c.detail}\n\nIt will stop blocking, and the dismissal is logged under your name. If these figures change and the check fails differently, it comes back.`)) return;
            btn.disabled = true;
            try {
                const y = window.scrollY;
                setView(st, await send(base(st.ship.id), 'PATCH', a === 'dismiss-check' ? { dismiss: id } : { restore: id }));
                draw(st);
                window.scrollTo(0, y);
                toast(a === 'dismiss-check' ? `Dismissed: ${c ? c.title : 'check'}` : `Check restored`);
            } catch (e) { toast('Not changed: ' + e.message); btn.disabled = false; }
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
        if (a === 'gen-draft' || a === 'gen-final' || a === 'gen-jps') {
            btn.disabled = true; const label = btn.textContent; btn.textContent = 'Generating…';
            try {
                const docs = a === 'gen-draft' ? [{ doc: 'packing', stage: 'draft' }, { doc: 'proforma' }] : a === 'gen-jps' ? [{ doc: 'jps' }] : [{ doc: 'packing', stage: 'final' }];
                const view = await send(`${base(st.ship.id)}/render`, 'POST', { docs });
                setView(st, view); draw(st);
                toast(`Generated ${view.generated.map(g => g.name.toLowerCase()).join(' and ')} — open each below to print or save as PDF`);
            } catch (e) { toast('Not generated: ' + e.message); btn.disabled = false; btn.textContent = label; }
        }
    }

    // Passed-checks popovers close on a click elsewhere or Escape.
    function closePassedPopovers(except) {
        document.querySelectorAll('.sd-passed-pop:not([hidden])').forEach(pop => {
            if (except && pop.parentElement.contains(except)) return;
            pop.hidden = true;
            pop.previousElementSibling?.setAttribute('aria-expanded', 'false');
        });
    }
    document.addEventListener('click', e => closePassedPopovers(e.target));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closePassedPopovers(); });

    // Run a request that returns the view, redraw in place, say what happened.
    async function redrawWith(st, promise, done) {
        try {
            const y = window.scrollY;
            setView(st, await promise);
            st.editing.clear();
            draw(st);
            window.scrollTo(0, y);
            if (done) toast(done);
        } catch (e) { toast('Not done: ' + e.message); }
    }

    // After a failed Xero call: reload so the error the server saved shows up.
    async function showLatest(st) {
        try {
            const y = window.scrollY;
            setView(st, await api(base(st.ship.id)));
            draw(st);
            window.scrollTo(0, y);
        } catch (_) { /* the toast already said what went wrong */ }
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
        [['Address', s.buyer.addressLines], ['IRC no.', s.identifiers.irc], ['Applicant TIN', s.identifiers.applicantTin], ['Applicant BIN', s.identifiers.applicantBin], ['Bank TIN', s.identifiers.bankTin], ['Bank BIN', s.identifiers.bankBin], ['Bank VAT reg no.', s.identifiers.bankVatReg]]
            .forEach(([l, v]) => blank(v) && gaps.jps.push(l));
        [["Their bank", s.jps?.bank?.name], ["Their SWIFT", s.jps?.bank?.swift], ['Signs for JPS', s.jps?.signatory]].forEach(([l, v]) => blank(v) && gaps.jps.push(l));
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
        const taxSel = (label, path, val, opts) => `<label class="sd-field"><span class="imp-field-label">${esc(label)}</span><select class="sd-input" data-s="${path}">${opts.map(([v, l]) => `<option value="${v}" ${val === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
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
                <h4 class="sd-h4">Signature and seal <span class="sd-muted">on the packing lists, the proforma and the signed JPS contract</span></h4>
                <div class="sd-images">${image('signature')}${image('seal')}</div>`,
            jps: `
                <div class="sd-grid3">${inp('Name', 'buyer.name', s.buyer.name)}${ta('Address (one line each)', 'buyer.addressLines', s.buyer.addressLines, 4)}</div>
                <h4 class="sd-h4">Applicant numbers <span class="sd-muted">checked against each shipment's LC</span></h4>
                <div class="sd-grid3">${inp('IRC no.', 'identifiers.irc', s.identifiers.irc)}${inp('Applicant TIN', 'identifiers.applicantTin', s.identifiers.applicantTin)}${inp('Applicant BIN', 'identifiers.applicantBin', s.identifiers.applicantBin)}
                    ${inp("Applicant's bank", 'identifiers.bankName', s.identifiers.bankName)}${inp('Bank TIN', 'identifiers.bankTin', s.identifiers.bankTin)}${inp('Bank BIN', 'identifiers.bankBin', s.identifiers.bankBin)}
                    ${inp('Bank VAT reg no.', 'identifiers.bankVatReg', s.identifiers.bankVatReg)}</div>
                <h4 class="sd-h4">Their own details <span class="sd-muted">on the signed copy of their sales proforma</span></h4>
                <div class="sd-grid3">${inp('Phone', 'jps.phone', s.jps.phone)}${inp('Email', 'jps.email', s.jps.email)}${inp('Signs for JPS', 'jps.signatory', s.jps.signatory)}
                    ${inp('Their bank', 'jps.bank.name', s.jps.bank.name)}${inp('SWIFT', 'jps.bank.swift', s.jps.bank.swift)}${ta('Bank address', 'jps.bank.addressLines', s.jps.bank.addressLines, 2)}
                    ${inp('Port of loading', 'jps.portOfLoading', s.jps.portOfLoading)}${inp('Destination', 'jps.destination', s.jps.destination)}${inp('Freight terms', 'jps.freightTerms', s.jps.freightTerms)}</div>`,
            documents: `
                <div class="sd-grid3">${inp('HS code', 'hsCode', s.hsCode)}${inp('Packing — draft packing list', 'packingSpec.draft', s.packingSpec.draft)}${inp('Packing — final packing list', 'packingSpec.final', s.packingSpec.final)}</div>
                <p class="sd-warn-text">Match the packing wording in this shipment's LC — earlier LCs required exactly “export standard seaworthy packaging”.</p>
                <div class="sd-grid1">${ta('Proforma terms & conditions (one per line)', 'terms', s.terms, 7)}</div>`,
            xero: `
                <div class="sd-grid3">${inp('Pistoni contact', 'xero.supplierContact', s.xero.supplierContact)}${inp('JPS contact', 'xero.buyerContact', s.xero.buyerContact)}
                    <label class="sd-field"><span class="imp-field-label">Currency in Xero</span><select class="sd-input" data-s="xero.currencyMode">
                    ${[['nzd', 'NZD, converted at the day\'s rate'], ['foreign', 'EUR / USD (needs multi-currency in Xero)']].map(([v, l]) => `<option value="${v}" ${(s.xero.currencyMode || 'nzd') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                    <label class="sd-field"><span class="imp-field-label">Create invoices as</span><select class="sd-input" data-s="xero.status">
                    ${[['DRAFT', 'Draft'], ['SUBMITTED', 'Awaiting approval'], ['AUTHORISED', 'Awaiting payment']].map(([v, l]) => `<option value="${v}" ${s.xero.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
                <h4 class="sd-h4">Account codes <span class="sd-muted">your accountant's choice — nothing goes to Xero until they're set</span></h4>
                <div class="sd-grid4">${inp('Raw product (Pistoni bill)', 'xero.accounts.rawProduct', s.xero.accounts.rawProduct)}${inp('LC deposit (JPS bill)', 'xero.accounts.lcDeposit', s.xero.accounts.lcDeposit)}
                    ${inp('Handling & sorting (JPS bill)', 'xero.accounts.handling', s.xero.accounts.handling)}${inp('Export sale (our proforma)', 'xero.accounts.exportSale', s.xero.accounts.exportSale)}</div>
                <div class="sd-grid4">${taxSel('Tax rate on our proforma', 'xero.taxTypes.exportSale', s.xero.taxTypes?.exportSale || 'ZERORATED', [['ZERORATED', 'Zero Rated'], ['NONE', 'No GST'], ['OUTPUT2', 'GST on Income (15%)']])}
                    ${taxSel('Tax rate on the bills', 'xero.taxTypes.purchases', s.xero.taxTypes?.purchases || 'NONE', [['NONE', 'No GST'], ['GSTONIMPORTS', 'GST on Imports'], ['INPUT2', 'GST on Expenses (15%)']])}</div>`,
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
