import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import Ajv from "ajv";

import { GenesysCoreService } from "../core/service.js";
import { CoreConfig, Operation, PagingMapEntry } from "../core/types.js";
import { createMcpApp } from "./server.js";

const fixtureOperations: Record<string, Operation> = {
  getUsers: {
    catalogKey: "getUsers",
    operationId: "getUsers",
    method: "GET",
    path: "/api/v2/users",
    tags: ["Users"],
    summary: "Get users",
    description: "",
    parameters: [],
    pagingType: "NEXT_URI",
    responseItemsPath: "$.entities",
  },
};

const fixturePagingMap: Record<string, PagingMapEntry> = {
  getUsers: { type: "NEXT_URI", itemsPath: "$.entities" },
};

type JsonRpcEnvelope = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStreamableJsonRpc(text: string): JsonRpcEnvelope {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcEnvelope;
  }

  const lines = text.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    } else if (dataLines.length > 0 && line.trim() === "") {
      break;
    }
  }
  if (dataLines.length === 0) {
    throw new Error(`Unable to parse Streamable HTTP response: ${text}`);
  }
  return JSON.parse(dataLines.join("\n")) as JsonRpcEnvelope;
}

async function postMcp(
  url: string,
  payload: Record<string, unknown>,
  sessionId?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{
  response: Response;
  message: JsonRpcEnvelope;
}> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  return {
    response,
    message: parseStreamableJsonRpc(bodyText),
  };
}

function makeInitializePayload(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "mcp-integration-test",
        version: "1.0.0",
      },
    },
  };
}

function createFixtureCore(configOverrides: Partial<CoreConfig> = {}): GenesysCoreService {
  return new GenesysCoreService(process.cwd(), {
    operations: fixtureOperations,
    pagingMap: fixturePagingMap,
    definitions: {},
    config: {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      healthPath: "/healthz",
      readyPath: "/readyz",
      statusPath: "/status",
      metricsPath: "/metrics",
      serverApiKey: "",
      allowWriteOperations: false,
      legacyHttpApi: false,
      logRequestPayloads: false,
      ...configOverrides,
    },
  });
}

async function startTestServer(
  t: test.TestContext,
  core: GenesysCoreService,
): Promise<{ mcpUrl: string; healthUrl: string; readyUrl: string; statusUrl: string; metricsUrl: string }> {
  const app = createMcpApp(core);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
  const healthUrl = `http://127.0.0.1:${address.port}/healthz`;
  const readyUrl = `http://127.0.0.1:${address.port}/readyz`;
  const statusUrl = `http://127.0.0.1:${address.port}/status`;
  const metricsUrl = `http://127.0.0.1:${address.port}/metrics`;
  return { mcpUrl, healthUrl, readyUrl, statusUrl, metricsUrl };
}

async function initializeSession(mcpUrl: string): Promise<string> {
  const initialize = await postMcp(mcpUrl, makeInitializePayload(1));

  assert.equal(initialize.response.status, 200);
  assert.ok(!initialize.message.error);

  const sessionId = initialize.response.headers.get("mcp-session-id");
  assert.ok(sessionId && sessionId.trim().length > 0, "Expected mcp-session-id response header.");
  return sessionId;
}

test("MCP Streamable HTTP server exposes required tools and executes searchOperations", async (t) => {
  const core = createFixtureCore();
  const { mcpUrl } = await startTestServer(t, core);
  const sessionId = await initializeSession(mcpUrl);

  const listTools = await postMcp(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    sessionId,
  );

  assert.equal(listTools.response.status, 200);
  assert.ok(!listTools.message.error);

  const tools = (listTools.message.result?.tools as Array<Record<string, unknown>> | undefined) ?? [];
  const names = tools.map((tool) => String(tool.name)).sort();
  assert.deepEqual(names, ["genesys.call", "genesys.callAll", "genesys.describe", "genesys.searchOperations"]);

  const ajv = new Ajv();
  for (const tool of tools) {
    const schema = tool.inputSchema as Record<string, unknown> | undefined;
    assert.ok(schema, `Tool ${String(tool.name)} is missing inputSchema.`);
    const schemaValid = ajv.validateSchema(schema);
    assert.equal(schemaValid, true, `Invalid inputSchema for ${String(tool.name)}: ${ajv.errorsText(ajv.errors)}`);
  }

  const callSearch = await postMcp(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "genesys.searchOperations",
        arguments: {
          query: "users",
          limit: 5,
        },
      },
    },
    sessionId,
  );

  assert.equal(callSearch.response.status, 200);
  assert.ok(!callSearch.message.error);
  const structured = (callSearch.message.result?.structuredContent as Record<string, unknown> | undefined) ?? {};
  assert.equal(structured.count, 1);
  assert.equal(
    (structured.operations as Array<Record<string, unknown>> | undefined)?.[0]?.operationId,
    "getUsers",
  );

  const terminate = await fetch(mcpUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
  });
  assert.equal(terminate.status, 200);
  await terminate.text();
});

