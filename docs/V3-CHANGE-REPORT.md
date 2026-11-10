# V3 change report

Project: Business Impact Gate (Microsoft Containment Assurance), synthetic prototype. Branch `enhance/gate-v3`, baseline tag `v3-baseline` (`ac62921`), final application commit `76f0cb4`. Every number below comes from a command that was run in this build environment (Linux, Node v22.22.0, Chromium for Playwright at a local path). Nothing was pushed, published or deployed.

## 1. Baseline versus final

| Check | Baseline (`v3-baseline`, observed at the start of V3) | Final (`76f0cb4`, observed) |
|---|---|---|
| `npm run typecheck` | 0 errors | 0 errors |
| `npm run lint` | 0 problems | 0 problems |
| `npm test` (Vitest) | 6 files, 92 tests passed | 29 files, 237 tests passed |
| `npm run build` | built | built |
| `npm run secret-scan` | 3 bundle files, 65 source files, passed | 3 bundle files, 113 source files, passed |
| `npm run test:e2e` (Playwright) | 8 passed | 27 passed (two servers: gate off, gate on) |
| `npm run verify` exit code | 0 | 0 |

Historical numbers in `docs/TEST-REPORT.md` (92 tests, 8 E2E) describe the pre-V3 delivery and match the observed baseline. Every change below was committed only after the full `npm run verify` passed and an em dash check of the added lines returned 0.

## 2. Change register

Statuses: PASSED, DEFERRED (with reason, nothing changed in code), and for wave 6 the deployment labels TESTED_LOCALLY and CONFIGURED. No change is BLOCKED. The full register with test evidence, migration, demo effect and rollback notes is in `docs/IMPLEMENTATION-STATUS.md`. Rollback for any row: `git revert <SHA>`; each change is one commit.

| ID | Status | Git SHA |
|---|---|---|
| CH-1 Reads go through the port | PASSED | `43ca056` |
| CH-2 Typed payload accessors | PASSED | `6d9996e` |
| CH-3 Summary counters | DEFERRED | `c3632aa` |
| CH-4 Write and undo allocations | DEFERRED | `43358ca` |
| CH-5 Approval escalation | DEFERRED | `aa5b4c7` |
| CH-6 Possible duplicate request | PASSED | `874553a` |
| CH-7 Impact projection | PASSED | `bec0d58` |
| CH-8 Device history | PASSED | `9f2fb17` |
| CH-9 Bulk approvals | PASSED | `cffa824` |
| CH-10 Comparison bars | PASSED | `ec0f4c2` |
| CH-11 Collapsible history | PASSED | `9a3b183` |
| CH-12 Source badges | PASSED | `946012e` |
| CH-13 Demo role switch on blocked action | PASSED | `2d1dc47` |
| CH-14 Lifecycle stepper | PASSED | `949e841` |
| CH-15 Truthful empty states | PASSED | `d46f737` |
| CH-16 Policy provenance | PASSED | `f119e43` |
| CH-17 Audit hash chain verification | PASSED | `9b87162` |
| CH-18 Audit evidence package | PASSED | `34ee8a4` |
| CH-19 Evidence check matrix | PASSED | `fe018cd` |
| CH-L1 Existing-label clean-up (scheduled after CH-19) | PASSED | `4eaee87` |
| CH-20 Portfolio access gate | TESTED_LOCALLY | `ed2a0bd` |
| CH-21 Analytics after entry | CONFIGURED (no Clarity project ID provided; off). Loading rules TESTED_LOCALLY with a made-up ID and a local stand-in for clarity.ms | `76f0cb4` |
| CH-22 Single-VPS packaging | TESTED_LOCALLY (22A, process without Docker); image CONFIGURED; 22B not deployed | `c86ca76` |

Order note: wave 6 was committed CH-22, CH-20, CH-21, following the spec's own safest order (CH-22A container and persistence dry run before the access gate). CH-L1 (existing-label clean-up) was added after CH-19 as you asked.

