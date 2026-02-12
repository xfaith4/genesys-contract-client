## Blueprint: “Genesys Cloud Contract Client” (library + MCP server)

### Purpose

Create a **single, authoritative way** (for humans *and* agents) to call Genesys Cloud APIs that is:

* **Contract-enforced**: request params/body are validated against OpenAPI; unknown fields rejected.
* **Deterministically paged**: pagination is handled centrally (cursor / nextUri / nextPage / pageNumber, etc.) with an auditable loop.
* **Zero-guessing**: operation selection is explicit (operationId or method+path). No “maybe this endpoint…”
* **Governable**: allowlists, RBAC, audit logs, rate-limit safety, secrets handling.
* **Reusable**: the exact same core logic powers:

  1. a shared engineer-facing client wrapper
  2. a Strider-integrated MCP server

### What you hand to people

* **Engineers:** a client library/wrapper:

  * `Invoke-GcApi -OperationId ...`
  * `Invoke-GcApiAll -OperationId ... -Limit 5000`
* **Strider admins:** a **Genesys MCP server**:

  * `genesys.describe(operationId)`
  * `genesys.call(operationId, params, body)`
  * `genesys.callAll(operationId, params, body, limit?)`

---

## Roadmap (phased, with crisp deliverables)

### Phase 0 — Foundations: spec ingestion + operation catalog

**Goal:** make the OpenAPI spec a first-class input, versioned and testable.

**Deliverables**

* `spec/genesys.swagger.json` (pinned version) + checksum
* An **Operation Catalog** generator producing:

  * `operations.json` (operationId → method/path, required params, request/response schemas, tags)
* CI step: fails if catalog can’t be generated.

**Acceptance**

* Every operationId in swagger appears in the catalog with method/path + schema references.

---

### Phase 1 — Paging brain v1: classify + paginate + audit

**Goal:** deterministic pagination across the major Genesys patterns.

**Deliverables**

* Pagination classifier (schema-based) that labels ops as:

  * `NEXT_URI`, `NEXT_PAGE`, `CURSOR`, `AFTER`, `PAGE_NUMBER`, `TOTALHITS`, `UNKNOWN`
* Paging executor:

  * `CallAll(operationId, ...)` returns consolidated items + **paging audit trail**
* A **Paging Registry** file:

  * `paging-registry.yaml` keyed by operationId for overrides and known oddities
* Standard outputs:

  * `items` (array)
  * `rawPages` (optional)
  * `audit` (pages fetched, stop reason, tokens/nextUri chain, counts)

**Acceptance**

* A curated suite of endpoints (10–20 across types) “fetch-all” correctly, with reproducible audit logs.
* UNKNOWN ops refuse `callAll` with an actionable error (“needs registry entry”).

---

### Phase 2 — Contract enforcement: request validation + safe execution

**Goal:** remove the model/human’s ability to invent params.

**Deliverables**

* Request builder that:

  * validates query/path params and request body against OpenAPI schema
  * rejects unknown fields
  * enforces required fields
* Auth module (client credentials + token caching)
* Rate limiting + retry defaults (safe backoff)
* Redacted logging (no tokens, no PII fields you designate)

**Acceptance**

* Invalid requests fail locally (before call) with clear messages.
* Known transient failures retry safely; no infinite loops.

---

### Phase 3 — Engineer kit: wrapper + docs + golden examples

**Goal:** paved road for your team.

**Deliverables**

* A packaged client:

  * PowerShell module (your team-friendly) **and/or** .NET/TS library depending on adoption
* “Golden Path” scripts:

  * common reporting pulls
  * export patterns (JSON/CSV/Excel)
* `docs/`:

  * how to authenticate
  * how to call by operationId
  * how paging works (one page)

**Acceptance**

* An engineer can pull a report using `CallAll` without touching pagination logic.

---

### Phase 4 — MCP server for Strider: governed tool surface

**Goal:** let Strider call Genesys APIs without being allowed to hallucinate.

**Deliverables**

* Containerized MCP server with tools:

  * `describe`, `call`, `callAll`, `searchOperations`
* Governance features:

  * operation allowlist/denylist (by tag/path/operationId)
  * RBAC mapping (engineer vs admin capabilities)
  * full audit log (who/when/what operationId + request hash)
* Optional: response shaping presets (e.g., “entities-only”, “full”)

**Acceptance**

* Strider can only perform allowed operations and always gets validated responses.
* All calls are audit logged with paging traces.

---

### Phase 5 — Hardening: drift control + tests + release discipline

**Goal:** keep it correct as Genesys evolves.

**Deliverables**

* Spec update workflow:

  * pull new swagger → diff operationIds/schemas → run contract tests → publish release
* Contract tests:

  * paging tests per category
  * schema validation tests
* Observability:

  * structured logs, request timing, rate-limit events
