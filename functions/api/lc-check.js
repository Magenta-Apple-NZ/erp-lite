function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}

function buildLcContextBlock(lc) {
    if (!lc) return '';
    const g  = lc.goods    || {};
    const p  = lc.ports    || {};
    const ap = lc.applicant || {};
    const ab = lc.applicantBank || {};
    const lines = [
        `LC Number:          ${lc.lcNumber || '—'}`,
        `Issued Date:        ${lc.issuedDate || '—'}`,
        `Expiry Date:        ${lc.expiryDate || '—'}`,
        `Latest Ship Date:   ${lc.latestShipDate || '—'}`,
        `Amount:             ${lc.currency || 'USD'} ${lc.amount != null ? Number(lc.amount).toFixed(2) : '—'}`,
        `Governed By:        ${lc.governedBy || 'UCP 600'}`,
        `Presentation Days:  ${lc.presentationDays || 21} days after shipment`,
        ``,
        `Beneficiary:        ${lc.beneficiary || '—'}`,
        `Applicant Name:     ${ap.name || '—'}`,
        `Applicant Address:  ${ap.address || '—'}`,
        `Applicant Bank:     ${ab.name || '—'}, ${ab.city || '—'} (SWIFT: ${ab.swift || '—'})`,
        `Advising Bank:      ${(lc.advisingBank || {}).name || '—'}, ${(lc.advisingBank || {}).city || '—'}`,
        ``,
        `Goods Description:  ${g.description || '—'}`,
        `HS Code:            ${g.hsCode || '—'}`,
        `Quantity:           ${g.quantity != null ? g.quantity.toLocaleString() : '—'} ${g.quantityUnit || 'kg'}`,
        `Package Count:      ${g.packageCount || '—'} ${g.packageType || ''}`,
        `Unit Price:         ${lc.currency || 'USD'} ${g.unitPrice != null ? g.unitPrice : '—'} / ${g.quantityUnit || 'kg'}`,
        `Origin:             ${g.origin || '—'}`,
        `Container:          ${g.container || '—'}`,
        `Incoterms:          ${g.incoterms || '—'}`,
        ``,
        `Port of Loading:    ${p.loading || '—'}`,
        `Port of Discharge:  ${p.discharge || '—'}`,
        `Final Destination:  ${p.finalDestination || '—'}`,
        ``,
        `Proforma Ref:       No. ${lc.proformaRef || '—'}`,
        `Proforma Date:      ${lc.proformaDate || '—'}`,
    ];
    if (lc.f47aConditions && lc.f47aConditions.length) {
        lines.push('', 'Field 47A Special Conditions:');
        lc.f47aConditions.forEach((c, i) => lines.push(`  ${i + 1}. ${typeof c === 'string' ? c : (c.text || '')}`));
    }
    return lines.join('\n');
}