On "CH-1 to CH-19 all PASSED": CH-3, CH-4 and CH-5 are DEFERRED, not PASSED. Inspection showed nothing for them to change: there is no summary counter or cap (CH-3); no multi-part write, money or undo exists, because the Gate never isolates or reverses anything (CH-4); and approval packets expire after 15 minutes with no higher role in the seed, so a 72-hour escalation cannot happen (CH-5). Building them would have meant inventing domain features. Each has its own commit recording the reason.

### Files per change

### 43ca056 ch: CH-1: domain reads go through the port
docs/ARCHITECTURE.md packages/contracts/src/canonical.ts packages/contracts/src/domain.ts server/src/gate/adapters/ports.ts server/src/gate/adapters/simulated.ts server/src/gate/orchestrator.ts server/src/gate/store.ts server/src/imports/data-studio.ts simulators/itsm/itsm-sim.ts tests/integration/adapter-contract.test.ts tests/unit/http-client.test.ts tests/unit/port-boundary.test.ts 
### 6d9996e ch: CH-2: typed payload accessors
docs/SIMULATOR-CONTRACTS.md packages/contracts/src/domain.ts server/src/gate/adapters/http-client.ts server/src/gate/adapters/ports.ts server/src/gate/adapters/simulated.ts server/src/gate/orchestrator.ts tests/integration/typed-responses.test.ts tests/unit/http-client.test.ts 
### c3632aa ch: CH-3: summary counters deferred

### 43358ca ch: CH-4: write and undo allocations deferred

### aa5b4c7 ch: CH-5: approval escalation deferred

