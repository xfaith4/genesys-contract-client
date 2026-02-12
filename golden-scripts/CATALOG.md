# Golden Scripts — Catalog

These scripts are designed to **end pagination folklore on day one**.

- Each script calls exactly **one** Genesys `operationId`
- Paged endpoints use `Invoke-GcApiAll` (deterministic pagination)
- Exports:
  - CSV always
  - XLSX if `ImportExcel` is installed

Outputs: `golden-scripts/out/<timestamp>/`

## Reports

| Script | Report | operationId | What it’s for |
|---|---|---|---|
| `01-Users.ps1` | Users roster | `getUsers` | Identity inventory, drift checks |
| `02-RoutingQueues.ps1` | Queues | `getRoutingQueues` | Routing config visibility |
| `03-RoutingSkills.ps1` | Skills | `getRoutingSkills` | Skill taxonomy + cleanup |
| `04-RoutingWrapupCodes.ps1` | Wrap-up codes | `getRoutingWrapupcodes` | Wrap-up normalization, reporting |
| `05-EdgeExtensions.ps1` | Extensions | `getTelephonyProvidersEdgesExtensions` | Edge/extension audit |
| `06-EdgeDids.ps1` | DIDs | `getTelephonyProvidersEdgesDids` | DID inventory + assignment checks |
| `07-Divisions.ps1` | Divisions | `getAuthorizationDivisions` | Org structure, scoping |
| `20-AnalyticsConversationDetailsQuery.ps1` | Conversations (Details Query) | `postAnalyticsConversationsDetailsQuery` | Historical conversation sets by interval, queue, division (starter) |

## Notes

- If an endpoint is marked `UNKNOWN` for paging, `Invoke-GcApiAll` will refuse. Add an override to `registry/paging-registry.yaml` and regenerate the catalog.
