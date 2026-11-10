# Interview guide

## 30-second pitch

Defender can already disrupt attacks automatically and show attack-path blast radius. The gap I targeted is customer-specific operational context at the moment an analyst manually isolates something important. The Business Impact Gate checks the proposed isolation against CMDB tier and ownership, live dependencies, change freezes and cited runbook constraints. In the demo it stops a Tier-0 SAP gateway from being isolated without the right owners and stages one verified dual-approval packet — and the component holding the language model has no permission to isolate anything.

## Likely questions

**Why not an autonomous agent?** Authority must be deterministic and auditable at the point where an action can stop a business. Language understanding is only needed to read inconsistent runbook prose, so that is the only place it's used, and its output is a set of cited claims verified against the source text.

**How do you know the model can't sneak in a decision?** Three layers: the output schema is strict and has no decision/action fields; each claim's quote must appear verbatim in the cited document version; and the policy is a pure function over booleans. A hallucinated quote forces abstention → manual review. There's a unit test for each.

**What happens if the write succeeds but the response is lost?** The payload is persisted before the call, the idempotency key makes the retry return the existing packet (`duplicate=true`), and if the evidence aged out in between, re-evaluation reconciles to the existing packet only when every core field and evidence hash matches. Tests cover single timeout, all-attempts timeout, and reconciliation.

**Why read back after a 201?** Because "the API said OK" is not proof. The Gate compares every field it sent and re-reads the device and its machine actions. A corrupted read-back puts the request in `VERIFICATION_FAILED`; the UI says "not treated as staged".

**How is "no device mutation" enforced, not just promised?** The Gate's simulator token lacks the `machine.isolate` scope. A probe endpoint and a test show the simulator returns 403.

**What did current documentation change?** Graph incidents expose no ETag/version and have no approval status. So concurrency uses a simulator revision (production: `lastUpdateDateTime`), and the approval lifecycle lives in the Gate and the ITSM record rather than on the incident. Isolation exclusions only apply to Selective isolation, so "port-preserving full isolation" was dropped.

**Why Excel?** Reviewers need to change the simulated world without code. Excel is interchange only: validated, previewed, confirmed, committed across both simulator databases together, re-queried, and restorable. Native Excel dates are rejected because they carry no timezone.

**What isn't real?** Vendor APIs (placeholders that fail closed), authentication (demo identity switch), the model extractor live, notification channel, and any outcome metric.

**How would it scale?** Separate the simulators into real tenants via the existing ports; run the Gate behind SSO with managed identity; move outbox retries to a worker; push packet status via ITSM webhooks instead of polling; ship audit to immutable storage; evaluate the model extractor on a labelled runbook corpus before enabling it.

**What would you measure?** From the brief's discovery plan: share of high-impact manual decisions needing external context, time from recommendation to authorized action, how often CMDB/Defender criticality disagree, and whether users identify action, risk, owner and next step in 30 seconds. None of these is claimed today.

## Demo script (3 minutes)

Follow README → "Three-minute demo". Open Technical evidence once to show the HTTP attempts for the tool call, then close it — the business screen should stand on its own.

## Role-specific angles

- **Solution consultant:** narrowing scope against native capabilities; integration inventory; fail-closed modes.
- **Product manager:** problem framing, kill criteria from discovery, decision log, explicit non-goals.
- **Product designer:** wireframe-to-product fidelity, 30-second hierarchy, progressive disclosure, empty/error states, mobile.
- **Enterprise AI engineer:** bounded model use, verification of citations, prompt-injection handling, idempotency and read-back.
