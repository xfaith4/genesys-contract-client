# Golden Scripts (Genesys Contract Client)

These scripts are designed to **end pagination folklore on day one**.

## Prereqs

Set environment variables:

- `GC_CLIENT_ID`
- `GC_CLIENT_SECRET`
- (optional) `GC_BASE_URL` (e.g. `https://api.usw2.pure.cloud`)
- (optional) `GC_TOKEN_URL` (e.g. `https://login.usw2.pure.cloud/oauth/token`)

Optional for Excel export:

- PowerShell module `ImportExcel` (otherwise CSV-only)

## Run

From repo root:

```powershell
pwsh -File .\golden-scripts\01-Users.ps1
```

Each script:

- dot-sources `00-Setup.ps1`
- calls `Invoke-GcApiAll` with deterministic paging
- writes outputs to `golden-scripts/out/<timestamp>/`

## Notes

- Each script calls an explicit operationId set (single call or a documented sequence).
- If an endpoint is marked `UNKNOWN` for paging, `Invoke-GcApiAll` will refuse. Add an override to `registry/paging-registry.yaml` and regenerate.

### END FILE
