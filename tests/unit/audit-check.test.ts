import { describe, expect, it } from 'vitest';
import { auditCheckText } from '../../app/src/auditCheck';

const base = { brokenAt: null, reason: null, checkedAt: '2026-10-18T06:14:00Z', anchor: { seq: 7, establishedAt: '2026-10-18T06:14:00Z', preexistingRows: 0 } };

describe('auditCheckText', () => {
  it('names the verified range', () => {
    expect(auditCheckText({ ...base, intact: true, length: 7, fromSeq: 1, toSeq: 7 })).toBe(
      'Audit log check passed for entries 1 to 7 (7 entries). Every row links to the one before it and the last row matches the anchor.',
    );
  });
  it('discloses rows written before the anchor existed', () => {
    expect(auditCheckText({ ...base, intact: true, length: 7, fromSeq: 1, toSeq: 7, anchor: { ...base.anchor, preexistingRows: 5 } })).toContain('(5) are linked');
  });
  it('explains a failure in plain words', () => {
    expect(auditCheckText({ ...base, intact: false, brokenAt: 3, reason: 'SEQUENCE_GAP', length: 6, fromSeq: 1, toSeq: 7 })).toBe(
      'Audit log check failed at entry 3: one or more rows are missing before this one.',
    );
  });
  it('handles an empty log', () => {
    expect(auditCheckText({ ...base, intact: true, length: 0, fromSeq: null, toSeq: null })).toContain('The log is empty');
  });
});
