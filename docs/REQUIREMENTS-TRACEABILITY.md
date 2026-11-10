# Requirements traceability

Source: **B** = project brief (`Microsoft_Containment_Assurance_Refined_VSlice.md`, section), **W** = wireframe, **C** = master execution contract (section). Evidence: VERIFIED / INFERRED / SYNTHETIC / PROPOSED. Status per the contract's vocabulary; "EXECUTED_AND_VERIFIED" means an automated test ran and passed in this build (see TEST-REPORT.md).

Test file keys: VS = `tests/integration/vertical-slice.test.ts`, WF = `workflow.test.ts`, DI = `data-import.test.ts`, PU = `tests/unit/policy.test.ts`, EX = `extractor.test.ts`, HC = `http-client.test.ts`, E2E-R = `tests/e2e/review.spec.ts`, E2E-W = `tests/e2e/workflow.spec.ts`.

| ID | Requirement | Source | Evidence | Pri | Implementation | Test | Status |
|---|---|---|---|---|---|---|---|
| R1 | One event `ManualIsolationRequested` | B§11 | PROPOSED | P0 | `orchestrator.submitEvent`, contracts `ManualIsolationRequested` | VS, WF | EXECUTED_AND_VERIFIED |
| R2 | Decision `REQUIRE_DUAL_APPROVAL` with documented reason codes | B§11, §15 | PROPOSED | P0 | `policy.ts` | PU, VS | EXECUTED_AND_VERIFIED |
| R3 | One tool `stageContainmentApproval`, called exactly once | B§11 | PROPOSED | P0 | `ItsmPort.stageContainmentApproval` → ITSM `POST /approval-packets` | VS, WF (concurrent) | EXECUTED_AND_VERIFIED |
| R4 | State `RESPONSE_READY → WAITING_FOR_DUAL_APPROVAL` | B§11 | PROPOSED | P0 | `GateStore.transition` (allow-list + version) | VS, E2E-R | EXECUTED_AND_VERIFIED |
| R5 | Read-back verifies incident, machine, approvers, hashes, policy, expiry | B§18.3 | PROPOSED | P0 | `orchestrator.stage` verify block | VS, WF (corrupt read-back) | EXECUTED_AND_VERIFIED |
| R6 | Zero device mutations; tool cannot isolate | B§7, §16 | PROPOSED | P0 | Gate token lacks `machine.isolate`; device + machine-action re-check | VS, WF, E2E-R | EXECUTED_AND_VERIFIED |
| R7 | Missing / stale / ambiguous evidence → no mutation | B§18.5–7 | PROPOSED | P0 | Policy R1; identity resolution | PU, WF, VS, E2E-R | EXECUTED_AND_VERIFIED |
| R8 | Agent abstention → MANUAL_REVIEW, no mutation | B§13C, §18.8 | PROPOSED | P0 | extractor conflict detection; policy R2 | EX, WF | EXECUTED_AND_VERIFIED |
| R9 | Untrusted text cannot override policy (prompt injection) | B§18.9 | PROPOSED | P0 | `findUntrustedInstructions`, strict schema, citation verification | EX, WF | EXECUTED_AND_VERIFIED |
| R10 | Model-produced action/payload rejected by schema | B§18.10 | PROPOSED | P0 | `OperationalConstraintExtraction` (strict), ITSM strict tool schema | EX, WF | EXECUTED_AND_VERIFIED |
| R11 | Duplicate event returns existing request/packet; no duplicate notification | B§13D, §18.11 | PROPOSED | P0 | eventId uniqueness, open-request folding, idempotency key | WF | EXECUTED_AND_VERIFIED |
| R12 | Stale incident version fails closed; reload context | B§13E, §18.12 | VERIFIED (no Graph ETag) → sim revision | P0 | stage precheck → `REEVALUATION_REQUIRED` | WF | EXECUTED_AND_VERIFIED |
| R13 | Partial source failure visible and auditable | B§18.13 | PROPOSED | P1 | `SOURCE_UNAVAILABLE_*`, trace attempts, audit | WF | EXECUTED_AND_VERIFIED |
| R14 | Expiry → EXPIRED, never auto-approves | B§18.14 | PROPOSED | P1 | ITSM lazy expiry; Gate sync | WF | EXECUTED_AND_VERIFIED |
| R15 | Defender/CMDB disagreement → stricter path, exposed | B§13F | PROPOSED | P1 | `CRITICALITY_CONFLICT` | PU, WF | EXECUTED_AND_VERIFIED |
| R16 | 30-second UI: action, risk, decision, next step; three cards; "No containment executed" | B§17, W | PROPOSED | P0 | `RequestWorkspace.tsx` | E2E-R | EXECUTED_AND_VERIFIED (render + content); 30-s comprehension NOT_VERIFIED with users |
| R17 | Technical evidence collapsed; rendered from execution record | B§17–18.16 | PROPOSED | P1 | `Inspector.tsx` reads persisted runs/audit | E2E-R | EXECUTED_AND_VERIFIED |
| R18 | All fixtures/metrics labelled synthetic | B§18.19 | SYNTHETIC | P1 | header pill, footer, seed comments, workbook README | manual review | IMPLEMENTED |
| R19 | Approvals with two distinct accountable owners; separation of duties | B§11, C§7 | PROPOSED | P1 | ITSM `decide` rules | WF, E2E-W | EXECUTED_AND_VERIFIED |
| R20 | Faults: timeout, 429, 5xx, 401, 404, 409 with controlled handling | C§4, §11 | PROPOSED | P1 | `FaultInjector`, `HttpJsonClient` | WF, HC | EXECUTED_AND_VERIFIED |
| R21 | Lost response after commit does not duplicate; reconciliation | C§7, §11 | PROPOSED | P1 | outbox + idempotency + reconcile | WF | EXECUTED_AND_VERIFIED |
| R22 | Reset/replay; logs derive from execution | C§3, §11 | PROPOSED | P1 | `/api/lab/reset`, persisted runs | WF | EXECUTED_AND_VERIFIED |
| R23 | XLSX template with README/schema, versioned | C§5 | PROPOSED | P1 | `workbook-schema.ts`, `buildWorkbook` | DI | EXECUTED_AND_VERIFIED |
| R24 | Import validation (types, enums, keys, refs, dates, invariants), preview, confirm, atomic commit, re-query | C§5 | PROPOSED | P1 | `data-studio.ts` | DI, E2E-W | EXECUTED_AND_VERIFIED |
| R25 | Import negative cases incl. oversized, stale revision, repeat import | C§5 | PROPOSED | P1 | same | DI | EXECUTED_AND_VERIFIED |
| R26 | Export with formula-injection protection; record browser; history; restore | C§5 | PROPOSED | P1 | same | DI | EXECUTED_AND_VERIFIED |
| R27 | Imported data changes subsequent decisions | C§4–5 | PROPOSED | P0 | shared simulator state | DI, E2E-W | EXECUTED_AND_VERIFIED |
| R28 | SIMULATED/SANDBOX/LIVE modes; fail closed; explicit switch back | C§6 | PROPOSED | P2 | `system.ts buildGate`, `sandbox.ts` | WF | EXECUTED_AND_VERIFIED |
| R29 | Optional model provider adapter, fails closed when unconfigured | C§7 | PROPOSED | P2 | `model-extractor.ts` | EX (stubbed fetch) | EXECUTED_AND_VERIFIED (stub); live NOT_VERIFIED |
| R30 | Secrets not in browser bundle or source | C§6, §11 | PROPOSED | P1 | `scripts/secret-scan.ts`, `envPrefix` | `npm run secret-scan` | EXECUTED_AND_VERIFIED |
| R31 | Keyboard use and responsive layout | C§8, §11 | PROPOSED | P1 | CSS, semantic controls | E2E-W | EXECUTED_AND_VERIFIED (basic checks) |
| R32 | Append-only, tamper-evident audit | B§16 | PROPOSED | P1 | triggers + hash chain | WF | EXECUTED_AND_VERIFIED |
| R33 | Penpot-compatible SVG screens | C§8 | — | P2 | — | — | NOT_IMPLEMENTED |
| R34 | Real Graph/Defender and ServiceNow adapters | C§6 | TO_VERIFY | P2 | placeholders only | WF (fail closed) | NOT_IMPLEMENTED |
| R35 | Discovery research (interviews, tabletop) | B§6 | — | — | outside a code prototype | — | NOT_IMPLEMENTED |
