# genesys-contract-client server (HTTP surface)

This folder currently contains an **HTTP wrapper** around the contract/pagination logic.
It is intentionally conservative and designed to be wrapped by your org’s agent platform.

## Security defaults

- If `SERVER_API_KEY` is set, requests must include header `X-Server-Key: <value>`.
- If `registry/allowlist.yaml` contains operationIds/tags, only those are allowed.
- `registry/denylist.yaml` blocks matching operationIds/tags before allowlist evaluation.
- If the allowlist is empty, **GET operations are allowed** and **non-GET operations are denied** unless `ALLOW_WRITE_OPERATIONS=true`.
- Pagination follow-ups (`nextUri` / `nextPage`) are resolved against `client.baseUrl` and refused if they point to a different host.
- Request payload fields are strict; unknown fields are rejected.
- Request bodies are validated against Swagger schemas (`#/definitions/...`) with unknown field rejection.

## Scripts

```bash
npm install
npm run build
npm start
```

### Endpoints

- `POST /describe` → returns operation contract + paging metadata
- `POST /call` → performs a single call
- `POST /callAll` → performs deterministic pagination with safety caps
- `POST /searchOperations` → query operation catalog (query/method/tag)
- `GET /tools` → curated tool inventory (`genesys.*`)
- `POST /tools/invoke` → tool-style invocation front door (`genesys.describe/call/callAll/searchOperations`)
- `GET /healthz` → liveness probe

## Credential policy

- Server-managed credentials (recommended): set `GENESYS_BASE_URL`, `GENESYS_TOKEN_URL`, `GENESYS_CLIENT_ID`, `GENESYS_CLIENT_SECRET`, optional `GENESYS_SCOPE`.
- Per-request credentials: allowed only when `ALLOW_CLIENT_OVERRIDES=true`.
- Host restrictions:
  - `ALLOWED_BASE_HOSTS` (comma-separated hostnames)
  - `ALLOWED_TOKEN_HOSTS` (comma-separated hostnames)
- `ALLOW_INSECURE_HTTP=true` only allows loopback HTTP (`127.0.0.1/localhost`) for local testing.

## MCP note

For a **protocol-native** MCP server, you’d implement MCP Streamable HTTP (recommended over SSE) and expose a curated set of tools.
See OpenAI’s MCP guidance for transports and remote server behavior.
