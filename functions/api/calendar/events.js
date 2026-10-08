// GET /api/calendar/events?timeMin=&timeMax= — Google Calendar events for the
// connected account. Token refresh and the fetch itself live in _gcal.js so
// the notification feed can read the same calendar.

import { fetchGcalEvents } from './_gcal.js';

export async function onRequestGet(context) {
    const { request, env } = context;

    const url = new URL(request.url);
    const now = new Date();
    const timeMin = url.searchParams.get('timeMin') || new Date(now.getFullYear(), 0, 1).toISOString();
    const timeMax = url.searchParams.get('timeMax') || new Date(now.getFullYear(), 11, 31, 23, 59, 59).toISOString();

    const r = await fetchGcalEvents(env, { timeMin, timeMax });
    if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
    return Response.json(r.items);
}