### 874553a ch: CH-6: possible duplicate request detection
app/src/components/LabPage.tsx app/src/components/RequestWorkspace.tsx app/src/components/ReviewPage.tsx app/src/types.ts docs/ARCHITECTURE.md docs/DECISION-LOG.md fixtures/scenarios/optional.ts packages/contracts/src/domain.ts server/src/gate/orchestrator.ts server/src/gate/policy.ts server/src/gate/store.ts server/src/system.ts tests/e2e/workflow.spec.ts tests/integration/possible-duplicate.test.ts tests/integration/vertical-slice.test.ts tests/unit/policy.test.ts 
### bec0d58 ch: CH-7: read-only impact projection for approvers
app/src/components/ApprovalsPage.tsx app/src/impact.ts app/src/types.ts server/src/gate/orchestrator.ts tests/e2e/workflow.spec.ts tests/integration/workflow.test.ts tests/unit/impact.test.ts 
### 9f2fb17 ch: CH-8: trailing device history
app/src/components/RequestWorkspace.tsx app/src/history.ts app/src/types.ts server/src/gate/orchestrator.ts server/src/gate/policy.ts server/src/gate/store.ts tests/e2e/review.spec.ts tests/integration/device-history.test.ts tests/unit/history.test.ts 
### cffa824 ch: CH-9: per-item bulk approvals
app/src/components/ApprovalsPage.tsx server/src/gate/orchestrator.ts server/src/system.ts tests/e2e/workflow.spec.ts tests/integration/bulk-approvals.test.ts 
### ec0f4c2 ch: CH-10: evidence-age comparison bars
app/src/ageBar.ts app/src/components/RequestWorkspace.tsx app/src/styles.css tests/e2e/review.spec.ts tests/unit/age-bar.test.ts 
### 9a3b183 ch: CH-11: collapsible activity history
app/src/activity.ts app/src/components/RequestWorkspace.tsx tests/e2e/review.spec.ts tests/unit/activity.test.ts 
### 946012e ch: CH-12: separate source badges for criticality
app/src/components/RequestWorkspace.tsx app/src/sourceBadge.ts tests/e2e/review.spec.ts tests/unit/source-badge.test.ts 
### 2d1dc47 ch: CH-13: inline demo role switch on a blocked action
app/src/App.tsx app/src/components/ReviewPage.tsx app/src/types.ts server/src/gate/orchestrator.ts server/src/system.ts tests/e2e/review.spec.ts tests/integration/workflow.test.ts 
### 949e841 ch: CH-14: lifecycle stepper
app/src/components/RequestWorkspace.tsx app/src/lifecycle.ts app/src/styles.css packages/contracts/src/lifecycle.ts server/src/gate/store.ts tests/e2e/review.spec.ts tests/unit/lifecycle.test.ts 
### d46f737 ch: CH-15: truthful empty states
app/src/components/ApprovalsPage.tsx app/src/components/DataStudioPage.tsx app/src/components/ReviewPage.tsx tests/e2e/workflow.spec.ts 
### f119e43 ch: CH-16: policy provenance
app/src/activity.ts app/src/components/RequestWorkspace.tsx app/src/types.ts server/src/gate/orchestrator.ts server/src/gate/policy.ts server/src/gate/store.ts tests/e2e/review.spec.ts tests/fixtures/legacy-gate-v0.sql tests/integration/policy-provenance.test.ts tests/unit/policy.test.ts 
### 9b87162 ch: CH-17: audit hash chain verification with end-of-chain anchor
app/src/auditCheck.ts app/src/components/Inspector.tsx docs/ARCHITECTURE.md server/src/gate/store.ts server/src/system.ts tests/e2e/review.spec.ts tests/integration/audit-chain.test.ts tests/unit/audit-check.test.ts 
### 34ee8a4 ch: CH-18: audit evidence package export
app/src/components/EvidenceExport.tsx app/src/components/RequestWorkspace.tsx docs/SIMULATOR-CONTRACTS.md server/src/gate/evidence-package.ts server/src/gate/orchestrator.ts server/src/gate/store.ts server/src/system.ts tests/e2e/review.spec.ts tests/integration/evidence-package.test.ts 
### fe018cd ch: CH-19: evidence check matrix recorded by the policy engine
app/src/components/EvidenceChecks.tsx app/src/components/RequestWorkspace.tsx app/src/evidenceChecks.ts app/src/types.ts docs/ARCHITECTURE.md packages/contracts/src/domain.ts server/src/gate/evidence-package.ts server/src/gate/orchestrator.ts server/src/gate/policy.ts tests/e2e/review.spec.ts tests/integration/evidence-checks.test.ts tests/unit/evidence-checks-text.test.ts tests/unit/evidence-checks.test.ts 
### 4eaee87 ch: CH-L1: existing-label clean-up
app/src/App.tsx app/src/components/ApprovalsPage.tsx app/src/components/DataStudioPage.tsx app/src/components/EvidenceExport.tsx app/src/components/LabPage.tsx app/src/components/RequestWorkspace.tsx app/src/components/ReviewPage.tsx app/src/styles.css app/src/ui.tsx docs/DECISION-LOG.md fixtures/seed.ts server/src/gate/orchestrator.ts server/src/gate/policy.ts server/src/imports/data-studio.ts server/src/imports/workbook-schema.ts server/src/index.ts tests/e2e/review.spec.ts tests/e2e/workflow.spec.ts tests/unit/labels.test.ts 
### c86ca76 ch: CH-22: vps production packaging
.dockerignore .env.example .gitignore Dockerfile README.md docs/DEPLOYMENT.md eslint.config.js package-lock.json package.json scripts/backup.ts scripts/bootstrap.ts scripts/rehearse-image.sh server/src/config.ts server/src/gate/store.ts server/src/index.ts server/src/ops/backup.ts server/src/ops/production.ts server/src/system.ts simulators/shared/infra.ts tests/integration/production-ops.test.ts 
### ed2a0bd ch: CH-20: four-digit visitor access gate
.env.example .gitignore app/src/App.tsx app/src/api.ts app/src/styles.css app/src/types.ts docs/ACCESS-AND-ANALYTICS.md docs/DEPLOYMENT.md playwright.config.ts scripts/rehearse-image.sh server/src/access/access-gate.ts server/src/access/gate-page.ts server/src/config.ts server/src/ops/production.ts server/src/system.ts tests/e2e/access.spec.ts tests/integration/access-gate.test.ts tests/integration/production-ops.test.ts 
### 76f0cb4 ch: CH-21: analytics only after project entry
.env.example app/src/App.tsx app/src/analytics.ts app/src/components/AnalyticsNotice.tsx app/src/components/EvidenceExport.tsx app/src/components/ReviewPage.tsx app/src/styles.css app/src/types.ts docs/ACCESS-AND-ANALYTICS.md playwright.config.ts server/src/config.ts server/src/system.ts tests/e2e/access.spec.ts tests/unit/analytics.test.ts

