# Genesys Contract Client

A **contract-enforced, deterministic pagination** wrapper for the Genesys Cloud Platform API.

This repo intentionally focuses on **eliminating guessing**:
- Engineers (and agents) must call **by operationId**.
- Unknown params are rejected.
- Pagination is handled centrally (`nextUri`, `nextPage`, `cursor`, `pageNumber`, etc.), with an **audit trail**.

## Contents

- `specs/swagger.json` — pinned Swagger 2.0 definition (extracted from API Explorer cache)
- `generated/operations.json` — operation catalog (operationId → method/path/params)
- `generated/pagination-map.json` — paging classification per operationId
- `generated/catalog-collisions.json` — case-insensitive operationId key collisions remapped for PowerShell compatibility
- `playbooks/conversations.yaml` — guide-derived, contract-bound workflow map for conversations use cases
- `docs/stakeholder-map.md` — stakeholder focus map (API Explorer, AudioHook, CX as Code, SDK, Guides)
- `src/ps-module/Genesys.ContractClient` — PowerShell engineer-facing module (PS 5.1+)
- `src/mcp-server` — Node/TS HTTP service (easy to wrap as MCP tooling)

## Quick start (PowerShell)

```powershell
Import-Module ./src/ps-module/Genesys.ContractClient/Genesys.ContractClient.psd1 -Force

Import-GcSpec `
  -SwaggerPath ./specs/swagger.json `
  -OperationsPath ./generated/operations.json `
  -PaginationMapPath ./generated/pagination-map.json

$client = New-GcClient `
  -BaseUrl   "https://api.mypurecloud.com" `
  -TokenUrl  "https://login.mypurecloud.com/oauth/token" `
  -ClientId  $env:GC_CLIENT_ID `
  -ClientSecret $env:GC_CLIENT_SECRET

# Discover an operationId
Find-GcOperation -Query "routing skills" | Select-Object -First 5

# Call once (explicit operationId)
Invoke-GcApi -Client $client -OperationId "getRoutingSkills" -Params @{ pageSize = 100; pageNumber = 1 }

# Call all pages (deterministic)
Invoke-GcApiAll -Client $client -OperationId "getRoutingSkills" -Params @{} -PageSize 100 -Limit 5000
```

## Generate catalog / pagination map

```bash
python scripts/generate_catalog.py --swagger specs/swagger.json --out generated
```

## Evidence report command

Generate auditable test evidence (Markdown + JSON, schema-validated):

```powershell
pwsh -File tools/New-TestRunReport.ps1 `
  -Command "pwsh -File tests/Genesys.ContractClient.Tests.ps1" `
  -Command "pwsh -NoLogo -NoProfile -Command 'Set-Location src/mcp-server; npm test'"
```

Live Genesys checks must be explicitly marked and are skipped unless `COPILOT_GENESYS_ENV=sandbox`:

```powershell
pwsh -File tools/New-TestRunReport.ps1 `
  -LiveCommand "<live-genesys-command>"
```

## Node server (for Strider admins / integration)

```bash
cd src/mcp-server
npm install
npm run build
npm start
# POST http://localhost:8787/describe, /call, /callAll
```

## Notes

- **Validation**: This MVP enforces required query/path params + rejects unknown query/path params.
  Full JSON Schema validation can be added later (Ajv + $ref resolver).
- **Pagination**: `callAll` refuses operations classified as `UNKNOWN`. Add overrides in `registry/paging-registry.yaml` and regenerate maps.
- **Governance**: allow/deny policy in `registry/allowlist.yaml` + `registry/denylist.yaml`; redaction field policy in `registry/pii-redaction.yaml`.
