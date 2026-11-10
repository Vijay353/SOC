# Simulator contracts

Both simulators are **interoperable behavioural simulators** of the narrow capabilities this workflow needs. They are not clones of Microsoft Defender/Graph or ServiceNow: paths, payloads and rules are simplified and are not vendor-certified. Shared entity schemas live in `packages/contracts/src/domain.ts`.

Common behaviour (`simulators/shared/infra.ts`):

- Own SQLite database, CHECK constraints, foreign keys, append-only `audit_log` (UPDATE blocked by trigger).
- Bearer-token auth with scopes → `401 UNAUTHENTICATED` / `403 FORBIDDEN`.
- Structured errors: `{ "error": { "code", "message", "details" } }`.
- Fault injection (Lab or `POST /api/lab/faults`): `http_401`, `http_429`, `http_500`, `http_503`, `latency`, `timeout_after_commit` (ITSM writes), `corrupt_readback` (ITSM packet reads); target `all|reads|writes`; count or until cleared. Faulted responses carry `x-sim-fault`.
- Shared **synthetic scenario clock** (starts 2026-10-18T06:14:00Z; `ticking` or `frozen`).
- Deterministic seed (`fixtures/seed.ts`), reset via Lab or `npm run seed`.

## Response validation (V3 CH-2)

The Gate's simulated adapters check every successful response against the shared schemas in `packages/contracts/src/domain.ts` (`IncidentWithAlerts`, `DeviceRow`, `DeviceActivityRow`, `MachineActionRecord`, `ConfigItemRow`, `ConfigItemBundle`, `UserRow`, `ApprovalPacket`, `StagedApprovalPacket`). A body that does not match, or is not JSON, becomes an `INVALID_RESPONSE` error. It is not retried and is never turned into default values. During an evaluation that error makes the source unavailable, so the decision fails closed.

## Mock Microsoft Security — base `/sim/security`

| Method & path | Scope | Behaviour |
|---|---|---|
| `GET /api/incidents` | incident.read | `{ value: Incident[] }` |
| `GET /api/incidents/:id` | incident.read | Incident + `alerts[]`; `ETag: "r<revision>"`; 404 |
| `PATCH /api/incidents/:id` | incident.write | Requires `If-Match: "r<revision>"` (428 if absent); `409 REVISION_CONFLICT` if stale; bumps `revision` and `lastUpdateDateTime` |
| `GET /api/devices`, `GET /api/devices/:id` | device.read | Device inventory; 404 |
| `GET /api/devices/:id/activity-summary` | activity.read | `{ activeSessionCount, distinctRemoteHosts, observedAt }` |
| `GET /api/machines/:id/actions` | device.read | Machine actions (used to prove nothing was executed) |
| `POST /api/machines/:id/isolate` | **machine.isolate** | Body `{ Comment, IsolationType: Full|Selective }` → 201 action, device `ISOLATED`; `409 ALREADY_ISOLATED`. **The Gate's token lacks this scope.** |
| `GET /api/audit` | audit.read | Simulator audit log |

Entities: `Incident { incidentId, displayName, severity: informational|low|medium|high, status: active|inProgress|resolved|redirected, createdDateTime, lastUpdateDateTime, revision }`, `Device { machineId, computerDnsName, osPlatform, defenderCriticality: CRITICAL|STANDARD|UNKNOWN, isolationState, lastSeen, revision }`, `Alert { alertId, incidentId→, machineId→, source: DEFENDER_ENDPOINT|THIRD_PARTY_FIREWALL, title, description (untrusted), detectedAt }`, `DeviceActivity { machineId→, activeSessionCount, distinctRemoteHosts, observedAt }`.

**Known differences from the real platforms (VERIFIED against public docs, 2026-10-18):**

- Graph `security/incidents` has **no version/ETag**; `revision` is simulator-only. A production adapter would use `lastUpdateDateTime` as the staleness token.
- Graph severity has no `critical`; incident status also includes `awaitingAction` (Defender Experts only) — not modelled.
- Real isolation is `POST https://api.security.microsoft.com/api/machines/{id}/isolate` with `Comment` and `IsolationType` (`Full`, `Selective`, `UnManagedDevice`), permission `Machine.Isolate`, 100 calls/min. Ports cannot be passed; isolation exclusions are configured separately and apply only to Selective isolation.
- Critical-asset levels in Exposure Management are richer than `CRITICAL|STANDARD|UNKNOWN`; the simulator collapses them. The live-activity summary approximates an advanced-hunting aggregation; its real query is TO_VERIFY.

