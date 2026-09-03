// POST /api/orders/extract-pdf — extract order fields from a customer's
// purchase-order PDF for the New Order form (review-before-create).
//
// Body: { data: <base64 PDF (no data: prefix)>, mediaType }
// Returns: { ok, fields } — see the schema in EXTRACT_PROMPT below.
//
// Mirrors functions/api/lc-extract.js: a single Claude call with the PDF as a
// document block. Needs ANTHROPIC_API_KEY in the Pages env.

import { jsonResponse, errResponse } from '../_xero.js';

const EXTRACT_PROMPT = `You are extracting a purchase order (PO) that a CUSTOMER has sent to Enviroware / Prime Ties, a New Zealand supplier of "Prime Ties" plant ties (products: Prime Ties Bundled, Prime Ties Loose, eco Ties — in 1kg or 10kg).

Return ONLY a valid JSON object with these exact fields (use null for anything not clearly present — do not guess):

{
  "poNumber": "the customer's PO / order number, e.g. PO323765",
  "orderDate": "YYYY-MM-DD order date",
  "customerName": "the company BUYING from Enviroware (the buyer / ship-to company). NEVER 'Enviroware' or 'Enviroware Ltd' — that is the vendor (us).",
  "branch": "the specific branch / store / town this order ships to or is for (e.g. 'Tauranga'), or null",
  "shipToAddress": "ship-to street address, first line only",
  "shipToCity": "ship-to city / town",
  "shipToPostcode": "ship-to postcode",
  "fulfilment": "pickup or courier — 'pickup' if the document says the customer will pick up / collect, otherwise 'courier'",
  "notes": "any short delivery or handling note, e.g. 'we will pick up Wednesday', else null",
  "lines": [
    { "description": "the product description exactly as written", "customerSku": "the customer's own item code if shown, else null", "quantity": <number>, "unitPrice": <number: per-unit price ex-GST, no $ or commas> }
  ]
}

Rules:
- customerName is the entity ordering FROM Enviroware — never Enviroware/Enviroware Ltd (that is the vendor).
- Convert any date to YYYY-MM-DD.
- Strip $, commas and units from numeric fields. unitPrice is the per-unit price excluding GST.
- lines: only real product lines. Skip freight, GST, subtotal and total rows.
- fulfilment: "pickup" if the PO mentions pick up / collect / "we will collect"; otherwise "courier".
- Return ONLY the JSON object, no other text.`;

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
                max_tokens: 8000,
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
