# Genesys Contract Client MCP Server

Protocol-native MCP server using **Streamable HTTP** (`@modelcontextprotocol/sdk`) with a curated tool surface:

- `genesys.describe`
- `genesys.searchOperations`
- `genesys.call`
- `genesys.callAll`

The server enforces contract validation, deterministic pagination, and governance controls from the catalog and registry files.
Core contract logic is sourced from `../contract-core`.

## Run

```bash
cd src/mcp-server
npm install
npm run dev
```

`npm run build`/`npm run dev` auto-bootstrap `../contract-core` dependencies when missing or stale.  
Run `npm run setup:core` only when you want to pre-install core dependencies explicitly.

Production build:

```bash
npm run build
npm start
```

## Tests

From `src/mcp-server`:

```bash
npm test
npm run test:pester
```

`npm run test:pester` resolves the root-level Pester test path automatically.

## Endpoints

- MCP endpoint: `POST/GET/DELETE /mcp` (configurable via `MCP_PATH`)
- Health endpoint: `GET /healthz` (configurable via `HEALTH_PATH`)
- Readiness endpoint: `GET /readyz` (configurable via `READY_PATH`)
- Status endpoint: `GET /status` (configurable via `STATUS_PATH`)
- Metrics endpoint (Prometheus text): `GET /metrics` (configurable via `METRICS_PATH`)

`/status` and `/metrics` include tool/session telemetry and should be treated as operational endpoints.
When `SERVER_API_KEY` is configured, these endpoints require `X-Server-Key`.

Legacy HTTP adapter routes (`/describe`, `/call`, `/callAll`, `/tools/invoke`) are **disabled by default** and only enabled when:

- `LEGACY_HTTP_API=true`

## Governance Controls

- `registry/allowlist.yaml`: operation allowlist (`operationId` and `tag:<name>`)
- `registry/denylist.yaml`: deny rules evaluated before allowlist/default policy
- `registry/paging-registry.yaml`: pagination overrides
- `registry/pii-redaction.yaml`: redaction fallback field names
- `registry/logging-policy.yaml`: allowlisted request summary fields

Default execution policy:

- Deny writes by default (`GET` allowed, non-GET blocked) unless `ALLOW_WRITE_OPERATIONS=true`
- Enforce same-origin for pagination links (`nextUri`, `nextPage`)
- Clamp pagination runtime controls (`limit`, `maxPages`, `maxRuntimeMs`) to hard caps

## Credentials

Recommended for MCP tools: server-managed credentials from environment:

- `GENESYS_BASE_URL`
- `GENESYS_TOKEN_URL`
- `GENESYS_CLIENT_ID`
- `GENESYS_CLIENT_SECRET`
- `GENESYS_SCOPE` (optional)

Optional per-request credential overrides are blocked unless:

- `ALLOW_CLIENT_OVERRIDES=true`

## Optional Auth Boundary

If `SERVER_API_KEY` is set, every request must include:

- `X-Server-Key: <value>`

## Tool Inputs and Outputs

### `genesys.describe`

Input:

```json
{ "operationId": "getUsers" }
```

Output (`structuredContent`):

```json
{
  "operation": { "...": "..." },
  "paging": { "type": "NEXT_URI", "itemsPath": "$.entities" },
  "policy": { "...": "..." }
}
```

### `genesys.searchOperations`

Input:

```json
{ "query": "conversations details", "limit": 25 }
```

Output:

```json
{ "count": 3, "operations": [ { "...": "..." } ] }
```

### `genesys.call`

Input:

```json
{
  "operationId": "getUsers",
  "params": { "pageSize": 100, "pageNumber": 1 }
}
```

Output:

```json
{ "data": { "...": "..." } }
```

### `genesys.callAll`

Input:

```json
{
  "operationId": "postAnalyticsConversationsDetailsQuery",
  "body": { "interval": "2026-02-01T00:00:00.000Z/2026-02-01T01:00:00.000Z" },
  "limit": 5000,
  "maxPages": 50,
  "maxRuntimeMs": 120000
}
```

Output:

```json
{
  "items": [],
  "audit": [],
  "pagingType": "TOTALHITS",
  "totalFetched": 0
}
```
