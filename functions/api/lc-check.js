function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
function errResponse(msg, status = 500) {
    return jsonResponse({ error: msg }, status);
}

export async function onRequestPost({ env, request }) {
    let step = 'init';
    try {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return errResponse('ANTHROPIC_API_KEY not configured', 500);

        step = 'parse-request';
        const body = await request.json();
        const { docType, docTitle, checks, data: base64, mediaType = 'application/pdf' } = body;
        if (!base64) return errResponse('No document data', 400);
        if (!checks?.length) return errResponse('No checks provided', 400);

        const checkList = checks.map((c, i) => `${i + 1}. [${c.id}] ${c.text}`).join('\n');

        const prompt = `You are checking a ${docTitle || docType} against LC requirements.

Check each requirement below against the uploaded document. Return ONLY a JSON array:

[
  {"checkId": "id-from-list", "pass": true or false, "note": "brief note — what you found or what is missing/wrong"}
]

Requirements to check:
${checkList}

Rules:
- check every item in the list
- pass: true only if the document clearly satisfies the requirement
- pass: false if the requirement cannot be verified or is clearly not met
- note: one short sentence — quote the relevant text if helpful
- return ONLY the JSON array, no other text`;

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
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 2048,
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
        const text = result.content?.[0]?.text?.trim() || '';
        const match = text.match(/\[[\s\S]*\]/);
        if (!match) return errResponse('No JSON array in model response: ' + text.slice(0, 200), 500);
        const results = JSON.parse(match[0]);
        return jsonResponse({ ok: true, results });

    } catch (e) {
        return errResponse(`[${step}] ${e.message || String(e)}`, 500);
    }
}
