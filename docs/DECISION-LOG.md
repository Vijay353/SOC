# Decision log

Format: ORIGINAL IDEA → CHANGE → REASON → CONSEQUENCE. Evidence labels: VERIFIED, INFERRED, SYNTHETIC, PROPOSED, UNKNOWN.

## Implementation decision record

- **Product thesis (PROPOSED):** a customer-specific pre-flight gate for manual high-impact containment that reconciles Defender evidence with operational truth and stages accountable dual approval — not another autonomous containment engine.
- **Primary persona:** SOC incident lead/analyst. **Co-owner:** business service owner. **Approver of record:** on-call SOC incident commander.
- **Primary workflow:** `ManualIsolationRequested → evidence snapshot → REQUIRE_DUAL_APPROVAL → stageContainmentApproval → read-back → RESPONSE_READY → WAITING_FOR_DUAL_APPROVAL`, zero endpoint mutations.
- **Minimum success metric (product gate, not a claimed result):** the Gate never stages or marks safe on missing/stale/ambiguous evidence; duplicate events never create a duplicate packet; a user can name action, risk, decision, owners and no-action boundary in 30 s.
- **Integration boundaries:** SecurityPort (read-only), ItsmPort (CMDB read + approval write). **Deployment:** local single process. **Simulated:** both vendors, identity, clock, model.
- **Architecture:** deterministic rules engine + one narrowly scoped extractor (rules by default, optional model) + ports/adapters + stateful HTTP simulators + React.
- **Critical risks:** stale evidence treated as current; extractor output treated as authority; lost write responses causing duplicates; UI claiming success without read-back.

## Alternatives scored (1 = poor, 5 = strong)

| Option | Feasibility | Fidelity | Business value | Complexity (5 = simple) | Demonstrability | Verdict |
|---|---|---|---|---|---|---|
| CRUD enrichment panel only | 5 | 3 | 2 | 5 | 3 | Insufficient: no decision, no approval routing |
| **Deterministic gate + bounded extractor + approval tool** | 5 | 4 | 4 | 4 | 5 | **Chosen** |
| Autonomous LLM agent with tool access | 3 | 2 | 2 | 2 | 3 | Rejected: duplicates native attack disruption; unsafe authority |
| RAG over runbooks | 3 | 3 | 3 | 2 | 2 | Rejected: one CI's few documents don't need retrieval; citations from direct read suffice |

## Decisions

| # | Original idea | Change | Reason | Consequence |
|---|---|---|---|---|
| D1 | BlastGuard + SignalTune agent (tuning, SCU budgeting, multi-vendor containment, rollback) | Build only the Business Impact Gate | Supplied brief's own audit; Defender already has attack disruption, exclusions, attack paths, tuning (VERIFIED in brief sources) | Narrow, defensible scope; no SignalTune, no SCU math, no ROI |
| D2 | Brief: incident version used for optimistic concurrency | Simulator exposes `revision`; production maps to `lastUpdateDateTime` | Graph incident has **no version/ETag** (VERIFIED, Graph docs 2026-10-18) | Staleness check remains; production adapter compares timestamps (TO_VERIFY behaviour) |
| D3 | Brief: "incident is now WAITING_FOR_DUAL_APPROVAL" | State owned by the Gate's response-request record, not written onto the incident | Graph incident status values are active/inProgress/resolved/redirected/awaitingAction (VERIFIED); a second upstream write would break the one-tool rule | One mutating tool; incident untouched |
| D4 | "Agent" decides | Policy CAP-1.0 is a pure function; extractor produces cited claims only | Authority must be deterministic and auditable | Extractor cannot return safe/approve; strict schema + verbatim citation check for any provider |
| D5 | LLM required | Default deterministic rules extractor; optional model adapter, disabled, fails closed | Must run offline without paid credentials | Rules extractor handles shipped fixtures only — documented as not general NLU |
| D6 | Click "Stage" executes immediately after evaluation | Evaluate (read-only) and Stage (human click) are separate; evaluation valid 5 min | Matches the wireframe; prevents staging on aged evidence | `EVALUATION_EXPIRED` path |
| D7 | Retry blindly | Retries only for GETs and the idempotency-keyed write; outbox persists the exact payload; reconcile on `IDEMPOTENCY_KEY_REUSED` | Lost-response-after-commit must not duplicate approvals | Reconciliation adopts a packet only if all core fields and evidence hashes match |
| D8 | Trust tool 201 | Read back every field + re-read device and machine actions | "No adapter claims success without read-back" (brief §18.20) | `VERIFICATION_FAILED` state |
| D9 | Approval packet in Gate DB | Packet lives in ITSM simulator | Approvers work in ITSM; separate system-of-record mirrors reality | Gate syncs status by reading; no push |
| D10 | Least privilege by convention | Scoped tokens enforced by the simulator; Gate token has no `machine.isolate` | Make "cannot isolate" structurally true and testable | Probe endpoint + test show 403 |
| D11 | Defender/CMDB disagreement silently resolved | Conflict adds `CRITICALITY_CONFLICT` and takes the stricter path | Brief §5.2/§13F | Payments scenario |
| D12 | Expiry could auto-progress | Expiry only ever moves to `EXPIRED` | Brief §18.14 | Test "expiry never approves" |
| D13 | Excel as a data source | Excel is interchange only; all-or-nothing validated imports with preview, confirm, re-query, snapshot restore | Contract §5; prevents silent partial data | Demo shows Excel fixing stale CMDB → decision changes |
| D14 | Native Excel dates accepted | Rejected; ISO text with timezone required | Excel dates have no timezone | Clear error `NATIVE_DATE_NOT_ALLOWED` |
| D15 | Microsoft-style UI/branding (wireframe header "Microsoft Security") | Neutral "Business Impact Gate" branding, generic shield icon, "Mock Defender XDR" labels | Do not copy vendor branding/icons | Clearly conceptual; disclaimer in footer |
| D16 | Penpot SVG design assets | Not produced; real screenshots of the running app instead | P2 scope; runnable product prioritized | Listed as NOT_IMPLEMENTED |
| D17 | Playwright-managed browser | Allow `PW_CHROMIUM_PATH` override | Browser CDN blocked in build environment | E2E ran with a Chromium binary obtained from the npm registry |
| D19 | `better-sqlite3` native addon | Node's built-in `node:sqlite` behind `simulators/shared/sqlite.ts` | Clean-room `npm ci` triggered a registry-injected `node-gyp rebuild` needing Node headers + C++ toolchain (failed offline) | Zero-build install; requires Node ≥ 22.13; one experimental-API warning is filtered |
| D18 | `STANDARD_RESPONSE_ELIGIBLE` triggers isolation | Shown as eligible; Gate still executes nothing | Out of slice; brief §13A | Clear "outside this slice" callout |

