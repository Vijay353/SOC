# Product clarity & UX plan (Final Draft Plan)

Branch `enhance/product-clarity`, baseline tag `baseline-product-clarity` (`e907954`).
Inputs: *Business Impact Gate: Product Clarity & Investor-Readiness Specification* (CH-1 to CH-20, "the spec") and the senior-friendly UX / business deep-dive brief ("the brief").
This document was written before any code changed. Sections A to E follow the brief. The change register at the end is filled in as work lands.

---

## 0. Baseline as found (verified, not assumed)

| Check | Spec expected | Actually found on `e907954` (Node 22.23.5) |
|---|---|---|
| `npm run typecheck` | 0 errors | 0 errors |
| `npm run lint` | 0 errors | 0 errors |
| `npm test` | 92 tests | **237/238 pass, 1 FAIL**: `labels.test.ts › the browser app source contains no em dash` |
| `npm run build` | green | green |
| `npm run secret-scan` | green | green (3 bundle + 114 source files) |
| `npm run test:e2e` | 8 tests | **26/27 pass, 1 FAIL**: `access.spec.ts › analytics … one tag after Allow` |
| Six seeded decisions (live API) | as spec | match: DUAL / INSUFFICIENT / STANDARD / INSUFFICIENT / DUAL / MANUAL_REVIEW |
| Lifecycle INC-90482 stage → 2 approvals | APPROVED, device untouched, chain intact | confirmed: `APPROVED_FOR_MANUAL_EXECUTION`, `NOT_ISOLATED`, audit chain 16/16 intact |

**Both failures come from the latest commit `e907954` ("Send demo user ID to Clarity").** It added an em dash in a code comment (the repo bans em dashes in `app/src`), duplicated a JSDoc line, and calls `clarity('identify')` twice per consent (once in the click handler, once in an effect). The e2e test still encodes the pre-`e907954` contract of "no identify call".

**Spec vs repository drift.** The spec was written against a 92-test checkout. The repository has since shipped a "V3" programme (see `IMPLEMENTATION-STATUS.md`) that already implements several spec items, under different CH numbers:

| Spec item | Already in repo as | Status |
|---|---|---|
| CH-5 truthful state rail | V3 CH-14 lifecycle stepper (`app/src/lifecycle.ts`) | Stepper done; the redundant before/after boxes remain → finish in CH-5 |
| CH-13 evidence verification matrix | V3 CH-19 evidence checks (server-recorded) | **Done**, stronger than spec (server-side, tested) |
| CH-14 evidence package | V3 CH-18 JSON package with SHA-256 | Done for machines; a human-readable print view is missing → add |
| CH-15 audit chain in context | V3 CH-17 "Check the audit log" | **Done** |
| CH-20 access gate | V3 CH-20 passcode gate | **Done** |

---

## Section A: The spec's items, restated and mapped

