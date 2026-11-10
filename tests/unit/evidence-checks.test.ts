/**
 * CH-19: the checks are recorded by the policy engine itself. These properties hold for every input in a grid
 * that covers each rule: the checks agree with the decision and the reason codes, and nothing not run is shown as run.
 */
import { describe, expect, it } from 'vitest';
import type { PolicyInput } from '../../packages/contracts/src/domain';
import { CHECK_DEFS, evaluatePolicy } from '../../server/src/gate/policy';

const base: PolicyInput = {
  requestedAction: 'FULL_ISOLATION',
  defenderCriticality: 'CRITICAL',
  cmdbCriticality: 'TIER_0',
  activeDependencyCount: 18,
  activeSessionCount: 1420,
  changeFreezeActive: true,
  evidenceFresh: true,
  staleSources: [],
  unavailableSources: [],
  identityMatch: 'EXACT',
  extractionAbstained: false,
  ownerApprovalConstraint: true,
  approversResolved: true,
  separationOfDutiesConflict: false,
  possibleDuplicate: false,
};
const standard: PolicyInput = { ...base, defenderCriticality: 'STANDARD', cmdbCriticality: 'TIER_3', activeDependencyCount: 0, activeSessionCount: 0, changeFreezeActive: false, ownerApprovalConstraint: false };

function* grid(): Generator<PolicyInput> {
  for (const start of [base, standard])
    for (const unavailableSources of [[], ['cmdb']])
      for (const identityMatch of ['EXACT', 'AMBIGUOUS', 'NONE'] as const)
        for (const stale of [false, true])
          for (const extractionAbstained of [false, true])
            for (const separationOfDutiesConflict of [false, true])
              for (const approversResolved of [true, false])
                for (const possibleDuplicate of [false, true])
                  for (const cmdbCriticality of [start.cmdbCriticality, 'UNKNOWN'] as const)
                    yield { ...start, unavailableSources, identityMatch, evidenceFresh: !stale, staleSources: stale ? ['cmdb'] : [], extractionAbstained, separationOfDutiesConflict, approversResolved, possibleDuplicate, cmdbCriticality };
}

const ORDER = ['R1', 'R2', 'R3', 'R4a', 'R4'];
const decidingRule = (rulesFired: string[]) => (rulesFired.includes('R3b_APPROVERS_UNRESOLVED') ? 'R3' : rulesFired[0]!.split('_')[0]!);

describe('evidence checks recorded by the policy engine', () => {
  it('cover every check in a fixed order', () => {
    const r = evaluatePolicy(base);
    expect(r.checks.map((c) => c.checkId)).toEqual(CHECK_DEFS.map((d) => d.checkId));
  });

  it('agree with the decision and reason codes for every input in the grid', () => {
    let n = 0;
    for (const input of grid()) {
      n++;
      const r = evaluatePolicy(input);
      const ctx = JSON.stringify({ input, decision: r.decision });
      // Every reason code comes from a check that did not pass.
      const fromChecks = new Set(r.checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN').flatMap((c) => c.reasonCodes));
      for (const code of r.reasonCodes) if (code !== 'NO_BUSINESS_IMPACT_SIGNAL') expect(fromChecks.has(code), `${code} ${ctx}`).toBe(true);
      // Only the standard path has no blocking check.
      expect(r.checks.some((c) => c.blocksAutoAction), ctx).toBe(r.decision !== 'STANDARD_RESPONSE_ELIGIBLE');
      // Checks of rules after the deciding rule were not run, so they are never shown as passed or failed.
      const decided = ORDER.indexOf(decidingRule(r.rulesFired));
      for (const c of r.checks) if (ORDER.indexOf(c.ruleId.split(',')[0]!) > decided) expect(c.status, `${c.checkId} ${ctx}`).toBe('NOT_EVALUATED');
      // NOT_EVALUATED never blocks and never carries a reason code.
      for (const c of r.checks.filter((x) => x.status === 'NOT_EVALUATED')) expect(c.blocksAutoAction || c.reasonCodes.length > 0).toBe(false);
    }
    expect(n).toBe(2 * 2 * 3 * 2 * 2 * 2 * 2 * 2 * 2);
  });

  it('the primary scenario: evidence passes, business impact warns, and no later check is skipped', () => {
    const r = evaluatePolicy(base);
    const by = Object.fromEntries(r.checks.map((c) => [c.checkId, c.status]));
    expect(by).toEqual({
      SOURCES_AVAILABLE: 'PASS',
      DEVICE_IDENTITY: 'PASS',
      EVIDENCE_FRESH: 'PASS',
      MANDATORY_FIELDS: 'PASS',
      OPERATING_DOCUMENTS: 'PASS',
      SEPARATION_OF_DUTIES: 'PASS',
      BUSINESS_IMPACT: 'WARN',
      APPROVERS_RESOLVED: 'PASS',
      DUPLICATE_RISK: 'PASS',
    });
  });

  it('a source that did not answer: identity and freshness are not evaluated, not passed', () => {
    const r = evaluatePolicy({ ...base, unavailableSources: ['cmdb'] });
    const by = Object.fromEntries(r.checks.map((c) => [c.checkId, c.status]));
    expect(by).toMatchObject({ SOURCES_AVAILABLE: 'FAIL', DEVICE_IDENTITY: 'NOT_EVALUATED', EVIDENCE_FRESH: 'NOT_EVALUATED', MANDATORY_FIELDS: 'NOT_EVALUATED', BUSINESS_IMPACT: 'NOT_EVALUATED' });
  });

  it('the standard path has no approvers check, because none is needed', () => {
    const r = evaluatePolicy(standard);
    expect(r.decision).toBe('STANDARD_RESPONSE_ELIGIBLE');
    expect(r.checks.find((c) => c.checkId === 'APPROVERS_RESOLVED')).toMatchObject({ status: 'NOT_EVALUATED', blocksAutoAction: false });
  });
});
