import { describe, expect, it } from 'vitest';
import { historyLine } from '../../app/src/history';

const empty = { windowDays: 90, excludesCurrentRequest: true, total: 0, approved: 0, standardEligible: 0, rejectedOrExpired: 0, blocked: 0, inProgress: 0 };

describe('CH-8 history line', () => {
  it('says no prior history for a genuinely empty window', () => {
    expect(historyLine(empty)).toBe('History for this device (last 90 days, this request not counted): no prior history.');
  });
  it('lists only non-zero outcomes and they add up to the total', () => {
    expect(historyLine({ ...empty, total: 3, approved: 1, rejectedOrExpired: 1, blocked: 1 })).toBe(
      'History for this device (last 90 days, this request not counted): 3 requests, 1 approved, 1 rejected or expired, 1 blocked.',
    );
  });
  it('uses the singular for one request', () => {
    expect(historyLine({ ...empty, total: 1, inProgress: 1 })).toContain(': 1 request, 1 still in progress.');
  });
});
