/**
 * The request lifecycle transition table, shared by the Gate store (which enforces it) and the UI (which only
 * displays it). Plain TypeScript with no runtime dependencies so the browser bundle can import it.
 */
import type { RequestState } from './domain';

export const REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  RESPONSE_READY: ['WAITING_FOR_DUAL_APPROVAL', 'STANDARD_RESPONSE_ELIGIBLE', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'REEVALUATION_REQUIRED', 'VERIFICATION_FAILED', 'RESPONSE_READY'],
  INSUFFICIENT_EVIDENCE: ['RESPONSE_READY'],
  MANUAL_REVIEW: ['RESPONSE_READY'],
  REEVALUATION_REQUIRED: ['RESPONSE_READY'],
  WAITING_FOR_DUAL_APPROVAL: ['APPROVED_FOR_MANUAL_EXECUTION', 'REJECTED', 'EXPIRED'],
  VERIFICATION_FAILED: [],
  STANDARD_RESPONSE_ELIGIBLE: [],
  APPROVED_FOR_MANUAL_EXECUTION: [],
  REJECTED: [],
  EXPIRED: [],
};
