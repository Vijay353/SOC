import { describe, expect, it } from 'vitest';
import { ageBar } from '../../app/src/ageBar';

describe('CH-10 evidence-age bar', () => {
  it('under the limit: true proportion, limit at the end of the track', () => {
    expect(ageBar(17, 60)).toEqual({ fillPct: 28.3, limitPct: 100, over: false, text: '17 min old, within the 60 min limit' });
  });
  it('exactly at the limit is within the limit', () => {
    expect(ageBar(60, 60)).toMatchObject({ fillPct: 100, limitPct: 100, over: false });
  });
  it('over the limit: the track grows, nothing is clipped, and the overage is stated in words', () => {
    const g = ageBar(552, 60); // MES record, about 9.2 hours
    expect(g.over).toBe(true);
    expect(g.fillPct).toBe(100);
    expect(g.limitPct).toBe(10.9);
    expect(g.text).toBe('9.2 h old, over the 60 min limit by 8.2 h');
  });
  it('zero age and negative clock skew show as zero, not as an error', () => {
    expect(ageBar(0, 15)).toMatchObject({ fillPct: 0, over: false, text: '0 min old, within the 15 min limit' });
    expect(ageBar(-3, 15).fillPct).toBe(0);
  });
  it('a very large age stays finite', () => {
    const g = ageBar(100_000, 15);
    expect(g.limitPct).toBe(0);
    expect(g.text).toContain('over the 15 min limit');
  });
});
