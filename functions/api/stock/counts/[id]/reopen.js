// POST /api/stock/counts/:id/reopen — turn a committed count back into a
// draft so an older entry can be corrected, then re-committed. The counted
// figures (and per-shipment sub-count) are kept; the frozen expected /
// variance / valuation snapshots are cleared and recomputed on re-commit.
// While reopened the count no longer acts as a baseline.

import { jsonResponse, errResponse } from '../../../_xero.js';
import { loadCount, saveCount, whoami } from '../../_store.js';

export async function onRequestPost({ env, params, request }) {
    try {
        const count = await loadCount(env, params.id);
        if (!count) return errResponse('Count not found', 404);
        if (count.status !== 'committed') return errResponse('Only a committed count can be reopened', 409);
        const reopened = {
            ...count,
            status: 'draft',
            reopenedAt: new Date().toISOString(),
            reopenedBy: whoami(request),
            previouslyCommittedAt: count.committedAt || null,
            committedAt: null, committedBy: null,
            lines: (count.lines || []).map(l => ({ ...l, expectedQty: null, varianceQty: null, variancePct: null, unitValue: null, accountCode: null })),
        };
        await saveCount(env, reopened);
        return jsonResponse(reopened);
    } catch (e) {
        return errResponse(e.message);
    }
}
