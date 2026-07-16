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

        const prompt = `You are checking a ${docTitle || docType} against LC (Letter of Credit) requirements. Be strict — any deviation, however small, must be flagged.

Check each requirement below against the uploaded document. Return ONLY a JSON array:

[
  {"checkId": "id-from-list", "result": "pass", "note": "brief note — what you found or what is missing/wrong"}
]

Requirements to check:
${checkList}

Rules:
- result must be exactly one of: "pass", "flag", or "fail"
- "pass" — the document clearly and exactly satisfies the requirement, with no discrepancies
- "flag" — the requirement is partially met but has a minor issue: misspelling, slightly different wording, near-match, ambiguous phrasing, or any detail not exactly matching the LC text. When in doubt, flag rather than pass.
- "fail" — the requirement is not met: content is missing, clearly wrong, or cannot be verified from the document
- note: one short sentence — quote the relevant text from the document if helpful, or state what is missing/wrong
- check every item in the list
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
        // Normalise: if model still returns old {pass: bool} shape, convert
        const normalised = results.map(r => ({
            ...r,
            result: r.result || (r.pass === true ? 'pass' : r.pass === false ? 'fail' : 'fail'),
        }));
        return jsonResponse({ ok: true, results: normalised });

    } catch (e) {
        return errResponse(`[${step}] ${e.message || String(e)}`, 500);
    }
}
