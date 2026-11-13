// Minimal MCP server (JSON-RPC 2.0 over Streamable HTTP, stateless, JSON
// responses — no SSE, no sessions). Handles initialize, ping, tools/list and
// tools/call; everything a tools-only server needs. Pure: takes a parsed
// message and a context, returns the response object (or null for a
// notification), so it's testable without HTTP.

import { TOOLS, readOnlyEnv } from './_tools.js';

export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'business-hub', title: 'Prime Ties Business Hub', version: '1.0.0' };

const INSTRUCTIONS = `Read-only access to the Prime Ties / Enviroware Business Hub (a mini-ERP for a two-person NZ business selling Prime Tie bale ties).
- Orders flow New → Reviewed → Sent to Xero → Complete (dispatched); "paid" comes from Xero. Prices are NZD ex GST.
- Products are measured in kg: Prime Tie Bundled ("bundles") is the active line, sold in 10kg boxes and 1kg bags. Loose and eco Ties are parked.
- All dates are Pacific/Auckland calendar dates (YYYY-MM-DD); the NZ financial year runs April–March.
- Stock is derived (last committed count + shipments − sales), never stored; ask stock_item_ledger to explain a number.
- A shipment starts with its export documents: Pistoni's packing list and proforma become Enviroware's packing list and proforma invoice to JPS (shipment_export_docs). Supplier EUR prices are internal and never printed on those documents.
- Nothing here can create, change, print or send anything.`;

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError  = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined && { data }) } });

function negotiate(requested) {
    return SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
}

// ctx: { env, user }
export async function handleMessage(msg, ctx) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return rpcError(msg?.id, -32600, 'Invalid Request');
    }
    const isNotification = msg.id === undefined;
    if (isNotification) return null; // notifications/initialized, cancelled, … need no reply

    const { id, method, params = {} } = msg;
    switch (method) {
        case 'initialize':
            return rpcResult(id, {
                protocolVersion: negotiate(params.protocolVersion),
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
                instructions: INSTRUCTIONS,
            });
        case 'ping':
            return rpcResult(id, {});
        case 'tools/list':
            return rpcResult(id, {
                tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
            });
        case 'tools/call': {
            const tool = TOOLS.find(t => t.name === params.name);
            if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
            const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
            try {
                const data = await tool.run(args, { env: readOnlyEnv(ctx.env), user: ctx.user });
                return rpcResult(id, {
                    content: [{ type: 'text', text: JSON.stringify(data, null, 1) }],
                    structuredContent: data,
                });
            } catch (e) {
                // Tool failures are results the model can read, not protocol errors.
                return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + (e.message || String(e)) }], isError: true });
            }
        }
        default:
            return rpcError(id, -32601, `Method not found: ${method}`);
    }
}
