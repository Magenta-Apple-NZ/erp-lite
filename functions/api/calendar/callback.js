export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
        return Response.redirect('https://hub.primetie.co.nz/#calendar?gcal_error=' + encodeURIComponent(error), 302);
    }
    if (!code) {
        return new Response('Missing authorisation code', { status: 400 });
    }

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: env.GCAL_CLIENT_ID,
            client_secret: env.GCAL_CLIENT_SECRET,
            redirect_uri: 'https://hub.primetie.co.nz/api/calendar/callback',
            grant_type: 'authorization_code',
        }),
    });

    if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return new Response('Token exchange failed: ' + err, { status: 500 });
    }

    const tokens = await tokenResp.json();
    tokens.stored_at = Date.now();

    await env.XERO_KV.put('gcal:tokens', JSON.stringify(tokens));

    return Response.redirect('https://hub.primetie.co.nz/#calendar', 302);
}
