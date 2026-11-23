/** Product-clarity CH-6: queue grouping is a pure function of the server-reported state. */
import { describe, expect, it } from 'vitest';
import { triage, triageGroup, TRIAGE_ORDER } from '../../app/src/triage';
import type { RequestState } from '../../app/src/types';

const item = (id: string, state: RequestState | null) => ({ id, latestRequest: state ? { requestId: `REQ-${id}`, state, approvalId: null } : null });

describe('queue triage', () => {
  it('an unreviewed item is "not checked yet"', () => {
    expect(triageGroup(item('a', null))).toBe('new');
  });

  it('every real request state maps to exactly one group, and terminal states are finished', () => {
    const all: RequestState[] = [
      'RESPONSE_READY',
      'WAITING_FOR_DUAL_APPROVAL',
      'STANDARD_RESPONSE_ELIGIBLE',
      'INSUFFICIENT_EVIDENCE',
      'MANUAL_REVIEW',
      'REEVALUATION_REQUIRED',
      'VERIFICATION_FAILED',
      'APPROVED_FOR_MANUAL_EXECUTION',
      'REJECTED',
      'EXPIRED',
    ];
    for (const s of all) expect(TRIAGE_ORDER).toContain(triageGroup(item('x', s)));
    for (const s of ['APPROVED_FOR_MANUAL_EXECUTION', 'STANDARD_RESPONSE_ELIGIBLE', 'REJECTED', 'EXPIRED'] as const) expect(triageGroup(item('x', s))).toBe('done');
    expect(triageGroup(item('x', 'WAITING_FOR_DUAL_APPROVAL'))).toBe('waiting');
    for (const s of ['RESPONSE_READY', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'REEVALUATION_REQUIRED', 'VERIFICATION_FAILED'] as const) expect(triageGroup(item('x', s))).toBe('action');
  });

  it('a fresh seed keeps its order in one group', () => {
    const fresh = ['1', '2', '3', '4', '5', '6'].map((id) => item(id, null));
    const groups = triage(fresh);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('orders action, new, waiting, done; stable inside a group; drops empty groups; loses nothing', () => {
    const mixed = [item('a', 'EXPIRED'), item('b', null), item('c', 'INSUFFICIENT_EVIDENCE'), item('d', 'WAITING_FOR_DUAL_APPROVAL'), item('e', 'RESPONSE_READY'), item('f', null)];
    const groups = triage(mixed);
    expect(groups.map((g) => g.group)).toEqual(['action', 'new', 'waiting', 'done']);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['c', 'e']);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['b', 'f']);
    expect(groups.flatMap((g) => g.items)).toHaveLength(mixed.length);
  });
});
