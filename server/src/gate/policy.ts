/**
 * Deterministic gate policy CAP-1.1. Pure function: same input → same decision.
 * CAP-1.1 (V3 CH-6) adds the possible-duplicate check. With no duplicate, every CAP-1.0 decision is unchanged.
 * The language model never produces a decision; it only contributes cited claims that become booleans here.
 */
import type { EvidenceCheck, GateDecision, PolicyInput } from '../../../packages/contracts/src/domain';

export const POLICY_VERSION = 'CAP-1.1';

export const POLICY_CONFIG = {
  cmdbMaxAgeMinutes: 60,
  activityMaxAgeMinutes: 15,
  evaluationValidMinutes: 5,
  approvalExpiryMinutes: 15,
  /** CH-6: how far back another active request for the same device counts as a possible duplicate. */
  duplicateWindowHours: 24,
  /** CH-8: trailing window for the device history line. Display only; no rule uses it. */
  historyWindowDays: 90,
} as const;

/**
 * CH-16: the ordered top-level rules, for display. The first rule that applies decides.
 * Each id is the prefix of the rulesFired entry that rule records (a unit test checks this).
 */
export const POLICY_RULES = [
  { id: 'R1', text: 'Missing, stale, unreadable or ambiguous evidence: not enough evidence' },
  { id: 'R2', text: 'Conflicting operational instructions, or the requester would approve their own request: manual review' },
  { id: 'R3', text: 'Any business-impact signal: dual approval (not enough evidence if two approvers cannot be found)' },
  { id: 'R4a', text: 'Another active request for the same device: manual review' },
  { id: 'R4', text: 'Otherwise: standard response path' },
] as const;

/** CH-16: what is and is not known about where this policy came from. Nothing here is invented. */
export const POLICY_PROVENANCE = {
  source: 'Defined in code: server/src/gate/policy.ts',
  updatedAt: null,
  updatedBy: null,
  note: 'Provenance unavailable: the policy is defined in code, and no author or change date is recorded for it.',
} as const;

export interface PolicyResult {
  decision: GateDecision;
  reasonCodes: string[];
  rulesFired: string[];
  /** CH-19: every check, in rule order, as the engine actually ran it. Checks after the deciding rule are NOT_EVALUATED. */
  checks: EvidenceCheck[];
}

/** CH-19: the checks the engine performs, in the order it performs them. Labels are plain words. */
export const CHECK_DEFS = [
  { checkId: 'SOURCES_AVAILABLE', ruleId: 'R1', label: 'Every evidence source answered', refs: ['policyInput.unavailableSources'] },
  { checkId: 'DEVICE_IDENTITY', ruleId: 'R1', label: 'The device matches exactly one CMDB record', refs: ['policyInput.identityMatch', 'evidence:device', 'evidence:cmdb'] },
  { checkId: 'EVIDENCE_FRESH', ruleId: 'R1', label: 'CMDB and live-activity records are within their age limits', refs: ['policyInput.evidenceFresh', 'policyInput.staleSources', 'evidence:cmdb', 'evidence:liveActivity'] },
  { checkId: 'MANDATORY_FIELDS', ruleId: 'R1', label: 'Criticality, dependencies, sessions and freeze status are known', refs: ['policyInput.cmdbCriticality', 'policyInput.activeDependencyCount', 'policyInput.activeSessionCount', 'policyInput.changeFreezeActive'] },
  { checkId: 'OPERATING_DOCUMENTS', ruleId: 'R2', label: 'Runbook and operating documents give clear instructions', refs: ['policyInput.extractionAbstained', 'evidence:extraction'] },
  { checkId: 'SEPARATION_OF_DUTIES', ruleId: 'R2', label: 'The requester is not one of the approvers', refs: ['policyInput.separationOfDutiesConflict'] },
  { checkId: 'BUSINESS_IMPACT', ruleId: 'R3', label: 'No business-impact signal', refs: ['policyInput.cmdbCriticality', 'policyInput.defenderCriticality', 'policyInput.activeDependencyCount', 'policyInput.activeSessionCount', 'policyInput.changeFreezeActive', 'policyInput.ownerApprovalConstraint', 'evidence:cmdb', 'evidence:liveActivity', 'evidence:extraction'] },
  { checkId: 'APPROVERS_RESOLVED', ruleId: 'R3', label: 'Two accountable approvers were found', refs: ['policyInput.approversResolved'] },
  { checkId: 'DUPLICATE_RISK', ruleId: 'R3, R4a', label: 'No other active request for this device', refs: ['policyInput.possibleDuplicate'] },
] as const;
type CheckId = (typeof CHECK_DEFS)[number]['checkId'];

