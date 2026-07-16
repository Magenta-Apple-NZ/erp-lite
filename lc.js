// LC Checker — Letters of Credit compliance tracker
const LC = (() => {
    const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    async function apiFetch(path, opts = {}) {
        const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
        if (!r.ok) {
            const err = await r.json().catch(() => ({ error: r.statusText }));
            throw new Error(err.error || r.statusText);
        }
        return r.json();
    }

    // ── Date helpers ──────────────────────────────────────────────────────────

    function fmtDate(iso) {
        if (!iso) return '—';
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-NZ', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function daysUntil(iso) {
        if (!iso) return null;
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const [y, m, d] = iso.split('-').map(Number);
        return Math.round((new Date(y, m - 1, d) - today) / 86400000);
    }

    function deltaHtml(days) {
        if (days === null) return '';
        const cls = days < 0 ? 'crit' : days <= 21 ? 'warn' : 'ok';
        const label = days < 0
            ? `${Math.abs(days)}d overdue`
            : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `${days} days`;
        return `<span class="lc-delta lc-delta--${cls}">${label}</span>`;
    }

    function fmtAmt(currency, amount) {
        return `${currency || 'USD'} ${Number(amount || 0).toLocaleString('en-NZ', {
            minimumFractionDigits: 2, maximumFractionDigits: 2
        })}`;
    }

    // ── Checklist generation (the 5% substituted into fixed structure) ────────

    function generateDocuments(lc) {
        const g  = lc.goods        || {};
        const p  = lc.ports        || {};
        const ab = lc.applicantBank|| {};
        const ap = lc.applicant    || {};
        const amt = fmtAmt(lc.currency, lc.amount);
        const fd  = fmtDate;

        return [
            {
                id: 'draft', title: 'Draft at Sight', copies: '2 originals',
                desc: `Bill of exchange drawn on ${ab.name || '—'}`,
                checks: [
                    { id: 'draft-bank',   text: `Drawn at sight on ${ab.name || '—'}${ab.city ? ', ' + ab.city : ''}` },
                    { id: 'draft-amount', text: `Amount: 100% of invoice value (${amt})` },
                    { id: 'draft-lcref',  text: `LC number and issue date stated (#${lc.lcNumber} · ${fd(lc.issuedDate)})` },
                    { id: 'draft-date',   text: `Dated on or after LC opening date (not before ${fd(lc.issuedDate)})` },
                    { id: 'draft-signed', text: '2 originals signed by Enviroware Ltd' },
                ]
            },
            {
                id: 'commercialInvoice', title: 'Commercial Invoice', copies: '8 originals',
                desc: 'FOB value + freight shown separately',
                checks: [
                    { id: 'ci-fob',         text: 'FOB value stated as a separate line item' },
                    { id: 'ci-freight',     text: 'Freight charge stated as a separate line item' },
                    { id: 'ci-total',       text: `Total equals LC amount (${amt})` },
                    { id: 'ci-lcref',       text: `LC number and opening date on all copies (#${lc.lcNumber} · ${fd(lc.issuedDate)})` },
                    { id: 'ci-importer',    text: `Importer block: ${ap.name || '—'} · HS ${g.hsCode || '—'}` },
                    { id: 'ci-importertax', text: 'Importer BIN, TIN, IRC, and applicant bank TIN/VAT included' },
                    { id: 'ci-goods',       text: `Goods: ${g.packageCount || '?'} ${g.packageType || 'packages'} · ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'} · ${g.origin || '?'} origin` },
                    { id: 'ci-nopredate',   text: `Not dated before LC opening date (${fd(lc.issuedDate)})` },
                    { id: 'ci-copies',      text: '8 originals signed' },
                ]
            },
            {
                id: 'billOfLading', title: 'Clean Shipped-on-Board Ocean B/L', copies: 'Full set (3/3 originals)',
                desc: `To order of ${ab.name || '—'}`,
                checks: [
                    { id: 'bl-sob',       text: '"Shipped on board" notation with actual date' },
                    { id: 'bl-consignee', text: `Consigned to order of ${ab.name || '—'}` },
                    { id: 'bl-notify',    text: `Notify: ${ap.name || '—'} with full address` },
                    { id: 'bl-loading',   text: `Port of loading: ${p.loading || '—'}` },
                    { id: 'bl-discharge', text: `Port of discharge: ${p.discharge || '—'}${p.finalDestination ? ' · Final: ' + p.finalDestination : ''}` },
                    { id: 'bl-freight',   text: 'Freight prepaid' },
                    { id: 'bl-container', text: `Container: ${g.container || '—'} stated` },
                    { id: 'bl-freetime',  text: '14 days free time at discharge port stated or evidenced' },
                    { id: 'bl-weights',   text: `Gross weight, net weight, quantity shown (${g.packageCount || '?'} ${g.packageType || 'packages'} · ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'})` },
                ]
            },
            {
                id: 'certificateOfOrigin', title: 'Certificate of Origin', copies: '3 originals',
                desc: `${g.origin || '—'} — issued by authorised certifying body`,
                checks: [
                    { id: 'co-origin', text: `Country of origin: ${g.origin || '—'}` },
                    { id: 'co-body',   text: 'Issued by authorised chamber of commerce / certifying body' },
                    { id: 'co-desc',   text: 'Goods description matches commercial invoice' },
                    { id: 'co-hs',     text: `HS code ${g.hsCode || '—'} shown` },
                    { id: 'co-copies', text: '3 originals provided' },
                ]
            },
            {
                id: 'insuranceNotification', title: 'Insurance Notification', copies: '1 copy',
                desc: 'Applicant opens insurance — beneficiary to advise within 21 days',
                checks: [
                    { id: 'ins-note',   text: "Insurance is applicant's responsibility — Enviroware advises only" },
                    { id: 'ins-21days', text: 'Notification sent within 21 days of shipment' },
                    { id: 'ins-copy',   text: 'Copy of notification included with presentation documents' },
                ]
            },
            {
                id: 'beneficiaryCertificate', title: "Beneficiary's Certificate of Conformity", copies: '1 original',
                desc: `References Proforma Invoice ${lc.proformaRef || '—'}`,
                checks: [
                    { id: 'bc-ref',      text: `References Proforma Invoice ${lc.proformaRef || '—'}${lc.proformaDate ? ' dated ' + fd(lc.proformaDate) : ''}` },
                    { id: 'bc-quality',  text: 'Certifies quality conforms to proforma invoice' },
                    { id: 'bc-quantity', text: 'Certifies quantity conforms to proforma invoice' },
                    { id: 'bc-origin',   text: `Country of origin (${g.origin || '—'}) noted on packages confirmed` },
                    { id: 'bc-signed',   text: 'Signed by authorised representative of Enviroware Ltd' },
                ]
            },
            {
                id: 'inspectionCertificate', title: 'Pre-Shipment Inspection Certificate', copies: '1 original',
                desc: 'Issued by Enviroware Ltd (self-certification)',
                checks: [
                    { id: 'pi-issued',    text: 'Issued and signed by Enviroware Ltd prior to loading' },
                    { id: 'pi-shipment',  text: 'References vessel, container number(s), and B/L date' },
                    { id: 'pi-confirms',  text: 'Goods inspected before loading — quality and quantity confirmed' },
                    { id: 'pi-lcref',     text: `LC number and date on document (#${lc.lcNumber})` },
                ]
            },
        ];
    }

    const STANDARD_CONDITIONS = [
        { id: 'cond-01', text: 'LC number and date on all documents' },
        { id: 'cond-02', text: 'Importer details on all shipping docs (name, HS code, BIN, TIN, IRC, bank TIN/VAT)' },
        { id: 'cond-03', text: 'No documents dated before LC opening date' },
        { id: 'cond-04', text: 'Third-party documents acceptable — except commercial invoice and bill of exchange' },
        { id: 'cond-05', text: 'Packing list and B/L show quantity, gross weight, and net weight' },
        { id: 'cond-06', text: 'Discrepancy fee noted (USD 58 + SWIFT/mail USD 35)' },
        { id: 'cond-07', text: 'Country of origin on all packages — confirmed by beneficiary certificate' },
        { id: 'cond-08', text: 'Export standard seaworthy packing used' },
        { id: 'cond-09', text: 'Non-negotiable copy docs emailed to applicant within 21 days of shipment' },
        { id: 'cond-10', text: 'Name, address, TIN, BIN, country of origin on ≥ 2% of packages' },
        { id: 'cond-11', text: 'B/L or certificate evidences 14 days free time at discharge port' },
        { id: 'cond-12', text: 'All documents in English' },
        { id: 'cond-13', text: 'No Israeli-flag vessel or UN-sanctioned country routing' },
        { id: 'cond-14', text: 'Transaction not under any active sanctions regime' },
        { id: 'cond-15', text: 'Full set of original docs couriered (DHL) to issuing bank' },
        { id: 'cond-16', text: 'Beneficiary certifies goods shipped per proforma invoice' },
        { id: 'cond-17', text: 'Minor typos acceptable — not in price, amount, qty, ports, or dates' },
        { id: 'cond-18', text: 'Goods are re-exported as stated in proforma invoice' },
        { id: 'cond-19', text: 'Shipment in stated FCL container configuration confirmed' },
        { id: 'cond-20', text: 'Temporary Import Policy conditions complied with (as applicable)' },
    ];

    const STATUS_CYCLE  = ['todo', 'prep', 'ready', 'disc'];
    const STATUS_LABELS = { todo: 'Not started', prep: 'In preparation', ready: 'Ready', disc: 'Discrepancy' };

    // ── List view ─────────────────────────────────────────────────────────────

    async function renderList(container) {
        container.innerHTML = '<p class="lc-loading">Loading…</p>';
        let lcs;
        try {
            ({ lcs } = await apiFetch('/api/lc'));
        } catch (e) {
            container.innerHTML = `<p class="lc-error">Could not load LCs: ${esc(e.message)}</p>`;
            return;
        }

        const rows = lcs.map(lc => {
            const readyCount = Object.values(lc.docStatus || {}).filter(s => s === 'ready').length;
            const days = daysUntil(lc.expiryDate);
            const expCls = days === null ? '' : days < 0 ? 'lc-exp--crit' : days <= 21 ? 'lc-exp--warn' : '';
            return `
            <tr class="lc-list-row" data-id="${esc(lc.id)}" tabindex="0" role="button" aria-label="Open LC ${esc(lc.lcNumber)}">
                <td class="lc-list-ref"><span class="lc-mono">#${esc(lc.lcNumber)}</span></td>
                <td class="lc-list-party">${esc((lc.applicant || {}).name || '—')}</td>
                <td class="lc-list-amt lc-mono">${esc(fmtAmt(lc.currency, lc.amount))}</td>
                <td class="lc-list-exp ${expCls}">${esc(fmtDate(lc.expiryDate))}</td>
                <td class="lc-list-docs">
                    <span class="lc-docs-badge${readyCount === 7 ? ' lc-docs-badge--done' : ''}">${readyCount}/7 ready</span>
                </td>
                <td class="lc-list-ship lc-list-ship--sub">${lc.shipmentRef ? esc(lc.shipmentRef) : '<span class="lc-none">—</span>'}</td>
            </tr>`;
        }).join('');

        container.innerHTML = `
        <div class="orders-view-inner">
            <div class="lc-list-hd">
                <div>
                    <h1 class="lc-page-title">Letters of Credit</h1>
                    <p class="lc-page-sub">LC compliance tracker &amp; document checklist</p>
                </div>
                <a class="lc-btn-primary" href="#lc/new">+ New LC</a>
            </div>
            ${lcs.length === 0 ? '<p class="lc-empty">No LCs yet. <a href="#lc/new">Add one →</a></p>' : `
            <div class="lc-table-wrap">
                <table class="lc-list-table">
                    <thead><tr>
                        <th>LC Number</th>
                        <th>Applicant</th>
                        <th>Amount</th>
                        <th>Expiry</th>
                        <th>Documents</th>
                        <th>Shipment</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`}
        </div>`;

        container.querySelectorAll('.lc-list-row').forEach(row => {
            const open = () => { location.hash = 'lc/' + row.dataset.id; };
            row.addEventListener('click', open);
            row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        });
    }

    // ── Create view ───────────────────────────────────────────────────────────

    function fillFormFromFields(form, fields) {
        const MAP = {
            lcNumber: 'f-lcNumber', currency: 'f-currency', amount: 'f-amount',
            issuedDate: 'f-issuedDate', latestShipDate: 'f-latestShipDate',
            expiryDate: 'f-expiryDate', presentationDays: 'f-presentationDays',
            governedBy: 'f-governedBy', applicantName: 'f-applicantName',
            applicantAddress: 'f-applicantAddress', applicantBankName: 'f-applicantBankName',
            applicantBankCity: 'f-applicantBankCity', applicantBankSwift: 'f-applicantBankSwift',
            advisingBankName: 'f-advisingBankName', advisingBankCity: 'f-advisingBankCity',
            goodsDescription: 'f-goodsDescription', hsCode: 'f-hsCode', origin: 'f-origin',
            packageCount: 'f-packageCount', packageType: 'f-packageType',
            quantity: 'f-quantity', quantityUnit: 'f-quantityUnit', unitPrice: 'f-unitPrice',
            container: 'f-container', incoterms: 'f-incoterms',
            portLoading: 'f-portLoading', portDischarge: 'f-portDischarge', portFinal: 'f-portFinal',
            proformaRef: 'f-proformaRef', proformaDate: 'f-proformaDate',
        };
        for (const [key, id] of Object.entries(MAP)) {
            const val = fields[key];
            if (val === null || val === undefined) continue;
            const el = form.querySelector('#' + id);
            if (el) el.value = String(val);
        }
    }

    async function renderCreate(container) {
        const UPLOAD_SVG = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

        container.innerHTML = `
        <div class="orders-view-inner">
            <div class="lc-create-hd">
                <a class="lc-back" href="#lc">← Letters of Credit</a>
                <h1 class="lc-page-title">New Letter of Credit</h1>
            </div>

            <div class="lc-upload-wrap">
                <div class="lc-upload-zone" id="lc-upload-zone" role="button" tabindex="0"
                     aria-label="Upload MT700 PDF to auto-fill form">
                    <input type="file" id="lc-file-input" accept=".pdf,application/pdf" hidden>
                    <div class="lc-upload-icon">${UPLOAD_SVG}</div>
                    <div class="lc-upload-prompt">Upload MT700 to auto-fill form</div>
                    <div class="lc-upload-hint">Drop PDF here, or click to browse — fields will populate automatically</div>
                </div>
                <div class="lc-extract-status" id="lc-extract-status" hidden></div>
            </div>

            <form id="lc-create-form" class="lc-form" autocomplete="off">

                <div class="lc-form-section">
                    <h2 class="lc-form-section-title">LC Identity</h2>
                    <div class="lc-form-grid">
                        <div class="lc-field" style="grid-column:1/-1">
                            <label class="lc-label" for="f-lcNumber">LC Number <span class="lc-req">*</span></label>
                            <input class="lc-input lc-mono" id="f-lcNumber" name="lcNumber" required placeholder="e.g. 320126011494">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-currency">Currency</label>
                            <select class="lc-input" id="f-currency" name="currency">
                                <option value="USD" selected>USD</option>
                                <option value="EUR">EUR</option>
                                <option value="GBP">GBP</option>
                                <option value="NZD">NZD</option>
                            </select>
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-amount">Amount <span class="lc-req">*</span></label>
                            <input class="lc-input lc-mono" id="f-amount" name="amount" type="number" step="0.01" min="0" required placeholder="0.00">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-issuedDate">Issued Date</label>
                            <input class="lc-input" id="f-issuedDate" name="issuedDate" type="date">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-latestShipDate">Latest Ship Date</label>
                            <input class="lc-input" id="f-latestShipDate" name="latestShipDate" type="date">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-expiryDate">Expiry Date</label>
                            <input class="lc-input" id="f-expiryDate" name="expiryDate" type="date">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-presentationDays">Presentation Days</label>
                            <input class="lc-input lc-mono" id="f-presentationDays" name="presentationDays" type="number" min="1" value="21">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-governedBy">Governed By</label>
                            <input class="lc-input" id="f-governedBy" name="governedBy" value="UCP 600">
                        </div>
                    </div>
                </div>

                <div class="lc-form-section">
                    <h2 class="lc-form-section-title">Parties</h2>
                    <div class="lc-form-grid">
                        <div class="lc-field" style="grid-column:1/-1">
                            <label class="lc-label" for="f-applicantName">Applicant Name <span class="lc-req">*</span></label>
                            <input class="lc-input" id="f-applicantName" name="applicantName" required placeholder="e.g. J.P.S. Enterprise">
                        </div>
                        <div class="lc-field" style="grid-column:1/-1">
                            <label class="lc-label" for="f-applicantAddress">Applicant Address</label>
                            <input class="lc-input" id="f-applicantAddress" name="applicantAddress" placeholder="City, Country">
                        </div>
                        <div class="lc-field lc-field--wide">
                            <label class="lc-label" for="f-applicantBankName">Issuing Bank</label>
                            <input class="lc-input" id="f-applicantBankName" name="applicantBankName" placeholder="e.g. SBAC Bank PLC">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-applicantBankCity">Bank City</label>
                            <input class="lc-input" id="f-applicantBankCity" name="applicantBankCity" placeholder="e.g. Dhaka, BD">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-applicantBankSwift">Bank SWIFT</label>
                            <input class="lc-input lc-mono" id="f-applicantBankSwift" name="applicantBankSwift" placeholder="XXXXBDDH">
                        </div>
                        <div class="lc-field lc-field--wide">
                            <label class="lc-label" for="f-advisingBankName">Advising Bank</label>
                            <input class="lc-input" id="f-advisingBankName" name="advisingBankName" value="ANZ Bank NZ">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-advisingBankCity">Advising Bank City</label>
                            <input class="lc-input" id="f-advisingBankCity" name="advisingBankCity" value="Wellington">
                        </div>
                    </div>
                </div>

                <div class="lc-form-section">
                    <h2 class="lc-form-section-title">Goods</h2>
                    <div class="lc-form-grid">
                        <div class="lc-field" style="grid-column:1/-1">
                            <label class="lc-label" for="f-goodsDescription">Description</label>
                            <textarea class="lc-input lc-textarea" id="f-goodsDescription" name="goodsDescription" rows="2" placeholder="e.g. Knitted nylon stocking material (toeclip) — by-product from manufacture of stockings"></textarea>
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-hsCode">HS Code</label>
                            <input class="lc-input lc-mono" id="f-hsCode" name="hsCode" placeholder="0000.00.00">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-origin">Origin Country</label>
                            <input class="lc-input" id="f-origin" name="origin" placeholder="e.g. Italy">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-packageCount">Package Count</label>
                            <input class="lc-input lc-mono" id="f-packageCount" name="packageCount" type="number" min="0" placeholder="40">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-packageType">Package Type</label>
                            <input class="lc-input" id="f-packageType" name="packageType" value="bales" placeholder="bales / cartons / pallets">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-quantity">Quantity</label>
                            <input class="lc-input lc-mono" id="f-quantity" name="quantity" type="number" step="0.01" min="0" placeholder="18754.00">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-quantityUnit">Unit</label>
                            <select class="lc-input" id="f-quantityUnit" name="quantityUnit">
                                <option value="kg" selected>kg</option>
                                <option value="mt">mt</option>
                                <option value="units">units</option>
                                <option value="pcs">pcs</option>
                            </select>
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-unitPrice">Unit Price</label>
                            <input class="lc-input lc-mono" id="f-unitPrice" name="unitPrice" type="number" step="0.0001" min="0" placeholder="1.18">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-container">Container</label>
                            <input class="lc-input" id="f-container" name="container" placeholder="e.g. 1×40 FCL">
                        </div>
                        <div class="lc-field lc-field--wide">
                            <label class="lc-label" for="f-incoterms">Incoterms</label>
                            <input class="lc-input" id="f-incoterms" name="incoterms" placeholder="e.g. CPT ICD Kamlapur, Dhaka via Chattogram (Incoterms 2020)">
                        </div>
                    </div>
                </div>

                <div class="lc-form-section">
                    <h2 class="lc-form-section-title">Routing &amp; References</h2>
                    <div class="lc-form-grid">
                        <div class="lc-field">
                            <label class="lc-label" for="f-portLoading">Port of Loading</label>
                            <input class="lc-input" id="f-portLoading" name="portLoading" placeholder="e.g. Any port of Italy">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-portDischarge">Port of Discharge</label>
                            <input class="lc-input" id="f-portDischarge" name="portDischarge" placeholder="e.g. Chattogram Sea Port">
                        </div>
                        <div class="lc-field lc-field--wide">
                            <label class="lc-label" for="f-portFinal">Final Destination</label>
                            <input class="lc-input" id="f-portFinal" name="portFinal" placeholder="e.g. ICD Kamlapur, Dhaka">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-proformaRef">Proforma Invoice Ref</label>
                            <input class="lc-input lc-mono" id="f-proformaRef" name="proformaRef" placeholder="e.g. 101/2026">
                        </div>
                        <div class="lc-field">
                            <label class="lc-label" for="f-proformaDate">Proforma Invoice Date</label>
                            <input class="lc-input" id="f-proformaDate" name="proformaDate" type="date">
                        </div>
                        <div class="lc-field lc-field--wide">
                            <label class="lc-label" for="f-shipmentRef">Linked Shipment <span class="lc-sub-label">(optional — seq # or description)</span></label>
                            <input class="lc-input" id="f-shipmentRef" name="shipmentRef" placeholder="e.g. Shipment #40">
                        </div>
                    </div>
                </div>

                <div class="lc-form-actions">
                    <a class="lc-btn-ghost" href="#lc">Cancel</a>
                    <button type="submit" class="lc-btn-primary" id="lc-submit-btn">Create LC</button>
                </div>
                <p class="lc-form-error" id="lc-form-error" hidden></p>
            </form>
        </div>`;

        const form    = container.querySelector('#lc-create-form');
        const zone    = container.querySelector('#lc-upload-zone');
        const fileIn  = container.querySelector('#lc-file-input');
        const statusEl = container.querySelector('#lc-extract-status');

        function showExtractStatus(type, msg) {
            statusEl.hidden = false;
            statusEl.className = 'lc-extract-status lc-extract-status--' + type;
            const icon = type === 'loading' ? '' : type === 'ok' ? '✓ ' : '✗ ';
            statusEl.textContent = (type === 'loading'
                ? '⏳ ' : icon) + msg;
        }

        async function handleUpload(file) {
            if (!file.name.endsWith('.pdf') && !file.type.includes('pdf')) {
                showExtractStatus('error', 'Please upload a PDF file');
                return;
            }
            showExtractStatus('loading', 'Reading document…');
            zone.classList.add('lc-upload-zone--busy');

            try {
                // Encode PDF to base64 in the browser — Workers have strict CPU limits
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = () => reject(new Error('Failed to read file'));
                    reader.readAsDataURL(file);
                });

                showExtractStatus('loading', 'Extracting fields with AI…');
                const res = await fetch('/api/lc-extract', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ data: base64, mediaType: 'application/pdf' }),
                });
                const ct = res.headers.get('content-type') || '';
                if (!ct.includes('json')) {
                    const preview = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
                    throw new Error(`HTTP ${res.status} — ${preview}`);
                }
                const json = await res.json();
                if (!json.ok) throw new Error(json.error || 'Extraction failed');
                if (!json.fields) throw new Error('No fields returned by extraction service');
                fillFormFromFields(form, json.fields);
                const num = json.fields.lcNumber || 'document';
                showExtractStatus('ok', `Fields populated from LC #${num}`);
                zone.classList.remove('lc-upload-zone--busy');
                form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (err) {
                showExtractStatus('error', err.message || 'Failed to extract fields');
                zone.classList.remove('lc-upload-zone--busy');
            }
        }

        zone.addEventListener('click', () => fileIn.click());
        zone.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); }
        });
        zone.addEventListener('dragover', e => {
            e.preventDefault();
            zone.classList.add('lc-upload-zone--drag');
        });
        zone.addEventListener('dragleave', e => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('lc-upload-zone--drag');
        });
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('lc-upload-zone--drag');
            const file = e.dataTransfer.files[0];
            if (file) handleUpload(file);
        });
        fileIn.addEventListener('change', () => {
            if (fileIn.files[0]) handleUpload(fileIn.files[0]);
        });

        form.addEventListener('submit', async e => {
            e.preventDefault();
            const btn = container.querySelector('#lc-submit-btn');
            btn.disabled = true;
            btn.textContent = 'Creating…';
            const errEl = container.querySelector('#lc-form-error');
            errEl.hidden = true;

            const data = Object.fromEntries(new FormData(e.target).entries());
            try {
                const created = await apiFetch('/api/lc', {
                    method: 'POST',
                    body: JSON.stringify(data),
                });
                location.hash = 'lc/' + created.id;
            } catch (err) {
                errEl.textContent = err.message;
                errEl.hidden = false;
                btn.disabled = false;
                btn.textContent = 'Create LC';
            }
        });
    }

    // ── Detail / checker view ─────────────────────────────────────────────────

    let _saveTimer = null;
    let _pending   = {};
    let _activeLcId = null;

    function scheduleChecksave(id) {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(async () => {
            if (!Object.keys(_pending).length) return;
            const payload = { ..._pending };
            _pending = {};
            const statusEl = document.getElementById('lc-save-status');
            if (statusEl) statusEl.textContent = 'Saving…';
            try {
                await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify(payload) });
                if (statusEl) { statusEl.textContent = 'Saved'; setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500); }
            } catch (_) {
                if (statusEl) statusEl.textContent = 'Save failed';
            }
        }, 700);
    }

    function readyCount(lc) {
        return Object.values(lc.docStatus || {}).filter(s => s === 'ready').length;
    }

    function renderDocCard(doc, lc) {
        const status  = (lc.docStatus || {})[doc.id] || 'todo';
        const checks  = lc.docChecks || {};
        const checked = doc.checks.filter(c => checks[c.id]).length;
        const ICONS = {
            draft:                  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1h6l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><polyline points="9,1 9,4 12,4"/><line x1="5" y1="9" x2="11" y2="9"/></svg>`,
            commercialInvoice:      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1" width="12" height="14" rx="1"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="8" y2="11"/></svg>`,
            billOfLading:           `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 11l4-6h6l4 6"/><line x1="1" y1="11" x2="15" y2="11"/><line x1="3" y1="13" x2="13" y2="13"/></svg>`,
            certificateOfOrigin:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2 3-3"/></svg>`,
            insuranceNotification:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5l5 2.5v4c0 3-2 5-5 6C6 13 3 11 3 8V4z"/></svg>`,
            beneficiaryCertificate: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1" width="12" height="14" rx="1"/><path d="M5.5 8l2 2 3-3"/></svg>`,
            inspectionCertificate:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5l4 4"/></svg>`,
        };

        const checkItems = doc.checks.map(c => {
            const isChecked = !!checks[c.id];
            return `<div class="lc-check-item${isChecked ? ' lc-check-item--done' : ''}">
                <input type="checkbox" id="chk-${c.id}" data-check="${c.id}" ${isChecked ? 'checked' : ''}>
                <label for="chk-${c.id}">${esc(c.text)}</label>
            </div>`;
        }).join('');

        return `
        <div class="lc-doc-card lc-doc-card--${status}" id="lcdoc-${doc.id}" data-doc="${doc.id}">
            <div class="lc-doc-hd">
                <div class="lc-doc-icon">${ICONS[doc.id] || ''}</div>
                <div class="lc-doc-meta">
                    <div class="lc-doc-title">${esc(doc.title)}</div>
                    <div class="lc-doc-copies">${esc(doc.copies)} &nbsp;·&nbsp; ${esc(doc.desc)}</div>
                </div>
                <div class="lc-doc-right">
                    <span class="lc-doc-prog">${checked}/${doc.checks.length}</span>
                    <button class="lc-chip lc-chip--${status}" data-status-doc="${doc.id}" type="button">${STATUS_LABELS[status]}</button>
                    <svg class="lc-doc-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3,6 8,11 13,6"/></svg>
                </div>
            </div>
            <div class="lc-doc-checks">${checkItems}</div>
        </div>`;
    }

    async function renderDetail(container, id) {
        _activeLcId = id;
        container.innerHTML = '<p class="lc-loading">Loading…</p>';

        let lc;
        try {
            lc = await apiFetch('/api/lc/' + id);
        } catch (e) {
            container.innerHTML = `<p class="lc-error">Could not load LC: ${esc(e.message)}</p>`;
            return;
        }

        const docs = generateDocuments(lc);
        const ready = readyCount(lc);
        const isCleared = ready === 7;
        const pct = Math.round((ready / 7) * 100);

        const shipDays   = daysUntil(lc.latestShipDate);
        const expiryDays = daysUntil(lc.expiryDate);

        const g  = lc.goods        || {};
        const p  = lc.ports        || {};
        const ab = lc.applicantBank|| {};
        const ap = lc.applicant    || {};
        const adv= lc.advisingBank || {};

        const sideRow = (label, val, mono = false) =>
            `<div class="lc-srow"><span class="lc-srow-label">${label}</span><span class="lc-srow-val${mono ? ' lc-mono' : ''}">${esc(val || '—')}</span></div>`;

        const condChecks = lc.condChecks || {};
        const condDone   = STANDARD_CONDITIONS.filter(c => condChecks[c.id]).length;
        const condItems  = STANDARD_CONDITIONS.map((c, i) => {
            const checked = !!condChecks[c.id];
            return `<div class="lc-cond-item${checked ? ' lc-cond-item--done' : ''}">
                <span class="lc-cond-num">${String(i + 1).padStart(2, '0')}</span>
                <input type="checkbox" id="cond-${c.id}" data-cond="${c.id}" ${checked ? 'checked' : ''}>
                <label for="cond-${c.id}">${esc(c.text)}</label>
            </div>`;
        }).join('');

        container.innerHTML = `
        <div class="orders-view-inner">
            <div class="lc-detail-hd">
                <a class="lc-back" href="#lc">← Letters of Credit</a>
                <span class="lc-save-status" id="lc-save-status"></span>
            </div>

            <div class="lc-checker-identity">
                <div class="lc-identity-left">
                    <span class="lc-mono lc-identity-ref">#${esc(lc.lcNumber)}</span>
                    <span class="lc-identity-parties">${esc(lc.beneficiary || 'Enviroware Ltd')} → ${esc(ap.name || '—')}</span>
                    ${lc.shipmentRef ? `<span class="lc-identity-ship">Shipment: ${esc(lc.shipmentRef)}</span>` : ''}
                </div>
                <div class="lc-identity-right">
                    <div class="lc-identity-amt lc-mono">${esc(fmtAmt(lc.currency, lc.amount))}</div>
                    <span class="lc-clearance-chip ${isCleared ? 'lc-clearance--ok' : 'lc-clearance--no'}"
                          id="lc-clearance">
                        ${isCleared ? 'Cleared to present' : 'Not cleared to present'}
                    </span>
                </div>
            </div>

            <div class="lc-progress-wrap">
                <div class="lc-progress-track"><div class="lc-progress-fill" id="lc-pfill" style="width:${pct}%"></div></div>
                <span class="lc-progress-label" id="lc-plabel">${ready} of 7 documents ready</span>
            </div>

            <div class="lc-checker-timeline">
                <div class="lc-tl-item">
                    <div class="lc-tl-label">Latest shipment date</div>
                    <div class="lc-tl-date lc-mono">${esc(fmtDate(lc.latestShipDate))}</div>
                    ${deltaHtml(shipDays)}
                </div>
                <div class="lc-tl-item">
                    <div class="lc-tl-label">Presentation deadline</div>
                    <div class="lc-tl-date lc-mono">${lc.latestShipDate ? esc(fmtDate(lc.latestShipDate)) + ' + ' + (lc.presentationDays || 21) + 'd' : '—'}</div>
                    <span class="lc-tl-note">${lc.presentationDays || 21} days after shipment</span>
                </div>
                <div class="lc-tl-item">
                    <div class="lc-tl-label">LC expiry</div>
                    <div class="lc-tl-date lc-mono">${esc(fmtDate(lc.expiryDate))}</div>
                    ${deltaHtml(expiryDays)}
                </div>
            </div>

            <div class="lc-checker-body">
                <aside class="lc-ref-sidebar">
                    <div class="lc-scard">
                        <div class="lc-scard-title">Amounts &amp; Goods</div>
                        ${sideRow('LC Amount',   fmtAmt(lc.currency, lc.amount), true)}
                        ${sideRow('Unit price',  `${lc.currency || 'USD'} ${g.unitPrice || '—'} / ${g.quantityUnit || 'kg'}`, true)}
                        ${sideRow('Quantity',    `${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'}`, true)}
                        ${sideRow('Packages',    `${g.packageCount || '?'} ${g.packageType || 'packages'}`, true)}
                        ${sideRow('HS Code',     g.hsCode, true)}
                        ${sideRow('Origin',      g.origin)}
                        ${sideRow('Container',   g.container)}
                        ${sideRow('Incoterms',   g.incoterms)}
                    </div>
                    <div class="lc-scard">
                        <div class="lc-scard-title">Parties</div>
                        ${sideRow('Beneficiary',   lc.beneficiary || 'Enviroware Ltd')}
                        ${sideRow('Applicant',     ap.name + (ap.address ? ', ' + ap.address : ''))}
                        ${sideRow('Issuing bank',  ab.name + (ab.city ? ', ' + ab.city : ''))}
                        ${sideRow('Advising bank', adv.name + (adv.city ? ', ' + adv.city : ''))}
                    </div>
                    <div class="lc-scard">
                        <div class="lc-scard-title">References</div>
                        ${sideRow('Proforma',    lc.proformaRef, true)}
                        ${sideRow('PI date',     fmtDate(lc.proformaDate))}
                        ${sideRow('LC issued',   fmtDate(lc.issuedDate))}
                        ${sideRow('Governed by', lc.governedBy)}
                        ${sideRow('Port loading',   p.loading)}
                        ${sideRow('Port discharge', p.discharge)}
                        ${sideRow('Final dest.',    p.finalDestination)}
                    </div>
                </aside>

                <main class="lc-checker-main">
                    <div class="lc-section-label">Documents Required — F46A</div>
                    <div class="lc-doc-list" id="lc-doc-list">
                        ${docs.map(d => renderDocCard(d, lc)).join('')}
                    </div>

                    <details class="lc-cond-section" id="lc-cond-section">
                        <summary class="lc-cond-summary">
                            <span class="lc-cond-title">Additional Conditions — F47A</span>
                            <span class="lc-cond-count" id="lc-cond-count">${condDone} of ${STANDARD_CONDITIONS.length} confirmed</span>
                        </summary>
                        <div class="lc-cond-grid" id="lc-cond-grid">${condItems}</div>
                    </details>
                </main>
            </div>
        </div>`;

        bindDetailEvents(container, id);
    }

    function bindDetailEvents(container, id) {
        // Doc card expand/collapse
        container.querySelector('#lc-doc-list').addEventListener('click', e => {
            const hd = e.target.closest('.lc-doc-hd');
            if (!hd || e.target.closest('.lc-chip')) return;
            const card = hd.closest('.lc-doc-card');
            card.classList.toggle('lc-doc-card--open');
        });

        // Status chip: cycle and save immediately
        container.querySelector('#lc-doc-list').addEventListener('click', async e => {
            const btn = e.target.closest('[data-status-doc]');
            if (!btn) return;
            const docId = btn.dataset.statusDoc;
            const card  = container.querySelector(`#lcdoc-${docId}`);
            const curr  = STATUS_CYCLE.indexOf(btn.className.match(/lc-chip--(\w+)/)?.[1] || 'todo');
            const next  = STATUS_CYCLE[(curr + 1) % STATUS_CYCLE.length];

            btn.className  = `lc-chip lc-chip--${next}`;
            btn.textContent = STATUS_LABELS[next];
            card.className  = card.className.replace(/lc-doc-card--(?:todo|prep|ready|disc)/, `lc-doc-card--${next}`);

            updateClearance(container);

            await apiFetch('/api/lc/' + id, {
                method: 'PATCH',
                body: JSON.stringify({ docStatus: { [docId]: next } }),
            }).catch(() => {});
        });

        // Doc checkboxes: accumulate and debounce
        container.querySelector('#lc-doc-list').addEventListener('change', e => {
            const cb = e.target.closest('[data-check]');
            if (!cb) return;
            const checkId = cb.dataset.check;
            cb.closest('.lc-check-item')?.classList.toggle('lc-check-item--done', cb.checked);

            // update progress counter in card header
            const card = cb.closest('.lc-doc-card');
            const total  = card.querySelectorAll('[data-check]').length;
            const ticked = card.querySelectorAll('[data-check]:checked').length;
            const prog = card.querySelector('.lc-doc-prog');
            if (prog) prog.textContent = `${ticked}/${total}`;

            if (!_pending.docChecks) _pending.docChecks = {};
            _pending.docChecks[checkId] = cb.checked;
            scheduleChecksave(id);
        });

        // Condition checkboxes
        container.querySelector('#lc-cond-grid').addEventListener('change', e => {
            const cb = e.target.closest('[data-cond]');
            if (!cb) return;
            cb.closest('.lc-cond-item')?.classList.toggle('lc-cond-item--done', cb.checked);

            const total  = container.querySelectorAll('[data-cond]').length;
            const ticked = container.querySelectorAll('[data-cond]:checked').length;
            const count = container.querySelector('#lc-cond-count');
            if (count) count.textContent = `${ticked} of ${total} confirmed`;

            if (!_pending.condChecks) _pending.condChecks = {};
            _pending.condChecks[cb.dataset.cond] = cb.checked;
            scheduleChecksave(id);
        });
    }

    function updateClearance(container) {
        const chips = [...container.querySelectorAll('[data-status-doc]')];
        const ready = chips.filter(b => b.classList.contains('lc-chip--ready')).length;
        const pct   = Math.round((ready / 7) * 100);

        const fill  = container.querySelector('#lc-pfill');
        const label = container.querySelector('#lc-plabel');
        const chip  = container.querySelector('#lc-clearance');
        if (fill)  fill.style.width = pct + '%';
        if (label) label.textContent = `${ready} of 7 documents ready`;
        if (chip) {
            const cleared = ready === 7;
            chip.textContent = cleared ? 'Cleared to present' : 'Not cleared to present';
            chip.className   = `lc-clearance-chip ${cleared ? 'lc-clearance--ok' : 'lc-clearance--no'}`;
        }
    }

    // ── Public router ─────────────────────────────────────────────────────────

    async function render(container, subpath) {
        _pending    = {};
        _activeLcId = null;
        clearTimeout(_saveTimer);

        if (!subpath || subpath === '') return renderList(container);
        if (subpath === 'new')          return renderCreate(container);
        return renderDetail(container, subpath);
    }

    return { render };
})();
