# Integrations — what is real, what is simulated, and how to connect later

Nothing in this repository talks to Microsoft, ServiceNow or a model provider by default. The SANDBOX/LIVE adapters in `server/src/gate/adapters/sandbox.ts` are **placeholders that fail closed**: missing configuration → setup error; present configuration → every call throws `ADAPTER_NOT_VERIFIED`. They never fall back to simulated data. Items marked **TO_VERIFY** were not confirmed against a live tenant.

Credential rules (all providers): server-side environment only (`.env`, never committed — see `.env.example`); never in browser code, fixtures, logs or URLs; least-privilege read scopes; rotate on exposure. `npm run secret-scan` checks the bundle and source.

---

## 1. Microsoft Defender XDR / Microsoft Graph security (SecurityPort)

**Purpose:** read incident, alerts, device, criticality and a bounded live-activity summary. **Never** isolate.

| Port method | Proposed real call | Status |
|---|---|---|
| `getIncident`, `listIncidents` | Graph `GET /security/incidents/{id}?$expand=alerts` | VERIFIED resource exists; HTTP paths follow the standard Graph pattern — TO_VERIFY on the method pages |
| `getDevice`, `listDevices` | Defender for Endpoint `GET /api/machines/{id}` | TO_VERIFY |
| `getActivitySummary` | Advanced hunting query aggregating recent network sessions | TO_VERIFY (query and table) |
| `getMachineActions` | Defender for Endpoint machine actions list | TO_VERIFY |
| *(not used)* isolate | `POST https://api.security.microsoft.com/api/machines/{id}/isolate`, `Machine.Isolate`, 100/min | VERIFIED — deliberately **not** granted |

Mapping notes: Graph incidents have **no version/ETag** (VERIFIED) — map `revision` to `lastUpdateDateTime` and compare timestamps before staging. Severity has no `critical`. Criticality from Exposure Management has multiple levels — map to `CRITICAL|STANDARD|UNKNOWN` conservatively (unknown → UNKNOWN, which fails closed).

Setup (sandbox): Entra app registration in a test tenant → application permissions for *read* scopes only (exact names TO_VERIFY, e.g. incident read and machine read) → admin consent → set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` → implement each method in `GraphDefenderSecurityAdapter` with token acquisition (client credentials) → add contract tests that run the existing integration suite against the adapter → health check: `listIncidents` returns 200. Prefer a managed identity / certificate over a client secret outside local testing. Rate limits: honour `Retry-After`; the shared `HttpJsonClient` already backs off on 429.

## 2. ServiceNow CMDB / approvals (ItsmPort)

**Purpose:** resolve the device to one CI, read owner, relationships, change freezes and runbooks; create one approval record; read it back.

| Port method | Proposed real call | Status |
|---|---|---|
| `findConfigItemsByMachine` | Table API `GET /api/now/table/cmdb_ci_server?sysparm_query=...` (correlation by Defender machine id or hostname) | TO_VERIFY per instance |
| `getConfigItemBundle` | CI + `cmdb_rel_ci` relationships + owner + change schedule/blackout + knowledge/runbook record | TO_VERIFY — tables differ by customer |
| `listUsers` | `sys_user` + on-call schedule | TO_VERIFY |
| `stageContainmentApproval` | Create a change/approval record with a correlation id = idempotency key; dedupe on it | TO_VERIFY — design per customer flow |
| `getApprovalPacket`, `findApprovalPacketByKey`, `listApprovalPackets`, `recordApprovalDecision` | approval records (`sysapproval_approver` or a Flow Designer flow) | TO_VERIFY |

References (not verified for this design): [ServiceNow Table API](https://docs.servicenow.com/bundle/utah-api-reference/page/integrate/inbound-rest/concept/c_TableAPI.html), [Identification and Reconciliation API](https://docs.servicenow.com/bundle/vancouver-api-reference/page/integrate/inbound-rest/concept/c_IdentifyReconcileAPI.html).

Setup (sandbox): personal developer instance → integration user with read on CMDB tables and create/read on the chosen approval table only → set `SERVICENOW_INSTANCE`, `SERVICENOW_USER`, `SERVICENOW_PASSWORD` (prefer OAuth client credentials) → implement `ServiceNowItsmAdapter` → enforce idempotency with a unique correlation field → run the integration suite against it → health check: one CI read. Rollback: switch `INTEGRATION_MODE=SIMULATED`; approval records created in the sandbox can be cancelled there.

## 3. Optional model-backed constraint extractor

`server/src/gate/extractor/model-extractor.ts` (`EXTRACTOR_PROVIDER=anthropic`). Sends the CI's documents (wrapped as untrusted data) to the Messages API and parses one JSON object. **Status: compiled and unit-tested with a stubbed fetch; NOT_VERIFIED against a live model.**

Setup: `ANTHROPIC_API_KEY` (server only) and `EXTRACTOR_MODEL_ID` (no default is assumed). Whatever the model returns is passed through `verifyExtraction`: strict schema (no decision/action fields), cited document and version must exist, quote must appear verbatim, confidence ≥ 0.7, instruction-like quotes dropped. Any failure → abstain → `MANUAL_REVIEW`. Provider errors also abstain; there is no silent fallback to "no constraints". Cost/latency: one call per evaluation, 15 s timeout, 1,500 max output tokens.

## 4. Approval notification channel (e.g. Teams)

Not implemented. The ITSM simulator records notifications; a production design would let ServiceNow (or a Teams adaptive card) notify approvers, with decisions flowing back through the ITSM approval record — never through the Gate directly.

## Health checks and smoke tests

`GET /api/health` (Gate) · `GET /sim/security/api/_health` · `GET /sim/itsm/api/_health`. A future live smoke test should: read one incident, resolve one CI, stage one approval in a sandbox with a test idempotency key, read it back, and cancel it.
