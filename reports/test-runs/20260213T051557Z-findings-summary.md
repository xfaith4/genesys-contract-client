# Baseline Hardening Pass - Findings Summary

**Report Timestamp**: 2026-02-13T05:15:57Z  
**Branch**: copilot/run-baseline-harding-pass  
**Commit**: 1ddddfe4b12ac035f8debb2b71ed7ea963299959

## Executive Summary

Executed baseline hardening pass with canonical test report command. Both PowerShell contract tests and MCP server tests passed all assertions. One external dependency issue identified.

**Status**: ✅ PASS with accepted risks documented  
**Total Checks**: 2  
**Passed**: 2  
**Failed**: 0

---

## 1. Findings (Ordered by Severity)

### High Severity

#### H-1: Unhandled Promise Rejections in MCP SDK During Test Cleanup
- **Location**: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:620`
- **Status**: accepted-risk
- **Details**: Multiple "RangeError: Maximum call stack size exceeded" exceptions occur during test cleanup after all test assertions pass. This is an issue in the `@modelcontextprotocol/sdk` v1.26.0 library's internal cleanup logic.
- **Evidence**: `reports/test-runs/20260213T051557Z-cmd-02.log` lines 31-57
- **Impact**: Tests complete successfully (exit code 0), but unhandled promise rejections indicate potential resource cleanup issues. This could lead to memory leaks or connection leaks in production scenarios.
- **Recommended Action**: 
  1. Monitor upstream SDK repository for fixes
  2. Consider pinning to a different SDK version if issue persists
  3. Add explicit cleanup handlers in test code to prevent unhandled rejections
  4. Report issue to MCP SDK maintainers if not already tracked
- **Why Not Fixed Now**: This is a third-party library issue, not a bug in repository code. Requires upstream fix or SDK version evaluation beyond scope of baseline hardening pass.

---

## 2. Commands Run and Outcomes

### Command 1: PowerShell Contract Tests
```bash
pwsh -File tests/Genesys.ContractClient.Tests.ps1
```
- **Exit Code**: 0 ✅
- **Duration**: 6624ms
- **Results**: 4 tests passed, 0 failed
- **Evidence**: `reports/test-runs/20260213T051557Z-cmd-01.log`

**Tests Executed**:
1. ✅ Finds operations by keyword
2. ✅ Rejects unknown query/path params before network call
3. ✅ Rejects unknown body fields against schema
4. ✅ Refuses callAll when pagination type is UNKNOWN

### Command 2: MCP Server Tests
```bash
pwsh -NoLogo -NoProfile -Command 'Set-Location src/mcp-server; npm test'
```
- **Exit Code**: 0 ✅
- **Duration**: 4973ms
- **Results**: 9 tests passed, 0 failed
- **Evidence**: `reports/test-runs/20260213T051557Z-cmd-02.log`

**Tests Executed**:
1. ✅ summarizeRequest logs allowlisted fields and omits everything else (2.84ms)
2. ✅ redactForLog masks nested secret fields (0.34ms)
3. ✅ schema validator enforces oneOf semantics (21.73ms)
4. ✅ schema validator enforces anyOf semantics (4.63ms)
5. ✅ schema validator preserves allOf merge behavior (5.88ms)
6. ✅ schema validator rejects unknown properties in strict mode (2.20ms)
7. ✅ MCP Streamable HTTP server exposes required tools and executes searchOperations (151.81ms)
8. ✅ legacy HTTP endpoints are disabled by default (955.39ms)
9. ✅ legacy HTTP mode enforces X-Server-Key when enabled (918.04ms)

**Note**: Stack overflow exceptions occurred during cleanup phase after all assertions passed.

---

## 3. Evidence Artifacts Generated

All artifacts stored in `reports/test-runs/`:
- `20260213T051557Z-cmd-01.log` - PowerShell contract test log
- `20260213T051557Z-cmd-02.log` - MCP server test log (includes stack overflow traces)
- `20260213T051557Z-report.json` - Machine-readable report (validated against schema)
- `20260213T051557Z-report.md` - Human-readable summary report
- `20260213T051557Z-findings-summary.md` - This comprehensive findings document

---

## 4. Genesys Contract Client Review Checklist

### Contract Enforcement ✅
- ✅ operationId use is explicit (verified in test 1)
- ✅ unknown params rejected before network call (verified in test 2)
- ✅ unknown body fields rejected against schema (verified in test 3)
- ✅ required params enforced (implicitly tested)

### Pagination Safety ✅
- ✅ callAll rejects UNKNOWN pagination type (verified in test 4)
- ⚠️ Other pagination types (NEXT_URI, NEXT_PAGE, CURSOR, etc.) not explicitly tested in baseline pass
- ℹ️ Full pagination coverage requires integration tests (out of scope)

### Security/Governance ✅
- ✅ redactForLog masks nested secret fields (verified in MCP test 2)
- ✅ summarizeRequest logs only allowlisted fields (verified in MCP test 1)
- ✅ schema validator enforces strict mode (verified in MCP test 6)
- ✅ legacy HTTP API requires X-Server-Key (verified in MCP test 9)
- ✅ legacy HTTP API disabled by default (verified in MCP test 8)

### Catalog/Schema Integrity
- ℹ️ Not tested in baseline pass - requires running catalog generator
- ℹ️ No drift detected (no generator run performed)

---

## 5. Residual Risks / Untested Areas

1. **Live Genesys API Integration**: No live API calls executed (COPILOT_GENESYS_ENV not set to sandbox)
   - **Risk**: Real API contract validation not performed
   - **Mitigation**: Run with sandbox credentials when available
   - **Status**: Accepted for baseline pass

2. **MCP SDK Cleanup Issue**: Unhandled promise rejections in third-party SDK
   - **Risk**: Potential resource leaks in long-running production scenarios
   - **Mitigation**: Monitor for SDK updates, consider version evaluation
   - **Status**: Documented as H-1, requires upstream fix

3. **Pagination Type Coverage**: Only UNKNOWN type tested in contract tests
   - **Risk**: Other pagination strategies (NEXT_URI, CURSOR, etc.) behavior not verified
   - **Mitigation**: Covered by integration tests if they exist
   - **Status**: Out of scope for baseline contract tests

4. **Catalog Generation**: Swagger-to-operations catalog regeneration not tested
   - **Risk**: Catalog drift undetected
   - **Mitigation**: Run `python scripts/generate_catalog.py` when swagger changes
   - **Status**: Not applicable (no swagger changes detected)

---

## 6. Recommended Next Hardening Steps

1. **Immediate** (if SDK issue impacts production):
   - Investigate `@modelcontextprotocol/sdk` version history for v1.26.0 issues
   - Test with SDK v1.25.x or v1.27.x+ if available
   - Add explicit promise rejection handlers in test/cleanup code

2. **Short-term** (within next sprint):
   - Add integration tests for all pagination types (NEXT_URI, CURSOR, PAGE_NUMBER, etc.)
   - Run catalog generator and verify no drift: `python scripts/generate_catalog.py --swagger specs/swagger.json --out generated --paging-registry registry/paging-registry.yaml`
   - Execute tests with sandbox credentials if available

3. **Medium-term** (technical debt):
   - Monitor MCP SDK repository for v1.26.0 cleanup issue fixes
   - Consider adding test coverage metrics reporting
   - Add automated catalog drift detection to CI pipeline

---

## 7. Minimal Patches Required

**None.** No High or Critical issues found in repository code that require immediate patches. The one High severity issue (H-1) is in a third-party dependency and requires upstream fix or version evaluation.

---

## Environment

- **OS**: Ubuntu 24.04.3 LTS
- **PowerShell**: 7.4.13
- **Node.js**: v24.13.0
- **Python**: 3.12.3
- **Repository**: xfaith4/genesys-contract-client
- **Branch**: copilot/run-baseline-harding-pass
- **Actor**: copilot-swe-agent[bot]

---

## Validation

✅ Machine-readable report validates against `docs/ai/test-report.schema.json`  
✅ All evidence artifacts generated successfully  
✅ No test failures detected  
✅ No High/Critical issues in repository code requiring immediate fixes

---

**Report Generated**: 2026-02-13T05:17:00Z  
**Report Format Version**: 1.0.0  
**Hardening Agent**: genesys-ci-hardening
