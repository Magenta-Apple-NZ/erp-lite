function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}

const EXTRACT_PROMPT = `You are extracting fields from a SWIFT MT700 "Issue of a Documentary Credit" document.

Return ONLY a valid JSON object with these exact fields (use null for any field not found):

{
  "lcNumber": "documentary credit number from field :20:",
  "issuedDate": "YYYY-MM-DD issue date from :31C:",
  "expiryDate": "YYYY-MM-DD expiry date from :31D:",
  "latestShipDate": "YYYY-MM-DD latest date of shipment from :44C:",
  "presentationDays": <integer days for presentation from :48:>,
  "amount": <numeric value only from :32B:, no currency symbol or commas>,
  "currency": "3-letter ISO currency code from :32B:",
  "applicantName": "applicant company name from :50:",
  "applicantAddress": "applicant city and country",
  "applicantBankName": "issuing bank full name from :52A: or :52D:",
  "applicantBankCity": "issuing bank city and country",
  "applicantBankSwift": "issuing bank SWIFT/BIC code if present",
  "advisingBankName": "advising bank full name from :57A: or :57D:",
  "advisingBankCity": "advising bank city and country",
  "goodsDescription": "complete goods description from :45A:",
  "hsCode": "HS tariff/commodity code if stated",
  "quantity": <total numeric quantity from :45A:>,
  "quantityUnit": "unit of quantity: kg, mt, units, or pcs",
  "packageCount": <integer number of packages/bales/cartons>,
  "packageType": "package type: bales, cartons, pallets, rolls, etc.",
  "unitPrice": <numeric unit price>,
  "origin": "country of origin of goods",
  "container": "container type and count, e.g. 1x40 FCL",
  "incoterms": "full incoterms and named place",
  "proformaRef": "proforma invoice or sales contract reference number",
  "proformaDate": "YYYY-MM-DD date of proforma invoice",
  "portLoading": "port or place of loading from :44E:",
  "portDischarge": "port of discharge from :44F:",
  "portFinal": "place of final destination from :44B:",
  "governedBy": "applicable rules, e.g. UCP 600",
  "f47aConditions": [
    {"num": "01", "text": "verbatim text of condition 01 exactly as printed"},
    {"num": "02", "text": "verbatim text of condition 02 exactly as printed"}
  ]
}

Rules:
- Convert all SWIFT-format dates (YYMMDD or YYYYMMDD) to YYYY-MM-DD. If year 2-digit and >= 70 prefix 19, else prefix 20.
- Strip currency symbols, commas, and units from numeric fields.
- Return null for any field not clearly present. Do not guess.
- For f47aConditions: extract EVERY numbered condition from field :47A: verbatim. Do NOT categorise, merge, or omit any. Each condition gets its printed number (e.g. "01", "02") and the COMPLETE verbatim text of that condition exactly as it appears in the document — no paraphrasing, no summarising. If :47A: is absent return [].
- Return ONLY the JSON object, no other text.
- Also include a "rawText" field: the complete verbatim content of the LC, field by field, exactly as printed in the document. Format each field as ":TAG:\n[verbatim content]" with a blank line between fields. Do not paraphrase, summarise, or reformat — copy the exact wording, spacing, numbering, and punctuation from the document.`;

export async function onRequestPost({ env, request }) {
    let step = 'init';
    try {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return errResponse('ANTHROPIC_API_KEY not configured', 500);

        step = 'parse-request';
        const body = await request.json();
        const base64 = body?.data;
        const mediaType = body?.mediaType || 'application/pdf';
        if (!base64) return errResponse('No file data in request body', 400);

        step = 'anthropic-fetch';
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
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
                        { type: 'text', text: EXTRACT_PROMPT },
                    ],
                }],
            }),
        });

        step = 'anthropic-response';
        if (!anthropicRes.ok) {
            const err = await anthropicRes.json().catch(() => ({}));
            return errResponse('Anthropic ' + anthropicRes.status + ': ' + (err.error?.message || anthropicRes.statusText), 500);
        }

        step = 'parse-model-response';
        const result    = await anthropicRes.json();
        // Sonnet 5 may return thinking blocks — find first text block
        const textBlock = (result.content || []).find(b => b.type === 'text');
        const text      = textBlock?.text?.trim() || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return errResponse('Model did not return JSON: ' + text.slice(0, 200), 500);

        step = 'parse-fields';
        const fields = JSON.parse(jsonMatch[0]);
        return jsonResponse({ ok: true, fields });

    } catch (e) {
        return errResponse(`[${step}] ${e.message || String(e)}`, 500);
    }
}
