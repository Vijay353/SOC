/**
 * Canonical workbook schema v1 for the simulator datasets. This single definition drives the template,
 * the README/Schema sheets, import validation, export and the docs.
 */
import type { ZodType } from 'zod';
import {
  AlertRow,
  ChangeFreezeRow,
  ConfigItemRow,
  DependencyRow,
  DeviceActivityRow,
  DeviceRow,
  DocumentRow,
  IncidentRow,
  UserRow,
} from '../../../packages/contracts/src/domain';
import type { ItsmDataset, SecurityDataset } from '../../../fixtures/seed';

export const WORKBOOK_SCHEMA_VERSION = 1;

export type ColumnType = 'string' | 'text' | 'integer' | 'boolean' | 'datetime' | 'enum';

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  required: boolean;
  allowed?: string[];
  /** false = system-managed: used for optimistic concurrency/lifecycle; edit only to restore a dataset. */
  editable: boolean;
  nullable?: boolean;
  description: string;
}

export interface RefSpec {
  column: string;
  sheet: SheetName;
  /** 'error' rejects the row; 'warning' is reported but allowed (cross-system references). */
  severity: 'error' | 'warning';
}

export type SheetName = 'Incidents' | 'Devices' | 'Alerts' | 'DeviceActivity' | 'Users' | 'ConfigItems' | 'Dependencies' | 'ChangeFreezes' | 'Documents';

export interface SheetSpec {
  sheet: SheetName;
  system: 'security' | 'itsm';
  datasetKey: keyof SecurityDataset | keyof ItsmDataset;
  key: string;
  /** Column holding the record revision used for optimistic concurrency on merge, if any. */
  revisionColumn?: string;
  schema: ZodType;
  columns: ColumnSpec[];
  refs: RefSpec[];
  description: string;
}

const dt = (name: string, description: string, required = true): ColumnSpec => ({ name, type: 'datetime', required, editable: true, description: `${description} ISO-8601 text with explicit timezone, e.g. 2026-10-18T06:14:00Z.` });
const s = (name: string, description: string, required = true, editable = true): ColumnSpec => ({ name, type: 'string', required, editable, description });
const e = (name: string, allowed: string[], description: string): ColumnSpec => ({ name, type: 'enum', required: true, allowed, editable: true, description });
const rev: ColumnSpec = { name: 'revision', type: 'integer', required: false, editable: false, description: 'System-managed revision. On merge it must equal the current revision (stale rows are rejected); leave blank for new rows.' };

