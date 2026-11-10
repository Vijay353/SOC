import type { ImpactFacts } from './impact';

/** View-model types mirroring the Gate API responses (see server/src/gate/orchestrator.ts). */
export type RequestState =
  | 'RESPONSE_READY'
  | 'WAITING_FOR_DUAL_APPROVAL'
  | 'STANDARD_RESPONSE_ELIGIBLE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'MANUAL_REVIEW'
  | 'REEVALUATION_REQUIRED'
  | 'VERIFICATION_FAILED'
  | 'APPROVED_FOR_MANUAL_EXECUTION'
  | 'REJECTED'
  | 'EXPIRED';

export type Decision = 'REQUIRE_DUAL_APPROVAL' | 'STANDARD_RESPONSE_ELIGIBLE' | 'INSUFFICIENT_EVIDENCE' | 'MANUAL_REVIEW';

export interface Identity {
  userId: string;
  displayName: string;
  role: 'ANALYST' | 'INCIDENT_COMMANDER' | 'SERVICE_OWNER';
  onCall?: boolean;
  active?: boolean;
}

export interface Session {
  mode: string;
  setupError: { message: string; missing: string[] } | null;
  /** CH-20: whether the visitor passcode gate is on for this server. */
  access?: { enabled: boolean };
  /** Whether POST /api/lab/reset is allowed on this server (off in production unless explicitly enabled). */
  demoReset?: { allowed: boolean };
  /** CH-21: present only when analytics is configured for this server. */
  analytics?: { provider: 'clarity'; projectId: string } | null;
  clock: { now: string; mode: string; scenarioStart: string; manualOffsetMinutes: number };
  identities: Identity[];
  identityError: unknown;
  scenarios: Array<{ incidentId: string; machineId: string; label: string; expected: string }>;
  optionalScenarios: Array<{ name: string; label: string; description: string; queueLabels: Array<{ incidentId: string; machineId: string; label: string }> }>;
  policy: { version: string; cmdbMaxAgeMinutes: number; activityMaxAgeMinutes: number; evaluationValidMinutes: number; approvalExpiryMinutes: number };
  extractor: string;
  /** CH-13: roles the server allows to prepare, evaluate and stage. */
  eligibleRoles?: { requestActions: string[] };
  disclaimer: string;
}

export interface QueueItem {
  incidentId: string;
  displayName: string;
  severity: string;
  revision: number;
  machineId: string;
  computerDnsName: string;
  isolationState: string;
  alertCount: number;
  latestRequest: { requestId: string; state: RequestState; approvalId: string | null } | null;
}

export interface Constraint {
  category: string;
  normalizedValue: string;
  sourceDocumentId: string;
  sourceVersion: string;
  quote: string;
  confidence: number;
}

export interface CallRecord {
  system: string;
  operation: string;
  method: string;
  path: string;
  finalStatus: number | null;
  ok: boolean;
  attempts: Array<{ attempt: number; status: number | null; outcome: string; durationMs: number; fault: string | null; errorCode: string | null }>;
}

export interface TraceStep {
  seq: number;
  at: string;
  step: string;
  status: 'ok' | 'failed' | 'blocked' | 'info';
  summary: unknown;
  calls: CallRecord[];
}

