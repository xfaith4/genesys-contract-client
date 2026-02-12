import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { ensureObject, parsePositiveInt, toNonEmptyString } from "../core/utils.js";
function toMcpErrorResult(core, error) {
    const mapped = core.mapErrorToHttp(error);
    return {
        isError: true,
        content: [{ type: "text", text: `${mapped.status}: ${mapped.message}` }],
        structuredContent: {
            error: mapped.message,
            status: mapped.status,
            details: core.redactForLog(mapped.details),
        },
    };
}
function toMcpOkResult(payload) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
    };
}
function createGenesysMcpServer(core) {
    const server = new McpServer({
        name: "genesys-contract-client",
        version: "0.2.0",
    }, {
        capabilities: {
            logging: {},
        },
    });
    server.registerTool("genesys.describe", {
        description: "Describe operation contract, paging metadata, and governance policy.",
        inputSchema: {
            operationId: z.string().min(1),
        },
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    }, async ({ operationId }) => {
        try {
            const result = await core.describe({ operationId });
            return toMcpOkResult(result);
        }
        catch (error) {
            return toMcpErrorResult(core, error);
        }
    });
    server.registerTool("genesys.searchOperations", {
        description: "Search operation catalog by query/method/tag.",
        inputSchema: {
            query: z.string(),
            limit: z.number().int().positive().max(200).optional(),
        },
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    }, async ({ query, limit }) => {
        try {
            const result = core.searchOperations({ query, limit });
            return toMcpOkResult(result);
        }
        catch (error) {
            return toMcpErrorResult(core, error);
        }
    });
    server.registerTool("genesys.call", {
        description: "Execute one contract-validated Genesys operation.",
        inputSchema: {
            operationId: z.string().min(1),
            params: z.record(z.string(), z.unknown()).optional(),
            body: z.record(z.string(), z.unknown()).optional(),
        },
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
        },
    }, async ({ operationId, params, body }) => {
        try {
            if (core.config.logRequestPayloads) {
                const summary = core.summarizeRequest(operationId, params, body);
                console.log(JSON.stringify({ event: "mcp.tool.call.request", operationId, summary }));
            }
            const result = await core.call({ operationId, params, body });
            return toMcpOkResult(result);
        }
        catch (error) {
            return toMcpErrorResult(core, error);
        }
    });
    server.registerTool("genesys.callAll", {
        description: "Execute deterministic paginated operation call with audit output.",
        inputSchema: {
            operationId: z.string().min(1),
            params: z.record(z.string(), z.unknown()).optional(),
            body: z.record(z.string(), z.unknown()).optional(),
            limit: z.number().int().positive().optional(),
            maxPages: z.number().int().positive().optional(),
            maxRuntimeMs: z.number().int().positive().optional(),
        },
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
        },
    }, async ({ operationId, params, body, limit, maxPages, maxRuntimeMs }) => {
        try {
            if (core.config.logRequestPayloads) {
                const summary = core.summarizeRequest(operationId, params, body);
                console.log(JSON.stringify({ event: "mcp.tool.callAll.request", operationId, limit, maxPages, maxRuntimeMs, summary }));
            }
            const result = await core.callAll({ operationId, params, body, limit, maxPages, maxRuntimeMs, includeItems: true });
            return toMcpOkResult(result);
        }
        catch (error) {
            return toMcpErrorResult(core, error);
        }
    });
    return server;
}
export function createMcpApp(core) {
    const app = createMcpExpressApp({ host: core.config.host });
    app.disable("x-powered-by");
    app.use((req, res, next) => {
        const supplied = String(req.header("x-request-id") || "").trim();
        req.requestId = supplied || randomUUID();
        res.setHeader("x-request-id", req.requestId);
        next();
    });
    app.use((req, res, next) => {
        const startedAt = Date.now();
        res.on("finish", () => {
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: "info",
                event: "http.request",
                requestId: req.requestId ?? "",
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs: Date.now() - startedAt,
            }));
        });
        next();
    });
    app.post(core.config.mcpPath, async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const mcpServer = createGenesysMcpServer(core);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
            res.on("close", () => {
                void transport.close();
                void mcpServer.close();
            });
        }
        catch (error) {
            const mapped = core.mapErrorToHttp(error);
            if (!res.headersSent) {
                res.status(mapped.status).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: mapped.message, data: core.redactForLog(mapped.details) },
                    id: null,
                });
            }
        }
    });
    app.get(core.config.mcpPath, (_req, res) => {
        res.status(405).set("Allow", "POST").send("Method Not Allowed");
    });
    app.delete(core.config.mcpPath, (_req, res) => {
        res.status(405).set("Allow", "POST").send("Method Not Allowed");
    });
    app.get(core.config.healthPath, (_req, res) => {
        res.json({
            ok: true,
            transport: "mcp-streamable-http",
            mcpPath: core.config.mcpPath,
            legacyHttpApi: core.config.legacyHttpApi,
        });
    });
    return app;
}
export function parseMcpToolInput(raw) {
    const payload = ensureObject(raw, "tool input");
    const operationId = toNonEmptyString(payload.operationId, "operationId");
    const params = payload.params === undefined ? {} : ensureObject(payload.params, "params");
    const body = payload.body ?? null;
    return {
        operationId,
        params,
        body,
        limit: parsePositiveInt(payload.limit, "limit"),
        maxPages: parsePositiveInt(payload.maxPages, "maxPages"),
        maxRuntimeMs: parsePositiveInt(payload.maxRuntimeMs, "maxRuntimeMs"),
    };
}
