// POST /api/xero/remittance/extract — read a customer's remittance advice PDF.
//
// Body: { data: <base64 PDF (no data: prefix)>, mediaType }
// Returns: { ok, remit, totals } where remit is
//   { payer, customerNumber, paymentDate, total, bankAccount,
//     lines: [{ kind: 'invoice'|'deduction'|'credit_note', date, reference, details, amount }] }
// and totals = checkTotals(remit) (invoices − deductions must equal total).
//
// One general prompt for every customer (PGG Wrightson, Farmlands,
// HortiCentre …) rather than a parser per layout; the tie-out check is the
// guard against a bad read. Mirrors functions/api/orders/extract-pdf.js.

import { jsonResponse, errResponse } from '../../_xero.js';
import { checkTotals, toDollars, toCents } from '../_remittance.js';

const PROMPT = `This is a REMITTANCE ADVICE sent by a customer to Enviroware Ltd (trading as Prime Ties, a New Zealand supplier). It tells Enviroware which of ENVIROWARE'S sales invoices the customer is paying, and any amounts the customer has deducted (rebates, promotional allowances, claims, fees) from the payment.

Return ONLY a valid JSON object with these exact fields (null for anything not clearly present — do not guess):

{
  "payer": "the company making the payment (the customer) — NEVER Enviroware",
  "customerNumber": "Enviroware's customer/vendor number with the payer, if shown",
  "paymentDate": "YYYY-MM-DD date of the payment",
  "total": <number: the total amount actually paid>,
  "bankAccount": "the bank account the money was paid into, exactly as printed, or null",
  "lines": [
    { "kind": "invoice | deduction | credit_note",
      "date": "YYYY-MM-DD line date or null",
      "reference": "the reference exactly as printed, e.g. INV-1047 or Aug'26 Rebates RS",
      "details": "the details / description column, or null",
      "amount": <positive number> }
  ]
}

Rules:
- One entry per transaction row, across every page. Skip headers, subtotals and the grand total row.
- kind "invoice": a payment of one of Enviroware's invoices (reference usually like INV-1234). These INCREASE the payment.
- kind "deduction": a rebate, allowance, claim, fee or other amount the customer has taken off. These DECREASE the payment. Customers often show them in the opposite column to invoices (e.g. "Debit" when invoices are "Credit") or as negatives.
- kind "credit_note": Enviroware's own credit note being applied (reference like CN-1234). These DECREASE the payment.
- amount is always POSITIVE; the kind says which way it goes. Strip $ and commas.
- Convert dates to YYYY-MM-DD (NZ format is day/month/year).
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
                max_tokens: 8000,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } },
                        { type: 'text', text: PROMPT },
                    ],
                }],
            }),
        });

        step = 'anthropic-response';
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return errResponse('Anthropic ' + res.status + ': ' + (err.error?.message || res.statusText), 500);
        }

        step = 'parse-model-response';
        const result = await res.json();
        const text = (result.content || []).find(b => b.type === 'text')?.text?.trim() || '';
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return errResponse('Model did not return JSON: ' + text.slice(0, 200), 500);

        step = 'normalise';
        const raw = JSON.parse(m[0]);
        const KINDS = new Set(['invoice', 'deduction', 'credit_note']);
        const remit = {
            payer: raw.payer || null,
            customerNumber: raw.customerNumber || null,
            paymentDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.paymentDate || '') ? raw.paymentDate : null,
            total: toDollars(toCents(raw.total)),
            bankAccount: raw.bankAccount || null,
            lines: (Array.isArray(raw.lines) ? raw.lines : [])
                .map(l => ({
                    kind: KINDS.has(l?.kind) ? l.kind : 'invoice',
                    date: /^\d{4}-\d{2}-\d{2}$/.test(l?.date || '') ? l.date : null,
                    reference: String(l?.reference || '').trim(),
                    details: l?.details || null,
                    amount: toDollars(Math.abs(toCents(l?.amount))),
                }))
                .filter(l => l.amount > 0),
        };
        return jsonResponse({ ok: true, remit, totals: checkTotals(remit) });
    } catch (e) {
        return errResponse(`[${step}] ${e.message || String(e)}`, 500);
    }
}
