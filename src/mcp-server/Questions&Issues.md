**Findings (MCP server focus, ordered by severity)**

1. **Critical:** This is not an MCP server implementation yet; it is a custom HTTP wrapper with `/describe`, `/call`, `/callAll` only (`src/mcp-server/src/index.ts:113`, `src/mcp-server/src/index.ts:121`, `src/mcp-server/src/index.ts:134`), and no MCP protocol surface/tool descriptors. `src/mcp-server/package.json:11` also shows no MCP SDK dependency.

2. **Critical:** `callAll` can break on relative `nextUri`/`nextPage` links. `callOnce` uses `overrideUrl` directly (`src/mcp-server/src/index.ts:102`) and Axios in Node rejects relative URLs. Your PowerShell version already handles this (`src/ps-module/Genesys.ContractClient/Genesys.ContractClient.psm1:312`).

3. **Critical:** Security boundary is too open for agent usage: caller supplies `clientSecret` in request and can call any operationId (`src/mcp-server/src/index.ts:123`). There is no auth layer, no operation allowlist enforcement, and `registry/allowlist.yaml` is empty.

4. **High:** Potential token leakage/SSRF path in pagination follow-ups: bearer token is sent to whatever URL `nextUri`/`nextPage` contains (`src/mcp-server/src/index.ts:103`, `src/mcp-server/src/index.ts:107`) with no host validation.

5. **High:** `callAll` is unbounded by default and accumulates everything in memory (`src/mcp-server/src/index.ts:136`, `src/mcp-server/src/index.ts:145`, `src/mcp-server/src/index.ts:177`, `src/mcp-server/src/index.ts:208`), which risks OOM and long-running abuse.

6. **High:** `itemsPath` metadata is computed but ignored; extraction uses heuristic “first array property” (`src/mcp-server/src/index.ts:89`). This can silently return the wrong collection for some APIs.

7. **High:** No timeout/retry/backoff on token/API calls (`src/mcp-server/src/index.ts:45`, `src/mcp-server/src/index.ts:104`), so transient 429/5xx behavior is not production-safe.

8. **Medium:** Error mapping is too coarse: all failures return `400` (`src/mcp-server/src/index.ts:129`, `src/mcp-server/src/index.ts:210`). This hides auth failures vs throttling vs upstream outage and weakens agent decisioning.

9. **Medium:** Token cache design is unsafe for multi-tenant/scope scenarios: single global entry (`src/mcp-server/src/index.ts:34`) keyed only by `tokenUrl|clientId` (`src/mcp-server/src/index.ts:37`), excluding `scope` and `clientSecret`.

10. **Medium:** Repo-root resolution depends on `process.cwd()` (`src/mcp-server/src/index.ts:30`), so running from another working dir can fail to locate `generated/*.json`.

11. **Medium:** Required param validation checks key presence, not value validity (`src/mcp-server/src/index.ts:65`), so `null`/`undefined` can slip through.

12. **Medium:** Test coverage is effectively absent for MCP/Node behavior; only placeholder Pester test exists (`tests/Genesys.ContractClient.Tests.ps1:1`).

13. **Low:** Local dev script watches compiled output only (`src/mcp-server/package.json:7`) and does not compile on change, which is easy to misuse.

14. **Medium (intent mismatch):** Your roadmap says MCP surface should enforce allowlist + audits (`ROADMAP.md:320`, `ROADMAP.md:332`), but current server does not enforce allowlist and only returns in-response paging audit.

Build check: `npm run build` succeeds. No Node test suite exists to validate runtime behavior.

---

**OpenAI guidance gaps this code currently violates**

1. OpenAI MCP guidance emphasizes **trust boundaries** for remote MCP servers and limiting exposed tools (`allowed_tools`/`tool_filter`); current server exposes everything.
2. OpenAI docs indicate tool approval defaults are conservative; destructive actions should require stronger controls. Current design has no approval/authz layer.
3. OpenAI function-calling guidance recommends **strict schemas** for tool inputs; current request payloads are untyped/unvalidated at runtime.
4. OpenAI MCP docs recommend modern MCP transports (Streamable HTTP) and protocol-native tooling metadata; this service is protocol-adjacent, not protocol-native.
5. OpenAI agent safety guidance highlights prompt-injection risks and the need for guardrails/human oversight for high-impact actions; current surface allows direct high-impact API calls.

---

**Questions that decide the correct architecture**

1. Should this run as a **true MCP server** (stdio for local agents, Streamable HTTP for remote), or remain an internal HTTP service wrapped by another MCP adapter?
2. Do you want credentials supplied per request, or server-managed credentials via secret store with tenant mapping?
3. What is your initial allowlist: read-only Genesys operations only, or mixed read/write with approval gates?
4. Should `callAll` return full aggregates, or switch to chunked/streamed pagination to cap memory and runtime?
5. Are you targeting one organization/region first or multi-tenant from day one?

---

**Sources used (OpenAI)**

1. https://platform.openai.com/docs/guides/mcp
2. https://platform.openai.com/docs/guides/tools-remote-mcp
3. https://platform.openai.com/docs/guides/function-calling
4. https://platform.openai.com/docs/guides/agents-safety
5. https://platform.openai.com/docs/guides/production-best-practices
6. https://openai.github.io/openai-agents-js/guides/mcp/
7. https://openai.github.io/openai-agents-js/guides/tools/#model-context-protocol-mcp
