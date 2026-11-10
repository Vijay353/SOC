import { describe, expect, it } from 'vitest';
import { sourceBadge } from '../../app/src/sourceBadge';

describe('CH-12 source badges', () => {
  it('labels each source and never merges them', () => {
    expect(sourceBadge('defender', 'STANDARD').text).toBe('Defender criticality: Standard');
    expect(sourceBadge('cmdb', 'TIER_1').text).toBe('CMDB tier: Tier 1');
  });
  it('keeps Unknown separate from Not available', () => {
    expect(sourceBadge('cmdb', 'UNKNOWN')).toMatchObject({ value: 'Unknown', tone: 'badge-warn' });
    expect(sourceBadge('defender', null)).toMatchObject({ value: 'Not available', tone: 'badge-warn' });
  });
  it('an unexpected value is shown as-is with a warning tone, never mapped to a safe-looking label', () => {
    expect(sourceBadge('cmdb', 'TIER_9')).toMatchObject({ value: 'TIER_9', tone: 'badge-warn' });
  });
});