class CheckRecorder {
  private readonly results = new Map<CheckId, Omit<EvidenceCheck, 'checkId' | 'label' | 'ruleId' | 'evidenceRefs'>>();
  pass(id: CheckId, detail: string) {
    this.results.set(id, { status: 'PASS', reasonCodes: [], detail, blocksAutoAction: false });
  }
  fail(id: CheckId, codes: string[], detail: string) {
    this.results.set(id, { status: 'FAIL', reasonCodes: codes, detail, blocksAutoAction: true });
  }
  warn(id: CheckId, codes: string[], detail: string) {
    this.results.set(id, { status: 'WARN', reasonCodes: codes, detail, blocksAutoAction: true });
  }
  skip(id: CheckId, detail: string) {
    this.results.set(id, { status: 'NOT_EVALUATED', reasonCodes: [], detail, blocksAutoAction: false });
  }
  /** Every check not recorded yet was not reached, because an earlier rule decided. */
  done(decidedBy: string): EvidenceCheck[] {
    return CHECK_DEFS.map((d) => ({
      checkId: d.checkId,
      label: d.label,
      ruleId: d.ruleId,
      evidenceRefs: [...d.refs],
      ...(this.results.get(d.checkId) ?? { status: 'NOT_EVALUATED' as const, reasonCodes: [], detail: `Not run: rule ${decidedBy} already decided the path.`, blocksAutoAction: false }),
    }));
  }
}

