# genesys-contract-client server (HTTP surface)

This folder currently contains an **HTTP wrapper** around the contract/pagination logic.
It is intentionally conservative and designed to be wrapped by your org’s agent platform.

## Security defaults

- If `SERVER_API_KEY` is set, requests must include header `X-Server-Key: <value>`.
- If `registry/allowlist.yaml` contains any operationIds, only those are allowed.
- If the allowlist is empty, **GET operations are allowed** and **non-GET operations are denied** unless `ALLOW_WRITE_OPERATIONS=true`.
- Pagination follow-ups (`nextUri` / `nextPage`) are resolved against `client.baseUrl` and refused if they point to a different host.

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

## MCP note

For a **protocol-native** MCP server, you’d implement MCP Streamable HTTP (recommended over SSE) and expose a curated set of tools.
See OpenAI’s MCP guidance for transports and remote server behavior.