export async function onRequestPost({ env, request }) {
    let step = 'init';
    try {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return errResponse('ANTHROPIC_API_KEY not configured', 500);

        step = 'parse-request';
        const body = await request.json();
        const { docType, docTitle, checks, data: base64, mediaType = 'application/pdf', lcContext } = body;
        if (!base64) return errResponse('No document data', 400);
        if (!checks?.length) return errResponse('No checks provided', 400);

        // Load user-flagged known issues from KV
        step = 'load-known-issues';
        let knownIssues = [];
        try {
            const raw = await env.ORDERS_KV.get('lc_known_issues');
            knownIssues = raw ? JSON.parse(raw) : [];
        } catch (_) { /* non-fatal */ }

        // Use 'detail' for AI instruction if present, otherwise fall back to 'text'
        const checkList = checks.map((c, i) => `${i + 1}. [${c.id}] ${c.detail || c.text}`).join('\n');
        const lcBlock   = buildLcContextBlock(lcContext);

        // Build known patterns block — hardcoded baseline + user-flagged additions
        const basePatterns = [
            'Net weight appearing correctly in the goods/price section but differently in a separate weight summary, packing details, or footer. Both figures must match exactly.',
            'Incoterms abbreviated (C&F, C&I, CFR) rather than the full required form with "Incoterms 2020".',
            'Proforma invoice reference number or date slightly wrong (e.g. one digit off, wrong year).',
            'Port of loading vaguely stated or abbreviated rather than the exact LC wording.',
            'Importer name/address differing in punctuation, spacing, or abbreviation from the LC.',
            'Invoice dated before LC opening date.',
        ];
        const userPatterns = knownIssues
            .filter(i => !i.docType || i.docType === docType)
            .map(i => i.pattern);
        const allPatterns  = [...basePatterns, ...userPatterns];
        const patternBlock = allPatterns.map(p => `- ${p}`).join('\n');

        const prompt = `You are a senior trade finance document checker at a confirming bank. Your job is to find discrepancies that would cause a bank to reject a presentation under UCP 600. You are checking a ${docTitle || docType}.

## Known discrepancy patterns for this trade relationship
These are real issues found on previous presentations — be especially alert for them:
${patternBlock}

## LC Ground Truth
The following values come directly from the Letter of Credit and are the authoritative reference. Deviations in numbers, dates, amounts, references, and substantive wording are discrepancies; pure spacing/punctuation/case differences are not.

\`\`\`
${lcBlock}
\`\`\`

## Your task
Check each numbered requirement below against the uploaded document. For every check:
- Extract the actual value/text from the document
- Compare it against the LC ground truth above
- Numerical amounts: verify to the cent — USD 22,129.72 ≠ USD 22,130.00
- Dates: verify exact value
- If information the requirement demands is ABSENT from the document, result is "fail"

Return ONLY a JSON array, no other text:
[
  {"checkId": "id-from-list", "result": "pass|flag|fail", "note": "..."}
]

Note format — telegraphic, not conversational. Hard rules:
- pass: quote only the key value found (e.g. "18,754 kg net"). No commentary.
- flag/fail: "<Field>: <doc value> instead of <LC value>" — e.g. "Applicant TIN: 358887309531 instead of 358887309351" or "Port of discharge: 'CHATTOGRAM' instead of 'CHATTOGRAM SEA PORT, BANGLADESH'". For absent items: "<Field>: missing".
- If one check bundles several sub-items (TIN, BIN, IRC, HS code…), report ONLY the sub-items with problems. Never mention the ones that match.
- Aim for under 15 words per note. No full sentences, no explanations of why it matters, never restate the requirement text.

## Checks to perform
${checkList}

## Grading rules
- "pass" — requirement satisfied. Tolerance: differences ONLY in spacing, punctuation, capitalisation, or line-breaks that leave the identity/meaning unambiguous are NOT discrepancies — "J.P.S. ENTERPRISE" vs "J.P.S.ENTERPRISE" is a pass. Same for reordered address lines with identical content.
- "flag" (soft fail) — present but imperfect wording: abbreviated or partial port/place names, incoterm variant differing from the LC (e.g. CFR shown where LC says CPT), condensed clause wording, format differences. A human should review, but it may be acceptable.
- "fail" (hard fail) — missing entirely; wrong or transposed digits in any number, amount, date, quantity, or reference (TIN, BIN, IRC, proforma no., LC no.); wrong currency; contradicting figures within the document; a required certification/clause absent.
- Never give "pass" when you cannot find and quote the relevant text in the document
- Never give "pass" on a numerical check without confirming the exact figure
- Exception — some checks are LC special conditions that do not concern this document type at all (e.g. a bill-of-lading free-time clause when checking an invoice, bank charge clauses, container size, import policy references). If a condition genuinely cannot apply to this document, grade it "pass" with note "N/A" — do NOT fail a document for not containing a condition that was never meant to appear on it. Conditions like "all documents must bear the LC number" DO apply to every document and must be checked normally.
- For any value that could appear in multiple places (weight, quantity, amount, date): scan the ENTIRE document — headers, line items, summary tables, footers, certification clauses. If two sections show different figures, that is a fail regardless of which figure matches the LC.
- Return one object per check — every check in the list must appear in the output`;

        step = 'anthropic-fetch';
        const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'pdfs-2024-09-25',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-5',
                max_tokens: 16000,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } },
                        { type: 'text', text: prompt },
                    ],
                }],
            }),
        });

        step = 'anthropic-response';
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return errResponse(`Anthropic ${res.status}: ${err.error?.message || res.statusText}`, 500);
        }

        step = 'parse-response';
        const result = await res.json();
        // Sonnet 5 uses extended thinking — content[0] may be a thinking block.
        // Find the first content block with type 'text'.
        const textBlock = (result.content || []).find(b => b.type === 'text');
        const text = textBlock?.text?.trim() || '';
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) return errResponse('No JSON array in model response: ' + text.slice(0, 200), 500);
        const results = JSON.parse(match[0]);
        const normalised = results.map(r => ({
            ...r,
            result: r.result || (r.pass === true ? 'pass' : 'fail'),
        }));
        return jsonResponse({ ok: true, results: normalised });

    } catch (e) {
        return errResponse(`[${step}] ${e.message || String(e)}`, 500);
    }
}
