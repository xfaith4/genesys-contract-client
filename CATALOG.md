# Genesys Contract Client — Catalog

This repo is the **front door** to a contract-enforced way of calling **Genesys Cloud APIs**.

## What this toolset is for

- **No guessing**: every call uses an explicit `operationId`.
- **No pagination folklore**: `Invoke-GcApiAll` handles paging centrally (cursor/nextUri/nextPage/pageNumber/totalHits).
- **Audit-friendly**: fetch-all calls return a paging audit (how many pages, why it stopped).

## Quick start

### 1) Set environment variables

Required:
- `GC_CLIENT_ID`
- `GC_CLIENT_SECRET`

Recommended (region-specific):
- `GC_BASE_URL` (example: `https://api.usw2.pure.cloud`)
- `GC_TOKEN_URL` (example: `https://login.usw2.pure.cloud/oauth/token`)

### 2) Run a Golden Script (fastest value)

```powershell
pwsh -File .\golden-scripts\01-Users.ps1
```

Outputs land here:
- `golden-scripts/out/<timestamp>/*.csv`
- `golden-scripts/out/<timestamp>/*.xlsx` (if you have the `ImportExcel` module)

See the full report list: **[golden-scripts/CATALOG.md](golden-scripts/CATALOG.md)**

## How to use the client directly

```powershell
Import-Module .\src\ps-module\Genesys.ContractClient\Genesys.ContractClient.psd1 -Force
Import-GcSpec -SwaggerPath .\specs\swagger.json -OperationsPath .\generated\operations.json -PaginationMapPath .\generated\pagination-map.json

$client = New-GcClient -BaseUrl $env:GC_BASE_URL -TokenUrl $env:GC_TOKEN_URL -ClientId $env:GC_CLIENT_ID -ClientSecret $env:GC_CLIENT_SECRET

# Discover operations
Find-GcOperation -Query "routing queues" | Select-Object -First 10

# Single request
Invoke-GcApi -Client $client -OperationId "getRoutingQueues" -Params @{ pageSize = 100; pageNumber = 1 }

# Fetch-all with deterministic pagination + audit
Invoke-GcApiAll -Client $client -OperationId "getRoutingQueues" -PageSize 100 -Limit 200000
```

## Conversations playbook

Conversations are where engineers get real insight fast (single conversation forensics, timeboxed sets, queue/division slices).

- **Decision trees + recommended endpoints:** **[docs/conversations-playbook.md](docs/conversations-playbook.md)**
- Starter report script(s): see `golden-scripts/20-*`

## Adding a new Golden Script

1. Pick the **one** `operationId` you need (use `Find-GcOperation`).
2. Decide whether you need `Invoke-GcApi` (single) or `Invoke-GcApiAll` (paged).
3. Shape the output into a flat table (`[pscustomobject]`) with stable column names.
4. Export with `Export-GoldenReport` (CSV always; XLSX if ImportExcel exists).

## Updating the Swagger

When Genesys updates the OpenAPI/Swagger:
1. Replace `specs/swagger.json`
2. Regenerate catalogs:
   ```bash
   python scripts/generate_catalog.py --swagger specs/swagger.json --out generated
   ```
3. Run contract tests:
   ```powershell
   pwsh -File .\tests\Genesys.ContractClient.Tests.ps1
   ```

## Governance hooks (for Strider / admins)

- Allowlist: `registry/allowlist.yaml`
- Paging overrides: `registry/paging-registry.yaml`
- Redaction rules: `registry/pii-redaction.yaml`

For the integration surface, see `src/mcp-server/` (HTTP now; MCP wrapping is straightforward).
