/**
 * Product-clarity CH-12: which columns the record browser shows first. Display only; the CSV export keeps every
 * column. Key columns come first in this order, then the rest in their original order, up to a readable maximum.
 */
export const KEY_COLUMNS: Record<string, readonly string[]> = {
  Incidents: ['incidentId', 'displayName', 'severity', 'status', 'revision'],
  Devices: ['computerDnsName', 'machineId', 'defenderCriticality', 'isolationState', 'lastSeen'],
  Alerts: ['alertId', 'incidentId', 'machineId', 'title', 'source', 'detectedAt'],
  DeviceActivity: ['machineId', 'activeSessionCount', 'observedAt'],
  Users: ['displayName', 'userId', 'role', 'onCall', 'active'],
  ConfigItems: ['ciId', 'name', 'hostname', 'tier', 'businessService', 'ownerUserId', 'lastVerifiedAt'],
  Dependencies: ['dependencyId', 'ciId', 'workflowName', 'criticality', 'status'],
  ChangeFreezes: ['freezeId', 'ciId', 'status', 'startsAt', 'endsAt', 'reason'],
  Documents: ['documentId', 'title', 'ciId', 'version', 'docType', 'updatedAt'],
  ApprovalPackets: ['approvalId', 'incidentId', 'machineId', 'status', 'expiresAt'],
};

export const MAX_COLUMNS = 7;

export function recordColumns(entity: string, available: readonly string[], max = MAX_COLUMNS): { shown: string[]; hidden: string[] } {
  const keys = (KEY_COLUMNS[entity] ?? []).filter((k) => available.includes(k));
  const ordered = [...keys, ...available.filter((c) => !keys.includes(c))];
  return { shown: ordered.slice(0, max), hidden: ordered.slice(max) };
}
