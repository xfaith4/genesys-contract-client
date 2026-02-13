import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

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

test("legacy HTTP endpoints are disabled by default", async () => {
  const port = 18787;
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
  const port = 18788;
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
