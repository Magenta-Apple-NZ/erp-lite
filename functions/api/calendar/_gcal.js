// Shared Google Calendar reader for Pages Functions.
// Tokens live in XERO_KV under 'gcal:tokens' (written by calendar/callback.js).
// `loadGcalEvents` returns the raw Google event items, or null when the
// calendar is not connected or the fetch fails — callers treat null as
// "no calendar", never as an error.

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

// Returns { ok: true, items } or { ok: false, status, error }.
export async function fetchGcalEvents(env, { timeMin, timeMax }) {
    const raw = await env.XERO_KV.get('gcal:tokens');
    if (!raw) return { ok: false, status: 401, error: 'Not connected' };

    let tokens;
    try { tokens = JSON.parse(raw); } catch {
        return { ok: false, status: 500, error: 'Corrupt token store' };
    }

    try { tokens = await refreshIfNeeded(tokens, env); } catch (e) {
        return { ok: false, status: 401, error: e.message };
    }

    const gcalUrl = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    gcalUrl.searchParams.set('timeMin', timeMin);
    gcalUrl.searchParams.set('timeMax', timeMax);
    gcalUrl.searchParams.set('singleEvents', 'true');
    gcalUrl.searchParams.set('orderBy', 'startTime');
    gcalUrl.searchParams.set('maxResults', '500');

    const evResp = await fetch(gcalUrl.toString(), {
        headers: { Authorization: 'Bearer ' + tokens.access_token },
    });
    if (!evResp.ok) return { ok: false, status: evResp.status, error: 'Calendar fetch failed' };

    const data = await evResp.json();
    return { ok: true, items: data.items || [] };
}

// Convenience for background consumers: items[] or null, never throws.
export async function loadGcalEvents(env, range) {
    try {
        const r = await fetchGcalEvents(env, range);
        return r.ok ? r.items : null;
    } catch {
        return null;
    }
}
