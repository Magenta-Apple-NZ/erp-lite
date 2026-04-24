async function refreshIfNeeded(tokens, env) {
    const expiresAt = (tokens.stored_at || 0) + (tokens.expires_in || 3600) * 1000;
    if (Date.now() < expiresAt - 60_000) return tokens;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.GCAL_CLIENT_ID,
            client_secret: env.GCAL_CLIENT_SECRET,
            refresh_token: tokens.refresh_token,
            grant_type: 'refresh_token',
        }),
    });

    if (!resp.ok) throw new Error('Token refresh failed: ' + await resp.text());

    const fresh = await resp.json();
    const updated = { ...tokens, ...fresh, stored_at: Date.now() };
    await env.XERO_KV.put('gcal:tokens', JSON.stringify(updated));
    return updated;
}

export async function onRequestGet(context) {
    const { request, env } = context;

    const raw = await env.XERO_KV.get('gcal:tokens');
    if (!raw) {
        return Response.json({ error: 'Not connected' }, { status: 401 });
    }

    let tokens;
    try { tokens = JSON.parse(raw); } catch {
        return Response.json({ error: 'Corrupt token store' }, { status: 500 });
    }

    try { tokens = await refreshIfNeeded(tokens, env); } catch (e) {
        return Response.json({ error: e.message }, { status: 401 });
    }

    const url = new URL(request.url);
    const now = new Date();
    const timeMin = url.searchParams.get('timeMin') || new Date(now.getFullYear(), 0, 1).toISOString();
    const timeMax = url.searchParams.get('timeMax') || new Date(now.getFullYear(), 11, 31, 23, 59, 59).toISOString();

    const gcalUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    gcalUrl.searchParams.set('timeMin', timeMin);
    gcalUrl.searchParams.set('timeMax', timeMax);
    gcalUrl.searchParams.set('singleEvents', 'true');
    gcalUrl.searchParams.set('orderBy', 'startTime');
    gcalUrl.searchParams.set('maxResults', '500');

    const evResp = await fetch(gcalUrl.toString(), {
        headers: { Authorization: 'Bearer ' + tokens.access_token },
    });

    if (!evResp.ok) {
        return Response.json({ error: 'Calendar fetch failed' }, { status: evResp.status });
    }

    const data = await evResp.json();
    return Response.json(data.items || []);
}
