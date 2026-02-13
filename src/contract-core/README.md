# Genesys Contract Core

Shared contract enforcement engine for Genesys Cloud:

- OpenAPI/catalog loading
- Governance policy loading and redaction
- Request validation and deterministic pagination
- Core call/callAll execution behavior

Build:

```bash
cd src/contract-core
npm install
npm run build
```

Test:

```bash
npm test
```

This package is consumed by `src/mcp-server` via the build pipeline.
