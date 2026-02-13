import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { parsePositiveInt } from "../core/utils.js";
const describeInputSchema = z.strictObject({
    operationId: z.string().min(1),
});
const searchOperationsInputSchema = z.strictObject({
    query: z.string(),
    limit: z.number().int().positive().max(200).optional(),
});
const callInputSchema = z.strictObject({
    operationId: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
});
const callAllInputSchema = z.strictObject({
    operationId: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
    limit: z.number().int().positive().optional(),
    maxPages: z.number().int().positive().optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
});
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
        inputSchema: describeInputSchema,
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
        inputSchema: searchOperationsInputSchema,
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
        inputSchema: callInputSchema,
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
        },
    }, async ({ operationId, params, body }) => {
        try {
            const result = await core.call({ operationId, params, body });
            return toMcpOkResult(result);
        }
        catch (error) {
            return toMcpErrorResult(core, error);
        }
    });
    server.registerTool("genesys.callAll", {
        description: "Execute deterministic paginated operation call with audit output.",
        inputSchema: callAllInputSchema,
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
        },
    }, async ({ operationId, params, body, limit, maxPages, maxRuntimeMs }) => {
        try {
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
    const sessions = new Map();
    function scheduleSessionTimeout(sessionId, state) {
        state.expiresAt = Date.now() + core.config.mcpSessionTtlMs;
        if (state.timeout) {
            clearTimeout(state.timeout);
        }
        state.timeout = setTimeout(() => {
            void closeSession(sessionId);
        }, core.config.mcpSessionTtlMs);
        state.timeout.unref();
    }
    function createSessionState(sessionId, server, transport) {
        const state = {
            sessionId,
            server,
            transport,
            expiresAt: 0,
            timeout: null,
            closing: false,
        };
        scheduleSessionTimeout(sessionId, state);
        return state;
    }
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
    async function closeSessionState(state, closeTransport) {
        if (state.closing) {
            return;
        }
        state.closing = true;
        sessions.delete(state.sessionId);
        if (state.timeout) {
            clearTimeout(state.timeout);
            state.timeout = null;
        }
        if (closeTransport) {
            await state.transport.close().catch(() => undefined);
        }
        await state.server.close().catch(() => undefined);
    }
    async function closeSession(sessionId) {
        const state = sessions.get(sessionId);
        if (!state)
            return;
        await closeSessionState(state, true);
    }
    function writeJsonRpcError(res, code, mapped) {
        if (res.headersSent)
            return;
        res.status(mapped.status).json({
            jsonrpc: "2.0",
            error: { code, message: mapped.message, data: core.redactForLog(mapped.details) },
            id: null,
        });
    }
    app.post(core.config.mcpPath, async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const sessionId = String(req.header("mcp-session-id") || "").trim();
            if (sessionId) {
                const state = sessions.get(sessionId);
                if (!state) {
                    writeJsonRpcError(res, -32001, { status: 404, message: `Unknown MCP session '${sessionId}'.` });
                    return;
                }
                scheduleSessionTimeout(sessionId, state);
                await state.transport.handleRequest(req, res, req.body);
                return;
            }
            if (!isInitializeRequest(req.body)) {
                writeJsonRpcError(res, -32000, { status: 400, message: "Missing mcp-session-id header for non-initialize request." });
                return;
            }
            if (sessions.size >= core.config.mcpMaxSessions) {
                writeJsonRpcError(res, -32004, {
                    status: 429,
                    message: `MCP session limit reached (${core.config.mcpMaxSessions}).`,
                });
                return;
            }
            const mcpServer = createGenesysMcpServer(core);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                    sessions.set(newSessionId, createSessionState(newSessionId, mcpServer, transport));
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (!sid)
                    return;
                const state = sessions.get(sid);
                if (!state)
                    return;
                void closeSessionState(state, false);
            };
            try {
                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
            }
            catch (error) {
                await transport.close().catch(() => undefined);
                await mcpServer.close().catch(() => undefined);
                throw error;
            }
        }
        catch (error) {
            const mapped = core.mapErrorToHttp(error);
            writeJsonRpcError(res, -32603, mapped);
        }
    });
    app.get(core.config.mcpPath, async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const sessionId = String(req.header("mcp-session-id") || "").trim();
            if (!sessionId) {
                writeJsonRpcError(res, -32000, { status: 400, message: "Missing mcp-session-id header." });
                return;
            }
            const state = sessions.get(sessionId);
            if (!state) {
                writeJsonRpcError(res, -32001, { status: 404, message: `Unknown MCP session '${sessionId}'.` });
                return;
            }
            scheduleSessionTimeout(sessionId, state);
            await state.transport.handleRequest(req, res);
        }
        catch (error) {
            writeJsonRpcError(res, -32603, core.mapErrorToHttp(error));
        }
    });
    app.delete(core.config.mcpPath, async (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const sessionId = String(req.header("mcp-session-id") || "").trim();
            if (!sessionId) {
                writeJsonRpcError(res, -32000, { status: 400, message: "Missing mcp-session-id header." });
                return;
            }
            const state = sessions.get(sessionId);
            if (!state) {
                writeJsonRpcError(res, -32001, { status: 404, message: `Unknown MCP session '${sessionId}'.` });
                return;
            }
            await state.transport.handleRequest(req, res);
            await closeSession(sessionId);
        }
        catch (error) {
            writeJsonRpcError(res, -32603, core.mapErrorToHttp(error));
        }
    });
    app.get(core.config.healthPath, (_req, res) => {
        res.json({
            ok: true,
            transport: "mcp-streamable-http",
            mcpPath: core.config.mcpPath,
            legacyHttpApi: core.config.legacyHttpApi,
            activeSessions: sessions.size,
            maxSessions: core.config.mcpMaxSessions,
            sessionTtlMs: core.config.mcpSessionTtlMs,
        });
    });
    return app;
}
export function parseMcpToolInput(raw) {
    const parsed = callAllInputSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(parsed.error.message);
    }
    return {
        operationId: parsed.data.operationId,
        params: parsed.data.params ?? {},
        body: parsed.data.body ?? null,
        limit: parsePositiveInt(parsed.data.limit, "limit"),
        maxPages: parsePositiveInt(parsed.data.maxPages, "maxPages"),
        maxRuntimeMs: parsePositiveInt(parsed.data.maxRuntimeMs, "maxRuntimeMs"),
    };
}
