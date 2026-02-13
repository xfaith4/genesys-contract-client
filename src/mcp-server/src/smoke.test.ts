import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServerReady(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (resp.ok) {
        return;
      }
      lastError = new Error(`Health check returned ${resp.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }

  throw new Error(`Server did not become ready on port ${port}: ${String(lastError)}`);
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate an ephemeral test port.")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test("legacy HTTP endpoints are disabled by default", async () => {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LEGACY_HTTP_API: "false",
    },
    stdio: "ignore",
  });

  try {
    await waitForServerReady(port);

    const resp = await fetch(`http://127.0.0.1:${port}/describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "getUsers" }),
    });

    assert.equal(resp.status, 404);
  } finally {
    child.kill("SIGTERM");
  }
});

test("legacy HTTP mode enforces X-Server-Key when enabled", async () => {
  const port = await getAvailablePort();
  const key = "unit-test-key";

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      LEGACY_HTTP_API: "true",
      SERVER_API_KEY: key,
      ALLOW_WRITE_OPERATIONS: "false",
    },
    stdio: "ignore",
  });

  try {
    await waitForServerReady(port);

    const resp = await fetch(`http://127.0.0.1:${port}/describe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "getUsers" }),
    });

    assert.equal(resp.status, 401);
  } finally {
    child.kill("SIGTERM");
  }
});
