import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { logInfo, parsePositiveInt } from "../core/utils.js";
import { mapErrorClassToResultStatus, normalizeErrorClass, ObservabilityStore } from "./observability.js";
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
function asRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function parseJsonRpcMetadata(payload) {
    const root = asRecord(payload);
    if (!root)
        return { mcpMethod: "unknown" };
    const mcpMethod = typeof root.method === "string" && root.method.trim() ? root.method.trim() : "unknown";
    const params = asRecord(root.params);
    const metadata = { mcpMethod };
    if (mcpMethod === "tools/call" && params && typeof params.name === "string" && params.name.trim()) {
        metadata.toolName = params.name.trim();
    }
    if (mcpMethod === "initialize" && params) {
        const clientInfo = asRecord(params.clientInfo);
        if (clientInfo) {
            if (typeof clientInfo.name === "string" && clientInfo.name.trim())
                metadata.clientName = clientInfo.name.trim();
            if (typeof clientInfo.version === "string" && clientInfo.version.trim())
                metadata.clientVersion = clientInfo.version.trim();
        }
    }
    return metadata;
}
function summarizeToolArgsShape(toolArgs) {
    const keys = Object.keys(toolArgs).sort((lhs, rhs) => lhs.localeCompare(rhs));
    const valueTypes = {};
    for (const key of keys) {
        const value = toolArgs[key];
        if (Array.isArray(value)) {
            valueTypes[key] = "array";
            continue;
        }
        if (value === null) {
            valueTypes[key] = "null";
            continue;
        }
        valueTypes[key] = typeof value;
    }
    return {
        keys,
        keyCount: keys.length,
        valueTypes,
    };
}
function derivePolicyRuleId(errorMessage) {
    const trimmed = errorMessage.trim();
    if (!trimmed)
        return "policy-deny";
    if (trimmed.length <= 120)
        return trimmed;
    return `${trimmed.slice(0, 117)}...`;
}
function createGenesysMcpServer(core, invokeTool) {
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
    }, ({ operationId }) => invokeTool("genesys.describe", { operationId }, async () => (await core.describe({ operationId }))));
    server.registerTool("genesys.searchOperations", {
        description: "Search operation catalog by query/method/tag.",
        inputSchema: searchOperationsInputSchema,
        annotations: {
            readOnlyHint: true,
            idempotentHint: true,
        },
    }, ({ query, limit }) => invokeTool("genesys.searchOperations", { query, limit }, async () => core.searchOperations({ query, limit })));
    server.registerTool("genesys.call", {
        description: "Execute one contract-validated Genesys operation.",
        inputSchema: callInputSchema,
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
        },
    }, ({ operationId, params, body }) => invokeTool("genesys.call", { operationId, params, body }, async () => (await core.call({ operationId, params, body }))));
    server.registerTool("genesys.callAll", {
        description: "Execute deterministic paginated operation call with audit output.",
        inputSchema: callAllInputSchema,
        annotations: {
            readOnlyHint: false,
            idempotentHint: false,
        },
    }, ({ operationId, params, body, limit, maxPages, maxRuntimeMs }) => invokeTool("genesys.callAll", { operationId, params, body, limit, maxPages, maxRuntimeMs }, async () => (await core.callAll({ operationId, params, body, limit, maxPages, maxRuntimeMs, includeItems: true }))));
    return server;
}
export function createMcpApp(core) {
    const app = createMcpExpressApp({ host: core.config.host });
    const sessions = new Map();
    const observability = new ObservabilityStore();
    const requestContextStorage = new AsyncLocalStorage();
    function scheduleSessionTimeout(sessionId, state) {
        state.expiresAt = Date.now() + core.config.mcpSessionTtlMs;
        if (state.timeout) {
            clearTimeout(state.timeout);
        }
        state.timeout = setTimeout(() => {
            void closeSession(sessionId, "ttl_expired");
        }, core.config.mcpSessionTtlMs);
        state.timeout.unref();
    }
    function touchSession(state) {
        state.lastActivityAtMs = Date.now();
        scheduleSessionTimeout(state.sessionId, state);
    }
    function buildSessionInitMetadata(req, jsonRpcMetadata) {
        const headerClientId = String(req.header("x-client-id") || "").trim();
        const clientName = jsonRpcMetadata.clientName ?? "unknown-client";
        const clientVersion = jsonRpcMetadata.clientVersion ?? "";
        const derivedClientId = `${clientName}${clientVersion ? `@${clientVersion}` : ""}`;
        return {
            remoteAddress: req.ip || req.socket.remoteAddress || "unknown",
            clientId: headerClientId || derivedClientId,
            clientName,
            clientVersion,
            userId: String(req.header("x-user-id") || "").trim(),
            agentName: String(req.header("x-agent-name") || "").trim() ||
                String(req.header("x-copilot-agent") || "").trim() ||
                String(req.header("x-agent") || "").trim(),
            userAgent: String(req.header("user-agent") || "").trim(),
        };
    }
    function createSessionState(sessionId, server, transport, metadata) {
        const now = Date.now();
        const state = {
            sessionId,
            server,
            transport,
            expiresAt: 0,
            timeout: null,
            closing: false,
            openedAtMs: now,
            lastActivityAtMs: now,
            remoteAddress: metadata.remoteAddress,
            clientId: metadata.clientId,
            clientName: metadata.clientName,
            clientVersion: metadata.clientVersion,
            userId: metadata.userId,
            agentName: metadata.agentName,
            userAgent: metadata.userAgent,
            toolCalls: 0,
            toolErrors: 0,
        };
        touchSession(state);
        observability.recordSessionOpened();
        logInfo("mcp.session.opened", {
            sessionId,
            clientId: state.clientId,
            clientName: state.clientName,
            clientVersion: state.clientVersion,
            userId: state.userId || null,
            agentName: state.agentName || null,
            remoteAddress: state.remoteAddress,
        });
        return state;
    }
    function buildRequestContext(req, traceId, jsonRpcMetadata, sessionState) {
        const fallbackClientId = String(req.header("x-client-id") || "").trim() || "unknown-client";
        const fallbackUserId = String(req.header("x-user-id") || "").trim();
        const fallbackAgentName = String(req.header("x-agent-name") || "").trim() ||
            String(req.header("x-copilot-agent") || "").trim() ||
            String(req.header("x-agent") || "").trim();
        const fallbackRemoteAddress = req.ip || req.socket.remoteAddress || "unknown";
        return {
            requestId: req.requestId ?? randomUUID(),
            traceId,
            sessionId: sessionState?.sessionId ?? (String(req.header("mcp-session-id") || "").trim() || "pending"),
            clientId: sessionState?.clientId || fallbackClientId,
            userId: sessionState?.userId || fallbackUserId,
            agentName: sessionState?.agentName || fallbackAgentName,
            mcpMethod: jsonRpcMetadata.mcpMethod,
            toolName: jsonRpcMetadata.toolName,
            remoteAddress: sessionState?.remoteAddress || fallbackRemoteAddress,
        };
    }
    app.disable("x-powered-by");
    app.use((req, res, next) => {
        const suppliedRequestId = String(req.header("x-request-id") || "").trim();
        const suppliedTraceId = String(req.header("x-trace-id") || "").trim();
        req.requestId = suppliedRequestId || randomUUID();
        const traceId = suppliedTraceId || req.requestId;
        res.setHeader("x-request-id", req.requestId);
        res.setHeader("x-trace-id", traceId);
        next();
    });
    app.use((req, res, next) => {
        const startedAt = Date.now();
        res.on("finish", () => {
            const durationMs = Date.now() - startedAt;
            const traceId = String(res.getHeader("x-trace-id") || req.requestId || "");
            observability.recordHttpRequest({
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs,
            });
            logInfo("http.request", {
                traceId,
                requestId: req.requestId ?? "",
                method: req.method,
                path: req.path,
                status: res.statusCode,
                durationMs,
            });
        });
        next();
    });
    async function closeSessionState(state, closeTransport, reason) {
        if (state.closing) {
            return;
        }
        state.closing = true;
        sessions.delete(state.sessionId);
        if (state.timeout) {
            clearTimeout(state.timeout);
            state.timeout = null;
        }
        const sessionDurationMs = Date.now() - state.openedAtMs;
        observability.recordSessionClosed(sessionDurationMs);
        logInfo("mcp.session.closed", {
            sessionId: state.sessionId,
            clientId: state.clientId,
            reason,
            durationMs: sessionDurationMs,
            toolCalls: state.toolCalls,
            toolErrors: state.toolErrors,
        });
        if (closeTransport) {
            await state.transport.close().catch(() => undefined);
        }
        await state.server.close().catch(() => undefined);
    }
    async function closeSession(sessionId, reason) {
        const state = sessions.get(sessionId);
        if (!state)
            return;
        await closeSessionState(state, true, reason);
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
    const invokeTool = async (toolName, toolArgs, execute) => {
        const startedAt = Date.now();
        const context = requestContextStorage.getStore();
        const toolArgsShape = summarizeToolArgsShape(toolArgs);
        try {
            const payload = await execute();
            const durationMs = Date.now() - startedAt;
            const sessionState = context ? sessions.get(context.sessionId) : undefined;
            if (sessionState)
                sessionState.toolCalls += 1;
            observability.recordToolCall({
                mcpMethod: context?.mcpMethod || "tools/call",
                toolName,
                resultStatus: "ok",
                durationMs,
                sessionId: context?.sessionId,
                clientId: context?.clientId,
                requestId: context?.requestId,
                traceId: context?.traceId,
                userId: context?.userId,
                agentName: context?.agentName,
                toolArgsShape,
            });
            logInfo("mcp.tool.call", {
                traceId: context?.traceId ?? null,
                requestId: context?.requestId ?? null,
                sessionId: context?.sessionId ?? null,
                clientId: context?.clientId ?? null,
                userId: context?.userId || null,
                agentName: context?.agentName || null,
                mcpMethod: context?.mcpMethod || "tools/call",
                toolName,
                resultStatus: "ok",
                durationMs,
                toolArgsShape,
            });
            return toMcpOkResult(payload);
        }
        catch (error) {
            const mapped = core.mapErrorToHttp(error);
            const errorClass = normalizeErrorClass(mapped);
            const resultStatus = mapErrorClassToResultStatus(errorClass);
            const policyRuleId = resultStatus === "denied" ? derivePolicyRuleId(mapped.message) : undefined;
            const durationMs = Date.now() - startedAt;
            const sessionState = context ? sessions.get(context.sessionId) : undefined;
            if (sessionState) {
                sessionState.toolCalls += 1;
                sessionState.toolErrors += 1;
            }
            observability.recordToolCall({
                mcpMethod: context?.mcpMethod || "tools/call",
                toolName,
                resultStatus,
                durationMs,
                errorClass,
                policyRuleId,
                sessionId: context?.sessionId,
                clientId: context?.clientId,
                requestId: context?.requestId,
                traceId: context?.traceId,
                userId: context?.userId,
                agentName: context?.agentName,
                toolArgsShape,
            });
            logInfo("mcp.tool.call", {
                traceId: context?.traceId ?? null,
                requestId: context?.requestId ?? null,
                sessionId: context?.sessionId ?? null,
                clientId: context?.clientId ?? null,
                userId: context?.userId || null,
                agentName: context?.agentName || null,
                mcpMethod: context?.mcpMethod || "tools/call",
                toolName,
                resultStatus,
                errorClass,
                status: mapped.status,
                error: mapped.message,
                policyRuleId: policyRuleId ?? null,
                durationMs,
                toolArgsShape,
            });
            return toMcpErrorResult(core, error);
        }
    };
    app.post(core.config.mcpPath, async (req, res) => {
        const traceId = String(res.getHeader("x-trace-id") || req.requestId || "");
        const jsonRpcMetadata = parseJsonRpcMetadata(req.body);
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const sessionId = String(req.header("mcp-session-id") || "").trim();
            if (sessionId) {
                const state = sessions.get(sessionId);
                if (!state) {
                    writeJsonRpcError(res, -32001, { status: 404, message: `Unknown MCP session '${sessionId}'.` });
                    return;
                }
                touchSession(state);
                const requestContext = buildRequestContext(req, traceId, jsonRpcMetadata, state);
                await requestContextStorage.run(requestContext, async () => {
                    await state.transport.handleRequest(req, res, req.body);
                });
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
            const sessionInitMetadata = buildSessionInitMetadata(req, jsonRpcMetadata);
            const mcpServer = createGenesysMcpServer(core, invokeTool);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                    sessions.set(newSessionId, createSessionState(newSessionId, mcpServer, transport, sessionInitMetadata));
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (!sid)
                    return;
                const state = sessions.get(sid);
                if (!state)
                    return;
                void closeSessionState(state, false, "transport_closed");
            };
            try {
                const requestContext = buildRequestContext(req, traceId, jsonRpcMetadata);
                await requestContextStorage.run(requestContext, async () => {
                    await mcpServer.connect(transport);
                    await transport.handleRequest(req, res, req.body);
                });
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
        const traceId = String(res.getHeader("x-trace-id") || req.requestId || "");
        const jsonRpcMetadata = parseJsonRpcMetadata(req.body);
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
            touchSession(state);
            const requestContext = buildRequestContext(req, traceId, jsonRpcMetadata, state);
            await requestContextStorage.run(requestContext, async () => {
                await state.transport.handleRequest(req, res);
            });
        }
        catch (error) {
            writeJsonRpcError(res, -32603, core.mapErrorToHttp(error));
        }
    });
    app.delete(core.config.mcpPath, async (req, res) => {
        const traceId = String(res.getHeader("x-trace-id") || req.requestId || "");
        const jsonRpcMetadata = parseJsonRpcMetadata(req.body);
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
            touchSession(state);
            const requestContext = buildRequestContext(req, traceId, jsonRpcMetadata, state);
            await requestContextStorage.run(requestContext, async () => {
                await state.transport.handleRequest(req, res);
            });
            await closeSession(sessionId, "client_delete");
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
            healthPath: core.config.healthPath,
            readyPath: core.config.readyPath,
            statusPath: core.config.statusPath,
            metricsPath: core.config.metricsPath,
            legacyHttpApi: core.config.legacyHttpApi,
            activeSessions: sessions.size,
            maxSessions: core.config.mcpMaxSessions,
            sessionTtlMs: core.config.mcpSessionTtlMs,
        });
    });
    app.get(core.config.readyPath, (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const readiness = core.getReadinessSnapshot();
            if (!readiness.ok) {
                res.status(503).json(readiness);
                return;
            }
            res.json(readiness);
        }
        catch (error) {
            const mapped = core.mapErrorToHttp(error);
            res.status(mapped.status).json({ ok: false, error: mapped.message, details: core.redactForLog(mapped.details) });
        }
    });
    app.get(core.config.statusPath, (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            const readiness = core.getReadinessSnapshot();
            const sessionSummaries = [...sessions.values()]
                .sort((lhs, rhs) => lhs.openedAtMs - rhs.openedAtMs)
                .map((state) => ({
                sessionId: state.sessionId,
                openedAt: new Date(state.openedAtMs).toISOString(),
                lastActivityAt: new Date(state.lastActivityAtMs).toISOString(),
                expiresAt: new Date(state.expiresAt).toISOString(),
                ageMs: Date.now() - state.openedAtMs,
                idleMs: Date.now() - state.lastActivityAtMs,
                clientId: state.clientId,
                clientName: state.clientName,
                clientVersion: state.clientVersion,
                userId: state.userId || null,
                agentName: state.agentName || null,
                userAgent: state.userAgent || null,
                remoteAddress: state.remoteAddress,
                toolCalls: state.toolCalls,
                toolErrors: state.toolErrors,
            }));
            const status = observability.buildStatusSnapshot({
                activeSessions: sessions.size,
                readiness,
                sessions: sessionSummaries,
            });
            res.status(Boolean(readiness.ok) ? 200 : 503).json({
                ...status,
                transport: "mcp-streamable-http",
                mcpPath: core.config.mcpPath,
                healthPath: core.config.healthPath,
                readyPath: core.config.readyPath,
                statusPath: core.config.statusPath,
                metricsPath: core.config.metricsPath,
            });
        }
        catch (error) {
            const mapped = core.mapErrorToHttp(error);
            res.status(mapped.status).json({ ok: false, error: mapped.message, details: core.redactForLog(mapped.details) });
        }
    });
    app.get(core.config.metricsPath, (req, res) => {
        try {
            core.requireServerKey(String(req.header("x-server-key") || ""));
            res.type("text/plain; version=0.0.4; charset=utf-8");
            res.send(observability.renderPrometheus(sessions.size));
        }
        catch (error) {
            const mapped = core.mapErrorToHttp(error);
            res.status(mapped.status).json({ ok: false, error: mapped.message, details: core.redactForLog(mapped.details) });
        }
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
