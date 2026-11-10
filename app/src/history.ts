import type { DeviceHistory } from './types';

/** CH-8: one plain line. The parts always add up to the total because each request is counted once. */
export function historyLine(h: DeviceHistory): string {
  const scope = `History for this device (last ${h.windowDays} days, this request not counted)`;
  if (h.total === 0) return `${scope}: no prior history.`;
  const parts = [
    [h.approved, 'approved'],
    [h.standardEligible, 'standard path'],
    [h.rejectedOrExpired, 'rejected or expired'],
    [h.blocked, 'blocked'],
    [h.inProgress, 'still in progress'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`);
  return `${scope}: ${h.total} ${h.total === 1 ? 'request' : 'requests'}, ${parts.join(', ')}.`;
}