* Documentation for admins: “how to upgrade safely”

**Acceptance**

* A spec upgrade that breaks paging is caught in CI before rollout.

---

## Execution plan: how we actually build it (concrete steps)

### Step 1 — Extract + normalize swagger input

1. Unzip your swagger bundle(s).
2. Choose the canonical swagger file (or merge if you have multiple regions/specs).
3. Normalize:

   * ensure operationIds are unique
   * resolve `$ref` so validation is straightforward (you can keep refs but you’ll need resolver)

**Output**

* `spec/swagger.json` (pinned)
* `spec/metadata.json` (source + hash + timestamp)

---

### Step 2 — Generate the Operation Catalog

Build a generator that outputs for each `operationId`:

* method, path, tags
* parameters (path/query/header) with required flags
* requestBody schema (if present)
* response schema summary (top-level properties + likely items array path)

**Output**

* `generated/operations.json`
* `generated/operations.md` (optional human browse)

---

### Step 3 — Implement the Pagination Classifier

Classifier logic (in order):

1. If `paging-registry.yaml` has an entry → use it.
2. Else inspect response schema top-level properties:

   * `nextUri`, `nextPage`, `cursor`, `after`
   * `pageNumber/pageSize/pageCount/total`
   * `totalHits`
3. Infer items path:

   * prefer `entities`, else `results`, else first array property in response schema
4. If ambiguous → mark UNKNOWN

**Output**

* `generated/pagination-map.json` (operationId → type, itemsPath, param locations)

---

### Step 4 — Build the core call engine

A single core function used by both wrapper + MCP:

* `describe(operationId)` → returns method/path + paging type + schemas
* `call(operationId, params, body)`:

  * validate inputs
  * build URL + querystring
  * execute request (auth, retry, throttle)
* `callAll(...)`:

  * run `call(...)`
  * extract items
  * update paging token (cursor/nextUri/nextPage/pageNumber)
  * stop on deterministic condition
  * emit audit trail

**Audit record example (fields)**

* operationId, start/end time, pagesFetched
* stopReason (missing nextUri / reached pageCount / limit / empty items)
* tokens chain (redacted if needed)
* totalItems

---

### Step 5 — Engineer wrapper layer

If you want “most ideal” for your team quickly: **PowerShell module** that wraps the core engine.

* `Invoke-GcApi` (single)
* `Invoke-GcApiAll` (paged)
* Helpers:

  * `Find-GcOperation` (search by keyword/tag → operationId list)
  * `Get-GcOperationHelp` (shows required params + examples)

This gives you immediate adoption while the MCP server matures.

---

### Step 6 — MCP server layer for Strider

Wrap the same core engine in a service.

Implementation choices (pick based on your environment standards):

* **.NET Minimal API** (very enterprise-friendly; easy auth, logging, packaging)
* **Node/TypeScript** (often easiest in MCP ecosystems)

Core requirement: the MCP tool interface must *force*:

* operationId
* params/body objects that validate
* `callAll` does paging centrally

---

## Repo structure (recommended)

```
genesys-contract-client/
  spec/
    swagger.json
    metadata.json
  registry/
    paging-registry.yaml
    allowlist.yaml
    pii-redaction.yaml
  src/
    core/              # OpenAPI resolver, validator, paginator, http client
    ps-module/         # engineer wrapper (optional)
    mcp-server/        # Strider integration surface
  generated/
    operations.json
    pagination-map.json
  tests/
    contract/
    paging/
  docs/
```

---

## “Definition of Done” (the bar you want)

A solution counts as “done” when:

* No user or model can call an endpoint without selecting the correct operationId.
* Invalid params/bodies are rejected before the request leaves your network.
* `callAll` works for the known paging patterns and produces a paging audit.
* UNKNOWN pagination does **not** silently guess — it fails and points to the registry entry you need.
* Strider integration uses only `describe/call/callAll` tools, with allowlists + audits.

---

## Next immediate build tasks (the “start Monday” list)

1. Create repo skeleton + pin swagger + generate `operations.json`.
2. Implement schema resolver + validator (top priority).
3. Implement classifier + `pagination-map.json` generator.
4. Implement `call` + `callAll` core engine + audit.
5. Add first 15 endpoint contract tests spanning pagination patterns.
6. Publish PowerShell wrapper v0.1 to your team.
7. Wrap core into MCP server v0.1 with allowlist + audit logs.

This path gets engineers value early and keeps Strider integration clean and governable. The weirdness stays centralized, where it belongs.


## Status (auto)
- ✅ Spec pinned in `specs/swagger.json`
- ✅ Catalog generated (`generated/operations.json`)
- ✅ Pagination map generated (`generated/pagination-map.json`)
- ✅ PowerShell module scaffolded (`src/ps-module`)
- ✅ Node integration surface scaffolded (`src/mcp-server`)
