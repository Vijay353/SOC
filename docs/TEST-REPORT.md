# Test report

Run on 2026-10-18 in the build environment (Linux, Node v22.22.0). Counts below are from actual runs of `npm run verify` (exit code 0), including a clean-room run: the delivered zip unpacked into an empty directory, `npm ci` (no native build), then `npm run verify`.

| Step | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`, strict, `noUncheckedIndexedAccess`) | 0 errors |
| Lint | `npm run lint` | 0 errors, 0 warnings |
| Unit + integration | `npm test` | **6 files, 92 tests passed, 0 failed** |
| Production build | `npm run build` | Built (JS ≈ 260 KB, ≈ 80 KB gzip) |
| Secret scan | `npm run secret-scan` | Passed (3 bundle files, 65 source files) |
| Browser E2E | `PW_CHROMIUM_PATH=<chromium> npm run test:e2e` | **8 passed, 0 failed** |

## Unit + integration breakdown

| File | Tests | Covers |
|---|---|---|
| `tests/unit/policy.test.ts` | 15 | every policy rule, precedence, conflict, determinism |
| `tests/unit/extractor.test.ts` | 14 | SAP citations, conflict abstention, injection, wrong host, fabricated/old-version/unknown-doc citations, low confidence, strict schema, model adapter (stubbed): no creds, hallucinated quote, provider error |
| `tests/unit/http-client.test.ts` | 5 | retry on 503, no retry for unmarked POST, no retry on 409, timeout, canonical hashing |
| `tests/integration/vertical-slice.test.ts` | 3 | G1 happy path with independent simulator read-back; stale-CMDB negative; least-privilege 403 |
| `tests/integration/workflow.test.ts` | 35 | 6 seeded scenarios; conflict + injection; ambiguous identity; duplicate event; open-request folding; concurrent/repeated stage; stale revision + re-evaluate; simulator If-Match 409; evaluation expiry; ITSM outage + recovery; 401; transient 500s; 429 write retry; timeout-after-commit; all-attempts-timeout + outbox retry; reconciliation; corrupt read-back; precheck outage; approvals + SoD; reject; expiry never approves; inbox scoping; role/identity checks; invalid event; invalid tool payload + invalid transition; append-only audit + hash chain; reset/replay determinism; SANDBOX/LIVE/model fail-closed |
| `tests/integration/data-import.test.ts` | 20 | template structure; idempotent re-import; Excel fix changes decision; double commit; stale preview; 8 invalid fixtures (missing sheet, wrong types, duplicate IDs, orphan refs, invalid status, formula, native date, stale revision) with no state change; located errors; oversized/macro/non-zip/unsupported/empty; CSV merge + refs; CSV guards; export injection protection + round trip; replace + history restore; record browser |

## Browser E2E (`tests/e2e`)

1. Happy path: prepare → stage → verified result → inspector shows real HTTP trace → API confirms state and device untouched.
2. Negative: stale CMDB → INSUFFICIENT_EVIDENCE, no stage button.
3. Excel import (valid fixture) changes MES decision to REQUIRE_DUAL_APPROVAL.
4. Invalid workbook shows ORPHAN_REFERENCE with the bad ID; no commit offered.
5. Two approvers via identity switch; request APPROVED_FOR_MANUAL_EXECUTION; still no containment.
6. Corrupted read-back → VERIFICATION_FAILED banner, not success.
7. Keyboard-only selection and preparation.
8. 390 px viewport: no horizontal page scroll.

## Environment notes and omissions

- Playwright's managed browser download is blocked in the build environment; E2E used a Chromium binary from the `@sparticuz/chromium` npm package via `PW_CHROMIUM_PATH` (not a project dependency).
- Not tested: real vendor sandboxes, a live model, screen-reader output, cross-browser (Firefox/WebKit), load/concurrency beyond two parallel stage calls, contrast measured by tooling (palette chosen for WCAG AA but not machine-audited).

## V3 update (2026-11-09)

The numbers above are the pre-V3 delivery. After the V3 changes, `npm run verify` passes with 29 test files and 237 tests, and 27 browser tests on two servers (passcode gate off and on). Details, commands and output: `docs/V3-CHANGE-REPORT.md`.
