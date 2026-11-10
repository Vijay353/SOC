import { describe, expect, it } from 'vitest';
import { checkSummaryText, refText } from '../../app/src/evidenceChecks';
import type { EvidenceCheck } from '../../app/src/types';

const c = (status: EvidenceCheck['status']): EvidenceCheck => ({ checkId: status, label: 'x', status, evidenceRefs: [], reasonCodes: [], detail: '', ruleId: 'R1', blocksAutoAction: false });

describe('evidence check summary text', () => {
  it('counts each result', () => {
    expect(checkSummaryText([c('PASS'), c('PASS'), c('WARN'), c('FAIL'), c('NOT_EVALUATED'), c('NOT_EVALUATED')])).toBe('2 passed, 1 warned, 1 blocked, 2 not evaluated');
  });
  it('says plainly when nothing was recorded', () => {
    expect(checkSummaryText(undefined)).toBe('Evidence checks were not recorded for this evaluation. Re-evaluate to record them.');
  });
  it('names sources in plain words', () => {
    expect(refText('evidence:cmdb')).toBe('CMDB record');
    expect(refText('policyInput.identityMatch')).toBe('policy input: identityMatch');
  });
});
