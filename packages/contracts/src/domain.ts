/**
 * Shared, typed domain contracts for the Business Impact Gate and both simulators.
 * Everything here is SYNTHETIC/PROPOSED modelling unless a field comment says it mirrors a
 * documented vendor field (VERIFIED against public docs on 2026-10-18).
 */
import { z } from 'zod';

/** ISO-8601 instant with an explicit zone (Z or ±hh:mm). Local-time strings are rejected. */
export const IsoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, 'must be ISO-8601 with an explicit timezone, e.g. 2026-10-18T06:14:00Z')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'not a real calendar instant');

const Id = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@:-]+$/, 'only letters, digits and . _ @ : - are allowed');

// ---------------------------------------------------------------------------
// Mock Microsoft Security (behavioural simulator — NOT the Defender API)
// ---------------------------------------------------------------------------

/** Mirrors Graph `alertSeverity` values (VERIFIED). There is no "critical". */
export const IncidentSeverity = z.enum(['informational', 'low', 'medium', 'high']);
/** Subset of Graph `incidentStatus` values (VERIFIED). */
export const IncidentStatus = z.enum(['active', 'inProgress', 'resolved', 'redirected']);

export const IncidentRow = z.object({
  incidentId: Id,
  displayName: z.string().trim().min(1).max(200),
  severity: IncidentSeverity,
  status: IncidentStatus,
  createdDateTime: IsoInstant,
  lastUpdateDateTime: IsoInstant,
  /** SIMULATOR-ONLY concurrency token. Graph incidents expose no version/ETag; production maps to lastUpdateDateTime. */
  revision: z.number().int().min(1),
});
export type IncidentRow = z.infer<typeof IncidentRow>;

export const DefenderCriticality = z.enum(['CRITICAL', 'STANDARD', 'UNKNOWN']);
export const IsolationState = z.enum(['NOT_ISOLATED', 'ISOLATED']);

export const DeviceRow = z.object({
  machineId: Id,
  computerDnsName: z.string().trim().min(1).max(120),
  osPlatform: z.string().trim().min(1).max(60),
  defenderCriticality: DefenderCriticality,
  isolationState: IsolationState,
  lastSeen: IsoInstant,
  revision: z.number().int().min(1),
});
export type DeviceRow = z.infer<typeof DeviceRow>;

export const AlertSource = z.enum(['DEFENDER_ENDPOINT', 'THIRD_PARTY_FIREWALL']);
export const AlertRow = z.object({
  alertId: Id,
  incidentId: Id,
  machineId: Id,
  source: AlertSource,
  title: z.string().trim().min(1).max(200),
  /** Untrusted free text. Displayed only; never parsed for decisions. */
  description: z.string().max(2000).default(''),
  detectedAt: IsoInstant,
});
export type AlertRow = z.infer<typeof AlertRow>;

export const DeviceActivityRow = z.object({
  machineId: Id,
  activeSessionCount: z.number().int().min(0),
  distinctRemoteHosts: z.number().int().min(0),
  observedAt: IsoInstant,
});
export type DeviceActivityRow = z.infer<typeof DeviceActivityRow>;

/** An incident read together with its alerts (the security port's getIncident result). */
export const IncidentWithAlerts = IncidentRow.extend({ alerts: z.array(AlertRow) });
export type IncidentWithAlerts = z.infer<typeof IncidentWithAlerts>;

/** A machine action as the security simulator stores and returns it (snake_case columns). */
export const MachineActionRecord = z.object({
  action_id: Id,
  machine_id: Id,
  action_type: z.string().min(1),
  isolation_type: z.enum(['Full', 'Selective']).nullable(),
  requested_by: z.string().min(1),
  comment: z.string(),
  status: z.string().min(1),
  created_at: IsoInstant,
});
export type MachineActionRecord = z.infer<typeof MachineActionRecord>;

// ---------------------------------------------------------------------------
// Mock ITSM / CMDB (behavioural simulator — NOT ServiceNow)
// ---------------------------------------------------------------------------

export const CmdbTier = z.enum(['TIER_0', 'TIER_1', 'TIER_2', 'TIER_3', 'UNKNOWN']);
export const UserRole = z.enum(['ANALYST', 'INCIDENT_COMMANDER', 'SERVICE_OWNER']);

