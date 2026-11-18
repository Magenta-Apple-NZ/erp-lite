// Read Pistoni's packing list / proforma (and JPS's invoice) with Claude: the PDF as a document
// block, a strict JSON schema for the answer (structured outputs), then
// deterministic checks in ../_exportdocs.js. Never auto-accepted: the result
// only fills the review screen. Raw fetch + claude-sonnet-5, as in
// lc-extract.js and orders/extract-pdf.js. Needs ANTHROPIC_API_KEY.

const MODEL = 'claude-sonnet-5';

const str  = { type: 'string' };
const nstr = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nint = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const nnum = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
// Structured outputs allow at most 16 nullable (union-typed) fields per schema,
// so only numbers are nullable; text that isn't printed comes back as "".
// tests/export-docs.test.js counts them.

export const PACKING_SCHEMA = obj({
    shipmentNumber: nint,
    shipmentNumberRaw: str,
    bales: {
        type: 'array',
        items: obj({ n: { type: 'integer' }, kg: { type: 'number' }, kgRaw: str, colour: { type: 'string', enum: ['white', 'coloured'] } }),
    },
    whiteTotalKg: nnum, whiteTotalRaw: str,
    colouredTotalKg: nnum, colouredTotalRaw: str,
    totalPackages: nint, totalPackagesRaw: str,
    notes: str,
});

export const PROFORMA_SCHEMA = obj({
    documentNumber: str,
    documentDate: str,
    documentDateRaw: str,
    currency: str,
    lines: {
        type: 'array',
        items: obj({
            description: str,
            colour: { type: 'string', enum: ['white', 'coloured', 'unknown'] },
            kg: nnum, kgRaw: str,
            unitPrice: nnum, unitPriceRaw: str,
            amount: nnum, amountRaw: str,
        }),
    },
    netWeightKg: nnum, netWeightRaw: str,
    total: nnum, totalRaw: str,
    destination: str,
    deliveryTerms: str,
    hsCode: str,
    notes: str,
});

export const JPS_SCHEMA = obj({
    invoiceNumber: str,
    invoiceDate: str,
    invoiceDateRaw: str,
    currency: str,
    lines: {
        type: 'array',
        items: obj({ description: str, kg: nnum, kgRaw: str, unitPrice: nnum, unitPriceRaw: str, amount: nnum, amountRaw: str }),
    },
    netWeightKg: nnum, netWeightRaw: str,
    total: nnum, totalRaw: str,
    lastShipmentDate: str,
    expiryDate: str,
    containers: str,
    notes: str,
});

const NUMBER_RULE = `Numbers are printed in Italian format: a dot separates thousands and a comma marks decimals.
"4.887" is four thousand eight hundred and eighty-seven (4887), never 4.887. "7.330,50" is 7330.50. "0,75" is 0.75.
Return every number already converted to a plain JSON number. For each field ending in "Raw", copy the characters exactly as printed (for example "4.887" or "7.330,50"), so the conversion can be checked by code. A number that is not printed is null; text that is not printed (including a "Raw" field or a date) is an empty string "". Do not calculate, correct or fill in anything that is not on the page.`;

export const PACKING_PROMPT = `This PDF is a packing list from Pistoni SRL (Italy) for a shipment of toeclips (knitted nylon stocking offcuts) to Enviroware Ltd. It is usually titled like "PACKING LIST TOECLIPS, SHIPMENT N. 43" and has two side-by-side tables, WHITE and COLORED, each with the columns N. (bale number) and KG.

Extract:
- shipmentNumber: the number after "SHIPMENT N." in the title.
- bales: one entry per bale row across BOTH tables, in the order printed. n is the bale number, kg its weight, kgRaw the weight exactly as printed, colour "white" if the row sits in the WHITE table and "coloured" if it sits in the COLORED table. Bale numbers run 1 to N across both tables and each bale appears in exactly one table. Skip blank spacer rows and total rows. Never invent, merge or re-number a bale.
- whiteTotalKg / colouredTotalKg: the total printed for each table.
- totalPackages: the total number of packages (bales / colli) if printed.
- notes: anything unclear on the page (smudged digits, a row you could not read, an extra table). Empty string if nothing.

${NUMBER_RULE}`;

export const PROFORMA_PROMPT = `This PDF is a proforma invoice from Pistoni SRL (Italy) to Enviroware Ltd for toeclips (knitted nylon stocking offcuts). Headings are in Italian.

Extract:
- documentNumber: Pistoni's own document number (e.g. "23"), printed next to "N." / "Numero" / "Proforma n.". Never the shipment number, and never a VAT, GST or tax number (Enviroware's GST no. 129-544-112 is printed in the customer block; Pistoni's P.IVA is theirs): those are not document numbers. Use an empty string if you cannot find it.
- documentDate: the document date as YYYY-MM-DD; documentDateRaw as printed (dates are dd/mm/yyyy).
- currency: three-letter code of the invoice currency (e.g. EUR).
- lines: each goods line in order. description verbatim; colour "white" for white / bianco goods, "coloured" for coloured / colored / colorato goods, otherwise "unknown"; kg, unitPrice and amount with their raw printed strings. Do not include totals, VAT or transport rows as lines.
- netWeightKg: the total net weight (peso netto) printed on the invoice.
- total: the total amount of the invoice.
- destination: the destination of the goods as printed. deliveryTerms: the delivery terms (resa) as printed. hsCode: the customs tariff code if printed.
- notes: anything unclear. Empty string if nothing.

${NUMBER_RULE}`;

