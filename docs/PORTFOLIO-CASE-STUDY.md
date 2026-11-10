# Case study — Business Impact Gate

*A synthetic, conceptual extension for manual containment in a Defender XDR–style SOC. Built as a runnable, tested vertical slice. No customer data, no measured outcomes.*

## The problem

A containment action can be technically right and operationally harmful. When an analyst fully isolates a production SAP gateway during a quarter-end freeze, the security evidence is sound — but 1,400 warehouse scanner sessions drop. The context that would have changed the decision (CMDB tier, live dependencies, change freezes, the runbook line saying the service owner must approve) lives in other systems, is sometimes stale, and is joined by hand under pressure.

## What I deliberately did not build

The original concept was an autonomous agent that also tuned detections, budgeted Security Copilot units, orchestrated multi-vendor containment and rolled everything back "in one click". Checking current Microsoft documentation showed much of that already exists natively (automatic attack disruption, critical-asset exclusions, attack-path blast radius, detection tuning) and some claims were wrong (selective isolation cannot carry ports; session revocation isn't IP-scoped). I narrowed the product to the one gap that remains customer-specific: **a pre-flight check before a human runs a high-impact manual action.**

Two further corrections came from verifying the Graph incident schema during the build: it has no version/ETag, and its statuses don't include an approval state. So the concurrency token is simulator-side (mapped to `lastUpdateDateTime` for production), and the approval lifecycle belongs to the Gate, not the incident.

## What I built

- **One transaction, end to end:** `ManualIsolationRequested → evidence snapshot → REQUIRE_DUAL_APPROVAL → stageContainmentApproval → independent read-back → RESPONSE_READY → WAITING_FOR_DUAL_APPROVAL`, with zero endpoint mutations.
- **Two stateful simulators** (security and ITSM/CMDB) with their own databases, scoped tokens, lifecycle rules, audit logs and fault injection, reached over real HTTP.
- **A deterministic policy** that fails closed on missing, stale or ambiguous evidence and takes the stricter path when Defender and CMDB disagree.
- **A bounded extractor** that turns runbook prose into cited claims — and is never the authority. Every citation must match the source document version verbatim; the output schema cannot express "safe" or an action; instruction-like text is recorded and ignored.
- **Recovery engineering:** idempotency keys, an outbox so retries are byte-identical, reconciliation for a write that committed after its response was lost, read-back verification that refuses to claim success on mismatch, optimistic concurrency on the incident.
- **An approvals inbox** enforcing two distinct assigned approvers, separation of duties and expiry that never approves.
- **Excel Data Studio** so a reviewer can edit the simulated world: validated preview, explicit confirm, two-database commit, re-query, history and restore. Re-verifying a stale CMDB record in Excel visibly changes the next decision.
- **A 30-second screen** derived from the supplied wireframe: requested action, why it's risky, decision, safety state, one primary action — with the technical trace one click away.

## Evidence, not claims

`npm run verify` runs strict typecheck, lint, 92 unit/integration tests, production build, a secret scan and 8 browser tests; all pass in this build. Every failure path in the brief (stale CMDB, ambiguous identity, abstention, duplicate event, stale incident, source outage, prompt injection, expiry, read-back mismatch) has an automated test. Numbers in the scenario (1,420 sessions, 18 workflows) are synthetic. I make no time-to-contain, cost or risk-reduction claims; the brief's discovery plan defines how those would be measured.

## Trade-offs

- Rules-based extraction keeps the demo offline and testable but does not generalise; the model adapter exists, shares the same verifier, and is unverified live.
- A human click separates evaluation from staging — slower than auto-staging, but it matches the "pre-flight" framing and limits staging on aged evidence.
- Simulators are narrow by design. They model behaviour the workflow depends on, not vendor fidelity.

## What I would do next

Run the discovery plan (tabletops, ten reconstructed incidents) before writing more code; implement the Graph read adapter against a test tenant with timestamp-based staleness; move outbox retries to a background worker; put real SSO in front of the Gate.
