import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withServer(
  env: Record<string, string>,
  fn: (baseUrl: string, key: string) => Promise<void>,
) {
  const key = "unit-test-key";
  const port = String(18000 + Math.floor(Math.random() * 1000));

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      SERVER_API_KEY: key,
      ALLOW_WRITE_OPERATIONS: "false",
      ...env,
    },
    stdio: "ignore",
  });

  try {
    await wait(700);
    await fn(`http://127.0.0.1:${port}`, key);
  } finally {
    child.kill("SIGTERM");
  }
}

test("server enforces X-Server-Key when SERVER_API_KEY is set", async () => {
  await withServer({}, async (baseUrl) => {
    const resp = await fetch(`${baseUrl}/describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "getUsers" }),
    });
    assert.equal(resp.status, 401);
  });
});

test("call rejects unknown query parameters before upstream call", async () => {
  await withServer({}, async (baseUrl, key) => {
    const resp = await fetch(`${baseUrl}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Key": key,
      },
      body: JSON.stringify({
        operationId: "getUsers",
        params: { madeUpParam: "x" },
      }),
    });
    const body = await resp.json();
    assert.equal(resp.status, 400);
    assert.match(String(body.error), /Unknown parameter/i);
  });
});

test("call validates request body against operation schema", async () => {
  await withServer({}, async (baseUrl, key) => {
    const resp = await fetch(`${baseUrl}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Server-Key": key,
      },
      body: JSON.stringify({
        operationId: "postAnalyticsConversationsDetailsQuery",
        body: {
          interval: "2026-02-01T00:00:00.000Z/2026-02-02T00:00:00.000Z",
          madeUpField: "invalid",
        },
      }),
    });
    const body = await resp.json();
    assert.equal(resp.status, 400);
    assert.match(String(body.error), /Body schema validation failed/i);
  });
});

test("tools endpoint exposes curated genesys tools", async () => {
  await withServer({}, async (baseUrl, key) => {
    const resp = await fetch(`${baseUrl}/tools`, {
      method: "GET",
      headers: {
        "X-Server-Key": key,
      },
    });
    const body = await resp.json();
    assert.equal(resp.status, 200);
    const names = (body.tools ?? []).map((x: any) => x.name);
    assert.deepEqual(names, ["genesys.describe", "genesys.call", "genesys.callAll", "genesys.searchOperations"]);
  });
});

test("callAll blocks off-origin nextUri pagination", async () => {
  const upstreamPort = 19101 + Math.floor(Math.random() * 200);
  const upstream = createServer((req, res) => {
    if (req.url === "/oauth/token" && req.method === "POST") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "mock-token", expires_in: 3600 }));
      return;
    }
    if (req.url?.startsWith("/api/v2/authorization/divisions/deleted")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          entities: [{ id: "d1" }],
          pageNumber: 1,
          pageSize: 1,
          nextUri: "https://evil.example/steal-token",
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("not-found");
  });

  await new Promise<void>((resolve) => upstream.listen(upstreamPort, "127.0.0.1", () => resolve()));

  try {
    await withServer({ ALLOW_INSECURE_HTTP: "true", ALLOW_CLIENT_OVERRIDES: "true" }, async (baseUrl, key) => {
      const resp = await fetch(`${baseUrl}/callAll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Server-Key": key,
        },
        body: JSON.stringify({
          operationId: "getAuthorizationDivisionsDeleted",
          client: {
            baseUrl: `http://127.0.0.1:${upstreamPort}`,
            tokenUrl: `http://127.0.0.1:${upstreamPort}/oauth/token`,
            clientId: "client",
            clientSecret: "secret",
          },
          params: { pageSize: 1 },
          maxPages: 5,
        }),
      });
      const body = await resp.json();
      assert.equal(resp.status, 400);
      assert.match(String(body.error), /off-host/i);
    });
  } finally {
    upstream.close();
  }
});
