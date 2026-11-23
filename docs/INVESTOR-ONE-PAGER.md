# Business Impact Gate: one-pager

*Conceptual prototype with synthetic data. Not a Microsoft or ServiceNow product. Nothing here is a revenue, certification or loss-reduction claim; items marked **Hypothesis** are open questions to test with buyers.*

## The problem
A SOC analyst's fastest containment move, isolating a device, is also one of the easiest ways to stop a warehouse, a payments API or a factory line. The facts that would prevent it already exist (CMDB tier and owner, live sessions, change freezes, runbook rules), but they are not in front of the analyst at the moment of the click, and nobody signs for the business risk.

Why it matters now:
- An hour of IT downtime costs more than $300k for over 90% of mid-size and large enterprises; 41% put it at $1M to $5M+ (ITIC 2024).
- Unplanned downtime costs the Fortune Global 500 about $1.4T a year, 11% of revenue (Siemens, *True Cost of Downtime 2024*).
- Security tooling can cause the outage itself: the July 2024 CrowdStrike incident cost the US Fortune 500 an estimated $5.4B in direct losses, with only 10 to 20% insured (Parametrix).

## What the product does (and what the demo shows)
A **pre-execution control** between "analyst wants to isolate" and "device is isolated":
1. **Reconciles evidence**: Defender incident and device, CMDB tier and owner, live activity, change freezes, cited runbook lines. Stale, ambiguous or conflicting evidence → the Gate says no (fail-safe default).
2. **Decides deterministically**: one of four outcomes from a versioned policy; prompt-injection text in alerts and runbooks is treated as data.
3. **Turns a risky click into four-eyes work**: stages one approval request for the two accountable owners, reads it back to verify it, and never isolates anything itself.
4. **Keeps an audit-grade trail**: evidence hashes, the policy version used, every HTTP attempt, a hash-chained audit log, and a one-click evidence package (JSON with checksum, plus a printable decision record).

In the demo the live counter reads **"Containment actions executed by the Gate: 0"**. It is computed from the simulator's isolation records for the Gate's own principal, not hard-coded.

## Insurance and audit fit
The shape matches what cyber underwriters and auditors ask about: segregation of duties (requester cannot approve), verifiable approvals (read-back), tamper-evident records (local hash chain), and documented fail-safe behaviour. *The prototype is not certified and does not claim any premium effect.*

## Buyers and users
| Persona | Wants | What they see |
|---|---|---|
| SOC analyst | Contain fast without getting blamed | Decision, reasons and one next action above the fold |
| Service owner (often senior, not a security specialist) | No surprise outages | "Approve full isolation of PRD-SAP-GW02?" in business words, minutes left, what approving does not do |
| Incident commander | Accountability | Four-eyes approval, expiry never approves |
| CISO / risk / insurance buyer | Proof that controls work | Evidence package, audit chain check, live counts |

## Packaging (all **Hypothesis**)
- Per-SOC-seat subscription for the Gate and approval flow.
- An "evidence module" for compliance and insurance renewals.
- A premium tier that recommends selective isolation instead of full isolation (keeps business flows, blocks the attacker), always human-chosen.

## Where agentic AI fits (roadmap, human-in-the-loop by design)
Runbook constraint extraction already exists as an optional, citation-checked path. Next candidates: CMDB repair drafts (human previews and commits through the existing import), a three-line approver brief built only from recorded facts, and post-incident narratives that cite trace steps. The Gate never lets a model approve or execute.

## What this prototype does not prove
- No real Defender, Graph or ServiceNow integration (adapters are fail-closed placeholders).
- No user research yet: the "understood in 30 seconds" goal is designed for and browser-tested for layout, not validated with people.
- Audit tamper evidence is local only (no external anchoring); demo identities are not authentication.
- No data on how often self-inflicted containment outages happen in a given company; the value estimate in `PRODUCT-UX-PLAN.md` E3 is illustrative.

Sources: ITIC, *2024 Hourly Cost of Downtime Survey*; Siemens / Senseye, *The True Cost of Downtime 2024*; Parametrix, *CrowdStrike's Impact on the Fortune 500* (July 2024). Links in [PRODUCT-UX-PLAN.md](PRODUCT-UX-PLAN.md).