## 3. Invariant evidence

| Invariant | How this project holds it | Evidence (test) |
|---|---|---|
| Authority gateway | The only binding write is `ItsmPort.stageContainmentApproval`; the Gate's security token has no `machine.isolate` scope | `vertical-slice.test.ts` "the Gate token is structurally unable to isolate a device"; `port-boundary.test.ts` (CH-1) |
| Forged or wrong role rejected | Roles come from the ITSM user directory, never from the client; unknown or inactive identity gives 401, wrong role 403 | `workflow.test.ts` "service owners cannot raise containment requests; missing identity is rejected", "two distinct assigned approvers are required"; `bulk-approvals.test.ts` (CH-9); `evidence-package.test.ts` export scope (CH-18) |
| Stale revision rejected | Pre-write incident revision check and simulator `If-Match` | `workflow.test.ts` "stale incident revision fails closed", "simulator rejects a stale If-Match revision with 409"; `bulk-approvals.test.ts` STALE_STATUS |
| Idempotent replay | Idempotency key over event, revision, machine, action; outbox payload; reconciliation | `workflow.test.ts` "repeated and concurrent stage calls create exactly one packet", "write committed but response lost", "reconciliation"; `audit-chain.test.ts` repeated stage writes no second staged row |
| Per-part bounds | Not applicable: no quantities or money in this domain (CH-4 deferred) | n/a |
| Message freshness | Evidence age limits (CMDB 60 min, activity 15 min), evaluation valid 5 min, policy version re-checked at stage | `workflow.test.ts` "an evaluation older than the staging window must be refreshed"; `policy-provenance.test.ts` POLICY_CHANGED (CH-16); evidence-age E2E (CH-10) |
| Fail closed outside SIMULATED | SANDBOX and LIVE adapters refuse to return data; export and every API need setup | `workflow.test.ts` SANDBOX and LIVE tests; `evidence-package.test.ts` "outside SIMULATED mode without configuration the export fails closed" |
| Compensating reversal | Not applicable: the Gate makes no reversible device change; a rejected or expired packet simply closes | `workflow.test.ts` "one rejection closes the packet", "expiry never approves" |
| Original demo integrity | All six seeded scenarios keep their decisions and reason codes; evidence hashes for the primary scenario are identical to baseline except `policyInput` (one new field in CH-6, decision V3-1) | `workflow.test.ts` seeded scenario tests; `evidence-checks.test.ts` (CH-19) re-runs all six; hash comparison script output identical from CH-6 to CH-19 |
| Bulk keeps per-record authority | Bulk approval runs the single-item decision path per packet with its own role check, expected status and audit row | `bulk-approvals.test.ts` (CH-9) |

## 4. Migrations

All migrations are additive and run on open, inside a transaction, and are safe to repeat.

