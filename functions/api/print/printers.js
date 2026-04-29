// GET /api/print/printers
// Lists PrintNode printers visible to the configured API key.
// Used once after setup to discover the printer ID, then add it to env as
// PRINTNODE_PRINTER_ID. Also reports whether the env default is currently set.

import { printNodeHeaders, jsonResponse, errResponse } from './_printnode.js';

export async function onRequestGet({ env }) {
    if (!env.PRINTNODE_API_KEY) {
        return errResponse('PRINTNODE_API_KEY not configured', 500);
    }

    try {
        const resp = await fetch('https://api.printnode.com/printers', {
            headers: printNodeHeaders(env.PRINTNODE_API_KEY),
        });
        if (!resp.ok) {
            const body = await resp.text();
            return errResponse('PrintNode error: ' + body, resp.status);
        }

        const data = await resp.json();
        const printers = data.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            state: p.state,
            computer: p.computer?.name,
            default: p.default,
        }));

        return jsonResponse({
            defaultPrinterId: env.PRINTNODE_PRINTER_ID
                ? Number(env.PRINTNODE_PRINTER_ID)
                : null,
            printers,
        });
    } catch (e) {
        return errResponse(e.message);
    }
}
