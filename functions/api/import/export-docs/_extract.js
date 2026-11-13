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

export const PACKING_SCHEMA = obj({
    shipmentNumber: nint,
    shipmentNumberRaw: nstr,
    bales: {
        type: 'array',
        items: obj({ n: { type: 'integer' }, kg: { type: 'number' }, kgRaw: str, colour: { type: 'string', enum: ['white', 'coloured'] } }),
    },
    whiteTotalKg: nnum, whiteTotalRaw: nstr,
    colouredTotalKg: nnum, colouredTotalRaw: nstr,
    totalPackages: nint, totalPackagesRaw: nstr,
    notes: str,
});

export const PROFORMA_SCHEMA = obj({
    documentNumber: nstr,
    documentDate: nstr,
    documentDateRaw: nstr,
    currency: nstr,
    lines: {
        type: 'array',
        items: obj({
            description: str,
            colour: { type: 'string', enum: ['white', 'coloured', 'unknown'] },
            kg: nnum, kgRaw: nstr,
            unitPrice: nnum, unitPriceRaw: nstr,
            amount: nnum, amountRaw: nstr,
        }),
    },
    netWeightKg: nnum, netWeightRaw: nstr,
    total: nnum, totalRaw: nstr,
    destination: nstr,
    deliveryTerms: nstr,
    hsCode: nstr,
    notes: str,
});

export const JPS_SCHEMA = obj({
    invoiceNumber: nstr,
    invoiceDate: nstr,
    invoiceDateRaw: nstr,
    currency: nstr,
    lines: {
        type: 'array',
        items: obj({ description: str, kg: nnum, kgRaw: nstr, unitPrice: nnum, unitPriceRaw: nstr, amount: nnum, amountRaw: nstr }),
    },
    netWeightKg: nnum, netWeightRaw: nstr,
    total: nnum, totalRaw: nstr,
    notes: str,
});

const NUMBER_RULE = `Numbers are printed in Italian format: a dot separates thousands and a comma marks decimals.
"4.887" is four thousand eight hundred and eighty-seven (4887), never 4.887. "7.330,50" is 7330.50. "0,75" is 0.75.
Return every number already converted to a plain JSON number. For each field ending in "Raw", copy the characters exactly as printed (for example "4.887" or "7.330,50"), so the conversion can be checked by code. Use null when something is not printed. Do not calculate, correct or fill in anything that is not on the page.`;

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
- documentNumber: Pistoni's own document number (e.g. "23"). This is not the shipment number.
- documentDate: the document date as YYYY-MM-DD; documentDateRaw as printed (dates are dd/mm/yyyy).
- currency: three-letter code of the invoice currency (e.g. EUR).
- lines: each goods line in order. description verbatim; colour "white" for white / bianco goods, "coloured" for coloured / colored / colorato goods, otherwise "unknown"; kg, unitPrice and amount with their raw printed strings. Do not include totals, VAT or transport rows as lines.
- netWeightKg: the total net weight (peso netto) printed on the invoice.
- total: the total amount of the invoice.
- destination: the destination of the goods as printed. deliveryTerms: the delivery terms (resa) as printed. hsCode: the customs tariff code if printed.
- notes: anything unclear. Empty string if nothing.

${NUMBER_RULE}`;

export const JPS_PROMPT = `This PDF is an invoice from JPS Enterprise (Dhaka, Bangladesh) to Enviroware Ltd for an import shipment of knitted nylon stocking material (toeclips). It is usually priced per kg in USD and covers the LC deposit plus handling and sorting.

Extract:
- invoiceNumber: JPS's invoice number exactly as printed.
- invoiceDate: the invoice date as YYYY-MM-DD; invoiceDateRaw as printed.
- currency: three-letter code of the invoice currency (e.g. USD).
- lines: each charge line in order: description verbatim, kg (quantity in kg if the line has one), unitPrice (price per kg if printed), amount — each with its raw printed string. Do not include subtotal or total rows as lines.
- netWeightKg: the total net weight in kg if printed.
- total: the total amount payable.
- notes: anything unclear. Empty string if nothing.

Numbers are printed in standard English format: a comma separates thousands and a dot marks decimals ("32,815.30" is 32815.30).
Return every number as a plain JSON number. For each field ending in "Raw", copy the characters exactly as printed so the conversion can be checked by code. Use null when something is not printed. Do not calculate, correct or fill in anything that is not on the page.`;

export async function extractSupplierDoc(env, { kind, data, mediaType = 'application/pdf' }) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
    const isPacking = kind === 'packingList';
    const schema = isPacking ? PACKING_SCHEMA : kind === 'jpsInvoice' ? JPS_SCHEMA : PROFORMA_SCHEMA;
    const prompt = isPacking ? PACKING_PROMPT : kind === 'jpsInvoice' ? JPS_PROMPT : PROFORMA_PROMPT;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: 16000,
            output_config: { format: { type: 'json_schema', schema } },
            messages: [{
                role: 'user',
                content: [
                    { type: 'document', source: { type: 'base64', media_type: mediaType, data } },
                    { type: 'text', text: prompt },
                ],
            }],
        }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error('Anthropic ' + res.status + ': ' + (err.error?.message || res.statusText));
    }
    const result = await res.json();
    if (result.stop_reason === 'refusal') throw new Error('The model declined to read this document');
    if (result.stop_reason === 'max_tokens') throw new Error('The extraction was cut off (max_tokens) — the document may be larger than expected');
    const text = (result.content || []).find(b => b.type === 'text')?.text || '';
    let fields;
    try { fields = JSON.parse(text); } catch { throw new Error('Model did not return JSON: ' + text.slice(0, 200)); }
    return { fields, model: result.model || MODEL, stopReason: result.stop_reason, usage: result.usage || null };
}
