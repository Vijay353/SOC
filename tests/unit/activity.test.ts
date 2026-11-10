import { describe, expect, it } from 'vitest';
import { activitySummary, activityText } from '../../app/src/activity';

const ev = (seq: number, action: string, details: unknown = {}, actor = 'analyst-priya') => ({ seq, at: `2026-10-18T06:${String(10 + seq).padStart(2, '0')}:00Z`, actor, action, details });

describe('CH-11 activity history', () => {
  it('zero events: no latest line', () => {
    expect(activitySummary([])).toEqual({ latest: null, all: [] });
  });
  it('one event: latest only', () => {
    const s = activitySummary([ev(1, 'MANUAL_ISOLATION_REQUESTED')]);
    expect(s.latest?.text).toBe('analyst-priya asked to fully isolate the device');
    expect(s.all).toHaveLength(1);
  });
  it('keeps every event, oldest first, and the latest is the highest sequence', () => {
    const s = activitySummary([ev(3, 'APPROVAL_PACKET_STAGED', { approvalId: 'CAP-2026-1042', duplicate: false }), ev(1, 'MANUAL_ISOLATION_REQUESTED'), ev(2, 'EVALUATED', { decision: 'REQUIRE_DUAL_APPROVAL' })]);
    expect(s.all.map((a) => a.seq)).toEqual([1, 2, 3]);
    expect(s.all[1]!.text).toBe('Evidence checked: dual approval required');
    expect(s.latest?.text).toBe('Approval packet CAP-2026-1042 created and read back');
  });
  it('an unknown action falls back to its code instead of disappearing', () => {
    expect(activityText(ev(1, 'SOMETHING_NEW'))).toBe('SOMETHING_NEW');
  });
});
