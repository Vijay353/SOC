/**
 * CH-11: the request's own audit events in plain words. Nothing is dropped, reordered or redacted:
 * every audit event becomes exactly one line, oldest first, and unknown actions fall back to their code.
 */
export interface AuditEvent {
  seq: number;
  at: string;
  actor: string;
  action: string;
  details: unknown;
}

export const DECISION_WORDS: Record<string, string> = {
  REQUIRE_DUAL_APPROVAL: 'dual approval required',
  STANDARD_RESPONSE_ELIGIBLE: 'standard response path',
  INSUFFICIENT_EVIDENCE: 'not enough current evidence',
  MANUAL_REVIEW: 'manual review needed',
};

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function activityText(e: AuditEvent): string {
  const d = (e.details && typeof e.details === 'object' ? e.details : {}) as Record<string, unknown>;
  switch (e.action) {
    case 'MANUAL_ISOLATION_REQUESTED':
      return `${e.actor} asked to fully isolate the device`;
    case 'EVALUATED':
      return `Evidence checked: ${DECISION_WORDS[str(d.decision)] ?? str(d.decision)}`;
    case 'APPROVAL_PACKET_STAGED':
      return `Approval packet ${str(d.approvalId)} created and read back${d.duplicate ? ' (it already existed)' : ''}`;
    case 'STAGE_FAILED':
      return 'Creating the approval packet did not complete. Nothing was changed';
    case 'STAGE_BLOCKED_STALE_INCIDENT':
      return `Staging stopped: the incident changed from revision ${str(d.expected)} to ${str(d.actual)}`;
    case 'STAGE_BLOCKED_EVALUATION_EXPIRED':
      return 'Staging stopped: the evidence was too old and must be checked again';
    case 'STAGE_BLOCKED_POLICY_CHANGED':
      return `Staging stopped: the evidence was judged by policy ${str(d.evaluatedWith) || '(not recorded)'}, not the current ${str(d.current)}`;
    case 'STAGE_VERIFICATION_FAILED':
      return `Packet ${str(d.approvalId)} did not read back as sent. Escalated`;
    case 'APPROVER_APPROVE':
      return `${e.actor} approved`;
    case 'APPROVER_REJECT':
      return `${e.actor} rejected`;
    case 'REQUEST_APPROVED_FOR_MANUAL_EXECUTION':
      return 'Both approvals recorded: approved for manual execution in Defender';
    case 'REQUEST_REJECTED':
      return 'Request closed: an approver rejected it';
    case 'REQUEST_EXPIRED':
      return 'Request closed: the approval time ran out';
    case 'EVENT_DUPLICATE_IGNORED':
      return 'The same request arrived again and was ignored';
    case 'EVENT_DUPLICATE_OPEN_REQUEST':
      return 'Another request for this target was folded into this one';
    case 'SYNC_DEFERRED':
      return 'Approval recorded. The status here catches up on the next view';
    default:
      return e.action;
  }
}

export function activitySummary(events: AuditEvent[]): { latest: { at: string; text: string } | null; all: Array<{ seq: number; at: string; text: string }> } {
  const all = [...events].sort((a, b) => a.seq - b.seq).map((e) => ({ seq: e.seq, at: e.at, text: activityText(e) }));
  const last = all[all.length - 1];
  return { latest: last ? { at: last.at, text: last.text } : null, all };
}

/** Expanded only when the request needs attention now and the history gives the context for it. */
export const OPEN_HISTORY_STATES = ['REEVALUATION_REQUIRED', 'VERIFICATION_FAILED'];