| Change | Migration | Verified on |
|---|---|---|
| CH-16 | `evaluations.policy_version`, `evaluations.policy_config` (nullable) | a fresh database; the exact pre-V3 DDL (`tests/fixtures/legacy-gate-v0.sql`); a `gate.db` written by the `v3-baseline` code, opened twice |
| CH-17 | `gate_settings.audit_anchor` created on first open; records how many rows already existed | fresh database; database with rows but no anchor (`audit-chain.test.ts`) |
| CH-19 | none: checks stored inside the existing `evaluations.summary` JSON | older evaluations show "not recorded" (`evidence-checks.test.ts`) |
| CH-22 | `gate_settings.scenario_clock` (production only) | restart tests in `production-ops.test.ts`; rehearsal |

Legacy behaviour: evaluations written before CH-16 have no recorded policy and cannot be staged until re-evaluated; their export is marked partial with "not recorded", never filled in from current settings. Audit rows written before the anchor existed are linked and checked, but rows removed from the end before the anchor was created cannot be detected; the check says how many such rows there are.

Forward and backward: the V3 code reads pre-V3 files. Pre-V3 code ignores the added columns and settings, so rolling back the code keeps the data readable. There is no automatic reverse migration; going further back means a reviewed restore from backup.

## 5. Explicitly rejected

- New infrastructure: no queue, cache, broker, second database or PostgreSQL. One process, three SQLite files.
- New model provider: none added. The deterministic extractor stays the default; the optional model adapter is unchanged.
- UI overhaul: no new CSS or component framework; navigation unchanged.
- Unattended approval: no auto-approval for late approvers, similar records or reliable parties. CH-5 escalation was deferred rather than invented.
- Identity and signature fiction: the demo identity switch is labelled as not authentication; the evidence package has a SHA-256 checksum described as a checksum, not a signature; the visitor PIN is described as a convenience gate.
- Counters, allocations and reversals (CH-3, CH-4) because the domain has none.
- A CSV evidence export: one flat file cannot carry the linked records faithfully.
- Path routing for deep links: the app has none; any path opens the app shell, and adding routes was out of scope.

## 6. Known limitations

- Everything is synthetic: Microsoft Defender and ServiceNow are local behavioural simulators, the roles are demo identities chosen in a header, and no real vendor API was called.
- The audit chain is local tamper evidence only. Someone with full write access to `gate.db` can rewrite rows, hashes and the anchor together. It is not signed and not copied outside the database. Simulator audit logs and execution traces are not covered.
- Legacy rows: see section 4.
- The visitor PIN has 10,000 values. Limits slow guessing (per address and global) but do not make it strong; the global limit can be used to lock visitors out for up to 10 minutes. Counters reset on restart.
- Analytics is not active: no Clarity project ID was provided. The withdrawal path uses Clarity's v1 `consent(false)` call, which Microsoft marks for deprecation (TO_VERIFY).
- The Docker image was not built: no image registry was reachable from this environment (requests to Docker Hub, ECR Public and the Google mirror were refused by the network policy). The Dockerfile's steps were rehearsed without Docker.
- No deployment, DNS, TLS, firewall or panel setup was done (CH-22B). Base image digest pinning is TO_VERIFY at build time.
- No usability study was run (section 9).
- Deferred: CH-3, CH-4, CH-5 (reasons in section 2). No revenue, savings, detection-precision or compliance claims are made.

## 7. Demo walkthrough

Local: `npm install`, `npm run dev` (or `npm run build && npm run build:server && npm start`), open the app. All data is synthetic.

