# Architecture

## Topology

One Node.js process hosts three independently owned components, each with its own SQLite file. The Gate reaches both simulators **over real HTTP** with scoped bearer tokens, so faults, auth failures, retries and read-backs are genuine network behaviour — and either simulator can be moved to its own process (or replaced by a vendor adapter) by changing a base URL / provider.

```
Browser (React, Vite)                       ── no tokens, no secrets; sends X-Demo-User (demo identity, not auth)
   │  /api/*
   ▼
Gate API  (server/src/system.ts)            ── composition root, Express
   ├─ GateOrchestrator  (gate/orchestrator.ts)   evaluate · stage · decide · sync · views
   │    ├─ Policy CAP-1.1 (gate/policy.ts)          pure, deterministic
   │    ├─ ConstraintExtractor (gate/extractor/*)   rules (default) | optional model; output verified
   │    ├─ GateStore → gate.db                      requests, evaluations+outbox, runs/traces, hash-chained audit, imports
   │    └─ Ports (gate/adapters/ports.ts)
   │          ├─ SecurityPort ──HTTP──▶ /sim/security  Mock Microsoft Security → security.db
   │          └─ ItsmPort     ──HTTP──▶ /sim/itsm      Mock ITSM / CMDB        → itsm.db
   ├─ Data Studio (imports/data-studio.ts)       XLSX/CSV ⇄ simulator repositories (admin console)
   └─ Lab routes                                 reset, scenario clock, fault injection, probes (demo only)
```

## Data ownership

| Store | Owner | Holds |
|---|---|---|
| `security.db` | Mock Microsoft Security | incidents (with sim-only `revision`), devices, alerts, live-activity summaries, machine actions, audit log |
| `itsm.db` | Mock ITSM/CMDB | users/roles, configuration items, dependencies, change freezes, documents, **approval packets**, decisions, notifications, audit log |
| `gate.db` | Business Impact Gate | response requests + lifecycle, evaluations (+ outbox of the exact tool payload), execution traces, hash-chained audit, import history |

The approval packet lives in the ITSM system (where approvers work); the request lifecycle (`RESPONSE_READY → WAITING_FOR_DUAL_APPROVAL → …`) lives in the Gate. Neither writes to the other's database.

## Port boundary (V3 CH-1)

Gate code under `server/src/gate` imports nothing from a simulator module. Shared contract types (including `ConfigItemBundle`) and the hashing helpers (`canonical`, `sha256`) live in `packages/contracts`. The only allowed imports from `simulators/` are shared infrastructure: the scenario clock and the database wrapper in `simulators/shared/`. A unit test (`tests/unit/port-boundary.test.ts`) enforces this.

Two server parts still use simulator repositories directly, on purpose: the Data Studio (simulator administration: import, export, restore) and the composition root's seed and reset. They sit outside the Gate's trust boundary and would not exist in a production deployment.

## Trust boundaries

1. **Browser ↔ Gate.** The browser holds no credentials. Identity is a demo header; the Gate looks it up in the ITSM user directory and enforces roles (analysts/incident commander may request/stage; approvals are enforced by ITSM). *Production needs real authentication (e.g. Entra ID) — not implemented.*
2. **Gate ↔ simulators.** Bearer tokens with scopes, generated per process unless supplied. The Gate's security token has `incident.read device.read activity.read` only — **no `machine.isolate`** (proved by `/api/lab/least-privilege-check` and a test). Its ITSM token has `cmdb.read approval.write approval.read approval.decide`.
3. **Untrusted content.** Alert descriptions, runbook/change-note bodies and workbook cells are data. Alert text is display-only; documents are read only by the extractor; instruction-like text is detected, recorded and ignored; the extractor's schema cannot express a decision or action; every citation must match the cited document version verbatim.
4. **Lab / Data Studio.** Simulator administration for the demo, outside the Gate's trust boundary. They would not exist in production.

## Transaction boundaries, consistency and recovery

- **Evaluate** is read-only upstream; it persists one evaluation and (for non-approval outcomes) a state transition.
- **Stage** is a single upstream write: `POST /approval-packets` with an idempotency key `sha256(eventId|incidentRevision|machineId|action)`. Before writing, the Gate re-reads the incident revision (optimistic concurrency) and persists the exact payload (outbox), so retries are byte-identical.
- **Retries** (timeouts, 429, 5xx) are allowed only for GETs and the idempotency-keyed write; full-jitter backoff, max 3 attempts.
- **Lost response after commit**: the retry returns the existing packet (`duplicate=true`). If the evaluation expired in between, re-evaluation produces the same key with a new expiry; the simulator returns `409 IDEMPOTENCY_KEY_REUSED` and the Gate **adopts** the existing packet only if incident, machine, CI, requester, approvers, reason codes, evidence hashes and policy version all match — otherwise it stops for manual reconciliation.
- **Read-back** must match every field of the payload and the device must show no isolation and no new machine action; otherwise the request becomes `VERIFICATION_FAILED` (escalated, never reported as success).
- **Gate state transition** uses an allow-list and optimistic version check; a concurrent stage that loses the race returns the already-recorded packet.
- **Data Studio commit** writes both simulator DBs inside open transactions and commits only when both succeed; a pre-commit JSON snapshot enables restore.
- **Eventual consistency**: the Gate learns approval outcomes by reading the packet (`sync` on view/decision). There is no push channel.

## Audit chain verification (CH-17)

- Each Gate audit row stores `prev_hash` and `hash = sha256(prev_hash + canonical JSON of {at, actor, action, requestId, details})`, with sorted keys. The first row links to `GENESIS`.
- The insert and an end-of-chain anchor (`gate_settings.audit_anchor`: last sequence number and hash) are written in one transaction. Without the anchor, deleting the last rows would leave a chain that still looks valid.
- `GET /api/audit/verify` walks rows by sequence number (never by timestamp) and reports the first problem: missing first rows, a sequence gap, a broken link, a changed row, or an end that does not match the anchor.
- A database from before V3 gets an anchor on first open. The anchor records how many rows already existed, because removal of rows from the end before that moment cannot be detected.
- Not covered: the two simulator audit logs and the execution traces. This is local tamper evidence only: anyone with full write access to `gate.db` can rewrite rows, hashes and anchor together. The chain is not signed and not copied outside the database.

## Evidence check matrix (CH-19)

- The policy engine (`evaluatePolicy`) records each check at the point where it runs, in rule order: sources answered, device identity, evidence age, required fields (R1); operating documents, separation of duties (R2); business impact, approvers found (R3); duplicate risk (R3 and R4a).
- A check after the rule that decided is `NOT_EVALUATED`. So is a check whose input was not reliable (for example identity when a source did not answer). `NOT_EVALUATED` is neither a pass nor a fail and never blocks.
- The checks are stored with the evaluation (`summary.evidenceChecks`) and listed in the `policy.evaluate` trace step. The UI only shows them; it computes nothing. Evaluations from before CH-19 show "not recorded".
- Property tests over 384 policy inputs check that every reason code comes from a failed or warned check, that only the standard path has no blocking check, and that no check after the deciding rule is shown as run.

## Deployment assumptions and limits

Local demo only: single process, SQLite WAL via Node's built-in `node:sqlite` (no native addon), no TLS, no real authentication, random per-process tokens, shared synthetic clock. Production would run simulators as real vendor tenants, the Gate behind enterprise SSO with managed identity to Graph/ServiceNow, a durable job/outbox worker, and an immutable external audit sink.