## Requirement conflicts resolved

- **Wireframe "Microsoft Security" branding vs contract "don't copy branding"** → contract (safety/legal precedence).
- **Brief reason-code list (4 codes) vs runbook constraint present in the same scenario** → added `RUNBOOK_OWNER_APPROVAL_REQUIRED` (5 codes) because the cited constraint is real evidence; documented.
- **Brief "incident version" vs verified Graph schema** → verified schema wins (D2).

## V3 decisions

| # | Change | Reason | Consequence |
|---|---|---|---|
| V3-1 | Policy CAP-1.0 becomes CAP-1.1 (CH-6) | The policy gained a possible-duplicate input. Changing behavior without a new version would make old and new evaluations look the same | With no duplicate, every CAP-1.0 decision and reason code is unchanged (all six seeded scenarios re-checked). The `policyInput` evidence hash changes because the input has one more field; the other five hashes are unchanged |
| V3-2 | A possible duplicate on a critical asset stays on dual approval and adds `POSSIBLE_DUPLICATE_REQUEST`; on a non-critical asset it becomes `MANUAL_REVIEW` | Spec CH-6: a flag must keep the request off any path without a human decision, but must not invent an override | Approvers see the reason on the packet. There is no endpoint to clear the flag |
| V3-3 | Duplicate-relevant states: ready, re-evaluation required, waiting for approval, verification failed, approved, standard eligible. Window 24 hours | These are the states in which a request permits or may soon permit an action. Blocked and closed requests cannot lead to an action | Documented in `store.ts`; tested at the exact 24-hour edge |

| V3-4 | CH-17 anchors the end of the audit chain in `gate_settings` instead of a new table | Smallest additive change. The anchor is written in the same transaction as each row, so a removed tail is detected | A database from before V3 is anchored on first open; rows removed from its end before then cannot be detected, and the verify result says how many rows predate the anchor |
| V3-5 | CH-19 checks are recorded inside `evaluatePolicy`, not derived later | The spec forbids a parallel evaluator. Recording at the execution site makes the matrix and the decision come from the same code path | Decisions and reason codes are unchanged (384-input property test and all seeded scenarios). Older evaluations show "not recorded" |
| V3-6 | CH-L1 keeps seeded person names (`Name then role`) as stored data and formats them as `Name (role)` in the UI | Changing seed rows would change ITSM data and evidence hashes for no user benefit | Codes stay visible only as secondary text next to plain words, so E2E selectors on codes still hold; one E2E text assertion changed ('You recorded an approval') |
