/**
 * CH-14: maps each real request state to the steps shown in the stepper. One place for every presentation label.
 * This is display only: transitions are decided and enforced on the server, and "possible next" comes straight
 * from the shared transition table rather than from a client-side copy.
 */
import { REQUEST_TRANSITIONS } from '../../packages/contracts/src/lifecycle';
import type { RequestState } from './types';

export type StepStatus = 'done' | 'current' | 'upcoming' | 'blocked' | 'failed' | 'end-ok' | 'end-bad';
export interface Step {
  label: string;
  status: StepStatus;
}

const evaluated: Step = { label: 'Evidence checked', status: 'done' };
const staged: Step = { label: 'Approval packet created and verified', status: 'done' };

export function lifecycleSteps(state: RequestState): Step[] {
  switch (state) {
    case 'RESPONSE_READY':
      return [evaluated, { label: 'Create the approval packet', status: 'current' }, { label: 'Two approvals', status: 'upcoming' }, { label: 'Approved, rejected or expired', status: 'upcoming' }];
    case 'WAITING_FOR_DUAL_APPROVAL':
      return [evaluated, staged, { label: 'Waiting for two approvals', status: 'current' }, { label: 'Approved, rejected or expired', status: 'upcoming' }];
    case 'APPROVED_FOR_MANUAL_EXECUTION':
      return [evaluated, staged, { label: 'Two approvals recorded', status: 'done' }, { label: 'Approved for manual execution in Defender', status: 'end-ok' }];
    case 'REJECTED':
      return [evaluated, staged, { label: 'An approver rejected the request', status: 'end-bad' }];
    case 'EXPIRED':
      return [evaluated, staged, { label: 'Approval time ran out', status: 'end-bad' }];
    case 'STANDARD_RESPONSE_ELIGIBLE':
      return [evaluated, { label: 'Standard path: no approval packet needed', status: 'end-ok' }];
    case 'INSUFFICIENT_EVIDENCE':
      return [evaluated, { label: 'Blocked: not enough current evidence', status: 'blocked' }, { label: 'Fix the evidence, then check again', status: 'upcoming' }];
    case 'MANUAL_REVIEW':
      return [evaluated, { label: 'Blocked: a person must review', status: 'blocked' }, { label: 'Check again after the review', status: 'upcoming' }];
    case 'REEVALUATION_REQUIRED':
      return [{ label: 'Evidence is out of date', status: 'blocked' }, { label: 'Check the evidence again', status: 'current' }];
    case 'VERIFICATION_FAILED':
      return [evaluated, { label: 'Packet did not read back as sent', status: 'failed' }, { label: 'Manual reconciliation (escalated)', status: 'end-bad' }];
  }
}

/** The states the server would allow next. Read from the shared table, never computed here. */
export function possibleNext(state: RequestState): readonly RequestState[] {
  return REQUEST_TRANSITIONS[state];
}
