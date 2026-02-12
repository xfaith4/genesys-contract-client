import test from "node:test";
import assert from "node:assert/strict";

import { redactForLog, summarizeRequest } from "./policy.js";
import { LoggingPolicy } from "./types.js";

const policy: LoggingPolicy = {
  defaultRule: { params: [], bodyPaths: [] },
  operationRules: new Map([
    [
      "postAnalyticsConversationsDetailsQuery",
      {
        params: ["pageSize", "pageNumber"],
        bodyPaths: ["$.interval", "$.paging.pageSize", "$.token"],
      },
    ],
  ]),
};

const redactionFields = new Set(["token", "secret", "clientsecret"]);

test("summarizeRequest logs allowlisted fields and omits everything else", () => {
  const summary = summarizeRequest(
    "postAnalyticsConversationsDetailsQuery",
    {
      pageSize: 100,
      pageNumber: 1,
      debug: true,
    },
    {
      interval: "2026-02-01T00:00:00.000Z/2026-02-01T01:00:00.000Z",
      paging: { pageSize: 100, pageNumber: 1 },
      token: "super-secret-token",
      queueId: "queue-1",
    },
    policy,
    redactionFields,
  );

  assert.deepEqual(summary.params, { pageSize: 100, pageNumber: 1 });
  assert.equal((summary.body as Record<string, unknown>)["$.interval"], "2026-02-01T00:00:00.000Z/2026-02-01T01:00:00.000Z");
  assert.equal((summary.body as Record<string, unknown>)["$.paging.pageSize"], 100);
  assert.equal((summary.body as Record<string, unknown>)["$.token"], "***redacted***");
  assert.ok(!("debug" in (summary.params as Record<string, unknown>)));
});

test("redactForLog masks nested secret fields", () => {
  const redacted = redactForLog(
    {
      clientSecret: "abc123",
      nested: {
        access_token: "token-value",
        ok: true,
      },
    },
    redactionFields,
  ) as Record<string, unknown>;

  assert.equal(redacted.clientSecret, "***redacted***");
  assert.equal((redacted.nested as Record<string, unknown>).access_token, "***redacted***");
  assert.equal((redacted.nested as Record<string, unknown>).ok, true);
});