export const UserRow = z.object({
  userId: Id,
  displayName: z.string().trim().min(1).max(120),
  role: UserRole,
  onCall: z.boolean(),
  active: z.boolean(),
});
export type UserRow = z.infer<typeof UserRow>;

export const ConfigItemRow = z.object({
  ciId: Id,
  name: z.string().trim().min(1).max(120),
  hostname: z.string().trim().min(1).max(120),
  /** Cross-system reference to the security simulator's device. Not FK-enforced across systems. */
  machineId: Id.nullable(),
  tier: CmdbTier,
  businessService: z.string().trim().min(1).max(160),
  environment: z.enum(['PRODUCTION', 'STAGING', 'DEVELOPMENT']),
  ownerUserId: Id,
  lastVerifiedAt: IsoInstant,
  revision: z.number().int().min(1),
});
export type ConfigItemRow = z.infer<typeof ConfigItemRow>;

export const DependencyRow = z.object({
  dependencyId: Id,
  ciId: Id,
  workflowName: z.string().trim().min(1).max(160),
  criticality: z.enum(['CRITICAL', 'NONCRITICAL']),
  status: z.enum(['ACTIVE', 'RETIRED']),
});
export type DependencyRow = z.infer<typeof DependencyRow>;

export const ChangeFreezeRow = z
  .object({
    freezeId: Id,
    ciId: Id,
    reason: z.string().trim().min(1).max(200),
    startsAt: IsoInstant,
    endsAt: IsoInstant,
    status: z.enum(['SCHEDULED', 'CANCELLED']),
  })
  .refine((r) => Date.parse(r.endsAt) > Date.parse(r.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] });
export type ChangeFreezeRow = z.infer<typeof ChangeFreezeRow>;

export const DocumentRow = z.object({
  documentId: Id,
  version: z.number().int().min(1),
  ciId: Id,
  docType: z.enum(['RUNBOOK', 'CHANGE_NOTE']),
  title: z.string().trim().min(1).max(200),
  /** Untrusted prose. Only the constraint extractor reads it, and its output is verified. */
  body: z.string().min(1).max(8000),
  updatedAt: IsoInstant,
});
export type DocumentRow = z.infer<typeof DocumentRow>;

/** One configuration item with everything the Gate reads about it. Shared by the ITSM port and its adapters. */
export const ConfigItemBundle = z.object({
  configItem: ConfigItemRow,
  owner: UserRow.nullable(),
  dependencies: z.array(DependencyRow),
  changeFreezes: z.array(ChangeFreezeRow),
  documents: z.array(DocumentRow),
});
export type ConfigItemBundle = z.infer<typeof ConfigItemBundle>;

// ---------------------------------------------------------------------------
// Gate: event, extraction, policy, tool
// ---------------------------------------------------------------------------

export const RequestedAction = z.literal('FULL_ISOLATION');

export const ManualIsolationRequested = z.object({
  eventId: Id,
  incidentId: Id,
  machineId: Id,
  requestedAction: RequestedAction,
});
export type ManualIsolationRequested = z.infer<typeof ManualIsolationRequested>;

export const ConstraintCategory = z.enum(['CHANGE_FREEZE', 'OWNER_APPROVAL', 'SERVICE_WINDOW', 'DEPENDENCY_NOTE']);

