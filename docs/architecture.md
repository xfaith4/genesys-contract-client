# Architecture

## Core idea
One **contract source of truth** (Swagger/OpenAPI) drives:

1. Operation selection (operationId)
2. Parameter enforcement (required + no-unknown)
3. Pagination classification + deterministic loops
4. Auditable execution

## Two delivery surfaces
- PowerShell module for engineers (fast adoption)
- HTTP/MCP service for Strider admins (governance + audit)

## Registry-driven hardening
`registry/paging-registry.yaml` should override and document weird endpoints.

## Guide-driven layer
`playbooks/` captures workflow sequences sourced from Genesys guides while still enforcing Swagger legality via operationId + schema validation.
