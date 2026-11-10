import { describe, expect, it } from 'vitest';
import type { PolicyInput } from '../../packages/contracts/src/domain';
import { evaluatePolicy } from '../../server/src/gate/policy';

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

describe('policy CAP-1.1', () => {
  it('primary scenario requires dual approval with the documented reason codes', () => {
    const r = evaluatePolicy(base);
    expect(r.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(r.reasonCodes).toEqual(['CMDB_TIER_0', 'ACTIVE_CRITICAL_DEPENDENCIES', 'CHANGE_FREEZE_ACTIVE', 'RUNBOOK_OWNER_APPROVAL_REQUIRED', 'FULL_ISOLATION_HIGH_IMPACT']);
  });

  it.each([
    [{ identityMatch: 'AMBIGUOUS' as const }, 'IDENTITY_AMBIGUOUS'],
    [{ identityMatch: 'NONE' as const }, 'IDENTITY_NOT_FOUND'],
    [{ evidenceFresh: false, staleSources: ['cmdb'] }, 'CMDB_STALE'],
    [{ unavailableSources: ['mock-itsm'] }, 'SOURCE_UNAVAILABLE_MOCK_ITSM'],
    [{ cmdbCriticality: 'UNKNOWN' as const }, 'CMDB_CRITICALITY_UNKNOWN'],
    [{ activeSessionCount: null }, 'MANDATORY_FIELD_MISSING'],
  ])('missing/ambiguous/stale evidence fails closed: %o', (patch, code) => {
    const r = evaluatePolicy({ ...base, ...patch });
    expect(r.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.reasonCodes).toContain(code);
  });

  it('insufficient evidence outranks extractor abstention and impact signals', () => {
    expect(evaluatePolicy({ ...base, identityMatch: 'AMBIGUOUS', extractionAbstained: true }).decision).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('extractor abstention → MANUAL_REVIEW even on a critical asset', () => {
    expect(evaluatePolicy({ ...base, extractionAbstained: true })).toMatchObject({ decision: 'MANUAL_REVIEW', reasonCodes: ['EXTRACTION_ABSTAINED'] });
  });

  it('separation-of-duties conflict → MANUAL_REVIEW', () => {
    expect(evaluatePolicy({ ...base, separationOfDutiesConflict: true }).decision).toBe('MANUAL_REVIEW');
  });

  it('criticality conflict selects the stricter path', () => {
    const r = evaluatePolicy({ ...base, defenderCriticality: 'STANDARD', cmdbCriticality: 'TIER_1', changeFreezeActive: false, ownerApprovalConstraint: false, activeDependencyCount: 0 });
    expect(r.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(r.reasonCodes).toContain('CRITICALITY_CONFLICT');
    const r2 = evaluatePolicy({ ...base, defenderCriticality: 'CRITICAL', cmdbCriticality: 'TIER_3', changeFreezeActive: false, ownerApprovalConstraint: false, activeDependencyCount: 0 });
    expect(r2.reasonCodes).toEqual(['CRITICALITY_CONFLICT', 'FULL_ISOLATION_HIGH_IMPACT']);
  });

  it('impact without resolvable approvers is not staged', () => {
    expect(evaluatePolicy({ ...base, approversResolved: false })).toMatchObject({ decision: 'INSUFFICIENT_EVIDENCE', reasonCodes: ['APPROVERS_UNRESOLVED'] });
  });

  it('standard path only with complete, current, impact-free evidence', () => {
    const r = evaluatePolicy({ ...base, defenderCriticality: 'STANDARD', cmdbCriticality: 'TIER_3', activeDependencyCount: 0, activeSessionCount: 2, changeFreezeActive: false, ownerApprovalConstraint: false });
    expect(r.decision).toBe('STANDARD_RESPONSE_ELIGIBLE');
  });

  it('dependencies without live sessions do not count as active dependency impact', () => {
    const r = evaluatePolicy({ ...base, defenderCriticality: 'STANDARD', cmdbCriticality: 'TIER_2', activeDependencyCount: 3, activeSessionCount: 0, changeFreezeActive: false, ownerApprovalConstraint: false });
    expect(r.decision).toBe('STANDARD_RESPONSE_ELIGIBLE');
  });

  it('CAP-1.1: a possible duplicate on a critical asset stays on dual approval and names the reason', () => {
    const r = evaluatePolicy({ ...base, possibleDuplicate: true });
    expect(r.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(r.reasonCodes).toEqual(['CMDB_TIER_0', 'ACTIVE_CRITICAL_DEPENDENCIES', 'CHANGE_FREEZE_ACTIVE', 'RUNBOOK_OWNER_APPROVAL_REQUIRED', 'POSSIBLE_DUPLICATE_REQUEST', 'FULL_ISOLATION_HIGH_IMPACT']);
  });

  it('CAP-1.1: a possible duplicate keeps an otherwise standard request off the standard path', () => {
    const quiet = { ...base, defenderCriticality: 'STANDARD' as const, cmdbCriticality: 'TIER_3' as const, activeDependencyCount: 0, activeSessionCount: 2, changeFreezeActive: false, ownerApprovalConstraint: false };
    expect(evaluatePolicy({ ...quiet, possibleDuplicate: true })).toMatchObject({ decision: 'MANUAL_REVIEW', reasonCodes: ['POSSIBLE_DUPLICATE_REQUEST'] });
    expect(evaluatePolicy(quiet).decision).toBe('STANDARD_RESPONSE_ELIGIBLE');
  });

  it('CAP-1.1: missing evidence still outranks a possible duplicate', () => {
    expect(evaluatePolicy({ ...base, possibleDuplicate: true, identityMatch: 'AMBIGUOUS' }).decision).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('is deterministic', () => {
    expect(evaluatePolicy(base)).toEqual(evaluatePolicy(structuredClone(base)));
  });
});

describe('CH-16 rule list matches the rules the engine actually fires', () => {
  it('every listed rule id is the prefix of a fired rule, and every fired rule is listed', async () => {
    const { POLICY_RULES } = await import('../../server/src/gate/policy');
    const quiet = { ...base, defenderCriticality: 'STANDARD' as const, cmdbCriticality: 'TIER_3' as const, activeDependencyCount: 0, activeSessionCount: 2, changeFreezeActive: false, ownerApprovalConstraint: false };
    const fired = new Set(
      [
        evaluatePolicy({ ...base, identityMatch: 'NONE' }),
        evaluatePolicy({ ...base, extractionAbstained: true }),
        evaluatePolicy(base),
        evaluatePolicy({ ...base, approversResolved: false }),
        evaluatePolicy({ ...quiet, possibleDuplicate: true }),
        evaluatePolicy(quiet),
      ].flatMap((r) => r.rulesFired.map((f) => f.split('_')[0]!.replace(/b$/, ''))),
    );
    expect([...fired].sort()).toEqual(POLICY_RULES.map((r) => r.id).sort());
  });
});
