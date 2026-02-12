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
| `30-Convo-ForensicsById.ps1` | Conversation forensics | `getConversation`, `getConversationsCall`, wrapup ops, `getAnalyticsConversationDetails` | Single-conversation investigation and wrap-up trace |
| `31-Convo-DetailsByInterval.ps1` | Details by interval | `postAnalyticsConversationsDetailsQuery` | Timeboxed conversation extracts |
| `32-Convo-DetailsByQueueOrDivision.ps1` | Details by queue/division | `postAnalyticsConversationsDetailsQuery` | Queue/division scoped investigations |
| `33-Convo-DetailsJobExport.ps1` | Async details export | `postAnalyticsConversationsDetailsJobs`, `getAnalyticsConversationsDetailsJob`, `getAnalyticsConversationsDetailsJobResults` | Large dataset export via async jobs |

## Notes

- If an endpoint is marked `UNKNOWN` for paging, `Invoke-GcApiAll` will refuse. Add an override to `registry/paging-registry.yaml` and regenerate the catalog.
