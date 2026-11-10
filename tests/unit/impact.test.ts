import { describe, expect, it } from 'vitest';
import { projectImpact, type ImpactFacts } from '../../app/src/impact';

const sap: ImpactFacts = {
  host: 'PRD-SAP-GW02',
  businessService: 'SAP warehouse operations',
  activeSessionCount: 1420,
  sessionsObservedAt: '2026-10-18T06:12:00Z',
  activeCriticalDependencies: 18,
  changeFreeze: { active: true, freezeId: 'FRZ-2210', endsAt: '2026-10-19T06:00:00Z' },
  evaluatedAt: '2026-10-18T06:14:00Z',
};

describe('CH-7 impact projection', () => {
  it('restates recorded facts with exact integers', () => {
    const { lines, caveat } = projectImpact(sap);
    expect(lines.map((l) => `${l.label}: ${l.value}`)).toEqual([
      'Network sessions that full isolation would cut: 1,420 active at 06:12 UTC',
      'Critical workflows that depend on the device: 18',
      'Business service: SAP warehouse operations',
      'Change freeze: Active (FRZ-2210) until 2026-10-19 06:00 UTC',
    ]);
    expect(caveat).toContain('Projection only');
    expect(caveat).toContain('No records changed');
  });

  it('missing data is shown as unknown, never as zero', () => {
    const { lines } = projectImpact({ ...sap, activeSessionCount: null, sessionsObservedAt: null, activeCriticalDependencies: null, changeFreeze: null, businessService: null });
    expect(lines.every((l) => !l.known)).toBe(true);
    expect(lines.map((l) => l.value)).toEqual(['Unknown: no current activity summary', 'Unknown: CMDB evidence missing', 'Unknown']);
  });

  it('a real zero stays zero and no freeze is stated plainly', () => {
    const { lines } = projectImpact({ ...sap, activeCriticalDependencies: 0, activeSessionCount: 0, changeFreeze: { active: false } });
    expect(lines[0]!.value).toBe('0 active at 06:12 UTC');
    expect(lines[1]!.value).toBe('0');
    expect(lines[3]!.value).toBe('None active');
  });

  it('is deterministic', () => {
    expect(projectImpact(sap)).toEqual(projectImpact(structuredClone(sap)));
  });
});