export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const rulesFired: string[] = [];
  const c = new CheckRecorder();

  // Rule 1 — mandatory evidence must exist, be unambiguous and current. Fail closed.
  const insufficient: string[] = [];
  const unavailableCodes = input.unavailableSources.map((s) => `SOURCE_UNAVAILABLE_${s.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
  insufficient.push(...unavailableCodes);
  if (unavailableCodes.length) c.fail('SOURCES_AVAILABLE', unavailableCodes, `No answer from: ${input.unavailableSources.join(', ')}.`);
  else c.pass('SOURCES_AVAILABLE', 'Defender, CMDB, live activity and documents all answered.');
  if (input.identityMatch === 'AMBIGUOUS') insufficient.push('IDENTITY_AMBIGUOUS');
  if (input.identityMatch === 'NONE') insufficient.push('IDENTITY_NOT_FOUND');
  if (input.identityMatch === 'AMBIGUOUS') c.fail('DEVICE_IDENTITY', ['IDENTITY_AMBIGUOUS'], 'More than one CMDB record claims this device.');
  else if (input.identityMatch === 'NONE') c.fail('DEVICE_IDENTITY', ['IDENTITY_NOT_FOUND'], 'No CMDB record is linked to this device.');
  else if (unavailableCodes.length) c.skip('DEVICE_IDENTITY', 'No reliable result: a source did not answer.');
  else c.pass('DEVICE_IDENTITY', 'Exactly one CMDB record matches this device.');
  if (!input.evidenceFresh) {
    const codes = input.staleSources.map((s) => `${s.toUpperCase()}_STALE`);
    for (const s of codes) insufficient.push(s);
    c.fail('EVIDENCE_FRESH', codes, `Older than the allowed maximum: ${input.staleSources.join(', ')}.`);
  } else if (unavailableCodes.length) c.skip('EVIDENCE_FRESH', 'No reliable result: a source did not answer, so its age is unknown.');
  else c.pass('EVIDENCE_FRESH', 'Every record used is within its age limit.');
  if (input.identityMatch === 'EXACT' && input.unavailableSources.length === 0) {
    const missing: string[] = [];
    if (input.cmdbCriticality === 'UNKNOWN') missing.push('CMDB_CRITICALITY_UNKNOWN');
    if (input.activeDependencyCount === null || input.activeSessionCount === null || input.changeFreezeActive === null) missing.push('MANDATORY_FIELD_MISSING');
    insufficient.push(...missing);
    if (missing.length) c.fail('MANDATORY_FIELDS', missing, 'A required field is empty or unknown.');
    else c.pass('MANDATORY_FIELDS', 'Criticality, dependency count, session count and freeze status are all known.');
  } else c.skip('MANDATORY_FIELDS', 'Not run: the policy checks required fields only when identity is exact and every source answered.');
  if (insufficient.length > 0) {
    rulesFired.push('R1_EVIDENCE_INSUFFICIENT');
    return { decision: 'INSUFFICIENT_EVIDENCE', reasonCodes: dedupe(insufficient), rulesFired, checks: c.done('R1') };
  }

  // Rule 2 — extraction abstained on material operational text, or approvers cannot be resolved safely.
  const manual: string[] = [];
  if (input.extractionAbstained) manual.push('EXTRACTION_ABSTAINED');
  if (input.separationOfDutiesConflict) manual.push('SEPARATION_OF_DUTIES_CONFLICT');
  if (input.extractionAbstained) c.fail('OPERATING_DOCUMENTS', ['EXTRACTION_ABSTAINED'], 'The documents are ambiguous or conflict, so no constraint was taken from them.');
  else c.pass('OPERATING_DOCUMENTS', 'Constraints were taken from the documents with citations.');
  if (input.separationOfDutiesConflict) c.fail('SEPARATION_OF_DUTIES', ['SEPARATION_OF_DUTIES_CONFLICT'], 'The requester would also approve this request.');
  else c.pass('SEPARATION_OF_DUTIES', 'The requester is not an approver.');
  if (manual.length > 0) {
    rulesFired.push('R2_MANUAL_REVIEW');
    return { decision: 'MANUAL_REVIEW', reasonCodes: manual, rulesFired, checks: c.done('R2') };
  }

  // Rule 3 — business-impact signals require two accountable approvals.
  const impact: string[] = [];
  if (input.cmdbCriticality === 'TIER_0') impact.push('CMDB_TIER_0');
  if (input.cmdbCriticality === 'TIER_1') impact.push('CMDB_TIER_1');
  if ((input.activeDependencyCount ?? 0) > 0 && (input.activeSessionCount ?? 0) > 0) impact.push('ACTIVE_CRITICAL_DEPENDENCIES');
  if (input.changeFreezeActive) impact.push('CHANGE_FREEZE_ACTIVE');
  const cmdbCritical = input.cmdbCriticality === 'TIER_0' || input.cmdbCriticality === 'TIER_1';
  if ((input.defenderCriticality === 'STANDARD' && cmdbCritical) || (input.defenderCriticality === 'CRITICAL' && !cmdbCritical)) impact.push('CRITICALITY_CONFLICT');
  if (input.ownerApprovalConstraint) impact.push('RUNBOOK_OWNER_APPROVAL_REQUIRED');
  const duplicateDetail = 'Another active request exists for this device under a different incident.';
  if (impact.length > 0) {
    // A possible duplicate never lowers the path; it is shown to both approvers as a reason to look closely.
    if (input.possibleDuplicate) impact.push('POSSIBLE_DUPLICATE_REQUEST');
    if (input.requestedAction === 'FULL_ISOLATION') impact.push('FULL_ISOLATION_HIGH_IMPACT');
    const signals = impact.filter((x) => x !== 'POSSIBLE_DUPLICATE_REQUEST');
    c.warn('BUSINESS_IMPACT', signals, `${signals.length} business-impact signal(s) found, so two people must approve.`);
    if (input.possibleDuplicate) c.warn('DUPLICATE_RISK', ['POSSIBLE_DUPLICATE_REQUEST'], `${duplicateDetail} Both approvers are told.`);
    else c.pass('DUPLICATE_RISK', 'No other active request for this device.');
    if (!input.approversResolved) {
      c.fail('APPROVERS_RESOLVED', ['APPROVERS_UNRESOLVED'], 'Two accountable approvers could not be found.');
      rulesFired.push('R3_IMPACT', 'R3b_APPROVERS_UNRESOLVED');
      return { decision: 'INSUFFICIENT_EVIDENCE', reasonCodes: ['APPROVERS_UNRESOLVED'], rulesFired, checks: c.done('R3') };
    }
    c.pass('APPROVERS_RESOLVED', 'An incident commander and a service owner were found.');
    rulesFired.push('R3_IMPACT_REQUIRES_DUAL_APPROVAL');
    return { decision: 'REQUIRE_DUAL_APPROVAL', reasonCodes: impact, rulesFired, checks: c.done('R3') };
  }
  c.pass('BUSINESS_IMPACT', 'No business-impact signal in current, complete evidence.');
  c.skip('APPROVERS_RESOLVED', 'Not needed: approvers are only required when there is a business-impact signal.');

  // Rule 4a (CAP-1.1): a possible duplicate keeps the request off the standard path until a person reviews it.
  if (input.possibleDuplicate) {
    c.warn('DUPLICATE_RISK', ['POSSIBLE_DUPLICATE_REQUEST'], `${duplicateDetail} A person must review it.`);
    rulesFired.push('R4a_POSSIBLE_DUPLICATE_REVIEW');
    return { decision: 'MANUAL_REVIEW', reasonCodes: ['POSSIBLE_DUPLICATE_REQUEST'], rulesFired, checks: c.done('R4a') };
  }
  c.pass('DUPLICATE_RISK', 'No other active request for this device.');

  // Rule 4 — evidence complete and no impact signal.
  rulesFired.push('R4_STANDARD_PATH');
  return { decision: 'STANDARD_RESPONSE_ELIGIBLE', reasonCodes: ['NO_BUSINESS_IMPACT_SIGNAL'], rulesFired, checks: c.done('R4') };
}

const dedupe = (a: string[]) => [...new Set(a)];

export const REASON_TEXT: Record<string, string> = {
  CMDB_TIER_0: 'CMDB classifies the asset as Tier 0',
  CMDB_TIER_1: 'CMDB classifies the asset as Tier 1',
  ACTIVE_CRITICAL_DEPENDENCIES: 'Live sessions and active critical workflows depend on it',
  CHANGE_FREEZE_ACTIVE: 'A change freeze is active',
  CRITICALITY_CONFLICT: 'Defender and CMDB criticality disagree, so the stricter path applies',
  RUNBOOK_OWNER_APPROVAL_REQUIRED: 'The runbook requires owner approval before network interruption',
  FULL_ISOLATION_HIGH_IMPACT: 'Full isolation drops all non-Defender network traffic',
  IDENTITY_AMBIGUOUS: 'More than one CMDB record claims this device',
  IDENTITY_NOT_FOUND: 'No CMDB record is linked to this device',
  CMDB_STALE: 'The CMDB record is older than the allowed maximum',
  ACTIVITY_STALE: 'The live-activity summary is older than the allowed maximum',
  CMDB_CRITICALITY_UNKNOWN: 'CMDB criticality is unknown',
  MANDATORY_FIELD_MISSING: 'A mandatory evidence field is missing',
  EXTRACTION_ABSTAINED: 'Operational documents are ambiguous or conflicting',
  SEPARATION_OF_DUTIES_CONFLICT: 'The requester would also be an approver',
  APPROVERS_UNRESOLVED: 'Two accountable approvers could not be resolved',
  POSSIBLE_DUPLICATE_REQUEST: 'Another active request exists for this device under a different incident',
  NO_BUSINESS_IMPACT_SIGNAL: 'No business-impact signal in current, complete evidence',
};
