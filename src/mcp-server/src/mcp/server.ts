import { randomUUID } from "node:crypto";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { GenesysCoreService } from "../core/service.js";
import { parsePositiveInt } from "../core/utils.js";

type SessionState = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

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

function toMcpErrorResult(core: GenesysCoreService, error: unknown) {
  const mapped = core.mapErrorToHttp(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${mapped.status}: ${mapped.message}` }],
    structuredContent: {
      error: mapped.message,
      status: mapped.status,
      details: core.redactForLog(mapped.details),
    },
  };
}

function toMcpOkResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function createGenesysMcpServer(core: GenesysCoreService): McpServer {
  const server = new McpServer(
    {
      name: "genesys-contract-client",
      version: "0.2.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "genesys.describe",
    {
      description: "Describe operation contract, paging metadata, and governance policy.",
      inputSchema: describeInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ operationId }) => {
      try {
        const result = await core.describe({ operationId });
        return toMcpOkResult(result as Record<string, unknown>);
      } catch (error) {
        return toMcpErrorResult(core, error);
      }
    },
  );

  server.registerTool(
    "genesys.searchOperations",
    {
      description: "Search operation catalog by query/method/tag.",
      inputSchema: searchOperationsInputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ query, limit }) => {
      try {
        const result = core.searchOperations({ query, limit });
        return toMcpOkResult(result as Record<string, unknown>);
      } catch (error) {
        return toMcpErrorResult(core, error);
      }
    },
  );

  server.registerTool(
    "genesys.call",
    {
      description: "Execute one contract-validated Genesys operation.",
      inputSchema: callInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ operationId, params, body }) => {
      try {
        const result = await core.call({ operationId, params, body });
        return toMcpOkResult(result as Record<string, unknown>);
      } catch (error) {
        return toMcpErrorResult(core, error);
      }
    },
  );

  server.registerTool(
    "genesys.callAll",
    {
      description: "Execute deterministic paginated operation call with audit output.",
      inputSchema: callAllInputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ operationId, params, body, limit, maxPages, maxRuntimeMs }) => {
      try {
        const result = await core.callAll({ operationId, params, body, limit, maxPages, maxRuntimeMs, includeItems: true });
        return toMcpOkResult(result as Record<string, unknown>);
      } catch (error) {
        return toMcpErrorResult(core, error);
      }
    },
  );

  return server;
}

export function createMcpApp(core: GenesysCoreService): express.Express {
  const app = createMcpExpressApp({ host: core.config.host });
  const sessions = new Map<string, SessionState>();

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
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          event: "http.request",
          requestId: req.requestId ?? "",
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
    next();
  });

  async function closeSession(sessionId: string): Promise<void> {
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    await state.transport.close().catch(() => undefined);
    await state.server.close().catch(() => undefined);
  }

  function writeJsonRpcError(res: express.Response, code: number, mapped: { status: number; message: string; details?: unknown }): void {
    if (res.headersSent) return;
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
        await state.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        writeJsonRpcError(res, -32000, { status: 400, message: "Missing mcp-session-id header for non-initialize request." });
        return;
      }

      const mcpServer = createGenesysMcpServer(core);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server: mcpServer, transport });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
        void mcpServer.close().catch(() => undefined);
      };

      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        await transport.close().catch(() => undefined);
        await mcpServer.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
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

      await state.transport.handleRequest(req, res);
    } catch (error) {
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
    } catch (error) {
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
    });
  });

  return app;
}

export function parseMcpToolInput(raw: {
  operationId: string;
  params?: Record<string, unknown>;
  body?: unknown;
  limit?: number;
  maxPages?: number;
  maxRuntimeMs?: number;
}): {
  operationId: string;
  params: Record<string, unknown>;
  body: unknown;
  limit?: number;
  maxPages?: number;
  maxRuntimeMs?: number;
} {
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