/** Strict schema for extractor output. Note: there is no field that can express "safe" or an action. */
export const OperationalConstraintExtraction = z
  .object({
    assetRef: z.string().max(120).nullable(),
    constraints: z
      .array(
        z
          .object({
            category: ConstraintCategory,
            normalizedValue: z.string().min(1).max(160),
            sourceDocumentId: Id,
            sourceVersion: z.string().min(1).max(16),
            quote: z.string().min(3).max(600),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(20),
    ambiguity: z.array(z.string().max(300)).max(20),
    abstain: z.boolean(),
  })
  .strict();
export type OperationalConstraintExtraction = z.infer<typeof OperationalConstraintExtraction>;

export const GateDecision = z.enum(['REQUIRE_DUAL_APPROVAL', 'STANDARD_RESPONSE_ELIGIBLE', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW']);
export type GateDecision = z.infer<typeof GateDecision>;

export const PolicyInput = z.object({
  requestedAction: RequestedAction,
  defenderCriticality: DefenderCriticality,
  cmdbCriticality: CmdbTier,
  activeDependencyCount: z.number().int().nullable(),
  activeSessionCount: z.number().int().nullable(),
  changeFreezeActive: z.boolean().nullable(),
  evidenceFresh: z.boolean(),
  staleSources: z.array(z.string()),
  unavailableSources: z.array(z.string()),
  identityMatch: z.enum(['EXACT', 'AMBIGUOUS', 'NONE']),
  extractionAbstained: z.boolean(),
  ownerApprovalConstraint: z.boolean(),
  approversResolved: z.boolean(),
  separationOfDutiesConflict: z.boolean(),
  /** CH-6: another active request exists for this device under a different incident, inside the time window. */
  possibleDuplicate: z.boolean(),
});
export type PolicyInput = z.infer<typeof PolicyInput>;

/**
 * CH-19: one deterministic check, recorded by the policy engine at the moment it ran.
 * NOT_EVALUATED means the engine did not run this check (or had no reliable data); it is neither a pass nor a fail.
 */
export const EvidenceCheckStatus = z.enum(['PASS', 'FAIL', 'WARN', 'NOT_EVALUATED']);
export type EvidenceCheckStatus = z.infer<typeof EvidenceCheckStatus>;
export const EvidenceCheck = z.object({
  checkId: z.string(),
  label: z.string(),
  status: EvidenceCheckStatus,
  /** Policy input fields and evidence sources the check read, for example 'policyInput.identityMatch' or 'evidence:cmdb'. */
  evidenceRefs: z.array(z.string()),
  /** Reason codes this check contributed to the decision. */
  reasonCodes: z.array(z.string()),
  detail: z.string(),
  ruleId: z.string(),
  blocksAutoAction: z.boolean(),
});
export type EvidenceCheck = z.infer<typeof EvidenceCheck>;

export const ApprovalPacketStatus = z.enum(['WAITING_FOR_DUAL_APPROVAL', 'PARTIALLY_APPROVED', 'APPROVED', 'REJECTED', 'EXPIRED']);
export type ApprovalPacketStatus = z.infer<typeof ApprovalPacketStatus>;

export const StageContainmentApprovalInput = z
  .object({
    idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
    incidentId: Id,
    expectedIncidentVersion: z.number().int().min(1),
    machineId: Id,
    ciId: Id,
    requestedAction: RequestedAction,
    decision: z.literal('REQUIRE_DUAL_APPROVAL'),
    reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]+$/)).min(1).max(12),
    approverIds: z.tuple([Id, Id]),
    evidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(16),
    policyVersion: z.string().min(1).max(20),
    requestedBy: Id,
    expiresAt: IsoInstant,
  })
  .strict();
export type StageContainmentApprovalInput = z.infer<typeof StageContainmentApprovalInput>;

export const ApprovalPacket = StageContainmentApprovalInput.omit({ idempotencyKey: true }).extend({
  approvalId: Id,
  idempotencyKey: z.string(),
  status: ApprovalPacketStatus,
  createdAt: IsoInstant,
  decisions: z.array(z.object({ approverId: Id, decision: z.enum(['APPROVE', 'REJECT']), decidedAt: IsoInstant, comment: z.string() })),
});
export type ApprovalPacket = z.infer<typeof ApprovalPacket>;

/** Gate-owned lifecycle of one manual response request. */
export const RequestState = z.enum([
  'RESPONSE_READY',
  'WAITING_FOR_DUAL_APPROVAL',
  'STANDARD_RESPONSE_ELIGIBLE',
  'INSUFFICIENT_EVIDENCE',
  'MANUAL_REVIEW',
  'REEVALUATION_REQUIRED',
  'VERIFICATION_FAILED',
  'APPROVED_FOR_MANUAL_EXECUTION',
  'REJECTED',
  'EXPIRED',
]);
export type RequestState = z.infer<typeof RequestState>;

/** An approval packet as returned by stageContainmentApproval: the stored packet plus whether it already existed. */
export const StagedApprovalPacket = ApprovalPacket.extend({ duplicate: z.boolean() });
export type StagedApprovalPacket = z.infer<typeof StagedApprovalPacket>;
