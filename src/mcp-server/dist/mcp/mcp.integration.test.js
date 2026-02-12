import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpApp } from "./server.js";
import { GenesysCoreService } from "../core/service.js";
const fixtureOperations = {
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
    postUsers: {
        catalogKey: "postUsers",
        operationId: "postUsers",
        method: "POST",
        path: "/api/v2/users",
        tags: ["Users"],
        summary: "Create user",
        description: "",
        parameters: [
            {
                name: "body",
                in: "body",
                required: true,
                schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                },
            },
        ],
        pagingType: "UNKNOWN",
    },
};
const fixturePagingMap = {
    getUsers: { type: "NEXT_URI", itemsPath: "$.entities" },
    postUsers: { type: "UNKNOWN", itemsPath: null },
};
test("MCP Streamable HTTP server exposes required tools and executes searchOperations", async () => {
    const core = new GenesysCoreService(process.cwd(), {
        operations: fixtureOperations,
        pagingMap: fixturePagingMap,
        definitions: {},
        config: {
            allowWriteOperations: false,
            legacyHttpApi: false,
            host: "127.0.0.1",
            port: 0,
            mcpPath: "/mcp",
            serverApiKey: "",
        },
    });
    const app = createMcpApp(core);
    const server = app.listen(0, "127.0.0.1");
    const address = server.address();
    const mcpUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
        reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1,
            maxReconnectionDelay: 1,
            reconnectionDelayGrowFactor: 1,
        },
    });
    const client = new Client({ name: "mcp-integration-test", version: "1.0.0" }, { capabilities: {} });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name).sort();
        assert.deepEqual(names, ["genesys.call", "genesys.callAll", "genesys.describe", "genesys.searchOperations"]);
        const response = await client.callTool({
            name: "genesys.searchOperations",
            arguments: { query: "users", limit: 10 },
        });
        assert.equal(response.isError, undefined);
        const structured = response.structuredContent;
        assert.equal(structured.count, 1);
        assert.equal(structured.operations[0].operationId, "getUsers");
    }
    finally {
        await client.close().catch(() => undefined);
        await transport.terminateSession().catch(() => undefined);
        await transport.close().catch(() => undefined);
        await new Promise((resolve) => server.close(() => resolve()));
    }
});
