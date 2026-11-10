import type { RequestState } from './types';

export const STATE_LABEL: Record<RequestState, string> = {
  RESPONSE_READY: 'Ready for review',
  WAITING_FOR_DUAL_APPROVAL: 'Waiting for dual approval',
  STANDARD_RESPONSE_ELIGIBLE: 'Standard response eligible',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
  MANUAL_REVIEW: 'Manual review',
  REEVALUATION_REQUIRED: 'Re-evaluation required',
  VERIFICATION_FAILED: 'Verification failed',
  APPROVED_FOR_MANUAL_EXECUTION: 'Approved for manual execution',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

export function stateTone(s: string): string {
  if (['WAITING_FOR_DUAL_APPROVAL', 'RESPONSE_READY', 'PARTIALLY_APPROVED', 'REEVALUATION_REQUIRED', 'MANUAL_REVIEW'].includes(s)) return 'badge-warn';
  if (['INSUFFICIENT_EVIDENCE', 'VERIFICATION_FAILED', 'REJECTED', 'EXPIRED'].includes(s)) return 'badge-danger';
  if (['APPROVED_FOR_MANUAL_EXECUTION', 'APPROVED', 'STANDARD_RESPONSE_ELIGIBLE'].includes(s)) return 'badge-ok';
  return 'badge-info';
}

const PACKET_LABEL: Record<string, string> = { PARTIALLY_APPROVED: 'Partially approved', APPROVED: 'Approved' };

export function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${stateTone(state)}`}>{STATE_LABEL[state as RequestState] ?? PACKET_LABEL[state] ?? state.replace(/_/g, ' ')}</span>;
}

export const fmtTime = (iso: string | undefined | null) => (iso ? `${iso.slice(11, 16)} UTC` : 'not recorded');
export const fmtDateTime = (iso: string | undefined | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` : 'not recorded');

/** CH-L1: a code shown to people becomes words, for example 'MERGE_UPDATE' becomes 'Merge update'. The code stays secondary. */
export const codeWords = (code: string) => code.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** CH-L1: seed display names read 'Name \u2014 role'; show them as 'Name (role)'. */
export const personLabel = (displayName: string) => {
  const [name, role] = displayName.split(/\s\u2014\s/);
  return role ? `${name} (${role})` : displayName;
};
export const personName = (displayName: string) => displayName.split(/\s\u2014\s/)[0] ?? displayName;

export function ShieldMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2 4 7v8c0 7.5 5.1 13.4 12 15 6.9-1.6 12-7.5 12-15V7z" fill="#1f5fbf" />
      <path d="m11 16 4 4 7-8" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function ErrorBanner({ error }: { error: { code?: string; message: string } | null }) {
  if (!error) return null;
  return (
    <div className="banner banner-error" role="alert">
      <strong>{error.message}</strong>
      {error.code && <span className="small"> (code: {error.code})</span>}
    </div>
  );
}