export interface Summary {
  headline: string;
  threat: {
    incident: { incidentId: string; displayName: string; severity: string; status: string; revision: number } | null;
    device: { machineId: string; computerDnsName: string; osPlatform: string; defenderCriticality: string; isolationState: string } | null;
    alerts: Array<{ alertId: string; source: string; title: string; detectedAt: string }>;
    untrustedTelemetryIgnored: number;
  };
  business: {
    identity: { match: string; candidates: Array<{ ciId: string; name: string; tier: string }> };
    configItem: { ciId: string; name: string; tier: string; businessService: string; lastVerifiedAt: string; ageMinutes: number; maxAgeMinutes: number; ownerUserId: string } | null;
    liveActivity: { activeSessionCount: number; distinctRemoteHosts: number; observedAt: string; ageMinutes: number; maxAgeMinutes: number } | null;
    activeCriticalDependencies: number;
    dependencySample: string[];
    changeFreeze: { active: boolean; freezeId?: string; reason?: string; endsAt?: string };
    owner: { userId: string; displayName: string } | null;
    constraints: Constraint[];
    extraction: { provider: string; abstain: boolean; ambiguity: string[]; untrustedInstructions: Array<{ documentId: string; quote: string }>; verificationNotes: string[] } | null;
    unavailableSources: string[];
    notes: string[];
  };
  nextStep: { approvers: Array<{ userId: string; displayName: string; role: string }>; approvalExpiryMinutes: number };
  /** CH-6. Absent on evaluations recorded before V3. */
  /** CH-19: recorded by the policy engine; absent on evaluations written before CH-19. */
  evidenceChecks?: EvidenceCheck[];
  duplicateCheck?: { windowHours: number; matches: Array<{ requestId: string; incidentId: string; state: RequestState; approvalId: string | null; createdAt: string }> };
}

export interface EvidenceCheck {
  checkId: string;
  label: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'NOT_EVALUATED';
  evidenceRefs: string[];
  reasonCodes: string[];
  detail: string;
  ruleId: string;
  blocksAutoAction: boolean;
}

export interface ApprovalPacket {
  approvalId: string;
  incidentId: string;
  expectedIncidentVersion: number;
  machineId: string;
  ciId: string;
  requestedAction: string;
  decision: string;
  reasonCodes: string[];
  approverIds: string[];
  evidenceHashes: string[];
  policyVersion: string;
  requestedBy: string;
  status: 'WAITING_FOR_DUAL_APPROVAL' | 'PARTIALLY_APPROVED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  decisions: Array<{ approverId: string; decision: 'APPROVE' | 'REJECT'; decidedAt: string; comment: string }>;
  requestId?: string | null;
  /** CH-7: recorded evaluation facts for the read-only projection (inbox only). */
  impactFacts?: ImpactFacts | null;
}

export interface RequestView {
  request: {
    requestId: string;
    eventId: string;
    incidentId: string;
    machineId: string;
    requestedAction: string;
    requestedBy: string;
    state: RequestState;
    approvalId: string | null;
    lastError: { code: string; message?: string; [k: string]: unknown } | null;
    version: number;
    createdAt: string;
    updatedAt: string;
  };
  evaluation: {
    evaluationId: string;
    decision: Decision;
    reasonCodes: string[];
    reasons: Array<{ code: string; text: string }>;
    summary: Summary;
    policyInput: Record<string, unknown>;
    evidenceHashes: Record<string, string>;
    approverIds: string[];
    incidentRevision: number | null;
    createdAt: string;
    validUntil: string;
    stageInput: Record<string, unknown> | null;
    /** CH-16: null for evaluations recorded before V3. */
    policyVersion?: string | null;
    policyConfig?: Record<string, unknown> | null;
  } | null;
  packet: ApprovalPacket | null;
  packetError: unknown;
  runs: Array<{ runId: string; kind: string; actor: string; startedAt: string; finishedAt: string; outcome: string; trace: TraceStep[] }>;
  audit: Array<{ seq: number; at: string; actor: string; action: string; details: unknown; hash: string; prevHash: string }>;
  policyVersion: string;
  /** CH-16 */
  policyProvenance?: { source: string; updatedAt: string | null; updatedBy: string | null; note: string; rules: ReadonlyArray<{ id: string; text: string }> };
  /** CH-8 */
  deviceHistory?: DeviceHistory;
}

export interface DeviceHistory {
  windowDays: number;
  excludesCurrentRequest: boolean;
  total: number;
  approved: number;
  standardEligible: number;
  rejectedOrExpired: number;
  blocked: number;
  inProgress: number;
}
