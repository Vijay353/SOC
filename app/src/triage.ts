/**
 * Product-clarity CH-6: groups the queue by what it needs from a person, using only the request state the server
 * already returned. Display only; the server decides every transition. The sort is stable, so items keep the
 * seeded order inside a group (the primary SAP scenario stays first on a fresh seed).
 */
import type { QueueItem, RequestState } from './types';

export type TriageGroup = 'action' | 'new' | 'waiting' | 'done';

export const TRIAGE_ORDER: readonly TriageGroup[] = ['action', 'new', 'waiting', 'done'];

export const TRIAGE_LABEL: Record<TriageGroup, string> = {
  action: 'Needs a decision',
  new: 'Not checked yet',
  waiting: 'Waiting for approvers',
  done: 'Finished',
};

const BY_STATE: Record<RequestState, TriageGroup> = {
  RESPONSE_READY: 'action',
  INSUFFICIENT_EVIDENCE: 'action',
  MANUAL_REVIEW: 'action',
  REEVALUATION_REQUIRED: 'action',
  VERIFICATION_FAILED: 'action',
  WAITING_FOR_DUAL_APPROVAL: 'waiting',
  APPROVED_FOR_MANUAL_EXECUTION: 'done',
  STANDARD_RESPONSE_ELIGIBLE: 'done',
  REJECTED: 'done',
  EXPIRED: 'done',
};

export function triageGroup(item: Pick<QueueItem, 'latestRequest'>): TriageGroup {
  return item.latestRequest ? BY_STATE[item.latestRequest.state] : 'new';
}

/** Groups in a fixed order; empty groups are left out. Stable within each group. */
export function triage<T extends Pick<QueueItem, 'latestRequest'>>(items: readonly T[]): Array<{ group: TriageGroup; label: string; items: T[] }> {
  return TRIAGE_ORDER.map((group) => ({ group, label: TRIAGE_LABEL[group], items: items.filter((i) => triageGroup(i) === group) })).filter((g) => g.items.length > 0);
}