## Mock ITSM / CMDB — base `/sim/itsm`

| Method & path | Scope | Behaviour |
|---|---|---|
| `GET /api/config-items?machineId=` / `?hostname=` | cmdb.read | CI list (identity resolution) |
| `GET /api/config-items/:id` | cmdb.read | Bundle: CI + owner + dependencies + change freezes + documents |
| `GET /api/users?role=&onCall=` | cmdb.read | People/roles |
| `POST /api/approval-packets` | approval.write | **The Gate's one mutating tool.** Strict schema. Same key + same payload → `200` existing packet `duplicate:true`; same key + different payload → `409 IDEMPOTENCY_KEY_REUSED`; another open packet for the target → `409 OPEN_PACKET_EXISTS`; validates CI exists and is linked to the machine, two distinct active non-analyst approvers, requester not an approver, expiry in future. Creates one notification per approver. `201` on create. |
| `GET /api/approval-packets/:id` | approval.read | Applies clock expiry lazily (`EXPIRED`, audited, never approves) |
| `GET /api/approval-packets?approverId=` / `?idempotencyKey=` | approval.read | Inbox / reconciliation lookup |
| `POST /api/approval-packets/:id/decisions` | approval.decide | `{ actorId, decision: APPROVE|REJECT, comment }`. `403 NOT_AN_APPROVER`, `403 SEPARATION_OF_DUTIES`, `409 ALREADY_DECIDED`, `409 PACKET_EXPIRED`, `409 PACKET_CLOSED`. One REJECT → `REJECTED`; two APPROVEs → `APPROVED`. |
| `GET /api/notifications` | approval.read | Approver notifications |
| `GET /api/audit` | audit.read | Simulator audit log |

Packet lifecycle: `WAITING_FOR_DUAL_APPROVAL → PARTIALLY_APPROVED → APPROVED`; any open state `→ REJECTED` or `→ EXPIRED`.

**Known differences:** ServiceNow models CIs in `cmdb_ci*` tables with relationships in `cmdb_rel_ci` and approvals in approval records/flows that vary per instance; the simulator flattens these. No ServiceNow endpoint is claimed to work — see [INTEGRATIONS.md](INTEGRATIONS.md).

## Gate API (consumed by the React app) — base `/api`

`GET /session`, `GET /queue`, `POST /events/manual-isolation-requested`, `GET /requests/:id`, `POST /requests/:id/evaluate`, `POST /requests/:id/stage`, `GET /approvals`, `POST /approvals/:id/decision`, `GET /audit`; Lab: `POST /lab/reset`, `POST /lab/clock`, `GET|POST /lab/faults`, `POST /lab/incidents/:id/concurrent-update`, `POST /lab/least-privilege-check`, `POST /lab/mode`, `GET /lab/simulator-audit`, `GET /lab/notifications`; Data: see [DATA-IMPORT-GUIDE.md](DATA-IMPORT-GUIDE.md).

## Audit evidence package (CH-18)

`GET /api/requests/:id/evidence-package` returns one request's evidence as canonical JSON (keys sorted, no spaces) with `content-disposition: attachment`. It is read-only: it reads the approval packet once and does not sync or write.

- Allowed: SOC analyst and SOC incident commander for any request; a service owner only for a request where they are a named approver. Others get `403 EXPORT_NOT_PERMITTED`; no identity gets `401`. Outside SIMULATED mode without configuration it fails closed with `503 SETUP_REQUIRED`.
- Contents: schema and version, export time and exporter, the record (ID, revision, state), source references (incident revision, CI, evidence hashes), every evaluation with the policy version and thresholds recorded at that time (or `recorded: false` for evaluations written before CH-16, never filled in from current settings), the actors from the audit rows, the runs with their traces, the approval packet as read back, the audit rows for this request and the chain check for the whole Gate log.
- `evidenceStatus` is `complete`, `partial` (with reasons) or `unverifiable` (the audit chain check failed).
- `digest.value` is SHA-256 over the canonical JSON of the package without the `digest` field. It is a checksum, not a signature: it shows the file was not changed after export, not who exported it.
- CSV is not offered: one flat file cannot carry the linked records faithfully.
