export async function onRequestGet() {
    return new Response(JSON.stringify({ ok: true, fn: 'lc-extract', method: 'GET' }), {
        headers: { 'Content-Type': 'application/json' },
    });
}

export async function onRequestPost({ env, request }) {
    try {
        const hasKey = !!env.ANTHROPIC_API_KEY;
        const contentType = request.headers.get('content-type') || '';
        let dataLength = 0;
        try {
            const body = await request.json();
            dataLength = body?.data?.length ?? -1;
        } catch (parseErr) {
            return new Response(JSON.stringify({ ok: false, step: 'parse', error: parseErr.message, contentType }), {
                status: 400, headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ ok: true, hasKey, dataLength, contentType }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' },
        });
    }
}
