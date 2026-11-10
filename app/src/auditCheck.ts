/** CH-17: plain words for the result of GET /api/audit/verify. */
export interface AuditCheck {
  intact: boolean;
  brokenAt: number | null;
  reason: string | null;
  length: number;
  fromSeq: number | null;
  toSeq: number | null;
  checkedAt: string;
  anchor: { seq: number; establishedAt: string; preexistingRows: number } | null;
}

const REASON_WORDS: Record<string, string> = {
  START_MISSING: 'the first rows of the log are missing',
  SEQUENCE_GAP: 'one or more rows are missing before this one',
  LINK_MISMATCH: 'this row does not point to the hash of the row before it',
  HASH_MISMATCH: 'this row was changed after it was written',
  END_DOES_NOT_MATCH_ANCHOR: 'the last rows of the log were removed or replaced',
};

export function auditCheckText(c: AuditCheck): string {
  if (!c.intact) {
    const why = (c.reason && REASON_WORDS[c.reason]) ?? 'the chain does not match';
    return `Audit log check failed at entry ${c.brokenAt ?? '?'}: ${why}.`;
  }
  if (c.length === 0) return 'Audit log check passed. The log is empty and matches its anchor.';
  const range = `entries ${c.fromSeq} to ${c.toSeq}`;
  const legacy = c.anchor && c.anchor.preexistingRows > 0 ? ` Rows written before the anchor was created (${c.anchor.preexistingRows}) are linked, but removal of rows from the end before that time cannot be detected.` : '';
  return `Audit log check passed for ${range} (${c.length} entries). Every row links to the one before it and the last row matches the anchor.${legacy}`;
}
