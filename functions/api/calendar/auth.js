export async function onRequestGet(context) {
    const { env } = context;
    const clientId = env.GCAL_CLIENT_ID;

    if (!clientId) {
        return new Response('GCAL_CLIENT_ID not configured', { status: 500 });
    }

    const redirectUri = 'https://hub.primetie.co.nz/api/calendar/callback';
    const scope = 'https://www.googleapis.com/auth/calendar.readonly';

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scope);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    // ?return=integrations → land back on Settings → Integrations (see callback.js).
    if (new URL(context.request.url).searchParams.get('return') === 'integrations') {
        url.searchParams.set('state', 'integrations');
    }

    return Response.redirect(url.toString(), 302);
}
