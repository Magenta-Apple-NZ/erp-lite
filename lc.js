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

    function addDays(isoDate, days) {
        if (!isoDate) return null;
        const [y, m, d] = isoDate.split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        dt.setDate(dt.getDate() + (days || 0));
        return dt.toISOString().slice(0, 10);
    }

    // ── Checklist generation (the 5% substituted into fixed structure) ────────

    function generateDocuments(lc) {
        const g  = lc.goods        || {};
        const p  = lc.ports        || {};
        const ab = lc.applicantBank|| {};
        const ap = lc.applicant    || {};
        const amt = fmtAmt(lc.currency, lc.amount);
        const fd  = fmtDate;

        const f47aChecks = (docId) => (lc.f47aConditions || [])
            .map((c, gi) => ({ c, gi }))
            .filter(({ c }) => !c.docId || c.docId === 'general' || c.docId === docId)
            .map(({ c, gi }, i) => ({ id: `f47a-${docId}-${i}`, text: c.text, cite: `lc-f47a-${gi}` }));

        return [
            {
                id: 'draft', title: 'Draft at Sight', copies: '2 originals', group: 'admin',
                desc: `Bill of exchange drawn on ${ab.name || '—'}`,
                checks: [
                    { id: 'draft-bank',   cite: 'lc-f-41d', text: `Drawn at sight on ${ab.name || '—'}${ab.city ? ', ' + ab.city : ''}` },
                    { id: 'draft-drawee', cite: 'lc-f-41d', text: `Drawee is exactly ${ab.name || '—'} as per LC F 42A — full bank name, not abbreviated` },
                    { id: 'draft-drawer', cite: 'lc-f-46a-draft', text: 'Drawer name (Enviroware Ltd) explicitly stated on draft' },
                    { id: 'draft-amount', cite: 'lc-f-32b', text: `Amount: 100% of invoice value (${amt})` },
                    { id: 'draft-lcref',  cite: 'lc-f-20',  text: `LC number and issue date stated (#${lc.lcNumber} · ${fd(lc.issuedDate)})` },
                    { id: 'draft-date',   cite: 'lc-f-31c', text: `Dated on or after LC opening date (not before ${fd(lc.issuedDate)})` },
                    { id: 'draft-signed', cite: 'lc-f-46a-draft', text: '2 originals signed by Enviroware Ltd' },
                    ...f47aChecks('draft'),
                ]
            },
            {
                id: 'commercialInvoice', title: 'Commercial Invoice', copies: '8 originals', group: 'enviro',
                desc: 'FOB value + freight shown separately',
                checks: [
                    { id: 'ci-invoicedate', cite: 'lc-f-31d',
                      text: `Invoice date within LC validity`,
                      detail: `Invoice date: extract the stated date. Must be on or after LC opening date ${fd(lc.issuedDate)} and on or before expiry ${fd(lc.expiryDate)}. State the date found.` },
                    { id: 'ci-total', cite: 'lc-f-32b',
                      text: `Total, FOB, and freight amounts correct`,
                      detail: `Invoice amounts: (1) Extract the final invoice total and confirm it equals exactly ${amt} to the cent. (2) Extract the FOB line-item — must appear separately. (3) Extract the freight line-item — must appear separately. (4) Confirm FOB + Freight arithmetically equals the invoice total. Any rounding or discrepancy on any figure is a fail.` },
                    { id: 'ci-unitprice', cite: 'lc-f-45a',
                      text: `Unit price exactly ${lc.currency || 'USD'} ${g.unitPrice || '—'}/${g.quantityUnit || 'kg'}`,
                      detail: `Unit price: extract the price per ${g.quantityUnit || 'kg'} and confirm it exactly matches ${lc.currency || 'USD'} ${g.unitPrice || '—'}. A difference of even one cent is a fail.` },
                    { id: 'ci-wtinternal', cite: 'lc-f-45a',
                      text: `Net weight consistent throughout document`,
                      detail: `Net weight internal consistency: scan the ENTIRE document and find every mention of net weight, total weight, or quantity — goods line items, weight summary table, packing details section, footer, certification clause, anywhere. List every figure found and confirm all instances equal exactly ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'}. If any section shows a different figure — even if the price calculations appear correct — that is a fail.` },
                    { id: 'ci-goods', cite: 'lc-f-45a',
                      text: `Goods: ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'} · ${g.packageCount || '?'} ${g.packageType || 'bales'} · ${g.origin || '?'} origin`,
                      detail: `Goods description and quantity: extract the goods description wording and confirm it is consistent with the LC. Confirm package count is ${g.packageCount || '?'} ${g.packageType || 'bales'} and origin is ${g.origin || '?'}.` },
                    { id: 'ci-incoterms', cite: 'lc-f-44d',
                      text: `Incoterms exactly as per LC`,
                      detail: `Incoterms: extract the exact wording and confirm it matches "${g.incoterms || '—'}". Flag any abbreviation (C&F, C&I, CFR without "Incoterms 2020"). Quote what the document actually says.` },
                    { id: 'ci-portloading', cite: 'lc-f-44a',
                      text: `Port of loading: ${p.loading || '—'}`,
                      detail: `Port of loading: extract the exact wording and confirm it matches "${p.loading || '—'}". Flag any abbreviation, alternative spelling, or vague wording such as "any port of Italy".` },
                    { id: 'ci-proforma', cite: 'lc-f-47a',
                      text: `Proforma ref No. ${lc.proformaRef || '—'}${lc.proformaDate ? ' · ' + fd(lc.proformaDate) : ''}`,
                      detail: `Proforma reference: extract the stated reference number and date. Must exactly match No. ${lc.proformaRef || '—'}${lc.proformaDate ? ' dated ' + fd(lc.proformaDate) : ''}. A wrong digit or wrong date is a common rejection reason.` },
                    { id: 'ci-importer', cite: 'lc-f-50',
                      text: `Importer name and address exact`,
                      detail: `Importer: extract the full name and address and confirm exact match to "${ap.name || '—'}${ap.address ? ', ' + ap.address : ''}". Different punctuation, abbreviation, or word order is a discrepancy.` },
                    { id: 'ci-regs', cite: 'lc-f-47a',
                      text: `BIN, TIN, IRC, HS code ${g.hsCode || '—'} present`,
                      detail: `Regulatory numbers: confirm BIN, TIN, IRC for ${ap.name || 'importer'} and TIN/VAT for ${ab.name || 'applicant bank'} all appear. Extract the HS code and confirm it matches ${g.hsCode || '—'} in full.` },
                    ...f47aChecks('commercialInvoice'),
                ]
            },
            {
                id: 'billOfLading', title: 'Clean Shipped-on-Board Ocean B/L', copies: 'Full set (3/3 originals)', group: '3rdparty',
                desc: `To order of ${ab.name || '—'}`,
                checks: [
                    { id: 'bl-sob',        cite: 'lc-f-46a-billOfLading', text: `Shipped on board: extract the notation and confirm it includes the actual on-board date — "received for shipment" or no date is a fail` },
                    { id: 'bl-shipdate',   cite: 'lc-f-44c', text: `On-board date: extract the date and confirm it is on or before latest shipment date ${fd(lc.latestShipDate)} and not before LC opening date ${fd(lc.issuedDate)}` },
                    { id: 'bl-consignee',  cite: 'lc-f-46a-billOfLading', text: `Consignee: extract exact wording and confirm it matches the LC instruction — "to order of ${ab.name || '—'}" — any variation (direct consignment, wrong bank name) is a fail` },
                    { id: 'bl-notify',     cite: 'lc-f-46a-billOfLading', text: `Notify party 1: extract the name and address and confirm exact match to "${ap.name || '—'}${ap.address ? ', ' + ap.address : ''}" — any abbreviation or address variation is a flag` },
                    { id: 'bl-banknotify', cite: 'lc-f-46a-billOfLading', text: `Notify party 2: extract name and address and confirm it matches issuing bank "${ab.name || '—'}, ${ab.city || '—'}" as per LC F 46A` },
                    { id: 'bl-loading',    cite: 'lc-f-44a', text: `Port of loading: extract exact wording and confirm it matches "${p.loading || '—'}" — abbreviated or alternate port name is a discrepancy` },
                    { id: 'bl-discharge',  cite: 'lc-f-44b', text: `Port of discharge: extract exact wording and confirm it matches "${p.discharge || '—'}${p.finalDestination ? ' / ' + p.finalDestination : ''}" — not abbreviated` },
                    { id: 'bl-freight',    cite: 'lc-f-46a-billOfLading', text: `Freight: extract the freight notation — confirm it reads "Freight Prepaid" — "Freight Collect" or blank is a fail` },
                    { id: 'bl-container',  cite: 'lc-f-45a', text: `Container number: extract the container number and confirm it matches ${g.container || '—'} as per the shipping documents` },
                    { id: 'bl-weights',    cite: 'lc-f-46a-billOfLading', text: `Weights and quantity: extract gross weight, net weight, and package count — confirm ${g.packageCount || '?'} ${g.packageType || 'packages'} and ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'} net` },
                    { id: 'bl-freetime',   cite: 'lc-f-47a', text: `Free time: confirm 14 days free time at discharge port is stated or evidenced on the B/L or attached certificate` },
                    { id: 'bl-banktax',    cite: 'lc-f-47a', text: `Bank tax numbers: confirm ${ab.name || 'applicant bank'} TIN No. and VAT Reg. No. appear on the B/L` },
                    { id: 'bl-clean',      cite: 'lc-f-46a-billOfLading', text: `Clean B/L: confirm there are no clauses noting damaged, inadequate, or suspect packaging — any such notation is a fail` },
                    ...f47aChecks('billOfLading'),
                ]
            },
            {
                id: 'certificateOfOrigin', title: 'Certificate of Origin', copies: '3 originals', group: '3rdparty',
                desc: `${g.origin || '—'} — issued by authorised certifying body`,
                checks: [
                    { id: 'co-origin',  cite: 'lc-f-46a-certificateOfOrigin', text: `Country of origin: extract the stated country and confirm it matches "${g.origin || '—'}" exactly` },
                    { id: 'co-body',    cite: 'lc-f-46a-certificateOfOrigin', text: `Issuing body: extract the certifying organisation name — must be an authorised chamber of commerce or government authority, not self-certified` },
                    { id: 'co-desc',    cite: 'lc-f-46a-certificateOfOrigin', text: `Goods description: extract the wording and confirm it is consistent with the commercial invoice description — any material difference is a flag` },
                    { id: 'co-hs',      cite: 'lc-f-47a', text: `HS code: extract the full code and confirm it matches ${g.hsCode || '—'} in full including all sub-headings — abbreviated code (e.g. 6002 instead of 6002.90.00) is a fail` },
                    { id: 'co-shipper', cite: 'lc-f-46a-certificateOfOrigin', text: `Shipper/exporter: extract name and address and confirm it matches the beneficiary (Enviroware Ltd) and is consistent with the B/L` },
                    { id: 'co-qty',     cite: 'lc-f-45a', text: `Quantity on COO: extract the stated quantity and confirm it matches the commercial invoice and B/L — any discrepancy in kg or package count is a flag` },
                    ...f47aChecks('certificateOfOrigin'),
                ]
            },
            {
                id: 'insuranceNotification', title: 'Insurance Notification', copies: '1 copy', group: 'email',
                desc: 'Applicant opens insurance — beneficiary to advise within 21 days',
                checks: [
                    { id: 'ins-note',       cite: 'lc-f-46a-insuranceNotification', text: "Insurance is applicant's responsibility — Enviroware advises only" },
                    { id: 'ins-21days',     cite: 'lc-f-46a-insuranceNotification', text: 'Notification sent within 21 days of shipment (or within LC-specified period)' },
                    { id: 'ins-covernote',  cite: 'lc-f-46a-insuranceNotification', text: 'Cover note number stated on shipping/insurance advice' },
                    { id: 'ins-addressed',  cite: 'lc-f-46a-insuranceNotification', text: `Addressed to both applicant (${ap.name || '—'}) and the insurance company` },
                    { id: 'ins-copy',       cite: 'lc-f-46a-insuranceNotification', text: 'Copy of notification included with presentation documents' },
                    ...f47aChecks('insuranceNotification'),
                ]
            },
            {
                id: 'beneficiaryCertificate', title: "Beneficiary's Certificate of Conformity", copies: '1 original', group: 'enviro',
                desc: `References Proforma Invoice ${lc.proformaRef || '—'}`,
                checks: [
                    { id: 'bc-ref',      cite: 'lc-f-46a-beneficiaryCertificate', text: `Proforma reference: extract the stated ref/date and confirm it matches No. ${lc.proformaRef || '—'}${lc.proformaDate ? ' dated ' + fd(lc.proformaDate) : ''} — wrong ref or date is a discrepancy` },
                    { id: 'bc-quantity', cite: 'lc-f-45a', text: `Quantity: extract the certified quantity and confirm it matches ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'} — any variance is a flag` },
                    { id: 'bc-freight',  cite: 'lc-f-44d', text: `Trade terms: extract the stated Incoterms/freight term and confirm it matches "${g.incoterms || '—'}" exactly — substitution (e.g. CPT vs CFR) is a fail` },
                    { id: 'bc-origin',   cite: 'lc-f-47a', text: `Origin marking: confirm that country of origin (${g.origin || '—'}) on packages is certified — extract exact wording` },
                    { id: 'bc-packingclause', cite: 'lc-f-47a', text: `Packing: extract the packing description and confirm it states exactly "export standard seaworthy packaging" — any paraphrase is a flag` },
                    ...f47aChecks('beneficiaryCertificate'),
                ]
            },
            {
                id: 'inspectionCertificate', title: 'Pre-Shipment Inspection Certificate', copies: '1 original', group: 'enviro',
                desc: 'Issued by Enviroware Ltd (self-certification)',
                checks: [
                    { id: 'pi-date',      cite: 'lc-f-44c', text: `Issue date: extract the certificate date and confirm it is before or on the shipment/B/L date and not before LC opening ${fd(lc.issuedDate)}` },
                    { id: 'pi-container', cite: 'lc-f-45a', text: `Container: extract the stated container number and confirm it matches ${g.container || '—'}` },
                    { id: 'pi-qty',       cite: 'lc-f-45a', text: `Quantity: extract certified quantity and confirm it matches ${(g.quantity || 0).toLocaleString()} ${g.quantityUnit || 'kg'} · ${g.packageCount || '?'} ${g.packageType || 'packages'}` },
                    { id: 'pi-lcref',     cite: 'lc-f-20',  text: `LC reference: confirm LC number #${lc.lcNumber} appears on the certificate` },
                    { id: 'pi-signed',    cite: 'lc-f-46a-inspectionCertificate', text: `Signatory: extract the name/title and confirm signed by an authorised representative of Enviroware Ltd` },
                    ...f47aChecks('inspectionCertificate'),
                ]
            },
            {
                id: 'applicantEmail', title: 'Applicant Documents Email', copies: '1 email + copy', group: 'email',
                desc: 'Full set of non-negotiable docs emailed to applicant within 21 days of shipment',
                checks: [
                    { id: 'apemail-21days',  cite: 'lc-f-47a', text: 'Email sent within 21 days of shipment date' },
                    { id: 'apemail-fullset', cite: 'lc-f-46a-applicantEmail', text: 'Full set of non-negotiable documents attached (invoice, packing list, B/L, COO, certs)' },
                    { id: 'apemail-address', cite: 'lc-f-50', text: `Addressed to applicant: ${ap.name || '—'}` },
                    { id: 'apemail-copy',    cite: 'lc-f-47a', text: 'Copy of email printed and included with original presentation documents' },
                    ...f47aChecks('applicantEmail'),
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
        { id: 'cond-08', text: 'Export standard seaworthy packing used — packing list must state exact wording: "export standard seaworthy packaging" (not "standard export seaworth" or similar)' },
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
        { id: 'cond-21', text: 'Packing list gross weight consistent with bill of lading — weight discrepancies between docs are a common rejection reason' },
        { id: 'cond-22', text: 'All documents show importer name and address — omitting from any single document is a discrepancy' },
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
                    <span class="lc-docs-badge${readyCount === 8 ? ' lc-docs-badge--done' : ''}">${readyCount}/8 ready</span>
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
            issuedDate: 'f-issuedDate', latestShipDate: 'f-latestShipDate', estimatedShipDate: 'f-estimatedShipDate',
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
            insuranceContactName: 'f-insuranceContactName',
            insuranceEmail: 'f-insuranceEmail',
            insuranceCoverNote: 'f-insuranceCoverNote',
            insuranceClauseText: 'f-insuranceClauseText',
            applicantEmail: 'f-applicantEmail',
        };
        for (const [key, id] of Object.entries(MAP)) {
            const val = fields[key];
            if (val === null || val === undefined) continue;
            const el = form.querySelector('#' + id);
            if (el) el.value = String(val);
        }
    }

    async function renderCreate(container) {
        const shipRef = _pendingShipRef || '';
        const shipId  = _pendingShipId  || '';
        _pendingShipRef = null;
        _pendingShipId  = null;

        const UPLOAD_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

        container.innerHTML = `
        <div class="orders-view-inner">
            <div class="lc-detail-hd">
                <a class="lc-back" href="#lc">← Letters of Credit</a>
                <span class="lc-save-status">New Letter of Credit</span>
            </div>

            <div class="lc-upload-strip" id="lc-upload-zone" role="button" tabindex="0"
                 aria-label="Upload MT700 PDF to auto-fill form">
                <input type="file" id="lc-file-input" accept=".pdf,application/pdf" hidden>
                <span class="lc-upload-strip-icon">${UPLOAD_SVG}</span>
                <div class="lc-upload-strip-body">
                    <span class="lc-upload-prompt">Upload MT700 PDF to auto-fill</span>
                    <span class="lc-upload-hint">Drop here, or click to browse</span>
                </div>
                <div class="lc-extract-status" id="lc-extract-status" hidden></div>
            </div>

            <form id="lc-create-form" class="lc-create-body" autocomplete="off">

                <div class="lc-checker-main">

                    <div class="lc-scard">
                        <div class="lc-scard-title">LC Identity</div>
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
                                <label class="lc-label" for="f-estimatedShipDate">Est. Ship Date</label>
                                <input class="lc-input" id="f-estimatedShipDate" name="estimatedShipDate" type="date">
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

                    <div class="lc-scard">
                        <div class="lc-scard-title">Goods</div>
                        <div class="lc-form-grid">
                            <div class="lc-field" style="grid-column:1/-1">
                                <label class="lc-label" for="f-goodsDescription">Description</label>
                                <textarea class="lc-input lc-textarea" id="f-goodsDescription" name="goodsDescription" rows="2" placeholder="e.g. Knitted nylon stocking material (toeclip)"></textarea>
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
                            <div class="lc-field" style="grid-column:1/-1">
                                <label class="lc-label" for="f-incoterms">Incoterms</label>
                                <input class="lc-input" id="f-incoterms" name="incoterms" placeholder="e.g. CPT ICD Kamlapur, Dhaka via Chattogram (Incoterms 2020)">
                            </div>
                        </div>
                    </div>

                </div>

                <div class="lc-create-sidebar">

                    <div class="lc-scard">
                        <div class="lc-scard-title">Parties</div>
                        <div class="lc-form-grid lc-form-grid--col1">
                            <div class="lc-field">
                                <label class="lc-label" for="f-applicantName">Applicant <span class="lc-req">*</span></label>
                                <input class="lc-input" id="f-applicantName" name="applicantName" required placeholder="e.g. J.P.S. Enterprise">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-applicantAddress">Applicant Address</label>
                                <input class="lc-input" id="f-applicantAddress" name="applicantAddress" placeholder="City, Country">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-applicantEmail">Applicant Email</label>
                                <input class="lc-input" id="f-applicantEmail" name="applicantEmail" type="email" placeholder="e.g. BADIULALAM082@GMAIL.COM">
                            </div>
                            <div class="lc-field">
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
                            <div class="lc-field">
                                <label class="lc-label" for="f-advisingBankName">Advising Bank</label>
                                <input class="lc-input" id="f-advisingBankName" name="advisingBankName" value="ANZ Bank NZ">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-advisingBankCity">Advising Bank City</label>
                                <input class="lc-input" id="f-advisingBankCity" name="advisingBankCity" value="Wellington">
                            </div>
                        </div>
                    </div>

                    <div class="lc-scard">
                        <div class="lc-scard-title">Routing &amp; References</div>
                        <div class="lc-form-grid lc-form-grid--col1">
                            <div class="lc-field">
                                <label class="lc-label" for="f-portLoading">Port of Loading</label>
                                <input class="lc-input" id="f-portLoading" name="portLoading" placeholder="e.g. Any port of Italy">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-portDischarge">Port of Discharge</label>
                                <input class="lc-input" id="f-portDischarge" name="portDischarge" placeholder="e.g. Chattogram Sea Port">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-portFinal">Final Destination</label>
                                <input class="lc-input" id="f-portFinal" name="portFinal" placeholder="e.g. ICD Kamlapur, Dhaka">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-proformaRef">Proforma Ref</label>
                                <input class="lc-input lc-mono" id="f-proformaRef" name="proformaRef" placeholder="e.g. 101/2026">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-proformaDate">Proforma Date</label>
                                <input class="lc-input" id="f-proformaDate" name="proformaDate" type="date">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-shipmentRef">Linked Shipment</label>
                                <input class="lc-input" id="f-shipmentRef" name="shipmentRef" placeholder="e.g. Shipment #40" value="${esc(shipRef)}">
                                <input type="hidden" name="linkedShipmentId" value="${esc(shipId)}">
                            </div>
                        </div>
                    </div>

                    <div class="lc-scard">
                        <div class="lc-scard-title">Insurance Contact</div>
                        <div class="lc-form-grid lc-form-grid--col1">
                            <div class="lc-field">
                                <label class="lc-label" for="f-insuranceContactName">Contact Name</label>
                                <input class="lc-input" id="f-insuranceContactName" name="insuranceContactName" placeholder="e.g. Paul">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-insuranceEmail">Insurance Email</label>
                                <input class="lc-input" id="f-insuranceEmail" name="insuranceEmail" type="email" placeholder="e.g. badiulalam082@gmail.com">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-insuranceCoverNote">Cover Note No.</label>
                                <input class="lc-input lc-mono" id="f-insuranceCoverNote" name="insuranceCoverNote" placeholder="e.g. GIL/MIR/MC-00555/10/2025">
                            </div>
                            <div class="lc-field">
                                <label class="lc-label" for="f-insuranceClauseText">LC Insurance Clause</label>
                                <textarea class="lc-input lc-textarea" id="f-insuranceClauseText" name="insuranceClauseText" rows="4" placeholder="Paste the insurance clause from the LC (Field 47A)…"></textarea>
                            </div>
                        </div>
                    </div>

                    <div class="lc-create-actions">
                        <button type="submit" class="lc-btn-primary" id="lc-submit-btn">Create LC</button>
                        <a class="lc-btn-ghost" href="#lc">Cancel</a>
                    </div>
                    <p class="lc-form-error" id="lc-form-error" hidden></p>

                </div>

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
            zone.classList.add('lc-upload-strip--busy');

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
                zone.classList.remove('lc-upload-strip--busy');
                form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (err) {
                showExtractStatus('error', err.message || 'Failed to extract fields');
                zone.classList.remove('lc-upload-strip--busy');
            }
        }

        zone.addEventListener('click', () => fileIn.click());
        zone.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); }
        });
        zone.addEventListener('dragover', e => {
            e.preventDefault();
            zone.classList.add('lc-upload-strip--drag');
        });
        zone.addEventListener('dragleave', e => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('lc-upload-strip--drag');
        });
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('lc-upload-strip--drag');
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

    // ── Pending context (set by callers before navigating to #lc/new) ────────
    let _pendingShipRef = null;   // e.g. "Shipment #40" (display label)
    let _pendingShipId  = null;   // e.g. "moqkexin47pa" (import shipment KV id)

    // ── Detail / checker view ─────────────────────────────────────────────────

    let _saveTimer      = null;
    let _pending        = {};
    let _activeLcId     = null;
    let _driveFolderUrl = '';       // current LC's linked Drive folder URL
    const _checkBase64  = new Map(); // docId → base64 from most recent check

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

    function docLinkIcon(url) {
        if (!url) return '';
        if (url.includes('docs.google.com/spreadsheets'))
            return `<svg width="12" height="12" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#34a853"/><line x1="3" y1="5" x2="13" y2="5" stroke="white" stroke-width="1.5"/><line x1="3" y1="8" x2="13" y2="8" stroke="white" stroke-width="1.5"/><line x1="3" y1="11" x2="9" y2="11" stroke="white" stroke-width="1.5"/></svg>`;
        if (url.includes('docs.google.com/document'))
            return `<svg width="12" height="12" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#4285f4"/><line x1="3" y1="5" x2="13" y2="5" stroke="white" stroke-width="1.5"/><line x1="3" y1="8" x2="13" y2="8" stroke="white" stroke-width="1.5"/><line x1="3" y1="11" x2="9" y2="11" stroke="white" stroke-width="1.5"/></svg>`;
        if (url.includes('drive.google.com') || url.includes('docs.google.com'))
            return `<svg width="12" height="12" viewBox="0 0 16 16"><rect width="16" height="16" rx="2" fill="#fbbc04"/><line x1="3" y1="5" x2="13" y2="5" stroke="white" stroke-width="1.5"/><line x1="3" y1="8" x2="13" y2="8" stroke="white" stroke-width="1.5"/><line x1="3" y1="11" x2="9" y2="11" stroke="white" stroke-width="1.5"/></svg>`;
        return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15,3 21,3 21,9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
    }

    function renderDocCard(doc, lc) {
        const status  = (lc.docStatus || {})[doc.id] || 'todo';
        const link    = (lc.docLinks  || {})[doc.id] || '';
        const checks  = lc.docChecks || {};
        const checked = doc.checks.filter(c => checks[c.id]).length;
        const ICONS = {
            draft:                  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1h6l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><polyline points="9,1 9,4 12,4"/><line x1="5" y1="9" x2="11" y2="9"/></svg>`,
            commercialInvoice:      `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1" width="12" height="14" rx="1"/><line x1="5" y1="5" x2="11" y2="5"/><line x1="5" y1="8" x2="11" y2="8"/><line x1="5" y1="11" x2="8" y2="11"/></svg>`,
            billOfLading:           `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 11l4-6h6l4 6"/><line x1="1" y1="11" x2="15" y2="11"/><line x1="3" y1="13" x2="13" y2="13"/></svg>`,
            certificateOfOrigin:    `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8l2 2 3-3"/></svg>`,
            insuranceNotification:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5l5 2.5v4c0 3-2 5-5 6C6 13 3 11 3 8V4z"/></svg>`,
            applicantEmail:         `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="14" height="10" rx="1.5"/><polyline points="1,3 8,9 15,3"/></svg>`,
            beneficiaryCertificate: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1" width="12" height="14" rx="1"/><path d="M5.5 8l2 2 3-3"/></svg>`,
            inspectionCertificate:  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6.5" r="4"/><path d="M9.5 9.5l4 4"/></svg>`,
        };

        const checkItems = doc.checks.map(c => {
            const isChecked = !!checks[c.id];
            const citeLink  = '<a class="lc-cite-link" href="#' + (c.cite || 'lc-raw-section') + '" title="View in LC reference">§</a>';
            return '<div class="lc-check-item' + (isChecked ? ' lc-check-item--done' : '') + '">'
                + '<input type="checkbox" id="chk-' + c.id + '" data-check="' + c.id + '"' + (isChecked ? ' checked' : '') + '>'
                + '<label for="chk-' + c.id + '">' + esc(c.text) + citeLink + '</label>'
                + '</div>';
        }).join('');

        return `
        <div class="lc-doc-card lc-doc-card--${status}" id="lcdoc-${doc.id}" data-doc="${doc.id}">
            <div class="lc-doc-hd">
                <div class="lc-doc-icon">${ICONS[doc.id] || ''}</div>
                <div class="lc-doc-meta">
                    <div class="lc-doc-title">${esc(doc.title)}<a class="lc-doc-cite" href="#lcref-46a-${doc.id}" title="Jump to LC reference">§</a></div>
                    <div class="lc-doc-copies">${esc(doc.copies)} &nbsp;·&nbsp; ${esc(doc.desc)}</div>
                    <div class="lc-doc-link-wrap" id="lc-link-wrap-${doc.id}">
                        ${link
                            ? `<div class="lc-doc-link-pill"><a href="${esc(link)}" target="_blank" rel="noopener" class="lc-doc-extlink">${docLinkIcon(link)} Open →</a><button class="lc-doc-link-edit-btn" data-link-doc="${doc.id}" type="button" title="Edit link">✎</button></div>`
                            : `<button class="lc-doc-link-add-btn" data-link-doc="${doc.id}" type="button">+ add link</button>`
                        }
                    </div>
                </div>
                <div class="lc-doc-right">
                    <span class="lc-doc-prog">${checked}/${doc.checks.length}</span>
                    ${doc.id === 'insuranceNotification' ? `
                    <button class="lc-ins-compose-btn" data-compose-insurance type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
                        Send Email
                    </button>` : ''}
                    ${doc.id === 'applicantEmail' ? `
                    <button class="lc-ins-compose-btn" data-compose-applicant type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="2,4 12,13 22,4"/></svg>
                        Send Email
                    </button>` : ''}
                    <button class="lc-doc-upload-btn" data-upload-doc="${doc.id}" type="button">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        Upload PDF
                    </button>
                    <button class="lc-chip lc-chip--${status}" data-status-doc="${doc.id}" type="button">${STATUS_LABELS[status]}</button>
                    <svg class="lc-doc-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3,6 8,11 13,6"/></svg>
                </div>
            </div>
            <div class="lc-doc-checks">
                <div class="lc-doc-link-form" id="lc-link-form-${doc.id}" hidden>
                    <input type="url" class="lc-doc-link-input lc-input"
                           placeholder="Paste Google Drive, Docs, or Sheets URL…"
                           value="${esc(link)}"
                           style="width:100%;font-size:0.8rem;padding:0.35rem 0.5rem;">
                    <div class="lc-doc-link-form-btns">
                        <button class="lc-doc-link-save" data-save-link="${doc.id}" type="button">Save</button>
                        <button class="lc-doc-link-cancel" data-cancel-link="${doc.id}" type="button">Cancel</button>
                        <button class="lc-doc-link-clear" data-clear-link="${doc.id}" type="button">Remove</button>
                    </div>
                </div>
                <div class="lc-doc-checklist" hidden>${checkItems}</div>
                <button class="lc-doc-checklist-toggle" data-toggle-checklist="${doc.id}" type="button">Show requirements</button>
            </div>
            <div class="lc-card-check-results" id="lccheck-${doc.id}" hidden></div>
            <div class="lc-doc-history" id="lc-doc-history-${doc.id}" hidden></div>
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

        _driveFolderUrl = lc.driveFolderUrl || '';

        // Normalise F47A conditions — older records may hold plain strings
        lc.f47aConditions = (lc.f47aConditions || []).map(c =>
            typeof c === 'string' ? { text: c, docId: null } : c
        ).filter(c => c && c.text);

        const docs = generateDocuments(lc);
        const ready = readyCount(lc);
        const DOC_TOTAL = 8;
        const isCleared = ready === DOC_TOTAL;
        const pct = Math.round((ready / DOC_TOTAL) * 100);

        const shipDays   = daysUntil(lc.latestShipDate);
        const expiryDays = daysUntil(lc.expiryDate);

        const g   = lc.goods        || {};
        const p   = lc.ports        || {};
        const ab  = lc.applicantBank|| {};
        const ap  = lc.applicant    || {};
        const adv = lc.advisingBank || {};
        const ins = lc.insurance    || {};

        const sideRow = (label, val, mono = false) =>
            `<div class="lc-srow"><span class="lc-srow-label">${label}</span><span class="lc-srow-val${mono ? ' lc-mono' : ''}">${esc(val || '—')}</span></div>`;

        const insCardHtml = (ins.contactName || ins.email || ins.coverNote)
            ? '<div class="lc-scard">'
                + '<div class="lc-scard-title">Insurance Contact</div>'
                + (ins.contactName ? sideRow('Contact', ins.contactName) : '')
                + (ins.email ? '<div class="lc-srow"><span class="lc-srow-label">Email</span>'
                    + '<a href="mailto:' + esc(ins.email) + '" class="lc-srow-link" style="font-size:0.8rem">' + esc(ins.email) + '</a></div>' : '')
                + (ins.coverNote ? sideRow('Cover Note', ins.coverNote, true) : '')
                + '</div>'
            : '';

        const f47aGeneral = (lc.f47aConditions || [])
            .filter(c => !c.docId || c.docId === 'general')
            .map((c, i) => ({ id: `f47a-general-${i}`, text: c.text }));
        const allConditions = [...STANDARD_CONDITIONS, ...f47aGeneral];
        const condChecks = lc.condChecks || {};
        const condDone   = allConditions.filter(c => condChecks[c.id]).length;
        const condItems  = allConditions.map((c, i) => {
            const checked = !!condChecks[c.id];
            return `<div class="lc-cond-item${checked ? ' lc-cond-item--done' : ''}">
                <span class="lc-cond-num">${String(i + 1).padStart(2, '0')}</span>
                <input type="checkbox" id="cond-${c.id}" data-cond="${c.id}" ${checked ? 'checked' : ''}>
                <label for="cond-${c.id}">${esc(c.text)}</label>
            </div>`;
        }).join('');

        // ── Timeline bar pre-computation ──────────────────────────────────────
        function isoTs(iso) {
            if (!iso) return null;
            const [y,m,d] = iso.split('-').map(Number);
            return new Date(y,m-1,d).getTime();
        }
        const tlStart = isoTs(lc.issuedDate);
        const tlEnd   = isoTs(lc.expiryDate);
        const tlRange = (tlStart && tlEnd && tlEnd > tlStart) ? tlEnd - tlStart : null;

        function tlPct(iso) {
            const t = isoTs(iso);
            if (!t || !tlRange) return null;
            return +Math.min(100, Math.max(0, (t - tlStart) / tlRange * 100)).toFixed(1);
        }

        function buildTlTrack(shipDate) {
            if (!tlRange) return '<div class="lc-tl2-missing">Set issued date and expiry date to see timeline</div>';
            const todayIso = new Date().toISOString().slice(0, 10);
            const todayPct = tlPct(todayIso);
            const pdays2   = lc.presentationDays || 21;
            const presIso  = shipDate ? addDays(shipDate, pdays2) : null;
            const shipPct       = tlPct(shipDate);
            const presPct       = tlPct(presIso);
            const latestShipPct = tlPct(lc.latestShipDate);
            const estShipPct    = tlPct(lc.estimatedShipDate);
            const shipIsToday   = shipDate && shipDate === todayIso;

            const dotCls = (dateIso, colourCls) =>
                (todayIso && dateIso && dateIso > todayIso) ? 'lc-tl2-dot--grey' : colourCls;

            function label(pct, nameHtml, dateHtml, deltaHtml2) {
                return '<div class="lc-tl2-info" style="left:' + pct + '%">'
                    + '<div class="lc-tl2-name">' + nameHtml + '</div>'
                    + '<div class="lc-tl2-date">' + dateHtml + '</div>'
                    + (deltaHtml2 ? '<div class="lc-tl2-delta">' + deltaHtml2 + '</div>' : '')
                    + '</div>';
            }

            // Rail and today line first (behind everything)
            let html     = '<div class="lc-tl2-rail"></div>';
            let labelsHtml = '';

            if (todayPct !== null) {
                html += '<div class="lc-tl2-today-line" style="left:' + todayPct + '%"></div>';
            }

            // Dots only inside marks; labels emitted separately at end so DOM order puts them on top
            html += '<div class="lc-tl2-mark" style="left:0%">'
                + '<div class="lc-tl2-dot ' + dotCls(lc.issuedDate, '') + '"></div>'
                + '</div>';
            labelsHtml += label('0', 'LC Issued', esc(fmtDate(lc.issuedDate)), '');

            if (lc.estimatedShipDate && estShipPct !== null) {
                const estDays = daysUntil(lc.estimatedShipDate);
                html += '<div class="lc-tl2-mark lc-tl2-mark--btn" data-setship title="Click to record actual shipment date" style="left:' + estShipPct + '%">'
                    + '<div class="lc-tl2-dot ' + dotCls(lc.estimatedShipDate, 'lc-tl2-dot--estship') + '"></div>'
                    + '</div>';
                labelsHtml += label(estShipPct, 'Est. Ship', esc(fmtDate(lc.estimatedShipDate)), estDays !== null ? deltaHtml(estDays) : '');
            }

            if (latestShipPct !== null) {
                const lsDays = daysUntil(lc.latestShipDate);
                html += '<div class="lc-tl2-mark" style="left:' + latestShipPct + '%">'
                    + '<div class="lc-tl2-dot ' + dotCls(lc.latestShipDate, 'lc-tl2-dot--latestship') + '"></div>'
                    + '</div>';
                labelsHtml += label(latestShipPct, 'Latest Ship', esc(fmtDate(lc.latestShipDate)), lsDays !== null ? deltaHtml(lsDays) : '');
            }

            if (presIso && presPct !== null) {
                const presDays = daysUntil(presIso);
                html += '<div class="lc-tl2-mark" style="left:' + presPct + '%">'
                    + '<div class="lc-tl2-dot ' + dotCls(presIso, 'lc-tl2-dot--pres') + '"></div>'
                    + '</div>';
                labelsHtml += label(presPct, 'Present by', esc(fmtDate(presIso)), presDays !== null ? deltaHtml(presDays) : '');
            }

            if (shipDate && shipPct !== null) {
                const shipLabel = shipIsToday ? 'Shipped · Today' : 'Shipped';
                html += '<div class="lc-tl2-mark lc-tl2-mark--btn" data-setship title="Click to edit shipment date" style="left:' + shipPct + '%">'
                    + '<div class="lc-tl2-dot ' + dotCls(shipDate, 'lc-tl2-dot--shipped') + '"></div>'
                    + '</div>';
                labelsHtml += label(shipPct, shipLabel, esc(fmtDate(shipDate)), '');
            }

            const expDays = daysUntil(lc.expiryDate);
            html += '<div class="lc-tl2-mark" style="left:100%">'
                + '<div class="lc-tl2-dot ' + dotCls(lc.expiryDate, 'lc-tl2-dot--expiry') + '"></div>'
                + '</div>';
            labelsHtml += label('100', 'LC Expiry', esc(fmtDate(lc.expiryDate)), expDays !== null ? deltaHtml(expDays) : '');

            // Labels last in DOM → always above rail, today line, and dots by DOM order
            return html + labelsHtml;
        }

        const tlWrap = '<div class="lc-tl2" id="lc-tl2">'
            + '<div class="lc-tl2-track" id="lc-tl2-track">' + buildTlTrack(lc.shipmentDate) + '</div>'
            + '<div class="lc-tl2-ship-row" id="lc-tl2-ship-row"' + (lc.shipmentDate && lc.estimatedShipDate ? ' hidden' : '') + '>'
            + '<span class="lc-tl2-ctrl-label">Actual shipment date</span>'
            + '<input type="date" id="lc-shipment-date-input" class="lc-input lc-mono" value="' + esc(lc.shipmentDate || '') + '" style="font-size:0.82rem;padding:0.22rem 0.4rem;width:auto;">'
            + (lc.shipmentDate ? '<button class="lc-tl2-ship-done" id="lc-tl2-ship-done" type="button">Done</button>' : '')
            + '</div>'
            + '</div>';

        // ── MT700 LC Reference pre-computation ────────────────────────────────
        function rawLines(val) {
            return esc(val || '—').replace(/\n/g, '<br>');
        }
        function rawField(num, label, val) {
            const anchorId = 'lc-f-' + num.toLowerCase().replace(/\s/g, '');
            return '<div class="lc-raw-field" id="' + anchorId + '">'
                + '<div class="lc-raw-field-hd">'
                + '<span class="lc-raw-field-num">F' + num + '</span>'
                + '<span class="lc-raw-field-label">' + esc(label) + '</span>'
                + '</div>'
                + '<div class="lc-raw-field-val">' + rawLines(val) + '</div>'
                + '</div>';
        }

        // TAG → anchor id map for verbatim raw rendering
        const TAG_ANCHORS = {
            '20': 'lc-f-20', '31C': 'lc-f-31c', '31D': 'lc-f-31d',
            '32B': 'lc-f-32b', '40A': 'lc-f-40a', '41A': 'lc-f-41a', '41D': 'lc-f-41d',
            '42C': 'lc-f-42c', '42A': 'lc-f-42a', '43P': 'lc-f-43p', '43T': 'lc-f-43t',
            '44A': 'lc-f-44a', '44B': 'lc-f-44b', '44C': 'lc-f-44c', '44D': 'lc-f-44d',
            '44E': 'lc-f-44e', '44F': 'lc-f-44f',
            '45A': 'lc-f-45a', '46A': 'lc-f-46a', '47A': 'lc-f-47a',
            '48': 'lc-f-48', '49': 'lc-f-49', '50': 'lc-f-50', '59': 'lc-f-59',
            '71B': 'lc-f-71b', '72': 'lc-f-72', '78': 'lc-f-78',
        };

        let lcRawHtml = '<section class="lc-raw-section" id="lc-raw-section">'
            + '<div class="lc-raw-section-hd">'
            + '<span class="lc-section-label">LC Reference — MT700</span>'
            + (lc.rawMt700 ? '' : '<span class="lc-raw-verbatim-hint">Upload the LC PDF above to show verbatim text</span>')
            + '</div>';

        if (lc.rawMt700) {
            // Verbatim raw text — split on :TAG: markers and inject anchors.
            // cleanRawSeg strips SWIFT printout noise (indentation, separator
            // dot-lines, #dupe# amount markers, page footers) without touching wording.
            function cleanRawSeg(t) {
                let lines = t.replace(/\r/g, '').split('\n').map(l => l.replace(/\s+$/, ''));
                const indents = lines.filter(l => l.trim()).map(l => (l.match(/^ */) || [''])[0].length);
                const minInd  = indents.length ? Math.min.apply(null, indents) : 0;
                const out = [];
                lines.forEach(function(l) {
                    l = l.slice(minInd);
                    const bare = l.trim();
                    if (/^\.+$/.test(bare)) { out.push(''); return; }                 // SWIFT "." separator lines
                    if (/^page\s+\d+\s+of\s+\d+$/i.test(bare)) return;                // report page footers
                    l = l.replace(/\s*#[0-9.,]+#/g, '');                              // duplicate #amount# markers
                    l = l.replace(/[ \t]{2,}/g, '  ');                                // collapse runaway space runs
                    out.push(l);
                });
                return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
            }

            const raw    = lc.rawMt700;
            const parts  = raw.split(/\n(?=:[0-9A-Z]{2,3}:)/);
            const f47aAll = lc.f47aConditions || [];

            lcRawHtml += '<div class="lc-raw-verbatim">';
            parts.forEach(function(part) {
                const tagMatch = part.match(/^:([0-9A-Z]{2,3}):/);
                const tag      = tagMatch ? tagMatch[1].toUpperCase() : null;
                const anchorId = tag ? (TAG_ANCHORS[tag] || ('lc-f-' + tag.toLowerCase())) : null;
                const content  = cleanRawSeg(part.replace(/^:[0-9A-Z]{2,3}:\n?/, ''));

                if (tag === '47A') {
                    // For F47A, also emit per-condition anchors so §47A.N links work
                    lcRawHtml += '<div class="lc-raw-verbatim-field" id="' + anchorId + '">'
                        + '<span class="lc-raw-verbatim-tag">:' + tag + ':</span>';

                    // Split numbered conditions (lines starting with a number + dot/bracket)
                    const condParts = content.split(/\n(?=\d+[.)]\s)/);
                    condParts.forEach(function(cp, ci) {
                        const condAnchor = f47aAll[ci] ? 'lc-f47a-' + ci : '';
                        const condText = cleanRawSeg(cp);
                        if (!condText) return;
                        lcRawHtml += '<span class="lc-raw-verbatim-cond"'
                            + (condAnchor ? ' id="' + condAnchor + '"' : '') + '>'
                            + esc(condText)
                            + '</span>';
                    });
                    lcRawHtml += '</div>';
                } else if (tag === '46A') {
                    // For F46A, inject doc-specific anchors by matching doc titles
                    lcRawHtml += '<div class="lc-raw-verbatim-field" id="' + anchorId + '">'
                        + '<span class="lc-raw-verbatim-tag">:' + tag + ':</span>';

                    docs.forEach(function(d) {
                        lcRawHtml += '<span class="lc-raw-verbatim-doc-anchor" id="lcref-46a-' + esc(d.id) + '"></span>';
                    });
                    lcRawHtml += '<span class="lc-raw-verbatim-body">' + esc(content) + '</span>'
                        + '</div>';
                } else if (tag) {
                    lcRawHtml += '<div class="lc-raw-verbatim-field" id="' + anchorId + '">'
                        + '<span class="lc-raw-verbatim-tag">:' + tag + ':</span>'
                        + '<span class="lc-raw-verbatim-body">' + esc(content) + '</span>'
                        + '</div>';
                } else if (cleanRawSeg(part)) {
                    lcRawHtml += '<div class="lc-raw-verbatim-field">'
                        + '<span class="lc-raw-verbatim-body">' + esc(cleanRawSeg(part)) + '</span>'
                        + '</div>';
                }
            });
            lcRawHtml += '</div>';
        } else {
            // Fallback: reconstructed grid from stored fields
            lcRawHtml += '<div class="lc-raw-body">';
            lcRawHtml += rawField('20',  'Documentary Credit Number', lc.lcNumber);
            lcRawHtml += rawField('31C', 'Date of Issue',             lc.issuedDate);
            lcRawHtml += rawField('31D', 'Date and Place of Expiry',  (lc.expiryDate || '') + (lc.expiryPlace ? '\n' + lc.expiryPlace : ''));
            lcRawHtml += rawField('50',  'Applicant',                 (ap.name || '') + (ap.address ? '\n' + ap.address : ''));
            lcRawHtml += rawField('59',  'Beneficiary',               lc.beneficiary || 'Enviroware Ltd');
            lcRawHtml += rawField('32B', 'Currency / Amount',         fmtAmt(lc.currency, lc.amount));
            lcRawHtml += rawField('41D', 'Available With / By',       (ab.name || '—') + '\nBY SIGHT PAYMENT');
            lcRawHtml += rawField('44A', 'Port of Loading',           p.loading);
            lcRawHtml += rawField('44B', 'For Transportation to',     (p.discharge || '') + (p.finalDestination ? '\n' + p.finalDestination : ''));
            lcRawHtml += rawField('44C', 'Latest Date of Shipment',   lc.latestShipDate);
            lcRawHtml += rawField('44D', 'Shipment Period / Incoterms', g.incoterms);
            lcRawHtml += rawField('45A', 'Description of Goods',      g.description || lc.goodsDescription || '');

            lcRawHtml += '<div class="lc-raw-field" id="lc-f-46a">'
                + '<div class="lc-raw-field-hd"><span class="lc-raw-field-num">F46A</span>'
                + '<span class="lc-raw-field-label">Documents Required</span></div>';
            docs.forEach(function(d) {
                lcRawHtml += '<div class="lc-raw-doc-item" id="lcref-46a-' + esc(d.id) + '">'
                    + '<div class="lc-raw-doc-title">' + esc(d.title) + '</div>'
                    + '<div class="lc-raw-doc-copies">' + esc(d.copies) + '</div>'
                    + '<div class="lc-raw-doc-desc">' + esc(d.desc) + '</div>'
                    + '</div>';
            });
            lcRawHtml += '</div>';

            const f47aAll = lc.f47aConditions || [];
            lcRawHtml += '<div class="lc-raw-field" id="lc-f-47a">'
                + '<div class="lc-raw-field-hd"><span class="lc-raw-field-num">F47A</span>'
                + '<span class="lc-raw-field-label">Additional Conditions</span></div>';
            if (f47aAll.length > 0) {
                f47aAll.forEach(function(c, i) {
                    lcRawHtml += '<div class="lc-raw-cond-item" id="lc-f47a-' + i + '">'
                        + '<span class="lc-raw-cond-num">' + (i + 1) + '.</span>'
                        + '<span class="lc-raw-cond-text">' + rawLines(c.text) + '</span>'
                        + '</div>';
                });
            } else {
                lcRawHtml += '<div class="lc-raw-cond-item lc-raw-cond-item--empty">No additional conditions recorded. Upload the LC PDF above to populate.</div>';
            }
            lcRawHtml += '</div>';

            if (ins.clauseText) {
                lcRawHtml += '<div class="lc-raw-field" id="lc-f-ins">'
                    + '<div class="lc-raw-field-hd"><span class="lc-raw-field-num">INS</span>'
                    + '<span class="lc-raw-field-label">Insurance Clause</span></div>'
                    + '<div class="lc-raw-field-val">' + rawLines(ins.clauseText) + '</div>'
                    + '</div>';
            }
            lcRawHtml += '</div>';
        }

        lcRawHtml += '</section>';

        // ── Grouped document list ──────────────────────────────────────────────
        const DOC_GROUPS = [
            { id: 'admin',    label: 'Bank / Admin' },
            { id: '3rdparty', label: '3rd Party Documents' },
            { id: 'enviro',   label: 'Enviroware Documents' },
            { id: 'email',    label: 'Email Notifications' },
        ];
        let docListHtml = '';
        DOC_GROUPS.forEach(function(grp) {
            const grpDocs = docs.filter(function(d) { return d.group === grp.id; });
            if (!grpDocs.length) return;
            docListHtml += '<div class="lc-doc-group-hd">' + esc(grp.label) + '</div>';
            grpDocs.forEach(function(d) { docListHtml += renderDocCard(d, lc); });
        });

        const backHref  = lc.linkedShipmentId ? '#imports/ship/' + encodeURIComponent(lc.linkedShipmentId) : '#lc';
        const backLabel = lc.linkedShipmentId ? '← ' + esc(lc.shipmentRef || 'Shipment') : '← Letters of Credit';
        const h1Label   = lc.shipmentRef || esc(lc.lcNumber);

        container.innerHTML = `
        <div class="orders-view-inner">
            <div class="lc-detail-hd">
                <a class="lc-back" href="${backHref}">${backLabel}</a>
                <span class="lc-save-status" id="lc-save-status"></span>
            </div>
            <div class="ship-detail-hdr" style="margin-bottom:0.25rem">
                <h1 class="ship-detail-title">${esc(h1Label)}</h1>
                <p class="ship-detail-meta">Letter of Credit · ${esc(lc.lcNumber)}</p>
            </div>

            <div class="lc-checker-identity">
                <div class="lc-identity-row1">
                    <div class="lc-identity-left">
                        <span class="lc-mono lc-identity-ref">#${esc(lc.lcNumber)}</span>
                        <button class="lc-copy-btn" data-copy="${esc(lc.lcNumber)}" type="button" title="Copy LC number">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                        </button>
                        <span class="lc-identity-parties">${esc(lc.beneficiary || 'Enviroware Ltd')} → ${esc(ap.name || '—')}</span>
                    </div>
                    <div class="lc-identity-right">
                        <div class="lc-identity-amt lc-mono">${esc(fmtAmt(lc.currency, lc.amount))}</div>
                        <span class="lc-clearance-chip ${isCleared ? 'lc-clearance--ok' : 'lc-clearance--no'}"
                              id="lc-clearance">
                            ${isCleared ? 'Cleared to present' : 'Not cleared to present'}
                        </span>
                        <button class="lc-extract-btn" id="lc-extract-btn" type="button" title="Upload LC PDF to re-extract all fields with AI">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            Upload LC PDF
                        </button>
                        <input type="file" id="lc-extract-file-input" accept=".pdf,application/pdf" hidden>
                    </div>
                </div>
                <div class="lc-identity-row2" id="lc-ship-link-row">
                    <span class="lc-identity-ship-label">Shipment</span>
                    ${lc.linkedShipmentId
                        ? '<div class="lc-ship-linked">'
                            + '<a href="#imports" class="lc-ship-linked-id">' + esc(lc.shipmentRef || lc.linkedShipmentId) + ' ↗</a>'
                            + '<button class="lc-ship-unlink-btn" id="lc-ship-unlink-btn" type="button">Unlink</button>'
                          + '</div>'
                        : '<span class="lc-ship-hint">Link from the shipment\'s Letter of Credit tab</span>'
                    }
                </div>
            </div>

            <div class="lc-progress-wrap">
                <div class="lc-progress-track"><div class="lc-progress-fill" id="lc-pfill" style="width:${pct}%"></div></div>
                <span class="lc-progress-label" id="lc-plabel">${ready} of ${DOC_TOTAL} documents ready</span>
            </div>

            ${tlWrap}

            <div class="lc-checker-body">
                <main class="lc-checker-main">
                    <div class="lc-doc-list" id="lc-doc-list">
                        ${docListHtml}
                    </div>

                    <details class="lc-cond-section" id="lc-cond-section">
                        <summary class="lc-cond-summary">
                            <span class="lc-cond-title">General Conditions — F47A</span>
                            <span class="lc-cond-count" id="lc-cond-count">${condDone} of ${allConditions.length} confirmed</span>
                        </summary>
                        <div class="lc-cond-grid" id="lc-cond-grid">${condItems}</div>
                    </details>

                    <input type="file" id="lc-card-file-input" accept=".pdf,application/pdf" hidden>

                    <div class="lc-archive-section">
                        <div class="lc-archive-hd">
                            <div class="lc-section-label" style="margin:0">Google Drive</div>
                            <div class="lc-drive-folder-wrap" id="lc-drive-folder-wrap">
                                ${lc.driveFolderUrl
                                    ? `<a href="${esc(lc.driveFolderUrl)}" target="_blank" class="lc-drive-folder-link">
                                           <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polygon points="7.5,3 16.5,3 22,13 13,13" fill="#fbbc04"/><polygon points="2,13 7.5,3 11.5,13 6,23" fill="#34a853"/><polygon points="12,13 6,23 18,23 24,13" fill="#4285f4"/></svg>
                                           Drive folder ↗
                                       </a>
                                       <button class="lc-drive-change-btn" id="lc-drive-change-btn" type="button">Change</button>`
                                    : `<button class="lc-drive-add-btn" id="lc-drive-add-btn" type="button">
                                           + Link Drive folder
                                       </button>`
                                }
                            </div>
                        </div>
                        <div class="lc-drive-folder-form" id="lc-drive-folder-form" hidden>
                            <input type="url" id="lc-drive-folder-input" class="lc-input"
                                   placeholder="Paste Google Drive folder URL…"
                                   value="${esc(lc.driveFolderUrl || '')}"
                                   style="width:100%;font-size:0.8rem;padding:0.35rem 0.5rem;margin-bottom:0.4rem;">
                            <div class="lc-drive-form-btns">
                                <button id="lc-drive-save-btn" type="button" class="lc-doc-link-save">Save</button>
                                <button id="lc-drive-cancel-btn" type="button" class="lc-doc-link-cancel">Cancel</button>
                                ${lc.driveFolderUrl ? `<button id="lc-drive-remove-btn" type="button" class="lc-doc-link-clear">Remove</button>` : ''}
                            </div>
                        </div>
                    </div>
                    ${lcRawHtml}
                </main>

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
                    ${insCardHtml}
                    <div class="lc-scard lc-known-issues-card" id="lc-known-issues-card">
                        <div class="lc-scard-title">Recurring Issues
                            <span class="lc-known-issues-hint">— flagged from past checks</span>
                        </div>
                        <div id="lc-known-issues-list"><span class="lc-known-issues-empty">Loading…</span></div>
                    </div>
                </aside>
            </div>
        </div>`;

        bindDetailEvents(container, id, docs, lc, buildTlTrack);
    }

    function showExtractReviewModal(fields, lc, lcId, onSaved) {
        document.querySelector('.lc-extract-modal')?.remove();

        // Map extracted field names → current LC values for comparison
        const g  = lc.goods || {};
        const p  = lc.ports || {};
        const ap = lc.applicant || {};
        const ab = lc.applicantBank || {};

        const FIELD_MAP = [
            { key: 'lcNumber',        label: 'LC Number',            cur: lc.lcNumber,          ext: fields.lcNumber },
            { key: 'issuedDate',      label: 'Date of Issue',        cur: lc.issuedDate,        ext: fields.issuedDate },
            { key: 'expiryDate',      label: 'Expiry Date',          cur: lc.expiryDate,        ext: fields.expiryDate },
            { key: 'latestShipDate',  label: 'Latest Ship Date',     cur: lc.latestShipDate,    ext: fields.latestShipDate },
            { key: 'currency',        label: 'Currency',             cur: lc.currency,          ext: fields.currency },
            { key: 'amount',          label: 'Amount',               cur: String(lc.amount || ''), ext: fields.amount != null ? String(fields.amount) : null },
            { key: 'presentationDays',label: 'Presentation Days',    cur: String(lc.presentationDays || ''), ext: fields.presentationDays != null ? String(fields.presentationDays) : null },
            { key: 'governedBy',      label: 'Governed By',          cur: lc.governedBy,        ext: fields.governedBy },
            { key: 'applicantName',   label: 'Applicant Name',       cur: ap.name,              ext: fields.applicantName },
            { key: 'applicantAddress',label: 'Applicant Address',    cur: ap.address,           ext: fields.applicantAddress },
            { key: 'applicantBankName',  label: 'Issuing Bank',      cur: ab.name,              ext: fields.applicantBankName },
            { key: 'applicantBankCity',  label: 'Issuing Bank City', cur: ab.city,              ext: fields.applicantBankCity },
            { key: 'applicantBankSwift', label: 'Issuing Bank SWIFT',cur: ab.swift,             ext: fields.applicantBankSwift },
            { key: 'portLoading',     label: 'Port of Loading',      cur: p.loading,            ext: fields.portLoading },
            { key: 'portDischarge',   label: 'Port of Discharge',    cur: p.discharge,          ext: fields.portDischarge },
            { key: 'portFinal',       label: 'Final Destination',    cur: p.finalDestination,   ext: fields.portFinal },
            { key: 'incoterms',       label: 'Incoterms',            cur: g.incoterms,          ext: fields.incoterms },
            { key: 'goodsDescription',label: 'Goods Description',    cur: g.description,        ext: fields.goodsDescription },
            { key: 'quantity',        label: 'Quantity',             cur: String(g.quantity || ''), ext: fields.quantity != null ? String(fields.quantity) : null },
            { key: 'quantityUnit',    label: 'Quantity Unit',        cur: g.quantityUnit,       ext: fields.quantityUnit },
            { key: 'packageCount',    label: 'Package Count',        cur: String(g.packageCount || ''), ext: fields.packageCount != null ? String(fields.packageCount) : null },
            { key: 'packageType',     label: 'Package Type',         cur: g.packageType,        ext: fields.packageType },
            { key: 'unitPrice',       label: 'Unit Price',           cur: String(g.unitPrice || ''), ext: fields.unitPrice != null ? String(fields.unitPrice) : null },
            { key: 'hsCode',          label: 'HS Code',              cur: g.hsCode,             ext: fields.hsCode },
            { key: 'origin',          label: 'Origin',               cur: g.origin,             ext: fields.origin },
            { key: 'container',       label: 'Container',            cur: g.container,          ext: fields.container },
            { key: 'proformaRef',     label: 'Proforma Ref',         cur: lc.proformaRef,       ext: fields.proformaRef },
            { key: 'proformaDate',    label: 'Proforma Date',        cur: lc.proformaDate,      ext: fields.proformaDate },
        ];

        const changed = FIELD_MAP.filter(f => {
            const e = (f.ext || '').toString().trim();
            const c = (f.cur || '').toString().trim();
            return e && e !== c;
        });

        const extractedConds = Array.isArray(fields.f47aConditions) ? fields.f47aConditions : [];
        const currentConds   = lc.f47aConditions || [];

        const fieldRows = changed.length
            ? changed.map((f, i) => {
                const isNew = !f.cur;
                return '<div class="lc-er-row' + (isNew ? ' lc-er-row--new' : '') + '">'
                    + '<label class="lc-er-check-wrap">'
                    + '<input type="checkbox" class="lc-er-cb" data-er-idx="' + i + '" checked>'
                    + '<span class="lc-er-label">' + esc(f.label) + '</span>'
                    + '</label>'
                    + '<div class="lc-er-vals">'
                    + (f.cur ? '<span class="lc-er-cur">' + esc(f.cur) + '</span>' : '<span class="lc-er-empty">not set</span>')
                    + '<span class="lc-er-arrow">→</span>'
                    + '<span class="lc-er-new">' + esc(f.ext) + '</span>'
                    + '</div>'
                    + '</div>';
            }).join('')
            : '<p class="lc-er-none">All stored field values match the document.</p>';

        const condRows = extractedConds.map((c, i) => {
            const alreadyHave = currentConds.some(x => x.text.trim() === c.text.trim());
            const label = c.num ? ('Cond. ' + c.num) : (c.docId && c.docId !== 'general' ? c.docId : 'General');
            return '<div class="lc-er-row lc-er-row--cond' + (alreadyHave ? ' lc-er-row--dupe' : '') + '">'
                + '<label class="lc-er-check-wrap">'
                + '<input type="checkbox" class="lc-er-cond-cb" data-cond-idx="' + i + '"' + (alreadyHave ? '' : ' checked') + '>'
                + '<span class="lc-er-label">' + esc(label) + '</span>'
                + '</label>'
                + '<span class="lc-er-cond-text">' + esc(c.text) + (alreadyHave ? ' <em>(already stored)</em>' : '') + '</span>'
                + '</div>';
        }).join('') || '<p class="lc-er-none">No F47A conditions extracted.</p>';

        const modal = document.createElement('div');
        modal.className = 'lc-extract-modal';
        modal.innerHTML = '<div class="lc-extract-modal-box">'
            + '<div class="lc-extract-modal-hd">'
            + '<span class="lc-extract-modal-title">Review Extracted Fields</span>'
            + '<span class="lc-extract-modal-sub">Check changes to accept · uncheck to keep current value</span>'
            + '<button class="lc-email-modal-close" id="lc-er-close" type="button">✕</button>'
            + '</div>'
            + '<div class="lc-extract-modal-body">'
            + (changed.length ? '<div class="lc-er-section-hd">Field Changes (' + changed.length + ')</div>' + fieldRows : fieldRows)
            + '<div class="lc-er-section-hd lc-er-section-hd--cond">F47A Conditions from document</div>'
            + condRows
            + '</div>'
            + '<div class="lc-extract-modal-ft">'
            + '<button class="lc-er-save" id="lc-er-save" type="button">Apply selected changes</button>'
            + '<button class="lc-er-cancel" id="lc-er-cancel" type="button">Cancel</button>'
            + '</div>'
            + '</div>';

        document.body.appendChild(modal);

        modal.querySelector('#lc-er-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#lc-er-cancel').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        modal.querySelector('#lc-er-save').addEventListener('click', async () => {
            const saveBtn = modal.querySelector('#lc-er-save');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving…';

            // Build patch from checked field rows
            const patch = {};
            modal.querySelectorAll('.lc-er-cb:checked').forEach(cb => {
                const f = changed[Number(cb.dataset.erIdx)];
                if (f) patch[f.key] = f.ext;
            });

            // Collect checked new conditions
            const newConds = [...currentConds];
            modal.querySelectorAll('.lc-er-cond-cb:checked').forEach(cb => {
                const c = extractedConds[Number(cb.dataset.condIdx)];
                if (c && !newConds.some(x => x.text.trim() === c.text.trim())) {
                    newConds.push({ text: c.text, docId: c.docId && c.docId !== 'general' ? c.docId : null });
                }
            });
            if (modal.querySelectorAll('.lc-er-cond-cb:checked').length) {
                patch.f47aConditions = newConds;
            }

            if (fields.rawText) patch.rawMt700 = fields.rawText;
            if (!Object.keys(patch).length) { modal.remove(); return; }

            try {
                await apiFetch('/api/lc/' + lcId, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(patch),
                });
                modal.remove();
                onSaved();
            } catch (err) {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Apply selected changes';
                alert('Could not save: ' + err.message);
            }
        });
    }

    function showEmailPanel(toEmail, subject, body) {
        document.querySelector('.lc-email-modal')?.remove();

        const modal = document.createElement('div');
        modal.className = 'lc-email-modal';
        modal.innerHTML = '<div class="lc-email-modal-box">'
            + '<div class="lc-email-modal-hd">'
            + '<span class="lc-email-modal-title">Email Content</span>'
            + '<button class="lc-email-modal-close" type="button" aria-label="Close">✕</button>'
            + '</div>'
            + '<div class="lc-email-modal-field">'
            + '<label class="lc-email-modal-label">To</label>'
            + '<div class="lc-email-modal-row">'
            + '<input class="lc-email-modal-input" id="lc-em-to" readonly value="' + esc(toEmail) + '">'
            + '<button class="lc-email-modal-copy" data-copy-target="lc-em-to" type="button">Copy</button>'
            + '</div>'
            + '</div>'
            + '<div class="lc-email-modal-field">'
            + '<label class="lc-email-modal-label">Subject</label>'
            + '<div class="lc-email-modal-row">'
            + '<input class="lc-email-modal-input" id="lc-em-sub" readonly value="' + esc(subject) + '">'
            + '<button class="lc-email-modal-copy" data-copy-target="lc-em-sub" type="button">Copy</button>'
            + '</div>'
            + '</div>'
            + '<div class="lc-email-modal-field lc-email-modal-field--body">'
            + '<label class="lc-email-modal-label">Body</label>'
            + '<textarea class="lc-email-modal-textarea" id="lc-em-body" readonly>' + esc(body) + '</textarea>'
            + '<button class="lc-email-modal-copy lc-email-modal-copy--body" data-copy-target="lc-em-body" type="button">Copy body</button>'
            + '</div>'
            + '</div>';

        document.body.appendChild(modal);

        modal.querySelector('.lc-email-modal-close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

        modal.querySelectorAll('.lc-email-modal-copy').forEach(btn => {
            btn.addEventListener('click', async () => {
                const el = modal.querySelector('#' + btn.dataset.copyTarget);
                if (!el) return;
                try {
                    await navigator.clipboard.writeText(el.value);
                    const orig = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => { btn.textContent = orig; }, 1500);
                } catch {}
            });
        });
    }

    function bindDetailEvents(container, id, docs, lc, buildTlTrack) {
        // Doc card expand/collapse — exclude interactive elements
        container.querySelector('#lc-doc-list').addEventListener('click', e => {
            const hd = e.target.closest('.lc-doc-hd');
            if (!hd) return;
            if (e.target.closest('.lc-chip') || e.target.closest('[data-upload-doc]') ||
                e.target.closest('[data-link-doc]') || e.target.closest('.lc-doc-extlink') ||
                e.target.closest('[data-compose-insurance]') || e.target.closest('[data-compose-applicant]') ||
                e.target.closest('[data-toggle-checklist]')) return;
            const card = hd.closest('.lc-doc-card');
            card.classList.toggle('lc-doc-card--open');
        });

        // Checklist toggle
        container.querySelector('#lc-doc-list').addEventListener('click', e => {
            const btn = e.target.closest('[data-toggle-checklist]');
            if (!btn) return;
            const docId   = btn.dataset.toggleChecklist;
            const card    = container.querySelector('#lcdoc-' + docId);
            const listEl  = card?.querySelector('.lc-doc-checklist');
            if (!listEl) return;
            const open = listEl.hidden;
            listEl.hidden = !open;
            btn.textContent = open ? 'Hide requirements' : 'Show requirements';
        });

        // Document link: show/edit form
        container.querySelector('#lc-doc-list').addEventListener('click', e => {
            const btn = e.target.closest('[data-link-doc]');
            if (!btn) return;
            const docId = btn.dataset.linkDoc;
            const card  = container.querySelector('#lcdoc-' + docId);
            if (card) card.classList.add('lc-doc-card--open');
            const form = container.querySelector('#lc-link-form-' + docId);
            if (form) {
                form.hidden = !form.hidden;
                if (!form.hidden) form.querySelector('.lc-doc-link-input')?.focus();
            }
        });

        // Document link: save / cancel / clear
        container.querySelector('#lc-doc-list').addEventListener('click', async e => {
            const saveBtn = e.target.closest('[data-save-link]');
            if (saveBtn) {
                const docId = saveBtn.dataset.saveLink;
                const url   = container.querySelector('#lc-link-form-' + docId)?.querySelector('.lc-doc-link-input')?.value.trim() || '';
                container.querySelector('#lc-link-form-' + docId).hidden = true;
                updateDocLink(container, docId, url);
                await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify({ docLinks: { [docId]: url } }) }).catch(() => {});
                return;
            }
            const cancelBtn = e.target.closest('[data-cancel-link]');
            if (cancelBtn) {
                container.querySelector('#lc-link-form-' + cancelBtn.dataset.cancelLink).hidden = true;
                return;
            }
            const clearBtn = e.target.closest('[data-clear-link]');
            if (clearBtn) {
                const docId = clearBtn.dataset.clearLink;
                container.querySelector('#lc-link-form-' + docId).hidden = true;
                updateDocLink(container, docId, '');
                await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify({ docLinks: { [docId]: '' } }) }).catch(() => {});
            }
        });

        // Enter key in link input
        container.querySelector('#lc-doc-list').addEventListener('keydown', async e => {
            if (e.key !== 'Enter') return;
            const input = e.target.closest('.lc-doc-link-input');
            if (!input) return;
            const form  = input.closest('.lc-doc-link-form');
            const docId = form?.querySelector('[data-save-link]')?.dataset.saveLink;
            if (!docId) return;
            form.hidden = true;
            const url = input.value.trim();
            updateDocLink(container, docId, url);
            await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify({ docLinks: { [docId]: url } }) }).catch(() => {});
        });

        function updateDocLink(container, docId, url) {
            const wrap = container.querySelector('#lc-link-wrap-' + docId);
            if (!wrap) return;
            if (url) {
                wrap.innerHTML = `<div class="lc-doc-link-pill"><a href="${esc(url)}" target="_blank" rel="noopener" class="lc-doc-extlink">${docLinkIcon(url)} Open →</a><button class="lc-doc-link-edit-btn" data-link-doc="${docId}" type="button" title="Edit link">✎</button></div>`;
            } else {
                wrap.innerHTML = `<button class="lc-doc-link-add-btn" data-link-doc="${docId}" type="button">+ add link</button>`;
            }
            const input = container.querySelector('#lc-link-form-' + docId)?.querySelector('.lc-doc-link-input');
            if (input) input.value = url;
        }

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

        // Flag issue as recurring pattern
        container.querySelector('#lc-doc-list').addEventListener('click', async e => {
            const btn = e.target.closest('.lc-flag-issue-btn');
            if (!btn) return;
            if (btn.classList.contains('lc-flag-issue-btn--saving')) return;

            const checkId   = btn.dataset.flagCheck;
            const checkText = btn.dataset.flagText;
            const aiNote    = btn.dataset.aiNote || '';
            const docId     = btn.dataset.flagDoc;
            const docDef    = docs.find(d => d.id === docId);
            const docTitle  = docDef ? docDef.title : docId;

            // Show inline form just below the button
            const existingForm = btn.parentElement.querySelector('.lc-flag-form');
            if (existingForm) { existingForm.remove(); return; }

            const form = document.createElement('div');
            form.className = 'lc-flag-form';
            form.innerHTML = '<textarea class="lc-flag-pattern" rows="2" placeholder="Describe the pattern to watch for in future checks…">' + esc(aiNote) + '</textarea>'
                + '<div class="lc-flag-form-btns">'
                + '<button class="lc-flag-save" type="button">Save pattern</button>'
                + '<button class="lc-flag-cancel" type="button">Cancel</button>'
                + '</div>';
            btn.parentElement.appendChild(form);
            form.querySelector('.lc-flag-pattern').focus();

            form.querySelector('.lc-flag-cancel').addEventListener('click', () => form.remove());
            form.querySelector('.lc-flag-save').addEventListener('click', async () => {
                const pattern = form.querySelector('.lc-flag-pattern').value.trim();
                if (!pattern) return;
                btn.classList.add('lc-flag-issue-btn--saving');
                try {
                    await apiFetch('/api/lc-known-issues', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ docType: docId, docTitle, checkId, checkText, pattern }),
                    });
                    btn.classList.add('lc-flag-issue-btn--saved');
                    btn.title = 'Saved as recurring issue';
                    form.remove();
                } catch (err) {
                    alert('Could not save: ' + err.message);
                    btn.classList.remove('lc-flag-issue-btn--saving');
                }
            });
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

        // Delete known issue
        container.querySelector('#lc-known-issues-card')?.addEventListener('click', async e => {
            const btn = e.target.closest('[data-del-ki]');
            if (!btn) return;
            const kiId = btn.dataset.delKi;
            btn.disabled = true;
            try {
                await apiFetch('/api/lc-known-issues?id=' + encodeURIComponent(kiId), { method: 'DELETE' });
                btn.closest('.lc-ki-row').remove();
                const listEl = container.querySelector('#lc-known-issues-list');
                if (listEl && !listEl.querySelector('.lc-ki-row')) {
                    listEl.innerHTML = '<span class="lc-known-issues-empty">No recurring issues flagged yet.</span>';
                }
            } catch (err) {
                btn.disabled = false;
                alert('Could not delete: ' + err.message);
            }
        });

        // Timeline: click Est. Ship or Shipped dot to reveal/hide ship date input
        container.querySelector('#lc-tl2')?.addEventListener('click', e => {
            const mark = e.target.closest('[data-setship]');
            if (!mark) return;
            const row = container.querySelector('#lc-tl2-ship-row');
            if (row) {
                row.hidden = !row.hidden;
                if (!row.hidden) row.querySelector('#lc-shipment-date-input')?.focus();
            }
        });

        // "Done" button collapses the row when ship date already set
        container.querySelector('#lc-tl2-ship-done')?.addEventListener('click', () => {
            const row = container.querySelector('#lc-tl2-ship-row');
            if (row) row.hidden = true;
        });

        // Shipment date input — patch + redraw track
        const shipDateInput = container.querySelector('#lc-shipment-date-input');
        if (shipDateInput) {
            shipDateInput.addEventListener('change', async () => {
                const val = shipDateInput.value;
                await apiFetch('/api/lc/' + id, {
                    method: 'PATCH',
                    body: JSON.stringify({ shipmentDate: val }),
                }).catch(() => {});
                const trackEl = container.querySelector('#lc-tl2-track');
                if (trackEl && buildTlTrack) trackEl.innerHTML = buildTlTrack(val);
            });
        }

        // Per-card document upload — shows draft/final confirm before archiving + checking
        const cardFileInput = container.querySelector('#lc-card-file-input');
        let _activeUploadDocId = null;

        container.querySelector('#lc-doc-list').addEventListener('click', e => {
            const btn = e.target.closest('[data-upload-doc]');
            if (!btn) return;
            e.stopPropagation();
            _activeUploadDocId = btn.dataset.uploadDoc;
            cardFileInput.value = '';
            cardFileInput.click();
        });

        cardFileInput.addEventListener('change', () => {
            if (cardFileInput.files[0] && _activeUploadDocId) {
                showUploadConfirm(cardFileInput.files[0], _activeUploadDocId);
            }
        });

        function showUploadConfirm(file, docId) {
            const resultsEl = container.querySelector('#lccheck-' + docId);
            if (!resultsEl) return;
            const card = container.querySelector('#lcdoc-' + docId);
            if (card) card.classList.add('lc-doc-card--open');
            resultsEl.hidden = false;
            resultsEl.innerHTML = `
                <div class="lc-upload-confirm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                    <span class="lc-upload-confirm-fname">${esc(file.name)}</span>
                    <label class="lc-upload-confirm-draft-label">
                        <input type="checkbox" class="lc-upload-draft-chk"> Draft
                    </label>
                    <button class="lc-upload-confirm-btn" type="button">Upload &amp; Check</button>
                    <button class="lc-upload-cancel-btn" type="button">Cancel</button>
                </div>`;
            resultsEl.querySelector('.lc-upload-confirm-btn').addEventListener('click', () => {
                const isDraft = resultsEl.querySelector('.lc-upload-draft-chk').checked;
                handleDocCheck(file, docId, isDraft);
            });
            resultsEl.querySelector('.lc-upload-cancel-btn').addEventListener('click', () => {
                resultsEl.hidden = true;
                resultsEl.innerHTML = '';
            });
        }

        // Drive folder: show form on add/change
        container.addEventListener('click', e => {
            if (!e.target.closest('#lc-drive-add-btn') && !e.target.closest('#lc-drive-change-btn')) return;
            container.querySelector('#lc-drive-folder-form').hidden = false;
            container.querySelector('#lc-drive-folder-input')?.focus();
        });

        // Drive folder: save
        container.querySelector('#lc-drive-save-btn')?.addEventListener('click', async () => {
            const url = container.querySelector('#lc-drive-folder-input').value.trim();
            container.querySelector('#lc-drive-folder-form').hidden = true;
            _driveFolderUrl = url;
            updateDriveFolderDisplay(container, url);
            await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify({ driveFolderUrl: url }) }).catch(() => {});
        });

        // Drive folder: cancel
        container.querySelector('#lc-drive-cancel-btn')?.addEventListener('click', () => {
            container.querySelector('#lc-drive-folder-form').hidden = true;
        });

        // Drive folder: remove
        container.querySelector('#lc-drive-remove-btn')?.addEventListener('click', async () => {
            container.querySelector('#lc-drive-folder-form').hidden = true;
            _driveFolderUrl = '';
            updateDriveFolderDisplay(container, '');
            await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify({ driveFolderUrl: '' }) }).catch(() => {});
        });

        function updateDriveFolderDisplay(container, url) {
            const wrap = container.querySelector('#lc-drive-folder-wrap');
            if (!wrap) return;
            if (url) {
                wrap.innerHTML = `<a href="${esc(url)}" target="_blank" class="lc-drive-folder-link">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><polygon points="7.5,3 16.5,3 22,13 13,13" fill="#fbbc04"/><polygon points="2,13 7.5,3 11.5,13 6,23" fill="#34a853"/><polygon points="12,13 6,23 18,23 24,13" fill="#4285f4"/></svg>
                    Drive folder ↗
                </a>
                <button class="lc-drive-change-btn" id="lc-drive-change-btn" type="button">Change</button>`;
            } else {
                wrap.innerHTML = `<button class="lc-drive-add-btn" id="lc-drive-add-btn" type="button">+ Link Drive folder</button>`;
            }
            const input = container.querySelector('#lc-drive-folder-input');
            if (input) input.value = url;
        }

        // Upload history delete handler (rows live beneath each doc card)
        container.querySelector('#lc-doc-list').addEventListener('click', async e => {
            const btn = e.target.closest('[data-del-key]');
            if (!btn) return;
            e.stopPropagation();
            if (!confirm('Remove this archived document?')) return;
            const key = btn.dataset.delKey;
            try {
                await fetch(`/api/lc-docs?key=${encodeURIComponent(key)}&lcId=${encodeURIComponent(id)}`, { method: 'DELETE' });
                loadArchivedDocs(container, id);
            } catch {}
        });

        // Insurance notification — send email (preview strip then open mail client)
        container.querySelector('#lc-doc-list').addEventListener('click', async e => {
            const btn = e.target.closest('[data-compose-insurance]');
            if (!btn) return;
            e.stopPropagation();

            const ins         = lc.insurance || {};
            const toEmail     = ins.email || '';
            const contactName = ins.contactName || 'Sir/Madam';
            const lcRef       = lc.lcNumber || '—';
            const issued      = fmtDate(lc.issuedDate) || '—';

            let finalDocs = [];
            try {
                const res = await apiFetch('/api/lc-docs?lcId=' + encodeURIComponent(id));
                finalDocs = (res.docs || []).filter(d => !d.draft && !d.superseded);
            } catch {}

            const docLines = finalDocs.length
                ? finalDocs.map(d => 'Final ' + (d.docTitle || d.docType)).join('\n')
                : '[No final documents archived yet]';
            const coverNoteRef = ins.coverNote ? 'Referring Cover Note No. ' + ins.coverNote + '.' : '';
            const clausePara   = ins.clauseText ? '\n\nThese documents are required by the LC as stated:\n\n' + ins.clauseText : '';

            const subject = 'Insurance Notification — LC #' + lcRef;
            const body = [
                'Hi ' + contactName + ',',
                '',
                'Please find the attached Final shipping documents for LC: ' + lcRef,
                'Issued ' + issued + '.',
                '',
                docLines,
                coverNoteRef,
                clausePara,
                '',
                'Thanks',
            ].join('\n');

            showEmailPanel(toEmail, subject, body);
        });

        // Applicant documents email — show copyable text panel
        container.querySelector('#lc-doc-list').addEventListener('click', async e => {
            const btn = e.target.closest('[data-compose-applicant]');
            if (!btn) return;
            e.stopPropagation();

            const ap    = lc.applicant || {};
            const lcRef = lc.lcNumber || '—';

            let finalDocs = [];
            try {
                const res = await apiFetch('/api/lc-docs?lcId=' + encodeURIComponent(id));
                finalDocs = (res.docs || []).filter(d => !d.draft && !d.superseded);
            } catch {}

            const docLines = finalDocs.length
                ? finalDocs.map(d => '- ' + (d.docTitle || d.docType)).join('\n')
                : '[No final documents archived yet]';

            const subject = 'Shipping Documents — LC #' + lcRef;
            const body = [
                'Dear ' + (ap.name || 'Sir/Madam') + ',',
                '',
                'Please find attached one full set of non-negotiable shipping documents for LC #' + lcRef + ':',
                '',
                docLines,
                '',
                'As required under the LC, this email and its attachments constitute the forwarding of documents within 21 days of shipment.',
                'Please retain a copy of this email to present with the original shipping documents.',
                '',
                'Regards,',
                'Enviroware Ltd',
            ].join('\n');

            showEmailPanel(ap.email || '', subject, body);
        });

        // Copy LC number to clipboard
        container.querySelector('[data-copy]')?.addEventListener('click', async function() {
            const text = this.dataset.copy;
            try {
                await navigator.clipboard.writeText(text);
                this.classList.add('lc-copy-btn--ok');
                setTimeout(() => this.classList.remove('lc-copy-btn--ok'), 1500);
            } catch {}
        });

        // Upload LC PDF to re-extract fields
        const extractBtn   = container.querySelector('#lc-extract-btn');
        const extractInput = container.querySelector('#lc-extract-file-input');
        if (extractBtn && extractInput) {
            function showExtractOverlay(msg) {
                let ov = document.getElementById('lc-extract-overlay');
                if (!ov) {
                    ov = document.createElement('div');
                    ov.id = 'lc-extract-overlay';
                    ov.className = 'lc-extract-overlay';
                    ov.innerHTML = '<div class="lc-extract-overlay-box">'
                        + '<div class="lc-extract-overlay-spinner"></div>'
                        + '<div class="lc-extract-overlay-msg" id="lc-extract-overlay-msg"></div>'
                        + '</div>';
                    document.body.appendChild(ov);
                }
                document.getElementById('lc-extract-overlay-msg').textContent = msg;
                ov.classList.add('lc-extract-overlay--visible');
            }
            function hideExtractOverlay() {
                document.getElementById('lc-extract-overlay')?.classList.remove('lc-extract-overlay--visible');
            }

            extractBtn.addEventListener('click', () => extractInput.click());
            extractInput.addEventListener('change', async () => {
                const file = extractInput.files[0];
                if (!file) return;
                extractInput.value = '';
                extractBtn.disabled = true;
                extractBtn.textContent = 'Reading…';
                showExtractOverlay('Reading document…');
                try {
                    const base64 = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result.split(',')[1]);
                        reader.onerror = () => reject(new Error('Failed to read file'));
                        reader.readAsDataURL(file);
                    });
                    extractBtn.textContent = 'Extracting…';
                    showExtractOverlay('Extracting fields with AI…');
                    const json = await apiFetch('/api/lc-extract', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ data: base64, mediaType: 'application/pdf' }),
                    });
                    hideExtractOverlay();
                    showExtractReviewModal(json.fields, lc, id, () => renderDetail(container, id));
                } catch (err) {
                    hideExtractOverlay();
                    alert('Extraction failed: ' + err.message);
                } finally {
                    extractBtn.disabled = false;
                    extractBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Upload LC PDF';
                }
            });
        }

        // Shipment link — populate dropdown from active orders
        // Unlink shipment
        container.querySelector('#lc-ship-unlink-btn')?.addEventListener('click', async () => {
            await apiFetch('/api/lc/' + id, { method: 'PATCH', body: JSON.stringify({ linkedShipmentId: '' }) }).catch(() => {});
            renderDetail(container, id);
        });

        loadArchivedDocs(container, id);
        loadKnownIssues(container);

        async function handleDocCheck(file, docId, isDraft = false) {
            const docDef = docs.find(d => d.id === docId);
            if (!docDef) return;

            const resultsEl = container.querySelector('#lccheck-' + docId);
            if (!resultsEl) return;

            const card = container.querySelector('#lcdoc-' + docId);
            if (card) card.classList.add('lc-doc-card--open');

            resultsEl.hidden = false;
            resultsEl.innerHTML = '<div class="lc-card-check-loading">⏳ Reading document…</div>';

            let archiveLabel = '';
            try {
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload  = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = () => reject(new Error('Failed to read file'));
                    reader.readAsDataURL(file);
                });
                _checkBase64.set(docId, base64);

                // Step 1 — Archive immediately
                const loadEl = () => resultsEl.querySelector('.lc-card-check-loading');
                if (loadEl()) loadEl().textContent = _driveFolderUrl ? '⏳ Saving to KV + Drive…' : '⏳ Saving document…';
                try {
                    const ar = await fetch('/api/lc-docs', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ lcId: id, docType: docId, docTitle: docDef.title, filename: file.name, data: base64, driveFolderUrl: _driveFolderUrl, draft: isDraft }),
                    });
                    const aj = await ar.json();
                    if (aj.ok) {
                        const driveOk  = aj.meta?.driveViewLink;
                        const driveErr = aj.meta?.driveError;
                        archiveLabel   = isDraft
                            ? 'Draft saved'
                            : driveErr  ? `Final saved · Drive error`
                            : driveOk   ? 'Final saved + Drive ↗'
                            : 'Final saved';
                        loadArchivedDocs(container, id);
                    }
                } catch (_) { archiveLabel = 'Save failed'; }

                // Step 2 — Check against LC requirements
                if (loadEl()) loadEl().textContent = '⏳ Checking against LC requirements…';
                const lcContext = {
                    lcNumber:         lc.lcNumber,
                    issuedDate:       lc.issuedDate,
                    expiryDate:       lc.expiryDate,
                    latestShipDate:   lc.latestShipDate,
                    currency:         lc.currency,
                    amount:           lc.amount,
                    presentationDays: lc.presentationDays,
                    beneficiary:      lc.beneficiary,
                    applicant:        lc.applicant,
                    applicantBank:    lc.applicantBank,
                    advisingBank:     lc.advisingBank,
                    goods:            lc.goods,
                    ports:            lc.ports,
                    proformaRef:      lc.proformaRef,
                    proformaDate:     lc.proformaDate,
                    insurance:        lc.insurance,
                    governedBy:       lc.governedBy,
                    f47aConditions:   lc.f47aConditions,
                };
                const res  = await fetch('/api/lc-check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ docType: docId, docTitle: docDef.title, checks: docDef.checks, data: base64, mediaType: 'application/pdf', lcContext }),
                });
                const json = await res.json();
                if (!json.ok) throw new Error(json.error || 'Check failed');

                const results = json.results;
                const passed  = results.filter(r => r.result === 'pass').length;
                const flagged = results.filter(r => r.result === 'flag').length;
                const failed  = results.filter(r => r.result === 'fail').length;

                const sumCls  = failed > 0 ? 'fail' : flagged > 0 ? 'flag' : 'pass';
                const sumIcon = failed > 0 ? '✗' : flagged > 0 ? '⚠' : '✓';
                const sumParts = [`${passed} pass`];
                if (flagged) sumParts.push(`${flagged} flag`);
                if (failed)  sumParts.push(`${failed} fail`);
                const archiveCls = isDraft ? 'draft' : 'final';

                // Step 3 — Merge AI results into the checklist (replace separate matrix)
                const checksEl = container.querySelector('#lcdoc-' + docId + ' .lc-doc-checks');
                const linkFormEl = checksEl ? checksEl.querySelector('.lc-doc-link-form') : null;

                const summaryBar = '<div class="lc-check-matrix-bar lc-check-matrix-bar--' + sumCls + ' lc-check-ai-bar">'
                    + '<span class="lc-check-matrix-tally">' + sumIcon + ' ' + sumParts.join(' · ') + '</span>'
                    + (archiveLabel ? '<span class="lc-doc-version-badge lc-doc-version-badge--' + archiveCls + '">' + esc(archiveLabel) + '</span>' : '')
                    + '</div>';

                // Only render flag/fail items individually; passes collapse to a single summary row
                const passItems  = results.filter(r => r.result === 'pass');
                const issueItems = results.filter(r => r.result !== 'pass');

                const issueRows = docDef.checks
                    .filter(c => issueItems.some(r => r.checkId === c.id))
                    .map(c => {
                        const r         = issueItems.find(r => r.checkId === c.id);
                        const chkEl     = container.querySelector('#chk-' + c.id);
                        const isChecked = chkEl ? chkEl.checked : !!(lc.docChecks && lc.docChecks[c.id]);
                        const cls       = r.result === 'flag' ? 'flag' : 'fail';
                        const icon      = r.result === 'flag' ? '⚠' : '✗';
                        const noteAttr  = r.note ? ' data-ai-note="' + esc(r.note) + '"' : '';
                        const citeLink  = '<a class="lc-cite-link" href="#' + (c.cite || 'lc-raw-section') + '" title="View in LC reference">§</a>';
                        return '<div class="lc-check-item lc-check-item--ai lc-check-item--ai-' + cls + (isChecked ? ' lc-check-item--done' : '') + '">'
                            + '<input type="checkbox" id="chk-' + c.id + '" data-check="' + c.id + '"' + (isChecked ? ' checked' : '') + '>'
                            + '<div class="lc-check-item-body">'
                            + '<label for="chk-' + c.id + '">' + esc(c.text) + citeLink + '</label>'
                            + (r.note ? '<span class="lc-check-ai-note">' + esc(r.note) + '</span>' : '')
                            + '</div>'
                            + '<span class="lc-check-ai-badge lc-check-ai-badge--' + cls + '">' + icon + '</span>'
                            + '<button class="lc-flag-issue-btn" type="button" title="Flag as recurring issue"'
                            + ' data-flag-doc="' + esc(docId) + '" data-flag-check="' + esc(c.id) + '" data-flag-text="' + esc(c.text) + '"' + noteAttr + '>⚑</button>'
                            + '</div>';
                    }).join('');

                const passRow = passItems.length
                    ? '<div class="lc-check-pass-summary">✓ ' + passItems.length + ' item' + (passItems.length === 1 ? '' : 's') + ' passed</div>'
                    : '';

                const enrichedItems = issueRows + passRow;

                if (checksEl) {
                    checksEl.innerHTML = (linkFormEl ? linkFormEl.outerHTML : '')
                        + summaryBar
                        + enrichedItems;
                    // Re-bind the link form cancel button (outerHTML clone loses listeners)
                    const newLinkForm = checksEl.querySelector('.lc-doc-link-form');
                    if (newLinkForm) {
                        newLinkForm.querySelector('[data-cancel-link]')?.addEventListener('click', () => { newLinkForm.hidden = true; });
                    }
                }
                resultsEl.hidden = true;

            } catch (err) {
                const checksEl2 = container.querySelector('#lcdoc-' + docId + ' .lc-doc-checks');
                const errBar = '<div class="lc-check-matrix-bar lc-check-matrix-bar--fail lc-check-ai-bar">'
                    + '<span class="lc-check-matrix-tally">✗ ' + esc(err.message) + '</span>'
                    + (archiveLabel ? '<span class="lc-doc-version-badge lc-doc-version-badge--' + (isDraft ? 'draft' : 'final') + '">' + esc(archiveLabel) + '</span>' : '')
                    + '</div>';
                if (checksEl2) {
                    const existingBar = checksEl2.querySelector('.lc-check-ai-bar');
                    if (existingBar) existingBar.outerHTML = errBar;
                    else checksEl2.insertAdjacentHTML('afterbegin', errBar);
                }
                resultsEl.hidden = true;
            }
        }
    }

    async function loadArchivedDocs(container, lcId) {
        // Per-document upload history — rows distributed beneath each doc card
        const historyEls = container.querySelectorAll('.lc-doc-history');
        if (!historyEls.length) return;

        const rowHtml = d => {
            const versionCls   = d.superseded ? 'superseded' : d.draft ? 'draft' : 'final';
            const versionLabel = d.superseded ? 'Superseded' : d.draft ? 'Draft' : 'Final';
            return `
                <div class="lc-archive-row${d.superseded ? ' lc-archive-row--superseded' : ''}">
                    <span class="lc-doc-version-badge lc-doc-version-badge--${versionCls}">${versionLabel}</span>
                    <span class="lc-archive-name">${esc(d.filename)}</span>
                    <span class="lc-archive-date">${esc(fmtDate((d.uploadedAt || '').slice(0, 10)))}</span>
                    <a class="lc-archive-view" href="/api/lc-doc-file?key=${encodeURIComponent(d.key)}&filename=${encodeURIComponent(d.filename)}" target="_blank">View PDF</a>
                    ${d.driveViewLink
                        ? `<a class="lc-archive-drive-link" href="${esc(d.driveViewLink)}" target="_blank" title="View in Google Drive">
                               <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><polygon points="7.5,3 16.5,3 22,13 13,13" fill="#fbbc04"/><polygon points="2,13 7.5,3 11.5,13 6,23" fill="#34a853"/><polygon points="12,13 6,23 18,23 24,13" fill="#4285f4"/></svg>
                               Drive
                           </a>`
                        : d.driveError
                            ? `<span class="lc-archive-drive-err" title="${esc(d.driveError)}">Drive ✗</span>`
                            : ''
                    }
                    <button class="lc-archive-del" data-del-key="${esc(d.key)}" type="button" title="Delete">✕</button>
                </div>`;
        };

        try {
            const json = await apiFetch('/api/lc-docs?lcId=' + lcId);
            const byType = {};
            (json.docs || []).forEach(d => {
                (byType[d.docType] = byType[d.docType] || []).push(d);
            });
            historyEls.forEach(el => {
                const docId = el.id.replace('lc-doc-history-', '');
                const rows  = byType[docId] || [];
                if (!rows.length) { el.hidden = true; el.innerHTML = ''; return; }
                el.innerHTML = '<div class="lc-doc-history-label">Upload history</div>' + rows.map(rowHtml).join('');
                el.hidden = false;
            });
        } catch { /* leave history blocks hidden */ }
    }

    async function loadKnownIssues(container) {
        const listEl = container.querySelector('#lc-known-issues-list');
        if (!listEl) return;
        try {
            const json   = await apiFetch('/api/lc-known-issues');
            const issues = json.issues || [];
            if (!issues.length) {
                listEl.innerHTML = '<span class="lc-known-issues-empty">No recurring issues flagged yet. Use the ⚑ button on a check result to add one.</span>';
                return;
            }
            listEl.innerHTML = issues.map(i => {
                return '<div class="lc-ki-row" data-ki-id="' + esc(i.id) + '">'
                    + '<div class="lc-ki-body">'
                    + (i.docTitle ? '<span class="lc-ki-doc">' + esc(i.docTitle) + '</span>' : '')
                    + '<span class="lc-ki-pattern">' + esc(i.pattern) + '</span>'
                    + '</div>'
                    + '<button class="lc-ki-del" data-del-ki="' + esc(i.id) + '" type="button" title="Remove">✕</button>'
                    + '</div>';
            }).join('');
        } catch {
            listEl.innerHTML = '<span class="lc-known-issues-empty">Could not load.</span>';
        }
    }

    function updateClearance(container) {
        const chips = [...container.querySelectorAll('[data-status-doc]')];
        const ready = chips.filter(b => b.classList.contains('lc-chip--ready')).length;
        const pct   = Math.round((ready / 7) * 100);

        const fill  = container.querySelector('#lc-pfill');
        const label = container.querySelector('#lc-plabel');
        const chip  = container.querySelector('#lc-clearance');
        if (fill)  fill.style.width = pct + '%';
        if (label) label.textContent = `${ready} of 8 documents ready`;
        if (chip) {
            const cleared = ready === 8;
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

    return {
        render,
        setPendingShip:   ref           => { _pendingShipRef = ref; },
        setPendingShipId: (shipId, seq) => { _pendingShipId = shipId; _pendingShipRef = 'Shipment #' + seq; },
    };
})();
