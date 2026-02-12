import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import Ajv from "ajv";

import { GenesysCoreService } from "../core/service.js";
import { Operation, PagingMapEntry } from "../core/types.js";
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
): Promise<{
  response: Response;
  message: JsonRpcEnvelope;
}> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
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

test("MCP Streamable HTTP server exposes required tools and executes searchOperations", async (t) => {
  const core = new GenesysCoreService(process.cwd(), {
    operations: fixtureOperations,
    pagingMap: fixturePagingMap,
    definitions: {},
    config: {
      host: "127.0.0.1",
      port: 0,
      mcpPath: "/mcp",
      healthPath: "/healthz",
      serverApiKey: "",
      allowWriteOperations: false,
      legacyHttpApi: false,
      logRequestPayloads: false,
    },
  });

  const app = createMcpApp(core);
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address() as AddressInfo;
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

  const initialize = await postMcp(mcpUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "mcp-integration-test",
        version: "1.0.0",
      },
    },
  });

  assert.equal(initialize.response.status, 200);
  assert.ok(!initialize.message.error);

  const sessionId = initialize.response.headers.get("mcp-session-id");
  assert.ok(sessionId && sessionId.trim().length > 0, "Expected mcp-session-id response header.");

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
