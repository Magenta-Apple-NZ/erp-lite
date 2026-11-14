// ── Remittance module ──
// Customer remittance advice PDF → review against Xero → one click posts the
// rebate credit note(s) and a batch payment, so the bank-feed line matches in
// one click in Xero. Opened from the Orders list ("Remittance…").
//   POST /api/xero/remittance/extract → match → apply

const Remittance = (() => {

    let onAppliedCb = null;

    async function api(path, opts = {}) {
        const { timeout = 30000, ...fetchOpts } = opts;
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        let resp;
        try {
            resp = await fetch(path, { ...fetchOpts, signal: ctrl.signal });
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('Request timed out — check your connection and retry.');
            throw new Error('Network error — could not reach the Hub. ' + (e.message || ''));
        } finally {
            clearTimeout(t);
        }
        const data = await resp.json().catch(() => null);
        if (!resp.ok) {
            const err = new Error((data && data.error) || resp.statusText);
            err.data = data; err.status = resp.status;
            throw err;
        }
        if (!data) throw new Error('Unexpected response — you may need to reload and sign in again.');
        return data;
    }

    function escHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    const money = cents => (cents < 0 ? '−$' : '$') + (Math.abs(cents) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cents = v => Math.round((Number(v) || 0) * 100);
    const fmtDate = ymd => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return '—';
        const [y, m, d] = ymd.split('-').map(Number);
        return `${d} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${y}`;
    };
    const invLink = id => 'https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=' + encodeURIComponent(id);
    const cnLink = id => 'https://go.xero.com/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=' + encodeURIComponent(id);

    const STATUS = {
        full:          ['Paid in full', 'rem-chip--ok'],
        partial:       ['Part payment', 'rem-chip--warn'],
        overpaid:      ['Overpaid', 'rem-chip--err'],
        paid_already:  ['Already paid', 'rem-chip--err'],
        voided:        ['Voided', 'rem-chip--err'],
        not_found:     ['Not found', 'rem-chip--err'],
        wrong_contact: ['Other customer', 'rem-chip--err'],
    };

    // ── Modal shell ──
    function open({ onApplied } = {}) {
        onAppliedCb = onApplied || null;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-box rem-box">
                <h3 class="modal-title">Reconcile a remittance</h3>
                <div id="rem-body"></div>
                <div class="modal-actions" id="rem-actions"></div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', onKey);
        const ctx = { overlay, close, $: sel => overlay.querySelector(sel) };
        renderPick(ctx);
    }

    function setActions(ctx, html) { ctx.$('#rem-actions').innerHTML = html; }

    // ── Step 1: pick the PDF ──
    function renderPick(ctx, errMsg = '') {
        ctx.$('#rem-body').innerHTML = `
            <p class="rem-lead">Upload the customer's remittance advice. The Hub reads it, checks every invoice against Xero, and shows you what it will post before anything is written.</p>
            ${errMsg ? `<div class="po-import-status po-import-status--err">${escHtml(errMsg)}</div>` : ''}
            <label class="rem-drop">
                <input type="file" id="rem-file" accept="application/pdf,image/*" hidden>
                <span class="rem-drop-icon">📄</span>
                <span><strong>Choose remittance PDF</strong><br><span class="rem-muted">PGG Wrightson, Farmlands, HortiCentre…</span></span>
            </label>`;
        setActions(ctx, `<button class="btn-secondary" id="rem-close">Close</button>`);
        ctx.$('#rem-close').addEventListener('click', ctx.close);
        ctx.$('#rem-file').addEventListener('change', async e => {
            const file = e.target.files && e.target.files[0];
            if (file) await readAndMatch(ctx, file);
        });
    }

    function renderBusy(ctx, msg) {
        ctx.$('#rem-body').innerHTML = `<div class="po-import-status po-import-status--busy">${escHtml(msg)}</div>`;
        setActions(ctx, `<button class="btn-secondary" id="rem-close">Close</button>`);
        ctx.$('#rem-close').addEventListener('click', ctx.close);
    }

    async function readAndMatch(ctx, file) {
        renderBusy(ctx, 'Reading the remittance with AI…');
        let remit;
        try {
            const dataUrl = await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(String(r.result));
                r.onerror = () => rej(new Error('Could not read the file'));
                r.readAsDataURL(file);
            });
            const out = await api('/api/xero/remittance/extract', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: dataUrl.split(',')[1] || '', mediaType: file.type || 'application/pdf' }),
                timeout: 90000,
            });
            remit = out.remit;
        } catch (e) {
            return renderPick(ctx, 'Could not read the remittance: ' + e.message);
        }
        await runMatch(ctx, remit, file.name);
    }

    async function runMatch(ctx, remit, fileName) {
        renderBusy(ctx, 'Checking ' + (remit.lines || []).length + ' lines against Xero…');
        try {
            const m = await api('/api/xero/remittance/match', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ remit }),
            });
            renderReview(ctx, remit, m, fileName);
        } catch (e) {
            if (e.data && e.data.needsReauth) return renderReauth(ctx);
            renderPick(ctx, 'Xero check failed: ' + e.message);
        }
    }

    function renderReauth(ctx) {
        ctx.$('#rem-body').innerHTML = `
            <div class="po-import-status po-import-status--err">
                Xero needs one more permission for remittances (payments + chart of accounts).
                Reconnect once and everything else keeps working.
            </div>`;
        setActions(ctx, `<button class="btn-secondary" id="rem-close">Close</button><a class="btn-primary" href="/api/xero/auth">Reconnect Xero</a>`);
        ctx.$('#rem-close').addEventListener('click', ctx.close);
    }

    // ── Step 2: review ──
    function renderReview(ctx, remit, m, fileName) {
        const t = m.totals || {};
        const plan = m.plan || { errors: [] };
        const banks = (m.accounts || []).filter(a => a.Type === 'BANK');
        const codeable = (m.accounts || []).filter(a => a.Type !== 'BANK' && a.Code);
        const hasDeductions = (m.deductions || []).length > 0;
        const allocByInv = new Map();
        for (const cn of plan.creditNotes || []) for (const a of cn.allocations || []) allocByInv.set(a.invoiceId, (allocByInv.get(a.invoiceId) || 0) + a.cents);
        const rebateCode = (m.settings && m.settings.rebateAccountCode) || '';
        const guessRebate = rebateCode || (codeable.find(a => /rebate|discount/i.test(a.Name)) || {}).Code || '';

        const rowsHtml = (m.rows || []).map(r => {
            const [label, cls] = STATUS[r.status] || [r.status, ''];
            const alloc = r.invoice ? (allocByInv.get(r.invoice.id) || 0) : 0;
            const inv = r.invoice
                ? `<a href="${invLink(r.invoice.id)}" target="_blank" rel="noopener">${escHtml(r.invoice.number)}</a>${r.invoice.reference ? `<div class="rem-muted">${escHtml(r.invoice.reference)}</div>` : ''}`
                : `<span class="rem-muted">${escHtml(r.ref)}</span>`;
            return `<tr class="${PAYABLE(r) ? '' : 'rem-row--bad'}">
                <td>${inv}</td>
                <td class="rem-num">${r.invoice ? money(r.dueCents) : '—'}</td>
                <td class="rem-num"><strong>${money(r.amountCents)}</strong>${alloc ? `<div class="rem-muted">${money(r.amountCents - alloc)} cash + ${money(alloc)} rebate</div>` : ''}</td>
                <td><span class="rem-chip ${cls}">${escHtml(label)}</span>${r.status === 'partial' ? `<div class="rem-muted">Leaves ${money(r.leftCents)} owing</div>` : r.note && r.status !== 'full' ? `<div class="rem-muted">${escHtml(r.note)}</div>` : ''}</td>
            </tr>`;
        }).join('');

        const dedHtml = (m.deductions || []).map(d => `<tr>
                <td>${escHtml(d.reference)}${d.details ? `<div class="rem-muted">${escHtml(d.details)}</div>` : ''}</td>
                <td class="rem-num"><strong>${money(d.amountCents)}</strong></td>
                <td class="rem-muted">New credit note (GST incl.) → allocated to ${escHtml(((plan.creditNotes || []).find(c => c.reference === d.reference)?.allocations || []).map(a => a.invoiceNumber).join(', ') || '—')}</td>
            </tr>`).join('');

        const other = m.otherOpen || [];
        const otherHtml = other.length ? `
            <details class="rem-other">
                <summary>${other.length} other open invoice${other.length === 1 ? '' : 's'} for ${escHtml(m.contact?.name || 'this customer')} not on this remittance · ${money(other.reduce((s, i) => s + i.dueCents, 0))}</summary>
                <table class="rem-table"><tbody>${other.map(i => `<tr>
                    <td><a href="${invLink(i.id)}" target="_blank" rel="noopener">${escHtml(i.number)}</a>${i.reference ? ` <span class="rem-muted">${escHtml(i.reference)}</span>` : ''}</td>
                    <td class="rem-muted">due ${escHtml(fmtDate(i.dueDate))}</td>
                    <td class="rem-num">${money(i.dueCents)}</td></tr>`).join('')}</tbody></table>
            </details>` : '';

        const applied = m.alreadyApplied;
        const appliedBanner = applied ? `<div class="po-import-status ${applied.status === 'applied' ? 'po-import-status--ok' : 'po-import-status--err'}">
            ${applied.status === 'applied'
                ? `Already applied on ${escHtml(applied.appliedOn || applied.startedOn || String(applied.appliedAt || applied.startedAt).slice(0, 10))} — nothing to do.`
                : `A previous attempt ${applied.status === 'failed' ? 'failed' : 'did not finish'}${applied.error ? ': ' + escHtml(applied.error) : ''}.${(applied.creditNotes || []).length ? ' It created ' + applied.creditNotes.map(c => `<a href="${cnLink(c.id)}" target="_blank" rel="noopener">${escHtml(c.number || 'a credit note')}</a>`).join(', ') + ' — void or keep it in Xero before retrying.' : ''}`}
            </div>` : '';

        const errors = plan.errors || [];
        const canApply = plan.ok && !m.needsReauth && !(applied && applied.status === 'applied');

        ctx.$('#rem-body').innerHTML = `
            <div class="rem-summary">
                <div><span class="rem-muted">From</span><strong>${escHtml(m.contact?.name || remit.payer || '—')}</strong></div>
                <div><span class="rem-muted">Paid</span><strong>${escHtml(fmtDate(remit.paymentDate))}</strong></div>
                <div><span class="rem-muted">Total</span><strong>${money(cents(remit.total))}</strong></div>
                <div><span class="rem-muted">Check</span>${t.ok
                    ? `<span class="rem-chip rem-chip--ok">Ties out</span>`
                    : `<span class="rem-chip rem-chip--err">Off by ${money((t.netCents || 0) - (t.statedCents || 0))}</span>`}</div>
            </div>
            <p class="rem-muted rem-sub">${escHtml(fileName || '')} · ${(m.rows || []).length} invoice${(m.rows || []).length === 1 ? '' : 's'} ${money(t.invoiceCents || 0)}${hasDeductions ? ` − ${m.deductions.length} deduction${m.deductions.length === 1 ? '' : 's'} ${money(t.deductionCents || 0)}` : ''} = ${money(t.netCents || 0)}</p>
            ${appliedBanner}
            ${m.needsReauth ? `<div class="po-import-status po-import-status--err">Reconnect Xero to post this (payments + chart of accounts permission). <a href="/api/xero/auth">Reconnect →</a></div>` : ''}
            <div class="rem-table-wrap"><table class="rem-table">
                <thead><tr><th>Xero invoice</th><th class="rem-num">Owing</th><th class="rem-num">Paying</th><th>Status</th></tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table></div>
            ${hasDeductions ? `<h4 class="rem-h">Deductions</h4>
            <div class="rem-table-wrap"><table class="rem-table"><tbody>${dedHtml}</tbody></table></div>` : ''}
            ${otherHtml}
            <div class="rem-fields">
                <label>Bank account
                    <select id="rem-bank">${banks.length ? '' : '<option value="">— no bank accounts —</option>'}${banks.map(a => `<option value="${escHtml(a.AccountID)}"${a.AccountID === m.suggestedBankAccountId ? ' selected' : ''}>${escHtml(a.Name)}${a.BankAccountNumber ? ' · ' + escHtml(a.BankAccountNumber) : ''}</option>`).join('')}</select>
                </label>
                ${hasDeductions ? `<label>Code rebates to
                    <select id="rem-rebate"><option value="">— choose account —</option>${codeable.map(a => `<option value="${escHtml(a.Code)}"${a.Code === guessRebate ? ' selected' : ''}>${escHtml(a.Code)} · ${escHtml(a.Name)}</option>`).join('')}</select>
                </label>` : ''}
            </div>
            ${errors.length ? `<div class="po-import-status po-import-status--err"><strong>Fix before posting:</strong><ul class="rem-errs">${errors.map(e => `<li>${escHtml(e)}</li>`).join('')}</ul></div>` : ''}
            <div id="rem-msg"></div>`;

        const summaryLine = `${plan.creditNotes?.length ? `${plan.creditNotes.length} credit note${plan.creditNotes.length === 1 ? '' : 's'} (${money(t.deductionCents)}) + ` : ''}a batch payment of ${money(plan.cashCents || 0)} across ${(plan.payments || []).length} invoice${(plan.payments || []).length === 1 ? '' : 's'}`;
        setActions(ctx, `
            <button class="btn-secondary" id="rem-back">Another PDF</button>
            <button class="btn-primary" id="rem-apply"${canApply ? '' : ' disabled'} title="${escHtml(summaryLine)}">Post to Xero</button>`);
        ctx.$('#rem-back').addEventListener('click', () => renderPick(ctx));

        const btn = ctx.$('#rem-apply');
        let armed = false;
        btn.addEventListener('click', async () => {
            const bankAccountId = ctx.$('#rem-bank')?.value || '';
            const rebateAccountCode = ctx.$('#rem-rebate')?.value || '';
            const msg = ctx.$('#rem-msg');
            if (!bankAccountId) { msg.innerHTML = `<div class="po-import-status po-import-status--err">Choose the bank account.</div>`; return; }
            if (hasDeductions && !rebateAccountCode) { msg.innerHTML = `<div class="po-import-status po-import-status--err">Choose the account to code rebates to.</div>`; return; }
            if (!armed) {
                armed = true;
                btn.textContent = 'Confirm — post to Xero';
                msg.innerHTML = `<div class="po-import-status po-import-status--busy">This creates ${escHtml(summaryLine)} in Xero. Click again to confirm.</div>`;
                return;
            }
            btn.disabled = true; btn.textContent = 'Posting…';
            try {
                const res = await api('/api/xero/remittance/apply', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ remit, bankAccountId, rebateAccountCode, force: !!(applied && applied.status === 'failed') }),
                    timeout: 60000,
                });
                renderDone(ctx, remit, m, res);
            } catch (e) {
                if (e.data && e.data.needsReauth) return renderReauth(ctx);
                const created = e.data && e.data.created && e.data.created.creditNotes || [];
                msg.innerHTML = `<div class="po-import-status po-import-status--err">Xero said: ${escHtml(e.message)}${created.length ? `<br>Already created: ${created.map(c => `<a href="${cnLink(c.id)}" target="_blank" rel="noopener">${escHtml(c.number || 'credit note')}</a>`).join(', ')} — check it in Xero.` : ''}</div>`;
                btn.textContent = 'Post to Xero';
            }
        });
    }
    const PAYABLE = r => r.status === 'full' || r.status === 'partial';

    // ── Step 3: done ──
    function renderDone(ctx, remit, m, res) {
        const notes = res.creditNotes || [];
        ctx.$('#rem-body').innerHTML = `
            <div class="po-import-status po-import-status--ok">
                Posted to Xero for ${escHtml(m.contact?.name || remit.payer || '')}:
                <ul class="rem-errs">
                    ${notes.map(c => `<li>Credit note <a href="${cnLink(c.id)}" target="_blank" rel="noopener">${escHtml(c.number || '')}</a> · ${money(c.amountCents)} (${escHtml(c.reference)})</li>`).join('')}
                    ${(res.payments || []).length ? `<li>Batch payment of <strong>${money(res.cashCents || 0)}</strong> across ${res.payments.length} invoice${res.payments.length === 1 ? '' : 's'}, dated ${escHtml(fmtDate(remit.paymentDate))}</li>` : ''}
                </ul>
            </div>
            <p class="rem-lead">Last step in Xero: open <strong>Bank reconciliation</strong> — the ${money(res.cashCents || 0)} deposit should show the batch payment as its match. Click <strong>OK</strong>.</p>`;
        setActions(ctx, `<a class="btn-secondary" href="https://go.xero.com/Bank/BankAccounts.aspx" target="_blank" rel="noopener">Open Xero bank accounts ↗</a><button class="btn-primary" id="rem-close">Done</button>`);
        ctx.$('#rem-close').addEventListener('click', ctx.close);
        if (onAppliedCb) { try { onAppliedCb(res); } catch (_) {} }
    }

    return { open };
})();