1. Primary scenario (about 60 seconds). Review tab, select PRD-SAP-GW02 (INC-90482), "Prepare isolation review". Checkpoints: headline "Full isolation could interrupt SAP warehouse operations"; decision "Dual approval required" with the code `REQUIRE_DUAL_APPROVAL` under it; "Evidence checks: 8 passed, 1 warned, 0 blocked, 0 not evaluated" (CH-19, open it to see each rule result and the evidence it read); evidence-age bars (CH-10); source badges (CH-12). Select "Stage dual-approval packet": result "Approval packet CAP-2026-1042 staged and verified", state "Waiting for dual approval", device change "None". Simulated: Defender, CMDB and the approval store.
2. Approvals (about 45 seconds). Switch "Acting as" to Jordan Reyes (SOC incident commander), Approvals tab: the packet shows the impact projection (CH-7). Approve. Switch to Maya Okafor (SAP EWM service owner) and approve. Back in Review the request is "Approved for manual execution". Bulk approval (CH-9) shows per-item results.
3. Blocked paths (about 30 seconds). PRD-MES-APP01 (stale CMDB): "Insufficient evidence", evidence-age bar says by how much, the evidence checks show "Blocked" for age and "Not evaluated" for later rules, no stage button. Selecting a service owner and preparing a review shows the role error with a demo switch (CH-13).
4. Audit review (about 45 seconds). In the request, "Export audit evidence package" downloads JSON with status "complete" and a SHA-256 checksum (CH-18). Inspector, Audit tab, "Check the audit log": "Audit log check passed for entries 1 to N" with what is and is not covered (CH-17). An integrity warning is shown on a disposable database by `tests/integration/audit-chain.test.ts`, not in the live demo.
5. Hosted mode (if deployed later). The passcode page appears first; a wrong code gets one plain message; the right code opens the app at the same address; "Leave demo" ends the session (CH-20). With a Clarity ID set, a notice asks before anything loads (CH-21).

## 8. Interview architecture explanation

An analyst asks to fully isolate a device. That request is an event with an ID, so a repeat delivery returns the same request. The Gate reads Defender (incident, device, alerts, live activity) and ITSM (CMDB item, dependencies, freezes, runbook documents) through typed ports; every response is schema-checked (CH-2), and an outage or a 401 makes the source "unavailable" instead of guessed. The extractor turns runbook text into cited constraints or abstains; it never decides. The policy engine is a pure function over a policy input: rule 1 not enough evidence, rule 2 manual review, rule 3 business impact needs two approvers, rule 4a a possible duplicate needs a person, rule 4 standard path. It records each check where it runs (CH-19) and the evaluation stores the policy version and thresholds (CH-16).

Authority: only roles from the directory can act; the Gate's own service token cannot isolate a device. The one write is "stage an approval packet" with an idempotency key. Before writing, the Gate re-checks the incident revision and the policy version; after writing, it reads the packet back and checks the device has no new action. A mismatch becomes "verification failed", never success. A lost response is reconciled by key. Every step goes into a trace, and every state change into a hash-chained audit log with an end anchor (CH-17).

Bulk approval does not bypass any of this: each packet goes through the same single-item path with its own role check, expected status and audit row, and one failure does not change the others (CH-9). The evidence package (CH-18) and the check matrix (CH-19) only read what was recorded; the UI never recomputes a decision.

## 9. Product validation

Targets from the spec (the 30-second rule, the one-sentence rule, plain words first) guided the UI changes: plain-language labels with codes as secondary text (CH-L1), the stepper (CH-14), the activity summary (CH-11), the evidence check summary (CH-19). These are design targets only. No usability exercise with real users was run, so there is no observed metric and no claim that the UI meets them.

## 10. Deployment and analytics evidence