export const SHEETS: SheetSpec[] = [
  {
    sheet: 'Incidents',
    system: 'security',
    datasetKey: 'incidents',
    key: 'incidentId',
    revisionColumn: 'revision',
    schema: IncidentRow,
    description: 'Mock Microsoft Security incidents.',
    refs: [],
    columns: [
      s('incidentId', 'Primary key, e.g. INC-90482.'),
      s('displayName', 'Incident title.'),
      e('severity', ['informational', 'low', 'medium', 'high'], 'Mirrors Graph alertSeverity (no "critical").'),
      e('status', ['active', 'inProgress', 'resolved', 'redirected'], 'Subset of Graph incidentStatus.'),
      dt('createdDateTime', 'Creation time.'),
      dt('lastUpdateDateTime', 'Last update time.'),
      rev,
    ],
  },
  {
    sheet: 'Devices',
    system: 'security',
    datasetKey: 'devices',
    key: 'machineId',
    revisionColumn: 'revision',
    schema: DeviceRow,
    description: 'Mock Defender device inventory.',
    refs: [],
    columns: [
      s('machineId', 'Primary key, e.g. device-d8f92a10.'),
      s('computerDnsName', 'Hostname as Defender reports it.'),
      s('osPlatform', 'Operating system.'),
      e('defenderCriticality', ['CRITICAL', 'STANDARD', 'UNKNOWN'], 'Simplified critical-asset classification.'),
      e('isolationState', ['NOT_ISOLATED', 'ISOLATED'], 'Current isolation state.'),
      dt('lastSeen', 'Last sensor check-in.'),
      rev,
    ],
  },
  {
    sheet: 'Alerts',
    system: 'security',
    datasetKey: 'alerts',
    key: 'alertId',
    schema: AlertRow,
    description: 'Alerts linking incidents to devices. Description is untrusted display text.',
    refs: [
      { column: 'incidentId', sheet: 'Incidents', severity: 'error' },
      { column: 'machineId', sheet: 'Devices', severity: 'error' },
    ],
    columns: [
      s('alertId', 'Primary key.'),
      s('incidentId', 'FK → Incidents.incidentId.'),
      s('machineId', 'FK → Devices.machineId.'),
      e('source', ['DEFENDER_ENDPOINT', 'THIRD_PARTY_FIREWALL'], 'Evidence source.'),
      s('title', 'Alert title.'),
      { name: 'description', type: 'text', required: false, editable: true, description: 'Untrusted free text; never used for decisions.' },
      dt('detectedAt', 'Detection time.'),
    ],
  },
  {
    sheet: 'DeviceActivity',
    system: 'security',
    datasetKey: 'deviceActivity',
    key: 'machineId',
    schema: DeviceActivityRow,
    description: 'Bounded live-activity summary per device.',
    refs: [{ column: 'machineId', sheet: 'Devices', severity: 'error' }],
    columns: [
      s('machineId', 'Primary key and FK → Devices.machineId.'),
      { name: 'activeSessionCount', type: 'integer', required: true, editable: true, description: 'Active sessions (≥ 0).' },
      { name: 'distinctRemoteHosts', type: 'integer', required: true, editable: true, description: 'Distinct remote peers (≥ 0).' },
      dt('observedAt', 'When the summary was computed (freshness max 15 min).'),
    ],
  },
  {
    sheet: 'Users',
    system: 'itsm',
    datasetKey: 'users',
    key: 'userId',
    schema: UserRow,
    description: 'Mock ITSM people. Roles drive approver resolution. Demo identities only, not accounts.',
    refs: [],
    columns: [
      s('userId', 'Primary key.'),
      s('displayName', 'Name followed by role.'),
      e('role', ['ANALYST', 'INCIDENT_COMMANDER', 'SERVICE_OWNER'], 'Role.'),
      { name: 'onCall', type: 'boolean', required: true, editable: true, description: 'TRUE/FALSE. Exactly one on-call INCIDENT_COMMANDER is expected.' },
      { name: 'active', type: 'boolean', required: true, editable: true, description: 'TRUE/FALSE.' },
    ],
  },
  {
    sheet: 'ConfigItems',
    system: 'itsm',
    datasetKey: 'configItems',
    key: 'ciId',
    revisionColumn: 'revision',
    schema: ConfigItemRow,
    description: 'Mock CMDB configuration items.',
    refs: [
      { column: 'ownerUserId', sheet: 'Users', severity: 'error' },
      { column: 'machineId', sheet: 'Devices', severity: 'warning' },
    ],
    columns: [
      s('ciId', 'Primary key, e.g. CI-009481.'),
      s('name', 'CI name.'),
      s('hostname', 'Must match the Defender computerDnsName for an exact identity match.'),
      { name: 'machineId', type: 'string', required: false, nullable: true, editable: true, description: 'Cross-system reference → Devices.machineId. Blank = not linked.' },
      e('tier', ['TIER_0', 'TIER_1', 'TIER_2', 'TIER_3', 'UNKNOWN'], 'Business criticality tier.'),
      s('businessService', 'Business service supported.'),
      e('environment', ['PRODUCTION', 'STAGING', 'DEVELOPMENT'], 'Environment.'),
      s('ownerUserId', 'FK → Users.userId (service owner).'),
      dt('lastVerifiedAt', 'Last time the record was verified (freshness max 60 min).'),
      rev,
    ],
  },
  {
    sheet: 'Dependencies',
    system: 'itsm',
    datasetKey: 'dependencies',
    key: 'dependencyId',
    schema: DependencyRow,
    description: 'Business workflows depending on a CI.',
    refs: [{ column: 'ciId', sheet: 'ConfigItems', severity: 'error' }],
    columns: [s('dependencyId', 'Primary key.'), s('ciId', 'FK → ConfigItems.ciId.'), s('workflowName', 'Dependent workflow.'), e('criticality', ['CRITICAL', 'NONCRITICAL'], 'Criticality.'), e('status', ['ACTIVE', 'RETIRED'], 'Only ACTIVE + CRITICAL counts.')],
  },
  {
    sheet: 'ChangeFreezes',
    system: 'itsm',
    datasetKey: 'changeFreezes',
    key: 'freezeId',
    schema: ChangeFreezeRow,
    description: 'Change freezes per CI. Active when SCHEDULED and startsAt ≤ now < endsAt.',
    refs: [{ column: 'ciId', sheet: 'ConfigItems', severity: 'error' }],
    columns: [s('freezeId', 'Primary key.'), s('ciId', 'FK → ConfigItems.ciId.'), s('reason', 'Reason.'), dt('startsAt', 'Start.'), dt('endsAt', 'End (must be after startsAt).'), e('status', ['SCHEDULED', 'CANCELLED'], 'Status.')],
  },
  {
    sheet: 'Documents',
    system: 'itsm',
    datasetKey: 'documents',
    key: 'documentId',
    schema: DocumentRow,
    description: 'Runbooks and change notes. Body is untrusted prose read only by the constraint extractor.',
    refs: [{ column: 'ciId', sheet: 'ConfigItems', severity: 'error' }],
    columns: [
      s('documentId', 'Primary key.'),
      { name: 'version', type: 'integer', required: true, editable: true, description: 'Document version (≥ 1). Citations reference it.' },
      s('ciId', 'FK → ConfigItems.ciId.'),
      e('docType', ['RUNBOOK', 'CHANGE_NOTE'], 'Type.'),
      s('title', 'Title.'),
      { name: 'body', type: 'text', required: true, editable: true, description: 'Up to 8,000 characters.' },
      dt('updatedAt', 'Last update.'),
    ],
  },
];

export const SHEET_BY_NAME = new Map(SHEETS.map((x) => [x.sheet, x]));

export const LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,
  maxRowsPerSheet: 5000,
  maxColumns: 40,
  maxSheets: 20,
  maxCellChars: 8000,
} as const;
