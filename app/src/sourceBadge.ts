/**
 * CH-12: one badge per source. Defender's criticality and the CMDB tier are never merged into one value.
 * "Unknown" (the source says it does not know) and "Not available" (the source could not be read) stay distinct.
 */
export type BadgeTone = 'badge-danger' | 'badge-info' | 'badge-warn';
export interface SourceBadgeView {
  source: string;
  value: string;
  tone: BadgeTone;
  text: string;
}

const DEFENDER: Record<string, [string, BadgeTone]> = {
  CRITICAL: ['Critical', 'badge-danger'],
  STANDARD: ['Standard', 'badge-info'],
  UNKNOWN: ['Unknown', 'badge-warn'],
};
const CMDB: Record<string, [string, BadgeTone]> = {
  TIER_0: ['Tier 0', 'badge-danger'],
  TIER_1: ['Tier 1', 'badge-danger'],
  TIER_2: ['Tier 2', 'badge-info'],
  TIER_3: ['Tier 3', 'badge-info'],
  UNKNOWN: ['Unknown', 'badge-warn'],
};

export function sourceBadge(source: 'defender' | 'cmdb', raw: string | null | undefined): SourceBadgeView {
  const label = source === 'defender' ? 'Defender criticality' : 'CMDB tier';
  const table = source === 'defender' ? DEFENDER : CMDB;
  const [value, tone] = raw == null ? (['Not available', 'badge-warn'] as [string, BadgeTone]) : (table[raw] ?? [raw, 'badge-warn']);
  return { source: label, value, tone, text: `${label}: ${value}` };
}
