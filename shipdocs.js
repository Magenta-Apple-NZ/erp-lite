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
        // open: sections showing their details (the step being worked on, then whatever you open).
        const st = { panel, ship, opts, view: null, review: null, jps: null, saveTimer: null, jpsTimer: null, editing: new Set(), open: null };
        panel.innerHTML = '<div class="ship-lc-loading">Loading export documents…</div>';
        wireOnce(st);
        load(st);
        return { reload: () => load(st) };
    }

    async function load(st) {
        try {
            setView(st, await api(base(st.ship.id)));
            if (!st.open) st.open = defaultOpen(st);
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
            ${stepsHtml(st)}
            ${settingsBannerHtml(v)}
            ${SEC_ORDER.map(k => { const html = secHtml(st, k); return `<section class="ship-det-section sd-sec" id="sd-sec-${k}" ${html ? '' : 'hidden'}>${html}</section>`; }).join('')}
        </div>`;
        glowStages(st);
        wire(st);
    }

    // The stage being worked on (the first numbered section not done) glows
    // faint orange; finished stages glow green.
    function glowStages(st) {
        const s = sectionStatus(st);
        const stages = ['1', '2', '3', '4', '5'];
        const current = stages.find(k => s[k] && s[k].kind !== 'done');
        for (const k of stages) {
            const el = $(st, '#sd-sec-' + k);
            if (!el) continue;
            el.classList.toggle('sd-sec--done', s[k]?.kind === 'done');
            el.classList.toggle('sd-sec--current', k === current);
        }
    }

    // The five steps, as the sections below: ✓ when done, the current one highlighted.
    function stepsHtml(st) {
        const v = st.view, s = sectionStatus(st);
        const names = { 1: "Pistoni's documents", 2: 'Our proforma invoice', 3: "JPS's proforma invoice", 4: 'In Xero', 5: 'LC and final packing list' };
        const current = Object.keys(names).find(k => s[k] && s[k].kind !== 'done');
        return `<div class="sd-top">
            <div class="sd-steps">${Object.entries(names).map(([k, l]) => { const done = s[k]?.kind === 'done';
                return `<span class="sd-step${done ? ' sd-step--done' : k === current ? ' sd-step--current' : ''}"><span class="sd-step-n">${done ? '✓' : k}</span>${esc(l)}</span>`; }).join('<span class="sd-step-sep"></span>')}${st.opts.openTab
                ? `<span class="sd-step-sep"></span><button type="button" class="sd-step sd-step--link" data-act="to-lc"${tipAttr('Steps 6–10 are on the Letter of Credit tab')}><span class="sd-step-n sd-step-n--wide">6–10</span>Letter of credit</button>` : ''}</div>
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

    // ── Section layout ───────────────────────────────────────────────────
    // Each section is one clean row: title (ⓘ says what it is), status, a
    // checks count and its buttons. The fields, tables and checks open below
    // on click (▸). Explanations live in tooltips, not on the page.
    const STAT_ICON = { done: '✓', attention: '!', open: '○', waiting: '…' };
    const tipAttr = t => (t ? ` data-tip="${esc(t)}"` : '');
    const info = t => (t ? `<span class="sd-info" tabindex="0"${tipAttr(t)} aria-label="${esc(t)}">i</span>` : '');
    const failing = list => (list || []).filter(c => c.ok === false && !c.dismissed);
    const blocking = c => c.level === 'block' && c.ok === false && !c.dismissed;
    const REVIEW_CHECKS = c => !['rate-confirmed', 'number-confirmed'].includes(c.id);
    const eiConfirmed = ei => !!(ei && ei.numberConfirmed && ei.rateConfirmed);
    const latestOut = (r, doc, stage) => (r.outputs || []).find(o => o.doc === doc && (o.stage || 'draft') === stage);
    const shortMsg = (m, n = 110) => { const t = String(m || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

    // ✗ 1 · ! 1 · ✓ 7 — click opens the section's details (where the checks are).
    function checksChip(list, key) {
        if (!(list || []).length) return '';
        const f = failing(list);
        const blocks = f.filter(c => c.level === 'block').length, warns = f.length - blocks;
        const ok = list.filter(c => c.ok === true).length, dismissed = list.filter(c => c.dismissed).length;
        const parts = [blocks && `<span class="sd-cc-fail">✗ ${blocks}</span>`, warns && `<span class="sd-cc-warn">! ${warns}</span>`, ok && `<span class="sd-cc-ok">✓ ${ok}</span>`].filter(Boolean).join('');
        const tip = (f.length ? f.map(c => (c.level === 'block' ? '✗ ' : '! ') + c.title).join(' · ') : `All ${ok} checks passed`)
            + (dismissed ? ` · ${dismissed} dismissed` : '') + ' — click for details';
        return `<button type="button" class="sd-cc" data-act="open-sec" data-sec="${key}"${tipAttr(tip)}>${parts || '–'}</button>`;
    }

    // p: { n, title, info, stat: { kind, text, tip }, checks, meta, actions, always, body }
    function hdHtml(st, key, p) {
        const open = st.open.has(String(key));
        const title = `${p.n ? p.n + ' · ' : ''}${esc(p.title)}`;
        return `<div class="sd-sec-hd" id="sd-hd-${key}">
            ${p.body ? `<button type="button" class="sd-sec-toggle" data-act="toggle-sec" data-sec="${key}" aria-expanded="${open}" title="${open ? 'Hide' : 'Show'} the details"><span class="sd-caret">${open ? '▾' : '▸'}</span><span class="sd-sec-title">${title}</span></button>`
                : `<span class="sd-sec-toggle sd-sec-toggle--static"><span class="sd-caret"></span><span class="sd-sec-title">${title}</span></span>`}
            ${info(p.info)}
            <span class="sd-sec-meta">${p.stat ? `<span class="sd-sstat sd-sstat--${p.stat.kind}"${tipAttr(p.stat.tip)}>${STAT_ICON[p.stat.kind]} ${esc(p.stat.text)}</span>` : ''}${p.checks ? checksChip(p.checks, key) : ''}${p.meta || ''}</span>
            <span class="sd-sec-actions">${p.actions || ''}</span>
        </div>`;
    }
    // p.bodyFirst: the details sit above the always-visible rows (step 2: its
    // fields, then the documents they produce).
    function secHtml(st, key) {
        const p = SECS[key](st);
        if (!p) return '';
        const body = p.body ? `<div class="sd-sec-body" id="sd-body-${key}" ${st.open.has(String(key)) ? '' : 'hidden'}>${p.body}</div>` : '';
        return hdHtml(st, key, p) + (p.bodyFirst ? body + (p.always || '') : (p.always || '') + body);
    }
    function refreshHd(st, key) {
        const el = $(st, '#sd-hd-' + key);
        const p = el && SECS[key](st);
        if (p) el.outerHTML = hdHtml(st, key, p);
    }
    function redrawSec(st, key) {
        const el = $(st, '#sd-sec-' + key);
        if (!el) return;
        const html = secHtml(st, key);
        el.hidden = !html;
        el.innerHTML = html;
    }
    const SEC_ORDER = ['rc', '1', '2', '3', '4', 'cost', '5', 'hist'];
    // Open on first view: the step being worked on.
    function defaultOpen(st) {
        const s = sectionStatus(st);
        const first = ['1', '2', '3', '5'].find(n => s[n] && (s[n].kind === 'attention' || s[n].kind === 'open'));
        return new Set(first ? [first] : []);
    }
    // After a confirm: close that section and open the next step.
    function openNext(st, closed) {
        st.open.delete(String(closed));
        defaultOpen(st).forEach(k => st.open.add(k));
    }

    function sectionStatus(st) {
        const v = st.view, r = v.record, s = {};
        const needs = n => ({ kind: 'attention', text: `Needs attention (${n})` });
        const lockTip = (at, who_, what) => `Confirmed ${when(at)}${by(who_)}. ${what} Unlock to edit clears the confirmation.`;
        const g = v.generation || {}, wait = v.waiting || {};
        const todo = k => (g[k] || []).filter(i => !(wait[k] || []).includes(i));
        // 1 · Pistoni's documents — A upload the PDFs, B check and confirm the figures
        const files = ['packingList', 'proforma'].map(k => ({ f: r.files?.[k], x: r.extractions?.[k] }));
        const readErr = files.some(({ f, x }) => f && x?.error && x.fileKey === f.key && !x.errorDismissed);
        const started = (st.review.bales || []).length || st.review.supplierInvoice;
        const f1 = failing(v.checks.filter(REVIEW_CHECKS));
        s[1] = r.confirmed && !v.unconfirmedChanges ? { kind: 'done', text: `Confirmed ${day(nzYmd(r.confirmed.confirmedAt))}`, tip: lockTip(r.confirmed.confirmedAt, r.confirmed.confirmedBy, 'The documents use these figures.') }
            : readErr ? { kind: 'attention', text: "A PDF couldn't be read", tip: 'Open the step to read why, then replace the PDF or enter the figures by hand' }
            : !started ? { kind: 'open', text: files.some(({ f }) => f) ? '1 of 2 uploaded' : 'To do' }
            : f1.length ? needs(f1.length) : { kind: 'open', text: r.confirmed ? 'Changed since confirmed' : 'Ready to confirm' };
        // 2 · Our proforma invoice — A number, date and rate, B the draft documents
        const ei = r.exportInvoice;
        const pd = latestOut(r, 'packing', 'draft'), pf = latestOut(r, 'proforma', 'draft');
        const t2 = [...new Set([...todo('packingDraft'), ...todo('proforma')])];
        s[2] = !r.confirmed ? { kind: 'waiting', text: 'Waiting for step 1' }
            : !eiConfirmed(ei) ? { kind: 'open', text: 'Not confirmed' }
            : pd && pf ? { kind: 'done', text: `Generated ${day(nzYmd(pd.at < pf.at ? pf.at : pd.at))}`, tip: ei.confirmedAt ? lockTip(ei.confirmedAt, ei.confirmedBy, '') : '' }
            : t2.length ? needs(t2.length) : { kind: 'open', text: 'Ready to generate' };
        // 3 · JPS's proforma invoice → the signed copy
        const f3 = failing(v.jpsChecks), signed = latestOut(r, 'jps', 'contract'), t3 = todo('jpsContract');
        s[3] = !r.confirmed ? { kind: 'waiting', text: 'Waiting for step 1' }
            : !r.jps ? { kind: 'open', text: 'To do' }
            : !r.jpsConfirmed ? (f3.length ? needs(f3.length) : { kind: 'open', text: 'Ready to confirm' })
            : signed ? { kind: 'done', text: `Signed copy ${day(nzYmd(signed.at))}`, tip: lockTip(r.jpsConfirmed.at, r.jpsConfirmed.by, 'The JPS bill and the signed copy use these figures.') }
            : t3.length ? needs(t3.length) : { kind: 'open', text: 'Signed copy to generate' };
        // 4 · Xero
        const docs = v.xero?.docs || [], errs = v.xero?.errors || {};
        const inX = docs.filter(d => d.inXero).length;
        s[4] = inX === docs.length && docs.length ? { kind: 'done', text: 'All three in Xero' }
            : docs.some(d => !d.inXero && errs[d.key]) || errs.refresh ? { kind: 'attention', text: 'Last attempt failed' }
            : docs.some(d => d.inXero && d.changedSincePush) ? { kind: 'attention', text: 'Changed since sent' }
            : { kind: docs.every(d => d.issues.length) ? 'waiting' : 'open', text: `${inX} of ${docs.length} in Xero` };
        // 5 · LC details and final packing list
        const fin = latestOut(r, 'packing', 'final');
        s[5] = fin ? { kind: 'done', text: `Generated ${day(nzYmd(fin.at))}` }
            : !r.confirmed ? { kind: 'waiting', text: 'Waiting for step 1' }
            : todo('packingFinal').length ? needs(todo('packingFinal').length)
            : (g.packingFinal || []).length ? { kind: 'waiting', text: 'Waiting for the LC', tip: (g.packingFinal || []).join(' · ') } : { kind: 'open', text: 'Ready to generate' };
        // Cost breakdown
        const ch = (v.costPlan?.changes || []).length;
        s.cost = !r.confirmed ? { kind: 'waiting', text: 'Waiting for step 1' }
            : ch ? { kind: 'attention', text: `${ch} change${ch === 1 ? '' : 's'} to apply` } : { kind: 'done', text: 'Matches' };
        return s;
    }

    // ── Figures side by side ─────────────────────────────────────────────
    function rcParts(st) {
        const rc = st.view.reconciliation;
        if (!rc || !rc.docs.some(d => d.present)) return null;
        const ICON = { ok: '✓', warn: '!', wait: '…' };
        const row = d => d.present
            ? `<tr><th>${esc(d.label)}${d.internal ? ' <span class="sd-tag" data-tip="Never printed on Enviroware\'s documents">internal</span>' : ''}</th>
                <td>${esc(d.number || '—')}</td><td>${esc(day(d.date) || '—')}</td>
                <td class="r">${kg(d.kg)}${d.bales ? `<div class="sd-muted">${d.bales} bales</div>` : ''}</td>
                <td class="r">${perKg(d.rate, d.currency)}${d.rate != null && d.rateIsAverage ? '<div class="sd-muted">average</div>' : ''}</td>
                <td class="r"><strong>${money(d.amount, d.currency)}</strong></td>
                <td class="r sd-muted">${money(d.nzd, 'NZD')}</td></tr>`
            : `<tr class="sd-rc-wait"><th>${esc(d.label)}</th><td colspan="6">Not in yet</td></tr>`;
        return {
            title: 'Figures side by side',
            info: "Pistoni's, our and JPS's proforma invoices next to each other, with the differences worked out. ✓ only when a comparison passed; ! when it doesn't match or can't be checked." + (rc.usesConfirmed ? '' : ' Uses the bales as reviewed — not confirmed yet.'),
            meta: rc.diffs.map(d => `<span class="sd-dchip sd-dchip--${d.status}"${tipAttr(d.text)}>${ICON[d.status]} ${esc(d.label)}</span>`).join(''),
            body: `<div class="sd-table-wrap"><table class="sd-rc-table">
                <thead><tr><th>Document</th><th>Number</th><th>Date</th><th class="r">Weight</th><th class="r">Rate</th><th class="r">Amount</th><th class="r">≈ NZD today</th></tr></thead>
                <tbody>${rc.docs.map(row).join('')}</tbody></table></div>
                <ul class="sd-rc-diffs">${rc.diffs.map(d => `<li class="sd-rc-${d.status}"><span class="sd-rc-i">${ICON[d.status]}</span><span><strong>${esc(d.label)}</strong> — ${esc(d.text)}</span></li>`).join('')}</ul>`,
        };
    }

    // ── 1 · Pistoni's documents ──────────────────────────────────────────
    function uploadCardHtml(v, kind, title, hint) {
        const f = v.record.files?.[kind];
        const x = v.record.extractions?.[kind];
        const ok = x && !x.error && x.fileKey === f?.key;
        const err = x?.error && x.fileKey === f?.key && !x.errorDismissed;
        const summary = !ok || kind === 'jpsInvoice' ? '' : kind === 'packingList'
            ? `${(x.result?.bales || []).length} bales read${x.result?.shipmentNumber != null ? ` · shipment ${esc(x.result.shipmentNumber)}` : ''}`
            : `Document ${esc(x.result?.documentNumber || '?')} · ${esc(money(x.result?.total, x.result?.currency))}`;
        return `<label class="sd-upload${f ? ' sd-upload--has' : ''}" data-kind="${kind}">
            <input type="file" accept="application/pdf" hidden data-upload="${kind}">
            <div class="sd-upload-title">${esc(title)}${f ? '' : info(hint)}</div>
            ${f ? `<div class="sd-upload-file">📄 <a href="${base(v.shipment.id)}/file?key=${encodeURIComponent(f.key)}" target="_blank" rel="noopener" data-stop${tipAttr(`Uploaded ${when(f.uploadedAt)}${by(f.by)}`)}>${esc(f.filename)}</a></div>
                   ${summary ? `<div class="sd-upload-sum">${summary}</div>` : ''}
                   ${err ? `<div class="sd-err sd-err--line"><span${tipAttr(x.errorDetail || x.error)}>✗ ${esc(shortMsg(x.error, 80))}</span> <button class="btn-link" data-act="dismiss-extract" data-kind="${kind}">Dismiss</button></div>` : ''}
                   <span class="btn-link sd-upload-cta">Replace PDF</span>`
                : `<span class="btn-secondary btn-sm sd-upload-cta">Choose PDF</span><div class="sd-muted sd-drop-hint">or drop it here</div>`}
            <div class="sd-upload-busy" hidden>Reading with AI… this can take up to a minute</div>
        </label>`;
    }
    function uploadsParts(st) {
        const v = st.view;
        return {
            n: 1, title: "Pistoni's documents", stat: sectionStatus(st)[1],
            info: "Pistoni's packing list and proforma invoice, read by AI.",
            body: `<div class="sd-uploads">
                ${uploadCardHtml(v, 'packingList', "Pistoni's packing list", 'The PACKING LIST TOECLIPS sheet with the WHITE and COLORED tables')}
                ${uploadCardHtml(v, 'proforma', "Pistoni's proforma invoice", "Pistoni's proforma addressed to Enviroware")}</div>`,
        };
    }

    // ── Checks ───────────────────────────────────────────────────────────
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

    function splitHtml(v) {
        const sp = v.jpsSplit, ei = v.record.exportInvoice || {};
        if (!sp) return '';
        return `<div class="sd-split">
            <div><strong>${money(sp.total, sp.currency)}</strong> is made up of</div>
            <div class="sd-split-row"><span${tipAttr(`Our proforma invoice ${ei.number || ''} — the LC pays this back`)}>LC deposit</span><span>${money(sp.depositAmount, sp.currency)}</span><span class="sd-muted">${kg(sp.netKg)} × ${perKg(sp.depositRate, sp.currency)}</span></div>
            <div class="sd-split-row"><span${tipAttr("JPS's margin — the real cost of the round trip")}>Handling &amp; sorting</span><span>${money(sp.handlingAmount, sp.currency)}</span><span class="sd-muted">${perKg(sp.handlingRate, sp.currency)}</span></div>
        </div>`;
    }

    // ── 2 · Bales and Pistoni's figures ──────────────────────────────────
    function reviewParts(st) {
        const v = st.view, r = st.review, p = r.packing || {}, c = v.record.confirmed;
        const locked = !!(c && !v.unconfirmedChanges);
        const fromPdf = !!v.record.extractions?.packingList;
        const t = v.reviewTotals, fails = v.checks.filter(blocking);
        const fld = (label, path, val, raw, fmt) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${figure(st, 'review', path, val, raw, fmt, { fromPdf, locked })}</div></div>`;
        const actions = locked
            ? '<button class="btn-secondary btn-sm" data-act="unlock-bales" title="Clears the confirmation until you confirm again">Unlock to edit</button>'
            : `<button class="btn-primary btn-sm" data-act="confirm" ${fails.length || !t.count ? 'disabled' : ''} title="${fails.length ? 'Fix or dismiss the failing checks first' : 'Locks this section; our proforma invoice and the documents use these figures'}">Confirm ${t.count || ''} bales</button>`;
        return {
            n: 2, title: "Bales and Pistoni's figures", stat: sectionStatus(st)[2], checks: v.checks.filter(REVIEW_CHECKS),
            info: "The bales from Pistoni's packing list and the figures on Pistoni's proforma invoice. Figures read from a PDF show as text — ✎ corrects one. Confirming locks the section; the documents use the confirmed figures.",
            meta: locked ? '' : '<span class="sd-save" id="sd-savestate"></span>',
            actions,
            body: `
            <div id="sd-checks">${checksHtml(st)}</div>
            <h4 class="sd-h4">Pistoni's packing list</h4>
            <div class="sd-grid4">
                ${locked ? `<div class="sd-field"><span class="imp-field-label">Shipment no.</span><div class="sd-fig"><span class="sd-val">${esc(r.shipmentNumber ?? '—')}</span></div></div>`
                    : `<label class="sd-field"><span class="imp-field-label">Shipment no.</span><input class="sd-input sd-num" data-path="shipmentNumber" type="number" step="1" value="${r.shipmentNumber ?? ''}"></label>`}
                ${fld('White total', 'packing.whiteTotalKg', p.whiteTotalKg, p.whiteTotalRaw, kg)}
                ${fld('Coloured total', 'packing.colouredTotalKg', p.colouredTotalKg, p.colouredTotalRaw, kg)}
                ${fld('Packages', 'packing.packages', p.packages, p.packagesRaw, n => `${fmtKg(n)} bales`)}
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
            <h4 class="sd-h4">Pistoni's proforma invoice <span class="sd-tag" data-tip="Never printed on Enviroware's documents">internal</span></h4>
            ${supplierInvoiceHtml(st, locked)}
            <div id="sd-confirm">${confirmHtml(st)}</div>`,
        };
    }

    // Below step 1's figures: the shipment's own weights, if they differ.
    function confirmHtml(st) {
        const v = st.view, c = v.record.confirmed, t = v.reviewTotals, s = v.shipment;
        const weightsDiffer = st.opts.applyShipPatch && t.count && (Math.round(s.whiteRawKg) !== Math.round(t.whiteKg) || Math.round(s.colourRawKg) !== Math.round(t.colouredKg));
        if (c && !v.unconfirmedChanges) {
            return weightsDiffer ? `<div class="sd-note">The shipment's Net Weight Breakdown still shows white ${kg(s.whiteRawKg)} / coloured ${kg(s.colourRawKg)}. <button class="btn-link" data-act="apply-weights">Update it to ${kg(t.whiteKg)} / ${kg(t.colouredKg)}</button></div>` : '';
        }
        return `${c ? '<div class="sd-warn-text sd-note">Changed since the last confirm — the documents use the confirmed figures until you confirm again.</div>' : ''}
            ${weightsDiffer ? `<label class="sd-check-line sd-note"><input type="checkbox" id="sd-apply-weights" checked>
                On confirm, also set the shipment's Net Weight Breakdown to white <strong>${kg(t.whiteKg)}</strong>, coloured <strong>${kg(t.colouredKg)}</strong></label>` : ''}`;
    }

    // ── 3 · Our proforma invoice ─────────────────────────────────────────
    function invoiceParts(st) {
        const v = st.view, r = v.record, ei = r.exportInvoice, d = v.defaults, t = v.confirmedTotals;
        const head = {
            n: 3, title: 'Our proforma invoice to JPS', stat: sectionStatus(st)[3],
            info: 'The LC amount: net kg × rate. Its date is printed on the draft packing list and our proforma. Confirming it is needed before the draft documents and Xero.',
        };
        if (!r.confirmed) return head;
        const amount = `${kg(t.netKg)} × ${perKg(ei.rate, ei.currency)} = <strong>${money(amountOf(t.netKg, ei.rate), ei.currency)}</strong>`;
        const field = (label, html) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${html}</div></div>`;
        if (eiConfirmed(ei)) {
            return { ...head,
                actions: '<button class="btn-secondary btn-sm" data-act="unlock-ei" title="Clears the confirmation until you confirm again">Unlock to edit</button>',
                body: `<div class="sd-grid4">
                    ${field('Invoice no.', `<span class="sd-val">${esc(ei.number)}</span>`)}
                    ${field('Date', `<span class="sd-val">${esc(day(ei.date))}</span>`)}
                    ${field('Rate', `<span class="sd-val">${esc(perKg(ei.rate, ei.currency))}</span>`)}
                    ${field('Amount', `<span class="sd-val">${amount}</span>`)}</div>` };
        }
        const numOk = /^\d+\s*\/\s*\d{4}$/.test(String(ei.number || '').trim()), rateOk = Number(ei.rate) > 0;
        return { ...head,
            actions: `<button class="btn-primary btn-sm" data-act="confirm-ei" ${numOk && rateOk ? '' : 'disabled'} title="${!numOk ? 'The number must look like 102/2026' : !rateOk ? 'Enter the rate' : 'Needed before generating the draft documents and creating it in Xero'}">Confirm</button>`,
            body: `<div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">Invoice no.</span><input class="sd-input" id="sd-ei-number" value="${esc(ei.number)}">
                    ${d.number && d.number !== ei.number ? `<span class="sd-muted">Next in sequence: ${esc(d.number)} · <button class="btn-link" data-act="use-suggested">Use it</button></span>` : ''}</label>
                <label class="sd-field"><span class="imp-field-label">Date</span><input class="sd-input" type="date" id="sd-ei-date" value="${esc(ei.date)}"></label>
                <label class="sd-field"><span class="imp-field-label">Rate (${esc(ei.currency)}/kg)</span><input class="sd-input sd-num" type="number" step="0.0001" id="sd-ei-rate" value="${ei.rate ?? ''}">
                    ${d.rate != null && Number(d.rate) !== Number(ei.rate) ? `<span class="sd-muted">Usual ${esc(perKg(d.rate, ei.currency))} (${esc(d.rateSource || '')})</span>` : ''}</label>
                ${field('Amount', `<span class="sd-val" id="sd-ei-amount">${amount}</span>`)}
            </div>` };
    }

    // ── Documents ────────────────────────────────────────────────────────
    // Every document row is the same: name, when a copy was generated, and
    // Preview · Download PDF · .xlsx · Generate. What still blocks it is a chip:
    // amber for something to do now, grey for what only comes with the LC.
    function issuesChip(list, waiting = []) {
        const later = list.filter(i => waiting.includes(i));
        const now = list.filter(i => !waiting.includes(i));
        return (now.length ? `<span class="sd-issue"${tipAttr(now.join(' · '))}>! ${esc(now.length === 1 ? now[0] : `${now.length} things to do first`)}</span>` : '')
            + (later.length ? `<span class="sd-wait"${tipAttr('Comes with the LC once it is issued and linked on the Letter of Credit tab: ' + later.map(i => i.replace(/ — it comes from the LC.*$/, '')).join(' · '))}>… Waiting for the LC</span>` : '');
    }
    function docRowHtml(st, { name, doc, stage, issues = [], waiting = [], xlsx = false, preview, gen, genLabel, tip = '' }) {
        const v = st.view, b = base(v.shipment.id);
        const out = latestOut(v.record, doc, stage);
        return `<div class="sd-docrow">
            <div class="sd-docrow-name"><strong>${esc(name)}</strong>${info(tip)}
                <span class="sd-muted"${out ? tipAttr(`Generated ${when(out.at)}${by(out.by)} · ${out.filename || ''}`) : ''}>${out ? `Generated ${esc(day(nzYmd(out.at)))}` : 'Not generated'}</span>${issuesChip(issues, waiting)}</div>
            <div class="sd-docrow-act">
                <a class="btn-secondary btn-sm" href="${b}/render?${preview}" target="_blank" rel="noopener" title="How it would print with today's figures — not an issued copy">Preview</a>
                ${out ? `<a class="btn-secondary btn-sm" href="${b}/render?out=${encodeURIComponent(out.key)}&download=1" target="_blank" rel="noopener" title="${esc(out.filename || '')}">Download PDF</a>` : ''}
                ${xlsx ? `<a class="btn-secondary btn-sm" href="${b}/xlsx${out ? '?out=' + encodeURIComponent(out.key) : ''}" title="Packing list as a spreadsheet">.xlsx</a>` : ''}
                ${gen ? `<button class="btn-primary btn-sm" data-act="${gen}" ${issues.length ? 'disabled' : ''} title="${esc(issues.length ? issues.join(' · ') : 'Keeps a fixed copy to download and send')}">${out ? 'Generate again' : esc(genLabel)}</button>` : ''}
            </div></div>`;
    }

    // ── 4 · Draft documents ──────────────────────────────────────────────
    function docsParts(st) {
        const v = st.view, r = v.record, g = v.generation;
        const head = {
            n: 4, title: 'Draft documents for Paul', stat: sectionStatus(st)[4],
            info: 'Our draft packing list and proforma invoice. Generating keeps a fixed copy of each to download and send to Paul; nothing is emailed or put in Drive.',
        };
        if (!r.confirmed || !eiConfirmed(r.exportInvoice)) return head;
        const issues = [...new Set([...g.packingDraft, ...g.proforma])];
        return { ...head,
            actions: `<button class="btn-primary btn-sm" data-act="gen-draft" ${issues.length ? 'disabled' : ''} title="${esc(issues.length ? issues.join(' · ') : 'Keeps a fixed copy of each to download and send to Paul')}">${latestOut(r, 'packing', 'draft') ? 'Generate both again' : 'Generate both'}</button>`,
            always: `<div class="sd-docs">
                ${docRowHtml(st, { name: 'Draft packing list', doc: 'packing', stage: 'draft', issues: g.packingDraft, xlsx: true, preview: 'doc=packing&stage=draft' })}
                ${docRowHtml(st, { name: 'Our proforma invoice', doc: 'proforma', stage: 'draft', issues: g.proforma, preview: 'doc=proforma' })}</div>` };
    }

    // ── 5 · JPS's proforma invoice ───────────────────────────────────────
    function jpsParts(st) {
        const v = st.view, j = st.jps, r = v.record;
        const head = {
            n: 3, title: "JPS's proforma invoice", stat: sectionStatus(st)[3],
            info: "JPS's invoice to us: our proforma amount (the LC deposit) plus JPS's handling & sorting. Paying it is what gets JPS to open the LC.",
        };
        if (!r.confirmed) return head;
        const locked = !!r.jpsConfirmed;
        const card = `<div class="sd-uploads sd-uploads--one">${uploadCardHtml(v, 'jpsInvoice', "JPS's proforma invoice (PDF)", "JPS Enterprise's sales proforma invoice to Enviroware")}</div>`;
        if (!j) return { ...head, body: `${card}<p class="sd-muted">Or <button class="btn-link" data-act="manual-jps">enter it by hand</button>.</p>` };
        const fromPdf = !!r.extractions?.jpsInvoice;
        const ccy = j.currency || '';
        const fig = (path, val, raw, fmt) => figure(st, 'jps', path, val, raw, fmt, { fromPdf, locked });
        const txt = (label, html) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span><div class="sd-fig">${html}</div></div>`;
        const inp = (label, path, val, attrs = '', placeholder = '') => locked
            ? txt(label, `<span class="sd-val">${esc(attrs.includes('date') ? day(val) || '—' : (val || '—'))}</span>`)
            : `<label class="sd-field"><span class="imp-field-label">${esc(label)}</span><input class="sd-input" data-jps="${path}" value="${esc(val || '')}" ${attrs}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}></label>`;
        const fails = (v.jpsChecks || []).filter(blocking);
        return { ...head,
            checks: v.jpsChecks || [],
            meta: locked ? '' : '<span class="sd-save" id="sd-jps-savestate"></span>',
            actions: locked
                ? '<button class="btn-secondary btn-sm" data-act="unlock-jps" title="Clears the confirmation until you confirm again">Unlock to edit</button>'
                : `<button class="btn-primary btn-sm" data-act="confirm-jps" ${fails.length ? 'disabled' : ''} title="${fails.length ? 'Fix or dismiss the failing checks first' : 'Needed before the JPS bill goes to Xero and before the signed copy'}">Confirm</button>`,
            always: `<div class="sd-docs" id="sd-jps-doc">${jpsDocHtml(st)}</div>`,
            body: `${card}
            <div class="sd-grid4">
                ${inp('Invoice no.', 'number', j.number)}
                ${inp('Date', 'date', j.date, 'type="date"')}
                ${inp('Currency', 'currency', j.currency, 'maxlength="3"')}
                ${txt('Total', fig('total', j.total, j.totalRaw, n => money(n, ccy)))}
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
            ${termsHtml(v.jpsTerms)}` };
    }

    // Contract terms on the signed copy: the LC's, read-only — shown only once
    // the LC is issued and linked (they aren't needed before then).
    function termsHtml(t) {
        if (!t || !Object.values(t.from).some(Boolean)) return '';
        const cell = (label, value) => `<div class="sd-field"><span class="imp-field-label">${esc(label)}</span>
            <div class="sd-fig"><span class="sd-val${value ? '' : ' sd-muted'}"${tipAttr(`From LC ${t.lcNumber || ''}`)}>${esc(value || '—')}</span></div></div>`;
        return `<h4 class="sd-h4">Contract terms ${info(`From LC ${t.lcNumber || ''} (latest date of shipment 44C, expiry 31D, container) — printed on the signed copy.`)}</h4>
            <div class="sd-grid3">
                ${cell('Last date of shipment', day(t.lastShipmentDate))}
                ${cell('Expiry date', day(t.expiryDate))}
                ${cell('Containers', t.containers)}
            </div>`;
    }

    function jpsDocHtml(st) {
        if (!st.view.record.jps) return '';
        return docRowHtml(st, { name: 'Signed copy for Paul', doc: 'jps', stage: 'contract', issues: st.view.generation?.jpsContract || [], waiting: st.view.waiting?.jpsContract || [], preview: 'doc=jps', gen: 'gen-jps', genLabel: 'Generate',
            tip: "JPS's proforma invoice rewritten without their template's errors, signed and sealed by you. Send it to Paul to sign." });
    }

    // ── 6 · Xero ─────────────────────────────────────────────────────────
    const XERO_WORDS = { DRAFT: 'Draft', SUBMITTED: 'Awaiting approval', AUTHORISED: 'Awaiting payment', PAID: 'Paid', VOIDED: 'Voided', DELETED: 'Deleted' };
    const XERO_STEPS = { check: 'checking the invoice', rate: 'getting the exchange rate', tax: 'checking the tax rates', auth: 'signing in to Xero', contact: 'finding the contact', create: 'creating the invoice', refresh: 'reading back from Xero' };

    // A failed attempt in one line — Details opens what Xero said and what was
    // sent; Dismiss hides it (it stays in the activity log).
    function xeroErrorHtml(e, key, what) {
        if (!e) return '';
        const sent = e.sent;
        return `<div class="sd-xerr">
            <div class="sd-xerr-line"><strong>✗ ${esc(what)}</strong><span class="sd-xerr-msg">${esc(e.summary || e.message)}</span>
                <button class="btn-link" data-act="xerr-more">Details</button><button class="btn-link" data-act="dismiss-xerr" data-key="${esc(key)}">Dismiss</button></div>
            <div class="sd-xerr-more" hidden>
                ${e.summary && e.summary !== e.message ? `<div>${esc(e.message)}</div>` : ''}
                <div class="sd-muted">${esc(when(e.at))}${esc(by(e.by))} · while ${esc(XERO_STEPS[e.step] || e.step || '')}${e.request ? ` · ${esc(e.request)}` : ''}${e.xeroStatus != null ? ` → Xero ${e.xeroStatus === 0 ? 'unreachable' : 'HTTP ' + e.xeroStatus}` : ''}</div>
                ${(e.details || []).length ? `<ul class="sd-issues">${e.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
                ${sent ? `<div class="sd-muted">Sent: ${esc(sent.type)} ${esc(sent.status)} · ${esc(sent.contact || '')} · no. ${esc(sent.number || '—')} · ${esc(sent.date || '')} · ${esc(money(sent.total, sent.currency))}</div>
                    <ul class="sd-xerr-lines">${(sent.lines || []).map(l => `<li>${esc(l.description)} — ${fmtKg(l.quantity)} × ${fmtRate(l.unitAmount)} · account ${esc(l.accountCode || '—')} · tax ${esc(l.taxType || '—')}</li>`).join('')}</ul>` : ''}
                ${e.response ? `<pre class="sd-xerr-raw">${esc(e.response)}</pre>` : ''}
            </div></div>`;
    }

    function xeroParts(st) {
        const v = st.view, docs = v.xero?.docs || [], errs = v.xero?.errors || {};
        const any = docs.some(d => d.inXero);
        const statusWord = (XERO_WORDS[v.xero?.status] || 'Draft').toLowerCase();
        const ccyNote = v.xero?.currencyMode === 'foreign' ? 'in their own currency' : "in NZD at the day's exchange rate (each line keeps the EUR / USD amount and rate)";
        return {
            n: 4, title: 'Invoices in Xero', stat: sectionStatus(st)[4],
            info: `Created as ${statusWord}, ${ccyNote}, only when you click. Approve and pay them in Xero; Refresh reads back what was paid in NZD.`,
            meta: any && v.xero.refreshedAt ? `<span class="sd-muted"${tipAttr('Last read back from Xero')}>Checked ${esc(day(nzYmd(v.xero.refreshedAt)))}</span>` : '',
            actions: any ? '<button class="btn-secondary btn-sm" data-act="xero-refresh">Refresh from Xero</button>' : '',
            always: `${errs.refresh ? xeroErrorHtml(errs.refresh, 'refresh', 'Refresh from Xero failed') : ''}
            <table class="sd-xero"><tbody>${docs.map(d => `<tr>
                <td><strong${tipAttr(`${d.contactName || '—'} · ${d.type === 'ACCREC' ? 'sales invoice' : 'bill'}`)}>${esc(d.label)}</strong></td>
                <td class="sd-muted">${d.number ? esc(d.number) : '—'}${d.date ? ` · ${esc(day(d.date))}` : ''}</td>
                <td class="r">${d.total != null ? esc(money(d.total, d.currency)) : '—'}
                    ${d.inXero && d.pushed.fx ? `<div class="sd-muted"${tipAttr(`1 NZD = ${d.pushed.fx.rate.toFixed(4)} ${d.pushed.fx.currency}`)}>${esc(money(d.pushed.total, 'NZD'))} in Xero</div>`
                        : !d.inXero && d.nzdEstimate ? `<div class="sd-muted"${tipAttr("At today's rate; the rate on the day it's created is used")}>≈ ${esc(money(d.nzdEstimate.total, 'NZD'))}</div>` : ''}</td>
                <td>${d.inXero
                    ? `<span class="sd-xs sd-xs--${esc((d.pushed.status || '').toLowerCase())}">${esc(XERO_WORDS[d.pushed.status] || d.pushed.status)}</span>${d.pushed.nzdPaid ? ` <span class="sd-muted">${esc(money(d.pushed.nzdPaid, 'NZD'))} paid</span>` : ''}${d.changedSincePush ? ` <span class="sd-issue"${tipAttr(`Hub total now ${money(d.total, d.currency)} — update it in Xero`)}>! Changed</span>` : ''}`
                    : d.issues.length ? issuesChip(d.issues) : '<span class="sd-muted">Not in Xero</span>'}</td>
                <td class="r">${d.inXero
                    ? `<a class="btn-link" href="${esc(d.url)}" target="_blank" rel="noopener">Open in Xero ↗</a>`
                    : `<button class="btn-secondary btn-sm" data-act="xero-push" data-doc="${esc(d.key)}" ${d.issues.length ? 'disabled' : ''}>${errs[d.key] ? 'Try again' : 'Create in Xero'}</button>`}</td>
            </tr>${!d.inXero && errs[d.key] ? `<tr class="sd-xerr-row"><td colspan="5">${xeroErrorHtml(errs[d.key], d.key, 'Not created')}</td></tr>` : ''}`).join('')}</tbody></table>`,
        };
    }

    // ── Cost breakdown ───────────────────────────────────────────────────
    function costParts(st) {
        if (!st.view.costPlanApplies) return null;
        const plan = st.view.costPlan || { changes: [] };
        const head = { title: 'Cost breakdown', stat: sectionStatus(st).cost, info: "The shipment's Overview, filled from these documents and Xero." };
        if (!st.view.record.confirmed || !plan.changes.length) return head;
        return { ...head,
            actions: st.opts.applyShipPatch ? '<button class="btn-primary btn-sm" data-act="apply-cost">Update cost breakdown</button>' : '',
            body: `<table class="sd-xero"><tbody>${plan.changes.map(c => `<tr>
                <td><strong${tipAttr('From ' + c.source)}>${esc(c.label)}</strong></td>
                <td class="sd-muted">${esc(c.from)}</td><td>→</td><td><strong>${esc(c.to)}</strong></td></tr>`).join('')}</tbody></table>` };
    }

    // ── 7 · LC details and final packing list ────────────────────────────
    function finalParts(st) {
        const v = st.view, lc = v.record.lc || {}, g = v.generation, L = v.linkedLc;
        const head = {
            n: 5, title: 'LC details and final packing list', stat: sectionStatus(st)[5],
            info: "Once JPS has opened the LC: its number, date of issue and the gross weight, checked against the LC on the Letter of Credit tab. Then the final packing list.",
        };
        if (!v.record.confirmed) return head;
        const useLc = L && (L.lcNumber !== lc.number || (L.issuedDate && L.issuedDate !== lc.date));
        return { ...head,
            checks: v.lcChecks.length ? v.lcChecks : null,
            always: `<div class="sd-docs">${docRowHtml(st, { name: 'Final packing list', doc: 'packing', stage: 'final', issues: g.packingFinal, waiting: v.waiting?.packingFinal || [], xlsx: true, preview: 'doc=packing&stage=final', gen: 'gen-final', genLabel: 'Generate' })}</div>`,
            body: `${L ? `<p class="sd-muted">Linked LC: <strong>${esc(L.lcNumber)}</strong>${L.issuedDate ? `, issued ${esc(day(L.issuedDate))}` : ''}${useLc ? ` · <button class="btn-link" data-act="use-lc">Use these</button>` : ''}</p>` : '<p class="sd-muted">No LC linked yet (Letter of Credit tab) — you can still enter the details.</p>'}
            <div class="sd-grid4">
                <label class="sd-field"><span class="imp-field-label">LC no.</span><input class="sd-input" id="sd-lc-number" value="${esc(lc.number || '')}"></label>
                <label class="sd-field"><span class="imp-field-label">LC date of issue</span><input class="sd-input" type="date" id="sd-lc-date" value="${esc(lc.date || '')}"></label>
                <label class="sd-field"><span class="imp-field-label">Gross weight (kg) ${info(`Net is ${kg(v.confirmedTotals.netKg)}`)}</span><input class="sd-input sd-num" type="number" step="any" id="sd-lc-gross" value="${lc.grossKg ?? ''}"></label>
                <div class="sd-field sd-field--btn"><button class="btn-secondary btn-sm" data-act="save-lc">Save LC details</button></div>
            </div>
            ${v.lcChecks.length ? checkListHtml(v.lcChecks, 'sd-checks--compact') : ''}` };
    }

    // ── Generated documents and activity ─────────────────────────────────
    const DOC_NAMES = { 'packing:draft': 'Draft packing list', 'packing:final': 'Final packing list', 'proforma:draft': 'Our proforma invoice', 'jps:contract': "JPS's proforma invoice — signed copy" };
    function histParts(st) {
        const v = st.view, r = v.record, b = base(v.shipment.id);
        const outs = r.outputs || [];
        return {
            title: `Generated documents and activity`, info: 'Every issued copy, the supplier files and everything done on this shipment',
            meta: `<span class="sd-muted">${outs.length} document${outs.length === 1 ? '' : 's'}</span>`,
            body: `${outs.length ? `<table class="sd-outs"><tbody>${outs.map(o => `<tr>
                <td><strong>${esc(DOC_NAMES[`${o.doc}:${o.stage || 'draft'}`] || o.name)}</strong><div class="sd-muted">${esc(o.filename)}</div></td>
                <td>${o.invoiceNumber ? `${esc(o.invoiceNumber)} · ${esc(money(o.amount, o.currency))}` : ''}${o.lcNumber ? `LC ${esc(o.lcNumber)} · gross ${esc(kg(o.grossKg))}` : ''}${!o.invoiceNumber && !o.lcNumber ? `${o.packages} bales · ${esc(kg(o.netKg))}` : ''}</td>
                <td class="sd-muted">${esc(when(o.at))}${esc(by(o.by))}</td>
                <td class="r sd-outs-act"><a class="btn-link" href="${b}/render?out=${encodeURIComponent(o.key)}" target="_blank" rel="noopener">Open</a> · <a class="btn-link" href="${b}/render?out=${encodeURIComponent(o.key)}&download=1" target="_blank" rel="noopener">Download PDF</a>${o.doc === 'packing' ? ` · <a class="btn-link" href="${b}/xlsx?out=${encodeURIComponent(o.key)}">.xlsx</a>` : ''}</td></tr>`).join('')}</tbody></table>`
                : '<p class="sd-muted">No documents generated yet.</p>'}
            <h4 class="sd-h4">Supplier files</h4>
            ${(r.fileHistory || []).map(f => `<div class="sd-muted">📄 <a href="${b}/file?key=${encodeURIComponent(f.key)}" target="_blank" rel="noopener">${esc(f.filename)}</a> · ${esc({ proforma: "Pistoni's proforma", packingList: "Pistoni's packing list", jpsInvoice: "JPS's proforma" }[f.kind] || f.kind)} · ${esc(when(f.uploadedAt))}${esc(by(f.by))}</div>`).join('') || '<div class="sd-muted">No files yet.</div>'}
            <h4 class="sd-h4">Activity</h4>
            <ul class="sd-log">${(r.log || []).map(l => `<li><span class="sd-muted">${esc(when(l.at))}${esc(by(l.by))}</span> ${esc(l.action)}</li>`).join('')}</ul>`,
        };
    }

    function pistoniParts(st) {
        const u = uploadsParts(st), r = reviewParts(st);
        return { ...r, n: 1, title: "Pistoni's documents", stat: sectionStatus(st)[1],
            info: "A · Pistoni's packing list and proforma invoice, read by AI. B · Check the bales and figures against the PDFs and confirm them — the documents use the confirmed figures. Figures read from a PDF show as text; ✎ corrects one.",
            body: `<h4 class="sd-sub">A · Pistoni's PDFs</h4>${u.body}<h4 class="sd-sub">B · Bales and figures</h4>${r.body}` };
    }
    function proformaParts(st) {
        const i = invoiceParts(st), d = docsParts(st);
        return { n: 2, title: 'Our proforma invoice to JPS', stat: sectionStatus(st)[2],
            info: 'A · Number, date and rate — the LC amount is net kg × rate; confirming it is needed before the documents and Xero. B · The draft packing list and our proforma for Paul: generating keeps a fixed copy of each to download and send; nothing is emailed or put in Drive.',
            actions: [i.actions, d.actions].filter(Boolean).join(''),
            always: d.always || '', bodyFirst: true,
            body: i.body ? `<h4 class="sd-sub">A · Number, date and rate</h4>${i.body}${d.always ? '<h4 class="sd-sub">B · Draft documents for Paul</h4>' : ''}` : '' };
    }

    const SECS = { rc: rcParts, 1: pistoniParts, 2: proformaParts, 3: jpsParts, 4: xeroParts, cost: costParts, 5: finalParts, hist: histParts };

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
            const s2 = $(st, '#sd-savestate'); if (s2) s2.textContent = 'Saved';
        } catch (e) {
            if (ss) ss.textContent = 'Save failed: ' + e.message;
        }
    }

    // After a save: headers (status, checks, buttons), the figures panel and
    // the sections without inputs are redrawn; inputs being typed in are not.
    function refreshStatus(st) {
        for (const k of ['1', '3', '5', 'cost']) refreshHd(st, k);
        for (const k of ['rc', '2', '4']) redrawSec(st, k);
        glowStages(st);
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
            refreshStatus(st);
            const s5 = $(st, '#sd-jps-savestate'); if (s5) s5.textContent = 'Saved';
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
        if (a === 'to-lc') return st.opts.openTab && st.opts.openTab('lc');
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
            redrawSec(st, '1');
            return scheduleSave(st, 0);
        }
        if (a === 'add-line') { r.supplierInvoice.lines.push({ description: '', colour: '', kg: null, unitPrice: null, amount: null }); redrawSec(st, '1'); return scheduleSave(st, 0); }
        if (a === 'del-line') { r.supplierInvoice.lines.splice(Number(btn.dataset.i), 1); redrawSec(st, '1'); return scheduleSave(st, 0); }
        if (a === 'manual-jps') {
            st.jps = { number: '', date: '', currency: st.view.record.exportInvoice?.currency || 'USD', lines: [], netKg: null, total: null, contract: { lastShipmentDate: '', expiryDate: '', containers: '' } };
            redrawSec(st, '3');
            return saveJps(st);
        }
        if (a === 'jps-add-line') { st.jps.lines = [...(st.jps.lines || []), { description: '', kg: null, unitPrice: null, amount: null }]; redrawSec(st, '3'); return saveJps(st); }
        if (a === 'jps-del-line') { st.jps.lines.splice(Number(btn.dataset.i), 1); redrawSec(st, '3'); return saveJps(st); }
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
        if (a === 'toggle-sec' || a === 'open-sec') {
            const k = btn.dataset.sec;
            const open = a === 'open-sec' ? true : !st.open.has(k);
            if (open) st.open.add(k); else st.open.delete(k);
            const body = $(st, '#sd-body-' + k);
            if (body) body.hidden = !open;
            const tg = $(st, `#sd-hd-${k} .sd-sec-toggle`);
            if (tg && tg.tagName === 'BUTTON') { tg.setAttribute('aria-expanded', String(open)); tg.querySelector('.sd-caret').textContent = open ? '▾' : '▸'; }
            if (a === 'open-sec' && body) body.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return;
        }
        if (a === 'xerr-more') {
            const more = btn.closest('.sd-xerr')?.querySelector('.sd-xerr-more');
            if (more) { more.hidden = !more.hidden; btn.textContent = more.hidden ? 'Details' : 'Hide'; }
            return;
        }
        if (a === 'dismiss-xerr') return redrawWith(st, send(base(st.ship.id), 'PATCH', { dismissXeroError: btn.dataset.key }), 'Error dismissed — it stays in the activity log');
        if (a === 'dismiss-extract') return redrawWith(st, send(base(st.ship.id), 'PATCH', { dismissExtractError: btn.dataset.kind }), 'Error dismissed — it stays in the activity log');
        if (a === 'edit-field') {
            // ✎ on a printed figure: switch it to an input, keep the page where it is
            const [store, ...rest] = btn.dataset.field.split(':');
            const path = rest.join(':');
            st.editing.add(btn.dataset.field);
            st.open.add(store === 'jps' ? '3' : '1');
            redrawSec(st, store === 'jps' ? '3' : '1');
            const inp = st.panel.querySelector(`[data-${store === 'jps' ? 'jps' : 'path'}="${CSS.escape(path)}"]`);
            if (inp) { inp.focus(); inp.select?.(); }
            return;
        }
        if (a === 'unlock-bales') {
            if (!confirm("Unlock step 1 to edit the bales and Pistoni's figures?\n\nThe confirmation is cleared: documents and Xero wait until you confirm again. Copies already generated and invoices already in Xero are not changed.")) return;
            st.open.add('1');
            return redrawWith(st, send(`${base(st.ship.id)}/confirm`, 'POST', { unlock: true }), 'Step 1 unlocked');
        }
        if (a === 'confirm-ei') {
            await saveInvoice(st, { numberConfirmed: true, rateConfirmed: true });
            if (eiConfirmed(st.view.record.exportInvoice)) { openNext(st, '2'); draw(st); }
            return;
        }
        if (a === 'unlock-ei') {
            if (!confirm('Unlock our proforma invoice to edit it?\n\nIts confirmation is cleared until you confirm it again.')) return;
            st.open.add('2');
            return saveInvoice(st, { numberConfirmed: false, rateConfirmed: false });
        }
        if (a === 'use-suggested') return saveInvoice(st, { number: st.view.defaults.number });
        if (a === 'confirm-jps') return redrawWith(st, send(base(st.ship.id), 'PATCH', { jpsConfirm: true }), "JPS's proforma invoice confirmed", () => openNext(st, '3'));
        if (a === 'unlock-jps') {
            if (!confirm("Unlock JPS's proforma invoice to edit it?\n\nIts confirmation is cleared: the JPS bill and the signed copy wait until you confirm it again.")) return;
            st.open.add('3');
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
    async function redrawWith(st, promise, done, after) {
        try {
            const y = window.scrollY;
            setView(st, await promise);
            st.editing.clear();
            if (after) after();
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
            openNext(st, '1');
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