| ID | What it means here | Files | Plan |
|---|---|---|---|
| CH-0 (new) | Repair the red baseline without weakening any test | `app/src/analytics.ts`, `AnalyticsNotice.tsx`, `tests/e2e/access.spec.ts` | Remove em dash and duplicate comment; make `identify` fire **exactly once** from one place; update the one e2e expectation to include that single call (see D1) |
| CH-1 | Design tokens and type scale | `styles.css` | Add `--space-*`, `--text-*`, `--tap-min`, `--radius-*`, `--shadow-card`. Additive; no existing token renamed |
| CH-2 | One consistent product story in copy | components (copy only), README | Glossary below. Decision/reason/state codes stay, shown small |
| CH-3 | Shared primitives | new `app/src/components/primitives.tsx` | Add primitives used by new UI (`Disclosure`, `MetricTile`, `CountBadge`). A wholesale refactor of four working pages is **DEFERRED**: high churn, no user-visible value, selector risk |
| CH-4 | Decision-first Review page | `RequestWorkspace.tsx` | New order: headline + safety → verdict with ≤3 plain reasons → **Next step panel (single primary button + what it will do)** → outcome → evidence. Primary action moves from ~1,250 px to above the fold at 1280×800 |
| CH-5 | Truthful lifecycle | `RequestWorkspace.tsx`, `lifecycle.ts` | Keep the stepper; replace the before/after boxes (which showed `WAITING_FOR_DUAL_APPROVAL (pending)` for a request that was not staged) with one status line carrying `state-transition`/`current-state` and the real state |
| CH-6 | Queue triage | `ReviewPage.tsx`, new `app/src/triage.ts` (+unit tests) | Group headings: Needs a decision / Not checked yet / Waiting for approvers / Finished. Stable sort, client-side, no backend |
| CH-7 | Say what a click will do | `RequestWorkspace.tsx` | One state-aware sentence under the primary button |
| CH-8 | Approver card leads with business context | `ApprovalsPage.tsx`, new `app/src/reasonText.ts` | Title "Approve full isolation of PRD-SAP-GW02?" + business service; reasons in plain words (reusing the server's `REASON_TEXT`, no copy); approver names, not IDs; codes secondary |
| CH-9 | Pending-approvals count | `App.tsx` | Count badge on the Approvals tab for the acting identity, refreshed on the existing 10 s session poll and on identity change |
| CH-10 | Demote the Lab | `LabPage.tsx`, `App.tsx` | Framing line "not part of the Gate"; reset + failure drills stay visible; clock, concurrency, least-privilege, logs and raw output move behind "Advanced simulator controls". **Tab keeps the name "Simulator Lab"** (see D3) |
| CH-11 | Guided 3-step import | `DataStudioPage.tsx` | Numbered steps 1 Choose file → 2 Review the check → 3 Confirm and commit. History and record browser stay visible (the e2e uses the record search) |
| CH-12 | Readable record browser | `DataStudioPage.tsx` | Key columns first per entity, truncation with full value in `title`, sticky header |
| CH-13 | Evidence matrix | none | Already done (V3 CH-19). No change |
| CH-14 | Exportable evidence | `RequestWorkspace.tsx`, `styles.css` | JSON package exists. Add **Print decision record**: a print stylesheet that prints the decision, reasons, checks and outcome with a "Synthetic demo data" header |
| CH-15 | Audit chain in context | none | Already done (V3 CH-17). No change |
| CH-16 | First-run story | `ReviewPage.tsx` | Not a modal. The existing empty state becomes a 3-part story (problem / answer / boundary) with one large button: **Show me the SAP gateway example** (selects INC-90482 and runs the check) |
| CH-17 | Live metrics strip | `server/src/system.ts` (one GET route), `ReviewPage.tsx`, integration test | `GET /api/metrics`: counts from `gate.db` + `machine_actions` filtered to `svc-containment-gate`. "Containment executed by the Gate: 0" is a computed count, not a literal |
| CH-18 | Present mode | `App.tsx`, `styles.css` | Header toggle; larger type, Lab tab hidden, metrics pinned; `sessionStorage` only |
| CH-19 | Investor one-pager | `docs/INVESTOR-ONE-PAGER.md` | Section E condensed; hypotheses labelled |
| CH-20 | Access gate | none | Already done (V3 CH-20) |

**Glossary applied in CH-2:** *containment* for the business audience ("Full isolation" kept where it is the Defender action); *business impact check* for evaluation; *approval request* in prose (the stored object stays "approval packet" where tests assert it); *four-eyes approval* = dual approval; *demo workspace* for simulator context; never "prevents outages", always "shows business impact before containment".

---

## Section B: Additional improvements (beyond the spec)

| # | Group | Problem (observed) | Change | Principle | Files | Risk |
|---|---|---|---|---|---|---|
| B1 | UI / a11y | Body text 14 px; labels and hints 11 to 12 px; hard for a 65+ reader | Base 16 px; nothing under 14 px; line-height 1.5 | WCAG 1.4.4/1.4.12; HIG Dynamic Type minimums | `styles.css` | Low (overflow re-tested at 390 px) |
| B2 | UI / a11y | Small buttons ~30 px tall | `.btn` ≥ 44 px, `.btn-sm` ≥ 36 px (AA 2.5.8 needs 24) | Fitts's law; WCAG 2.5.5 (AAA) / 2.5.8 | `styles.css` | Low |
| B3 | a11y | Focus ring only on some controls | Global `:focus-visible` ring, 3 px, high contrast | WCAG 2.4.7 / 2.4.13 | `styles.css` | Low |
| B4 | UX flow | Primary action ~1,250 px down the page | Covered by CH-4; plus result moves directly under the action | One primary action per screen; NN/g #1 visibility of system status | `RequestWorkspace.tsx` | Med (selectors held) |
| B5 | UX copy | Verdict is one run-on sentence with a capital mid-sentence ("…; A change freeze") | Reasons as a short list, first letter fixed | Miller's law, chunking | `RequestWorkspace.tsx` | Low |
| B6 | UX | Header sub-title is 70 characters of jargon | "Checks business impact before a device is cut off. Synthetic demo." | Plain language (NN/g #2 match the real world) | `App.tsx` | Low |
| B7 | a11y | Animations always on | Respect `prefers-reduced-motion` | WCAG 2.3.3 | `styles.css` | Low |
| B8 | DX / docs | README says 92 tests and 8 e2e; real numbers are higher | Update counts | Honesty of docs | `README.md` | Low |
| B9 | Code quality | Duplicate JSDoc line in `DataStudioPage.tsx` too | Remove | Hygiene | `DataStudioPage.tsx` | Low |
| B10 | Trust | Approvers listed by user ID (`soc-incident-commander (pending)`) | Names with role, ID secondary | Recognition over recall (NN/g #6) | `ApprovalsPage.tsx` | Low |

**Senior-user benchmark used.** Large type (≥16 px), high contrast (all text tokens ≥ 4.5:1 on their backgrounds; checked), no hover-only or hidden primary actions, one primary button per screen, plain verbs on buttons, every destructive or writing action states its effect before the click, errors say what to do next. Target journey for a first-time 65+ user: *open → read the three-line story → press "Show me the SAP gateway example" → read the decision and "what happens next"*. Two actions, no typing, no scrolling at 1280×800.

---

## Section C: Removals and simplifications

| What | Why | Reversible? |
|---|---|---|
| Before → After state boxes in "Bounded response workflow" | Duplicated the stepper and showed an unstaged request as `WAITING_FOR_DUAL_APPROVAL (pending)`, which is not a real state. Replaced by one truthful status line (same `data-testid`s) | Yes, UI only |
| "Bounded response workflow" as a separate section | Its content (stepper, button) moves into the Next step panel near the top | Yes |
| Duplicate JSDoc lines (`AnalyticsNotice.tsx`, `DataStudioPage.tsx`) | Copy-paste residue | Yes |
| Nothing in dependencies, schema, policy, simulators or tests is removed | | |

---

## Section D: Open questions (with the default taken so work is not blocked)

1. **Clarity `identify` contract.** `e907954` intentionally sends the demo user ID; the older e2e test forbids it. *Default:* keep the owner's newer intent, fix the double call, and update that one e2e expectation to "exactly one identify". This is the only existing assertion changed, isolated in its own commit, revertable. If you prefer no identity in analytics, revert `e907954` instead.
2. **Push access.** A request for push access to `Vijay353/SOC` was refused in this session. *Default:* commits stay on branch `enhance/product-clarity` and are delivered as a git bundle and patch series for you to push or open as a PR.
3. **Lab tab name.** The spec asks to rename "Simulator Lab" to "Demo controls"; unmodified e2e tests click the tab named "Simulator Lab" and the fourth visible **Inject** button. *Default:* keep the name and fault buttons visible; demote everything else.
4. **Real buyer evidence.** No user research exists (repo's own gap #7). All value estimates in Section E are hypotheses to test, not claims.

---

## Section E: Business problem deep-dive and value case

### E1. The problem in one sentence
**The fastest way for a SOC analyst to stop an attacker (isolating a device) is also one of the easiest ways to stop the business, and today nothing between the click and the outage checks which business service is on that device.**

### E2. Issue tree (MECE)

```
Why do security containment actions cause avoidable business interruption?
├── 1. The analyst cannot SEE business impact at decision time
│   ├── 1a. Ownership/tier lives in CMDB, not in the EDR console          (data location)
│   ├── 1b. CMDB data is stale or ambiguous (two CIs, no CI)               (data quality)
│   ├── 1c. Live dependencies/sessions are not in either tool              (data freshness)
│   └── 1d. Runbook constraints are prose in documents nobody reads at 3 a.m. (unstructured knowledge)
├── 2. Even when impact is known, there is no SAFE PATH to act
│   ├── 2a. No fast way to reach the accountable owner                     (process)
│   ├── 2b. Approvals happen in chat; no record of what evidence was seen  (audit)
│   └── 2c. Change freezes are not linked to security actions              (policy)
├── 3. Incentives favour speed over coordination
│   ├── 3a. SOC is measured on time-to-contain, not business continuity     (metrics)
│   └── 3b. Owner is blamed for outages they never approved                 (accountability)
└── 4. After the fact, nobody can prove the decision was sound
    ├── 4a. Regulators/insurers ask for segregation of duties evidence      (compliance)
    └── 4b. Post-incident reviews reconstruct decisions from memory         (learning)
```

**Symptoms vs root causes.** "Analyst isolated the wrong box" is a symptom. Root causes are 1b (untrusted CMDB), 2b (no evidence-bound approval) and 3a (one-sided metrics). The current product addresses 1a, 1c, 1d, 2a, 2b, 2c and 4a well; it touches 1b only by blocking and offering an Excel fix; it does not address 3a at all.

### E3. Cost of the status quo (sourced benchmarks, then a labelled estimate)

| Benchmark | Figure | Source |
|---|---|---|
| Hourly IT downtime cost, mid-size and large enterprises | > $300k/hour for over 90%; $1M to $5M+ for 41% | ITIC 2024 Hourly Cost of Downtime Survey |
| Unplanned downtime, Fortune Global 500 | ~$1.4T/year, 11% of revenue; automotive $2.3M/hour | Siemens, *True Cost of Downtime 2024* |
| A security-tool-induced outage at scale | CrowdStrike, July 2024: ~$5.4B direct loss to US Fortune 500, only ~10 to 20% insured | Parametrix impact analysis |

**Illustrative estimate (hypothesis, not a product claim).** A plant with one Tier-0 gateway at $300k/hour that suffers one 2-hour self-inflicted interruption per year loses ~$600k. If an evidence-bound gate prevented half of such events, avoided loss would be ~$300k/year per site, before audit savings. This must be validated with real incident data; the prototype proves the mechanism, not the rate.

### E4. New dimensions the current version under-weights
- **Data quality as a product** (1b): the Gate blocks on stale CMDB; the fix loop is Excel only. Opportunity: a "data debt" view of which CIs block containment.
- **Trust and compliance**: four-eyes approval, evidence hashes and a tamper-evident log map onto what cyber underwriters and auditors ask for (segregation of duties, verifiable approvals, fail-safe defaults).
- **Time pressure**: approvals expire in 15 minutes; the approver's experience (mobile, notification) is the real bottleneck. Notifications are out of scope today.
- **Accessibility and seniority**: approvers are often senior service owners, not SOC natives. The approver card must be readable in seconds by a non-security person (drives CH-8, B1, B2, B10).
- **Multi-persona**: analyst (speed), owner (continuity), incident commander (accountability), auditor (proof), buyer (risk transfer).

### E5. Honest map of the current solution
- **Solves well:** evidence reconciliation, fail-closed defaults, single verified write, dual approval, audit trail, injection resistance, failure drills.
- **Claims but only partly delivers:** "within 30 seconds" comprehension (the decision was visible, but the action was buried; untested with users).
- **Conflicts:** the UI presented a two-state before/after diagram that contradicted the 10-state machine; the analytics identify commit contradicted its own e2e contract.

### E6. Alternative approaches

| Option | What it is | Pros | Cons | Verdict |
|---|---|---|---|---|
| A. Pre-execution gate (current) | Sits between the request and the EDR action; stages owner approval | Clean authority boundary; auditable; no write power | Adds a step for every high-impact action | **Recommended core** |
| B. Selective containment by default | Recommend "selective isolation" (keep business flows) instead of asking for approval | Faster; less friction | Needs reliable flow maps; risk of leaving C2 open | Phase 2 add-on, as a *recommended alternative* the gate can surface |
| C. Post-hoc impact analytics | Report after containment which services were hit | Easy to sell to ops | Does not prevent anything; blame tool | Reject as primary; useful as retention feature |

### E7. Agentic AI value layer (proposals; none ship as "AI decides")

| Capability | Job to be done | Value lever (rough magnitude, hypothesis) | Human-in-the-loop boundary | Failure modes and guardrails | Fit with existing code |
|---|---|---|---|---|---|
| Constraint extraction from runbooks (exists, optional model path) | Turn prose runbooks into cited constraints | Efficiency: minutes per runbook per incident | Agent extracts and cites; policy decides; may abstain | Hallucination → verbatim-citation check + schema (already in `model-extractor.ts`) | Already integrated |
| CMDB repair suggestions | Propose the fix for a stale/ambiguous CI (which CI, which owner) | Cost: shrinks the blocked-request queue; hours saved per fix | Agent drafts an import row; human previews and commits via Data Studio | Wrong owner → only drafts; same validate → preview → confirm gate | Reuses the import pipeline, no new write path |
| Approver brief | 3-line plain-language summary for the owner on mobile | Retention/speed: fewer expired approvals | Agent summarises recorded facts only; owner decides | Invented facts → generate only from `impactFacts` and `REASON_TEXT`, show sources | Read-only over existing payload |
| Selective-isolation recommender (option B) | Suggest the least disruptive containment | Revenue: premium tier | Agent recommends; analyst chooses; Gate still never executes | Over-automation → never auto-selected; dual approval unchanged | Additive decision path, needs new policy version |
| Post-incident narrative | Draft the review from audit + trace | Efficiency: hours per review | Agent drafts; reviewer edits | Misattribution → every sentence cites a trace step | Read-only over evidence package |

None of these is implemented in this change: the spec forbids new third-party LLM integrations in this backlog. They are the roadmap.

### E8. Startup pitch (grounded in the code shipped)
- **Problem:** security teams cause some of the outages they are meant to prevent; one isolation click can stop a warehouse.
- **Insight:** the information needed to avoid it already exists (CMDB, live sessions, freezes, runbooks); it is just not at the point of decision, and nobody signs for the risk.
- **Solution:** a pre-execution gate that reconciles that evidence, decides deterministically, and turns a risky click into a four-eyes approval with a tamper-evident record. It never executes containment.
- **Value:** business-interruption avoidance with an audit-grade paper trail. In the demo the live counter shows *containment actions executed by the Gate: 0*, computed from the simulator.
- **Why now:** downtime costs keep rising (ITIC, Siemens); a security-tool outage in 2024 cost the Fortune 500 billions and was mostly uninsured (Parametrix); insurers now ask for verifiable controls.
- **Why this team:** a working, tested prototype with fail-closed adapters, injection resistance, and 260+ automated checks, built to be honest about what it does not prove.

### E9. Traceability: every change maps to a problem dimension
CH-4/5/7, B4, B5 → 1 and E5 ("30 seconds"). CH-6 → 1, time pressure. CH-8, CH-9, B10 → 2a and approver persona. CH-10/11/12 → 1b data quality. CH-14 print → 4a/4b. CH-16 → onboarding, senior users. CH-17 → value made visible (E8). CH-18 → buyer demo. B1 to B3, B7 → accessibility dimension.

---

## Sources
- ITIC, *2024 Hourly Cost of Downtime Survey*, https://itic-corp.com/?p=3152
- Siemens / Senseye, *The True Cost of Downtime 2024*, https://assets.new.siemens.com/siemens/assets/api/uuid:1b43afb5-2d07-47f7-9eb7-893fe7d0bc59/TCOD-2024_original.pdf
- Parametrix, *CrowdStrike's Impact on the Fortune 500* (reported by Insurance Journal, Business Insurance, Axios, July 2024)

---

## Completion summary (filled in after implementation)

Per-change evidence, SHAs and rollbacks: [IMPLEMENTATION-STATUS.md › Product-clarity change register](IMPLEMENTATION-STATUS.md#product-clarity-change-register).

| Measure | Baseline `e907954` | After |
|---|---|---|
| Unit + integration | 237/238 (1 fail) | 252/252 |
| E2E | 26/27 (1 fail) | 32/32 (27 existing + 5 new) |
| Existing assertions changed | n/a | 1 (CH-0, analytics identify, disclosed) |
| Primary action on decision screen (1280x800) | ~1,250 px down, below the fold | In the first viewport (e2e-asserted) |
| First visit to decision | Read hints, pick a device, press Prepare | One press: "Show me the PRD-SAP-GW02 example" |
| Smallest text | 9.5 px | 14 px (body 16 px) |
| Controls under 24 px (WCAG 2.5.8) | every disclosure toggle (21 px) | none |
| axe WCAG 2.2 AA, 12 page states light + dark | 3 contrast failures (dark-mode primary button, pre-existing) | 0 |
| Backend changes | n/a | 1 read-only route (`GET /api/metrics`); policy, orchestrator, store, simulators untouched |

**Value delivered, in business terms**
- *Efficiency:* the analyst sees decision, reasons and the one permitted action without scrolling, and knows what the click will do before pressing it. The approver decides from a card that names the business service and the time left.
- *Trust:* the lifecycle display can no longer show a state that does not exist; a race that could show one device's decision under another device's name is fixed; "containment executed by the Gate: 0" is computed, and a test proves it.
- *Usability:* senior-legible type, 44 px targets for the main controls, story-first on phones, zero axe violations.
- *Sales readiness:* Present mode, a printable decision record and an honest one-pager ([INVESTOR-ONE-PAGER.md](INVESTOR-ONE-PAGER.md)).

**Deviations from the spec:** CH-10 keeps the tab name "Simulator Lab" and the fault buttons visible (unmodified e2e depends on both). CH-3's full page refactor is deferred. CH-13, CH-15 and CH-20 were already implemented by the repo's V3 work.

**Follow-ups:** validate the first-visit journey with 5 to 8 real users including at least two aged 65+ (the repo has no user research); approver notifications (out of scope); consider a light/dark/large-text preference beyond Present mode; decide the analytics identify contract (D1).
