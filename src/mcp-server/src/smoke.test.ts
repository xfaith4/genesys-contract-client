import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

test("server enforces X-Server-Key when SERVER_API_KEY is set", async () => {
  const port = 18787;
  const key = "unit-test-key";

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_API_KEY: key,
      // keep it read-only for tests
      ALLOW_WRITE_OPERATIONS: "false",
    },
    stdio: "ignore",
  });

  try {
    // crude but effective: give the server a moment to bind
    await wait(600);

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