test("MCP observability endpoints expose readiness, status, and metrics", async (t) => {
  const core = createFixtureCore();
  const { mcpUrl, readyUrl, statusUrl, metricsUrl } = await startTestServer(t, core);
  const sessionId = await initializeSession(mcpUrl);

  const toolCall = await postMcp(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "genesys.searchOperations",
        arguments: {
          query: "users",
          limit: 5,
        },
      },
    },
    sessionId,
  );
  assert.equal(toolCall.response.status, 200);
  assert.ok(!toolCall.message.error);

  const ready = await fetch(readyUrl);
  assert.equal(ready.status, 200);
  const readyBody = (await ready.json()) as Record<string, unknown>;
  assert.equal(readyBody.ok, true);

  const status = await fetch(statusUrl);
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as Record<string, unknown>;
  assert.equal(statusBody.ok, true);
  assert.equal(statusBody.activeSessions, 1);
  const topTools = (statusBody.topTools as Array<Record<string, unknown>> | undefined) ?? [];
  assert.ok(topTools.some((entry) => entry.toolName === "genesys.searchOperations"));

  const metrics = await fetch(metricsUrl);
  assert.equal(metrics.status, 200);
  const metricsText = await metrics.text();
  assert.ok(metricsText.includes("mcp_requests_total{method=\"tools/call\",tool=\"genesys.searchOperations\",status=\"ok\"}"));
  assert.ok(metricsText.includes("mcp_active_sessions 1"));

  const terminate = await fetch(mcpUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(terminate.status, 200);
  await terminate.text();
});

test("MCP session delete closes state and rejects reuse", async (t) => {
  const core = createFixtureCore();
  const { mcpUrl, healthUrl } = await startTestServer(t, core);
  const sessionId = await initializeSession(mcpUrl);

  const healthBefore = await fetch(healthUrl);
  assert.equal(healthBefore.status, 200);
  const bodyBefore = (await healthBefore.json()) as Record<string, unknown>;
  assert.equal(bodyBefore.activeSessions, 1);

  const terminate = await fetch(mcpUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(terminate.status, 200);
  await terminate.text();

  const healthAfter = await fetch(healthUrl);
  assert.equal(healthAfter.status, 200);
  const bodyAfter = (await healthAfter.json()) as Record<string, unknown>;
  assert.equal(bodyAfter.activeSessions, 0);

  const reuse = await postMcp(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    sessionId,
  );
  assert.equal(reuse.response.status, 404);
  assert.equal(reuse.message.error?.message, `Unknown MCP session '${sessionId}'.`);
});

test("MCP initialize is rejected when max sessions are reached", async (t) => {
  const core = createFixtureCore({
    mcpMaxSessions: 1,
    mcpSessionTtlMs: 60000,
  });
  const { mcpUrl } = await startTestServer(t, core);
  const sessionId = await initializeSession(mcpUrl);

  const blocked = await postMcp(mcpUrl, makeInitializePayload(99));
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.message.error?.message, "MCP session limit reached (1).");

  const terminate = await fetch(mcpUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(terminate.status, 200);
  await terminate.text();
});

test("MCP concurrent initialize enforces max sessions under race", async (t) => {
  const maxSessions = 3;
  const attempts = 12;
  const core = createFixtureCore({
    mcpMaxSessions: maxSessions,
    mcpSessionTtlMs: 60000,
  });
  const { mcpUrl, healthUrl } = await startTestServer(t, core);

  const initResults = await Promise.all(
    Array.from({ length: attempts }).map((_v, idx) => postMcp(mcpUrl, makeInitializePayload(1000 + idx))),
  );

  const successResults = initResults.filter((r) => r.response.status === 200);
  const blockedResults = initResults.filter((r) => r.response.status === 429);

  assert.equal(successResults.length, maxSessions);
  assert.equal(blockedResults.length, attempts - maxSessions);
  for (const blocked of blockedResults) {
    assert.equal(blocked.message.error?.message, `MCP session limit reached (${maxSessions}).`);
  }

  const health = await fetch(healthUrl);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.equal(healthBody.activeSessions, maxSessions);

  for (const result of successResults) {
    const sessionId = result.response.headers.get("mcp-session-id");
    assert.ok(sessionId, "Expected successful initialize to include mcp-session-id.");
    const terminate = await fetch(mcpUrl, {
      method: "DELETE",
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
    });
    assert.equal(terminate.status, 200);
    await terminate.text();
  }
});

test("MCP max-session gate remains stable across repeated flood rounds", async (t) => {
  const maxSessions = 2;
  const attemptsPerRound = 8;
  const rounds = 6;
  const core = createFixtureCore({
    mcpMaxSessions: maxSessions,
    mcpSessionTtlMs: 60000,
  });
  const { mcpUrl } = await startTestServer(t, core);

  for (let round = 1; round <= rounds; round++) {
    const initResults = await Promise.all(
      Array.from({ length: attemptsPerRound }).map((_v, idx) => postMcp(mcpUrl, makeInitializePayload(round * 100 + idx))),
    );
    const successResults = initResults.filter((r) => r.response.status === 200);
    const blockedResults = initResults.filter((r) => r.response.status === 429);

    assert.equal(successResults.length, maxSessions);
    assert.equal(blockedResults.length, attemptsPerRound - maxSessions);

    for (const blocked of blockedResults) {
      assert.equal(blocked.message.error?.message, `MCP session limit reached (${maxSessions}).`);
    }

    for (const result of successResults) {
      const sessionId = result.response.headers.get("mcp-session-id");
      assert.ok(sessionId, "Expected successful initialize to include mcp-session-id.");
      const terminate = await fetch(mcpUrl, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
      });
      assert.equal(terminate.status, 200);
      await terminate.text();
    }
  }
});

