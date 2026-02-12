# Stakeholder Map: Genesys Contract Client

This repo has two responsibilities:
1. enforce what is legally callable from Swagger/OpenAPI,
2. encode guide-derived workflows as playbooks/scripts.

## Primary stakeholder surfaces

### API Explorer
- Why it matters: endpoint and operation discovery for engineers/admins.
- Repo alignment:
  - `generated/operations.json` is the canonical operation catalog.
  - `POST /searchOperations` and `genesys.searchOperations` provide search against that catalog.
  - `describe` exposes the operation contract, paging model, security scopes, and permissions.

### AudioHook
- Why it matters: real-time voice media integration with strict rate and latency constraints.
- Repo alignment:
  - No direct AudioHook transport implementation is added here.
  - Conversation forensics scripts and playbooks (`30-*`, `playbooks/conversations.yaml`) provide investigation/report surfaces that pair with AudioHook operational workflows.
  - Governance defaults (allowlist/denylist, SSRF protection, strict validation) reduce blast radius for any voice-adjacent automation.

### CX as Code
- Why it matters: infrastructure-as-code workflows for Genesys resources and policies.
- Repo alignment:
  - read-only-by-default contract calls and operation allowlist/denylist provide a safer control plane.
  - generated catalog + deterministic paging gives predictable data pull behavior for validation/export workflows.

### SDK ecosystem
- Why it matters: official SDKs are generated from public Swagger contracts.
- Repo alignment:
  - same contract source (`specs/swagger.json`) drives operation and paging catalogs.
  - schema validation in both Node and PowerShell wrappers keeps calls spec-constrained.

### Developer Guides
- Why it matters: practical best-practice sequences and usage patterns.
- Repo alignment:
  - conversations guide content is encoded in `playbooks/conversations.yaml`.
  - golden scripts implement these sequences in runnable form.
