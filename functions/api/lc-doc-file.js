// GET /api/lc-doc-file?key=xxx&filename=document.pdf
// Serves an archived LC document PDF from KV
export async function onRequestGet({ env, request }) {
    try {
        const url = new URL(request.url);
        const key = url.searchParams.get('key');
        const filename = (url.searchParams.get('filename') || 'document.pdf').replace(/"/g, '');
        if (!key) return new Response('key required', { status: 400 });

        const base64 = await env.ORDERS_KV.get('lc-doc:' + key);
        if (!base64) return new Response('Not found', { status: 404 });

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        return new Response(bytes, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="${filename}"`,
                'Cache-Control': 'private, max-age=3600',
            },
        });
    } catch (e) {
        return new Response(e.message, { status: 500 });
    }
}