test("MCP session TTL expires idle sessions and rejects stale session id", async (t) => {
  const sessionTtlMs = 120;
  const core = createFixtureCore({
    mcpSessionTtlMs: sessionTtlMs,
    mcpMaxSessions: 10,
  });
  const { mcpUrl, healthUrl } = await startTestServer(t, core);
  const sessionId = await initializeSession(mcpUrl);

  const deadline = Date.now() + 5000;
  let active = 1;
  while (Date.now() < deadline) {
    const health = await fetch(healthUrl);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    active = Number(healthBody.activeSessions ?? -1);
    if (active === 0) {
      break;
    }
    await wait(30);
  }
  assert.equal(active, 0, "Expected idle session to expire and be cleaned up.");

  const staleUse = await postMcp(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {},
    },
    sessionId,
  );
  assert.equal(staleUse.response.status, 404);
  assert.equal(staleUse.message.error?.message, `Unknown MCP session '${sessionId}'.`);
});

test("MCP delete/use race never returns server error and session is eventually closed", async (t) => {
  const core = createFixtureCore({
    mcpSessionTtlMs: 60000,
  });
  const { mcpUrl } = await startTestServer(t, core);
  const sessionId = await initializeSession(mcpUrl);

  const [listResult, terminate] = await Promise.all([
    postMcp(
      mcpUrl,
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
        params: {},
      },
      sessionId,
    ),
    fetch(mcpUrl, {
      method: "DELETE",
      headers: {
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
      },
    }),
  ]);

  const terminateBody = await terminate.text();
  assert.equal(terminate.status, 200, `Unexpected delete response body: ${terminateBody}`);
  assert.ok([200, 404].includes(listResult.response.status), `Unexpected tools/list status ${listResult.response.status}`);

  const afterRace = await postMcp(
    mcpUrl,
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {},
    },
    sessionId,
  );
  assert.equal(afterRace.response.status, 404);
});

test("MCP endpoint enforces x-server-key when configured", async (t) => {
  const serverApiKey = "test-api-key";
  const core = createFixtureCore({
    serverApiKey,
  });
  const { mcpUrl } = await startTestServer(t, core);

  const unauthorized = await postMcp(mcpUrl, makeInitializePayload(501));
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.message.error?.message, "Unauthorized: missing/invalid X-Server-Key.");

  const authorized = await postMcp(mcpUrl, makeInitializePayload(502), undefined, {
    "x-server-key": serverApiKey,
  });
  assert.equal(authorized.response.status, 200);
  const sessionId = authorized.response.headers.get("mcp-session-id");
  assert.ok(sessionId, "Expected mcp-session-id for authorized initialize.");

  const terminate = await fetch(mcpUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
      "x-server-key": serverApiKey,
    },
  });
  assert.equal(terminate.status, 200);
  await terminate.text();
});