| Item | Status | Evidence |
|---|---|---|
| Container feasibility | CONFIGURED | Multi-stage `Dockerfile`, `.dockerignore`; image not built (registry unreachable). Node 22 with built-in `node:sqlite`; no native addon. |
| Production process | TESTED_LOCALLY | `scripts/rehearse-image.sh`: clean `npm ci`, build, server bundle, runtime with production dependencies only (tsx absent), server as user `nobody` with `NODE_ENV=production` (output below) |
| Persistence and restart | TESTED_LOCALLY | Same request, packet and audit length after restart; no reseed; scenario clock continues (`production-ops.test.ts`, rehearsal) |
| Backups | TESTED_LOCALLY | `VACUUM INTO` while running, manifest, restore check passed; tampered copy detected |
| Passcode on the server | TESTED_LOCALLY | Without a session: page 401 (passcode page), `/api` 401, `/assets` 401; cookie HttpOnly, SameSite=Lax, Secure in production; no session secret in build output (`access-gate.test.ts`, E2E, rehearsal) |
| Zero analytics before entry | TESTED_LOCALLY | E2E: no request to clarity.ms on the passcode page, after a wrong PIN, or before consent; one tag after Allow; none after "No thanks" |
| Masking and consent | TESTED_LOCALLY | `data-clarity-mask` on main content and the identity selector; consent notice; withdrawal |
| Deployed URL | none | Nothing was deployed. CH-22B needs your server, DNS and authorization; steps in `docs/DEPLOYMENT.md` |

## 11. Verbatim command evidence

Final `npm run verify` (lines with results; the full log has the per-test lines):

```text
v22.22.0
76f0cb4
> containment-assurance@0.1.0 verify
> npm run typecheck && npm run lint && npm test && npm run build && npm run secret-scan && npm run test:e2e
> containment-assurance@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
> containment-assurance@0.1.0 lint
> eslint .
> containment-assurance@0.1.0 test
> vitest run
 Test Files  29 passed (29)
      Tests  237 passed (237)
> containment-assurance@0.1.0 build
> vite build
✓ built in 184ms
> containment-assurance@0.1.0 secret-scan
> tsx scripts/secret-scan.ts
secret-scan passed: 3 bundle files and 113 source files checked
> containment-assurance@0.1.0 test:e2e
> playwright test
  27 passed (21.0s)
VERIFY_EXIT=0
```

Image rehearsal at `76f0cb4` (`bash scripts/rehearse-image.sh <workdir>`), result lines:

```text
== build stage: context without ignored files
== runtime stage: production dependencies only
dev dependency tsx absent from runtime: ok
running as nobody (non-root)
== start before bootstrap must refuse
exit=1
START REFUSED: The databases are empty. Run the one-time bootstrap first: node dist-server/scripts/bootstrap
== bootstrap twice (idempotent)
[bootstrap] <workdir>/data: 6 incidents, 9 users, 0 recent Gate audit rows kept as they were.
[bootstrap] <workdir>/data: 6 incidents, 9 users, 0 recent Gate audit rows kept as they were.
== first start
{"ready":true}
without a session: page 401, api 401
wrong PIN: 401
right PIN: session cookie has HttpOnly, Secure, SameSite=Lax
<title>Business Impact Gate</title>
deep link serves app shell: 1
no session secret in build output, and the browser bundle does not read ACCESS_PIN: ok
evaluated: REQ-54E7C567 REQUIRE_DUAL_APPROVAL
staged: CAP-2026-1042 WAITING_FOR_DUAL_APPROVAL
audit before restart: true 3
== restart: same state, no reseed, no new writes
audit after restart: true 3
request after restart: WAITING_FOR_DUAL_APPROVAL packet CAP-2026-1042
== backup while running, then restore check
[backup] wrote <workdir>/backups/2026-11-10T02-27-26-321Z: security.db 53248 bytes, itsm.db 98304 bytes, gate.db 77824 bytes; audit chain intact (3 rows)
[backup] restore check: passed
-rw-r--r-- nobody gate.db
-rw-r--r-- nobody itsm.db
-rw-r--r-- nobody security.db
REHEARSAL PASSED (<workdir>)
```

Skipped or not possible here:

- `docker build .`: refused. `docker pull node:22.22.0-bookworm-slim` returned "Forbidden" from the network policy (also for `public.ecr.aws` and `mirror.gcr.io`). The local Docker daemon was started only for this check and stopped afterwards.
- Any deployment, push, DNS, TLS or firewall step: not authorized and not attempted.
- Clarity with a real project ID: no ID was provided.
