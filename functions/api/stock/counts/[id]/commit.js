// POST /api/stock/counts/:id/commit — freeze a draft: snapshot expected /
// variance / valuation onto each line and make it a baseline (§4.3).

import { jsonResponse, errResponse } from '../../../_xero.js';
import { loadCount, saveCount, loadWorld, whoami } from '../../_store.js';
import { commitCount } from '../../_engine.js';

export async function onRequestPost({ env, params, request }) {
    try {
        const count = await loadCount(env, params.id);
        if (!count) return errResponse('Count not found', 404);
        if (count.status === 'committed') return errResponse('Count is already committed', 409);
        const world = await loadWorld(env);
        if (count.date < world.settings.stockEpoch) return errResponse(`Count date is before the stock epoch (${world.settings.stockEpoch})`, 400);
        let committed;
        try {
            committed = commitCount(count, world, { committedAt: new Date().toISOString(), committedBy: whoami(request) });
        } catch (e) {
            const res = errResponse(e.message, 400);
            if (e.missing) return jsonResponse({ error: e.message, missing: e.missing }, 400);
            return res;
        }
        await saveCount(env, committed);
        return jsonResponse(committed);
    } catch (e) {
        return errResponse(e.message);
    }
}
