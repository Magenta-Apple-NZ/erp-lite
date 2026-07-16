import { jsonResponse, errResponse } from '../_xero.js';

async function loadIndex(env) {
    const raw = await env.ORDERS_KV.get('lc_index');
    return raw ? JSON.parse(raw) : [];
}

export async function onRequestGet({ env }) {
    try {
        const ids = await loadIndex(env);
        const lcs = (await Promise.all(
            ids.map(id => env.ORDERS_KV.get('lc:' + id, { type: 'json' }))
        )).filter(Boolean);
        return jsonResponse({ lcs });
    } catch (e) {
        return errResponse(e.message);
    }
}

export async function onRequestPost({ env, request }) {
    try {
        const body = await request.json();
        const lcNumber = String(body.lcNumber || '').trim();
        if (!lcNumber) return errResponse('lcNumber is required', 400);

        const id = 'lc-' + lcNumber.replace(/[^a-zA-Z0-9]/g, '');

        const existing = await env.ORDERS_KV.get('lc:' + id);
        if (existing) return errResponse('LC with this number already exists', 409);

        const now = new Date().toISOString();
        const lc = {
            id,
            lcNumber,
            shipmentRef:     String(body.shipmentRef || '').trim(),
            status:          'active',
            issuedDate:      String(body.issuedDate || ''),
            expiryDate:      String(body.expiryDate || ''),
            latestShipDate:  String(body.latestShipDate || ''),
            shipmentDate:    String(body.shipmentDate || ''),
            presentationDays: Number(body.presentationDays) || 21,
            amount:           Number(body.amount) || 0,
            currency:         String(body.currency || 'USD'),
            governedBy:       String(body.governedBy || 'UCP 600'),
            beneficiary:      String(body.beneficiary || 'Enviroware Ltd'),
            applicant: {
                name:    String(body.applicantName || ''),
                address: String(body.applicantAddress || ''),
            },
            applicantBank: {
                name:  String(body.applicantBankName || ''),
                city:  String(body.applicantBankCity || ''),
                swift: String(body.applicantBankSwift || ''),
            },
            advisingBank: {
                name: String(body.advisingBankName || 'ANZ Bank NZ'),
                city: String(body.advisingBankCity || 'Wellington'),
            },
            goods: {
                description:  String(body.goodsDescription || ''),
                hsCode:       String(body.hsCode || ''),
                quantity:     Number(body.quantity) || 0,
                quantityUnit: String(body.quantityUnit || 'kg'),
                packageCount: Number(body.packageCount) || 0,
                packageType:  String(body.packageType || 'bales'),
                unitPrice:    Number(body.unitPrice) || 0,
                origin:       String(body.origin || ''),
                container:    String(body.container || ''),
                incoterms:    String(body.incoterms || ''),
            },
            proformaRef:  String(body.proformaRef || ''),
            proformaDate: String(body.proformaDate || ''),
            ports: {
                loading:          String(body.portLoading || ''),
                discharge:        String(body.portDischarge || ''),
                finalDestination: String(body.portFinal || ''),
            },
            f47aConditions: Array.isArray(body.f47aConditions) ? body.f47aConditions : [],
            // Checklist state — persisted separately from generated structure
            docStatus:  {},
            docChecks:  {},
            condChecks: {},
            createdAt:  now,
            updatedAt:  now,
        };

        await env.ORDERS_KV.put('lc:' + id, JSON.stringify(lc));

        const ids = await loadIndex(env);
        if (!ids.includes(id)) {
            ids.unshift(id);
            await env.ORDERS_KV.put('lc_index', JSON.stringify(ids));
        }

        return jsonResponse({ id, ...lc }, 201);
    } catch (e) {
        return errResponse(e.message);
    }
}
