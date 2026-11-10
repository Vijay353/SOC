import { describe, expect, it } from 'vitest';
import { lifecycleSteps, possibleNext } from '../../app/src/lifecycle';
import { RequestState } from '../../packages/contracts/src/domain';
import { REQUEST_TRANSITIONS } from '../../packages/contracts/src/lifecycle';

const ALL = RequestState.options;

describe('CH-14 lifecycle stepper', () => {
  it('every real state has a presentation, with at most one current step', () => {
    for (const s of ALL) {
      const steps = lifecycleSteps(s);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.filter((x) => x.status === 'current').length).toBeLessThanOrEqual(1);
    }
  });

  it('states the server treats as terminal show an ending and nothing upcoming', () => {
    for (const s of ALL.filter((x) => REQUEST_TRANSITIONS[x].length === 0)) {
      const steps = lifecycleSteps(s);
      expect(steps.some((x) => x.status === 'upcoming' || x.status === 'current'), s).toBe(false);
      expect(['end-ok', 'end-bad']).toContain(steps[steps.length - 1]!.status);
    }
  });

  it('states the server allows to move on always show something still to come', () => {
    for (const s of ALL.filter((x) => REQUEST_TRANSITIONS[x].length > 0)) {
      expect(lifecycleSteps(s).some((x) => x.status === 'upcoming' || x.status === 'current'), s).toBe(true);
    }
  });

  it('failed, blocked and closed states are never shown as a success', () => {
    for (const s of ['REJECTED', 'EXPIRED', 'VERIFICATION_FAILED', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW'] as const) {
      expect(lifecycleSteps(s).some((x) => x.status === 'end-ok'), s).toBe(false);
    }
  });

  it('a waiting request does not promise approval: the outcome step names all three endings', () => {
    expect(lifecycleSteps('WAITING_FOR_DUAL_APPROVAL').at(-1)!.label).toBe('Approved, rejected or expired');
    expect(possibleNext('WAITING_FOR_DUAL_APPROVAL')).toEqual(['APPROVED_FOR_MANUAL_EXECUTION', 'REJECTED', 'EXPIRED']);
  });

  it('possible next states come from the shared table (the same object the store enforces)', () => {
    for (const s of ALL) expect(possibleNext(s)).toBe(REQUEST_TRANSITIONS[s]);
  });
});