export const JPS_PROMPT = `This PDF is an invoice from JPS Enterprise (Dhaka, Bangladesh) to Enviroware Ltd for an import shipment of knitted nylon stocking material (toeclips), often titled "Sales Proform Invoice". It is usually priced per kg in USD and covers the LC deposit plus handling and sorting.

Extract:
- invoiceNumber: JPS's invoice number exactly as printed.
- invoiceDate: the invoice date as YYYY-MM-DD; invoiceDateRaw as printed.
- currency: three-letter code of the invoice currency (e.g. USD).
- lines: each charge line in order: description verbatim, kg (quantity in kg if the line has one), unitPrice (price per kg if printed), amount — each with its raw printed string. Do not include subtotal or total rows as lines.
- netWeightKg: the total net weight in kg if printed.
- total: the total amount payable.
- lastShipmentDate and expiryDate: the last date of shipment and the expiry date from the terms, as YYYY-MM-DD (dates are day/month/year).
- containers: the container size as printed (e.g. "1 x 40' FCL and 1 x 20' GP").
- notes: anything unclear. Empty string if nothing.

Numbers are printed in standard English format: a comma separates thousands and a dot marks decimals ("32,815.30" is 32815.30).
Return every number as a plain JSON number. For each field ending in "Raw", copy the characters exactly as printed so the conversion can be checked by code. A number that is not printed is null; text that is not printed (including a "Raw" field or a date) is an empty string "". Do not calculate, correct or fill in anything that is not on the page.`;

// A failed read in plain words (shown on the page); the service's own reply
// is kept as `detail` (behind Details and in the activity log).
export class ReadError extends Error {
    constructor(message, detail) { super(message); this.name = 'ReadError'; this.detail = detail || null; }
}
export function readFailure(status, message) {
    const m = String(message || '');
    if (status === 401 || status === 403) return "The AI key isn't accepted — check ANTHROPIC_API_KEY in Cloudflare Pages";
    if (status === 429 || status === 529 || /overloaded|rate.?limit/i.test(m)) return 'The reading service is busy — try again in a minute';
    if (status === 413 || /too large|too long|too many pages/i.test(m)) return 'The PDF is too large to read — try a smaller copy';
    if (status >= 500) return 'The reading service had a problem — try again';
    return 'The reading service refused the request';
}

// The fields a schema asks for, as a JSON skeleton for the plain-mode prompt.
function outline(schema) {
    if (schema.anyOf) return outline(schema.anyOf.find(x => x.type !== 'null') || {}) + ' or null';
    if (schema.type === 'object') return '{ ' + Object.entries(schema.properties).map(([k, v]) => `"${k}": ${outline(v)}`).join(', ') + ' }';
    if (schema.type === 'array') return '[ ' + outline(schema.items) + ', … ]';
    if (schema.enum) return schema.enum.map(e => `"${e}"`).join(' | ');
    return schema.type;
}
const SCHEMA_REFUSED = /schema|union|anyOf|output_config|json_schema|structured output/i;

// Structured outputs first. If the service refuses the schema itself (as it
// did on 17 Nov 2026 over the number of nullable fields), read once more in
// plain mode — the same prompt plus the field list, JSON parsed from the text.
// The checks on the review screen guard both the same way.
export async function extractSupplierDoc(env, { kind, data, mediaType = 'application/pdf' }) {
    if (!env.ANTHROPIC_API_KEY) throw new ReadError("The AI key isn't set up — add ANTHROPIC_API_KEY in Cloudflare Pages", 'ANTHROPIC_API_KEY not configured');
    const isPacking = kind === 'packingList';
    const schema = isPacking ? PACKING_SCHEMA : kind === 'jpsInvoice' ? JPS_SCHEMA : PROFORMA_SCHEMA;
    const prompt = isPacking ? PACKING_PROMPT : kind === 'jpsInvoice' ? JPS_PROMPT : PROFORMA_PROMPT;
    const send = structured => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 16000,
            ...(structured && { output_config: { format: { type: 'json_schema', schema } } }),
            messages: [{
                role: 'user',
                content: [
                    { type: 'document', source: { type: 'base64', media_type: mediaType, data } },
                    { type: 'text', text: structured ? prompt : `${prompt}\n\nReturn only one JSON object, no other text, with exactly these fields:\n${outline(schema)}` },
                ],
            }],
        }),
    });
    const failure = async res => {
        const err = await res.json().catch(() => ({}));
        return { status: res.status, message: err.error?.message || res.statusText || '' };
    };
    let mode = 'structured';
    let res = await send(true);
    if (!res.ok) {
        const f = await failure(res);
        if (!(f.status === 400 && SCHEMA_REFUSED.test(f.message))) throw new ReadError(readFailure(f.status, f.message), `Anthropic ${f.status}: ${f.message}`);
        mode = 'plain';
        res = await send(false);
        if (!res.ok) {
            const g = await failure(res);
            throw new ReadError(readFailure(g.status, g.message), `Anthropic ${g.status}: ${g.message} (after the strict format was refused: ${f.message})`);
        }
    }
    const result = await res.json();
    if (result.stop_reason === 'refusal') throw new ReadError('The AI declined to read this document', 'stop_reason: refusal');
    if (result.stop_reason === 'max_tokens') throw new ReadError('The document was too long to read in one go', 'stop_reason: max_tokens');
    const text = (result.content || []).find(b => b.type === 'text')?.text || '';
    let fields;
    try {
        fields = JSON.parse(mode === 'plain' ? (text.match(/\{[\s\S]*\}/) || [''])[0] : text);
    } catch {
        throw new ReadError("The AI's answer wasn't readable — try again", 'Not JSON: ' + text.slice(0, 200));
    }
    return { fields, model: result.model || MODEL, stopReason: result.stop_reason, usage: result.usage || null, mode };
}
