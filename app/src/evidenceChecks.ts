import type { EvidenceCheck } from './types';

/** CH-19: plain words for recorded check results. The client never computes a check; it only describes them. */
export const CHECK_STATUS_WORDS: Record<EvidenceCheck['status'], string> = {
  PASS: 'Passed',
  WARN: 'Warning',
  FAIL: 'Blocked',
  NOT_EVALUATED: 'Not evaluated',
};

export function checkCounts(checks: EvidenceCheck[]) {
  const n = (s: EvidenceCheck['status']) => checks.filter((c) => c.status === s).length;
  return { passed: n('PASS'), warned: n('WARN'), blocked: n('FAIL'), notEvaluated: n('NOT_EVALUATED') };
}

export function checkSummaryText(checks: EvidenceCheck[] | undefined): string {
  if (!checks) return 'Evidence checks were not recorded for this evaluation. Re-evaluate to record them.';
  const c = checkCounts(checks);
  return `${c.passed} passed, ${c.warned} warned, ${c.blocked} blocked, ${c.notEvaluated} not evaluated`;
}

const SOURCE_WORDS: Record<string, string> = {
  device: 'Defender device record',
  cmdb: 'CMDB record',
  liveActivity: 'Live-activity summary',
  extraction: 'Cited document constraints',
  incident: 'Defender incident',
};

/** 'evidence:cmdb' becomes 'CMDB record'; 'policyInput.identityMatch' becomes 'policy input: identityMatch'. */
export function refText(ref: string): string {
  if (ref.startsWith('evidence:')) return SOURCE_WORDS[ref.slice(9)] ?? ref.slice(9);
  if (ref.startsWith('policyInput.')) return `policy input: ${ref.slice(12)}`;
  return ref;
}
