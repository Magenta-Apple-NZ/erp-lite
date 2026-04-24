export async function onRequestGet(context) {
    const { env } = context;

    const raw = await env.XERO_KV.get('gcal:tokens');
    if (!raw) {
        return Response.json({ connected: false });
    }

    let tokens;
    try { tokens = JSON.parse(raw); } catch { return Response.json({ connected: false }); }

    return Response.json({ connected: !!tokens.refresh_token });
}
