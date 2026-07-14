import { jsonResponse, errResponse } from './_xero.js';

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
}

const EXTRACT_PROMPT = `You are extracting fields from a SWIFT MT700 "Issue of a Documentary Credit" document.

Return ONLY a valid JSON object with these exact fields (use null for any field not found):

{
  "lcNumber": "documentary credit number from field :20:",
  "issuedDate": "YYYY-MM-DD issue date from :31C: — convert YYMMDD or YYYYMMDD format",
  "expiryDate": "YYYY-MM-DD expiry date from :31D:",
  "latestShipDate": "YYYY-MM-DD latest date of shipment from :44C:",
  "presentationDays": <integer days for presentation from :48:>,
  "amount": <numeric amount only from :32B:, no currency symbol or commas, e.g. 22129.72>,
  "currency": "3-letter ISO currency code from :32B:, e.g. USD",
  "applicantName": "applicant company name from :50:",
  "applicantAddress": "applicant city and country",
  "applicantBankName": "issuing bank full name from :52A: or :52D:",
  "applicantBankCity": "issuing bank city and country",
  "applicantBankSwift": "issuing bank SWIFT/BIC code if present",
  "advisingBankName": "advising bank full name from :57A: or :57D:",
  "advisingBankCity": "advising bank city and country",
  "goodsDescription": "complete goods description from :45A:",
  "hsCode": "HS tariff/commodity code if stated, e.g. 6002.90.00",
  "quantity": <total numeric quantity from :45A:, e.g. 18754>,
  "quantityUnit": "unit of quantity: kg, mt, units, or pcs",
  "packageCount": <integer number of packages/bales/cartons, e.g. 40>,
  "packageType": "package type: bales, cartons, pallets, rolls, etc.",
  "unitPrice": <numeric unit price, e.g. 1.18>,
  "origin": "country of origin of goods",
  "container": "container type and count, e.g. 1x40 FCL",
  "incoterms": "full incoterms and named place, e.g. CPT ICD Kamlapur, Dhaka (Incoterms 2020)",
  "proformaRef": "proforma invoice or sales contract reference number",
  "proformaDate": "YYYY-MM-DD date of proforma invoice — convert from YYMMDD if needed",
  "portLoading": "port or place of loading from :44E:",
  "portDischarge": "port of discharge from :44F:",
  "portFinal": "place of final destination from :44B:",
  "governedBy": "applicable rules, e.g. UCP 600"
}

Rules:
- Convert all SWIFT-format dates (YYMMDD or YYYYMMDD) to YYYY-MM-DD. If year is 2-digit and >= 70, prefix 19; otherwise 20.
- Strip currency symbols, commas, and units from numeric fields — return bare numbers only.
- Return null for any field not clearly present. Do not guess.
- Do not include any text outside the JSON object.`;

export async function onRequestPost({ env, request }) {
    try {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return errResponse('ANTHROPIC_API_KEY not configured — add it to Worker secrets', 500);

        const formData = await request.formData();
        const file = formData.get('file');
        if (!file || !file.size) return errResponse('No file provided', 400);

        const mimeType = file.type || 'application/pdf';
        if (!mimeType.includes('pdf') && !file.name?.endsWith('.pdf')) {
            return errResponse('File must be a PDF', 400);
        }

        const buffer = await file.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);

        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-5',
                max_tokens: 2048,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'document',
                            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
                        },
                        { type: 'text', text: EXTRACT_PROMPT },
                    ],
                }],
            }),
        });

        if (!anthropicRes.ok) {
            const err = await anthropicRes.json().catch(() => ({}));
            return errResponse(`Anthropic API error: ${err.error?.message || anthropicRes.statusText}`, 502);
        }

        const result = await anthropicRes.json();
        const text = result.content?.[0]?.text?.trim() || '';

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return errResponse('Model did not return JSON. Response: ' + text.slice(0, 400), 500);
        }

        let fields;
        try {
            fields = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            return errResponse('Malformed JSON from model: ' + parseErr.message, 500);
        }

        return jsonResponse({ ok: true, fields });

    } catch (e) {
        return errResponse(e.message);
    }
}
