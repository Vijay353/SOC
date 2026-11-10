/**
 * Business Impact Gate orchestrator.
 *
 * TRIGGER → AUTHORIZED CONTEXT → EVIDENCE SNAPSHOT → IDENTITY RESOLUTION → CITED EXTRACTION →
 * DETERMINISTIC POLICY → (human clicks Stage) → PRE-WRITE CONCURRENCY CHECK → ONE TOOL CALL →
 * READ-BACK VERIFICATION → STATE TRANSITION → AUDIT
 *
 * The orchestrator holds no endpoint, identity or firewall privileges. Its only mutating upstream call is
 * ItsmPort.stageContainmentApproval (plus forwarding an approver's own decision).
 */
import crypto from 'node:crypto';
import { buildEvidencePackage } from './evidence-package';
import {
  ManualIsolationRequested,
  type ApprovalPacket,
  type ConfigItemBundle,
  type DeviceActivityRow,
  type DeviceRow,
  type PolicyInput,
  type StageContainmentApprovalInput,
  type UserRow,
} from '../../../packages/contracts/src/domain';
import { canonical, sha256 } from '../../../packages/contracts/src/canonical';
import type { ScenarioClock } from '../../../simulators/shared/infra';
import { UpstreamError, type CallObserver, type CallRecord } from './adapters/http-client';
import type { IncidentWithAlerts, ItsmPort, SecurityPort } from './adapters/ports';
import { findUntrustedInstructions, type ConstraintExtractor, type ExtractionResult } from './extractor/extractor';
import { evaluatePolicy, POLICY_CONFIG, POLICY_PROVENANCE, POLICY_RULES, POLICY_VERSION, REASON_TEXT } from './policy';
import { GateStore, TransitionError, type EvaluationRecord, type RequestRecord } from './store';

export class GateError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface TraceStep {
  seq: number;
  at: string;
  step: string;
  status: 'ok' | 'failed' | 'blocked' | 'info';
  summary: unknown;
  calls: CallRecord[];
}

class Trace {
  steps: TraceStep[] = [];
  constructor(private clock: ScenarioClock) {}
  async call<T>(step: string, fn: (o: CallObserver) => Promise<T>, summarize?: (v: T) => unknown): Promise<T> {
    const calls: CallRecord[] = [];
    const at = this.clock.nowIso();
    try {
      const v = await fn((r) => calls.push(r));
      this.steps.push({ seq: this.steps.length + 1, at, step, status: 'ok', summary: summarize ? summarize(v) : null, calls });
      return v;
    } catch (e) {
      this.steps.push({ seq: this.steps.length + 1, at, step, status: 'failed', summary: describeError(e), calls });
      throw e;
    }
  }
  note(step: string, status: TraceStep['status'], summary: unknown): void {
    this.steps.push({ seq: this.steps.length + 1, at: this.clock.nowIso(), step, status, summary, calls: [] });
  }
}

export function describeError(e: unknown): Record<string, unknown> {
  if (e instanceof UpstreamError) return { kind: e.kind, system: e.system, operation: e.operation, status: e.status, code: e.code, message: e.message };
  if (e instanceof GateError) return { code: e.code, message: e.message };
  return { message: (e as Error)?.message ?? String(e) };
}

export interface GateDeps {
  store: GateStore;
  security: SecurityPort;
  itsm: ItsmPort;
  extractor: ConstraintExtractor;
  clock: ScenarioClock;
}

/** Roles that may raise, evaluate and stage a request. Exported so the UI never keeps its own copy. */
export const ACTOR_ROLES_FOR_REQUESTS = ['ANALYST', 'INCIDENT_COMMANDER'];

export class GateOrchestrator {
  private identities: { users: UserRow[]; loadedAt: number } | null = null;
  constructor(private d: GateDeps) {}

  // ------------------------------------------------------------------ identity
  /** DEMO identity directory (mirrors ITSM users). Selecting an identity is NOT authentication. */
  async directory(force = false): Promise<UserRow[]> {
    const fresh = this.identities && Date.now() - this.identities.loadedAt < 60_000;
    if (!force && fresh) return this.identities!.users;
    try {
      const users = await this.d.itsm.listUsers({});
      this.identities = { users, loadedAt: Date.now() };
      return users;
    } catch (e) {
      if (this.identities) return this.identities.users; // serve last known directory during an outage
      throw new GateError(503, 'IDENTITY_DIRECTORY_UNAVAILABLE', 'Cannot resolve demo identities: ITSM user directory unavailable', describeError(e));
    }
  }
  invalidateDirectory(): void {
    this.identities = null;
  }
  async resolveActor(userId: string | undefined, allowedRoles?: string[]): Promise<UserRow> {
    if (!userId) throw new GateError(401, 'NO_IDENTITY', 'Select a demo identity (X-Demo-User header) first');
    const user = (await this.directory()).find((u) => u.userId === userId);
    if (!user || !user.active) throw new GateError(401, 'UNKNOWN_IDENTITY', `Unknown or inactive demo identity ${userId}`);
    if (allowedRoles && !allowedRoles.includes(user.role)) throw new GateError(403, 'ROLE_NOT_PERMITTED', `${user.role} cannot perform this action`);
    return user;
  }

  // ------------------------------------------------------------------ queue
  async queue() {
    const incidents = (await this.d.security.listIncidents()).filter((i) => i.status === 'active' || i.status === 'inProgress');
    const devices = new Map((await this.d.security.listDevices()).map((d) => [d.machineId, d]));
    const requests = this.d.store.listRequests();
    const items: Array<Record<string, unknown>> = [];
    for (const inc of incidents) {
      const full = await this.d.security.getIncident(inc.incidentId);
      const machineIds = [...new Set(full.alerts.map((a) => a.machineId))];
      for (const machineId of machineIds) {
        const dev = devices.get(machineId);
        const latest = requests.find((r) => r.incidentId === inc.incidentId && r.machineId === machineId) ?? null;
        items.push({
          incidentId: inc.incidentId,
          displayName: inc.displayName,
          severity: inc.severity,
          revision: inc.revision,
          machineId,
          computerDnsName: dev?.computerDnsName ?? machineId,
          isolationState: dev?.isolationState ?? 'UNKNOWN',
          alertCount: full.alerts.filter((a) => a.machineId === machineId).length,
          latestRequest: latest ? { requestId: latest.requestId, state: latest.state, approvalId: latest.approvalId } : null,
        });
      }
    }
    return items;
  }

  // ------------------------------------------------------------------ trigger
  async submitEvent(raw: unknown, actorId: string | undefined) {
    const actor = await this.resolveActor(actorId, ACTOR_ROLES_FOR_REQUESTS);
    const parsed = ManualIsolationRequested.safeParse(raw);
    if (!parsed.success) throw new GateError(400, 'INVALID_EVENT', 'ManualIsolationRequested failed validation', parsed.error.issues);
    const evt = parsed.data;

    const byEvent = this.d.store.getRequestByEvent(evt.eventId);
    if (byEvent) {
      this.d.store.audit(actor.userId, 'EVENT_DUPLICATE_IGNORED', byEvent.requestId, { eventId: evt.eventId });
      return { requestId: byEvent.requestId, duplicate: true, reason: 'SAME_EVENT_ID' as const };
    }
    const open = this.d.store.findOpenRequest(evt.incidentId, evt.machineId, evt.requestedAction);
    if (open) {
      this.d.store.audit(actor.userId, 'EVENT_DUPLICATE_OPEN_REQUEST', open.requestId, { eventId: evt.eventId });
      return { requestId: open.requestId, duplicate: true, reason: 'OPEN_REQUEST_EXISTS' as const };
    }
    const req = this.d.store.createRequest({
      requestId: newId('REQ'),
      eventId: evt.eventId,
      incidentId: evt.incidentId,
      machineId: evt.machineId,
      requestedAction: evt.requestedAction,
      requestedBy: actor.userId,
    });
    this.d.store.audit(actor.userId, 'MANUAL_ISOLATION_REQUESTED', req.requestId, evt);
    await this.evaluate(req.requestId, actor.userId);
    return { requestId: req.requestId, duplicate: false, reason: null };
  }

  // ------------------------------------------------------------------ evaluate
  async evaluate(requestId: string, actorId: string | undefined) {
    const actor = await this.resolveActor(actorId, ACTOR_ROLES_FOR_REQUESTS);
    let req = this.mustGet(requestId);
    const evaluable = ['RESPONSE_READY', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'REEVALUATION_REQUIRED'];
    if (!evaluable.includes(req.state)) throw new GateError(409, 'NOT_EVALUABLE', `A request in state ${req.state} cannot be re-evaluated`);
    if (req.state !== 'RESPONSE_READY') req = this.d.store.transition(req.requestId, req.version, 'RESPONSE_READY');

    const t = new Trace(this.d.clock);
    const startedAt = this.d.clock.nowIso();
    const now = this.d.clock.nowMs();
    const unavailable = new Set<string>();
    const notes: string[] = [];

    t.note('event.received', 'info', { eventId: req.eventId, incidentId: req.incidentId, machineId: req.machineId, requestedAction: req.requestedAction, requestedBy: req.requestedBy, evaluatedBy: actor.userId });

    /** Read a source; outages/auth failures make the source "unavailable" (fail closed), 404 yields null. */
    const read = async <T>(step: string, label: string, fn: (o: CallObserver) => Promise<T>, summarize?: (v: T) => unknown): Promise<T | null> => {
      try {
        return await t.call(step, fn, summarize);
      } catch (e) {
        if (e instanceof UpstreamError && e.status === 404) {
          notes.push(`${label}: not found`);
          return null;
        }
        unavailable.add(label);
        return null;
      }
    };

    const incident = await read<IncidentWithAlerts>('snapshot.incident', 'mock-security', (o) => this.d.security.getIncident(req.incidentId, o), (i) => ({ incidentId: i.incidentId, revision: i.revision, severity: i.severity, status: i.status, alerts: i.alerts.length }));
    const device = await read<DeviceRow>('snapshot.device', 'mock-security', (o) => this.d.security.getDevice(req.machineId, o), (dv) => ({ machineId: dv.machineId, computerDnsName: dv.computerDnsName, defenderCriticality: dv.defenderCriticality, isolationState: dv.isolationState }));
    const activity = await read<DeviceActivityRow>('snapshot.liveActivity', 'mock-security', (o) => this.d.security.getActivitySummary(req.machineId, o), (a) => a);
    const actionsBefore = await read('snapshot.machineActions', 'mock-security', (o) => this.d.security.getMachineActions(req.machineId, o), (a) => ({ count: a.length }));
    if (incident && !incident.alerts.some((a) => a.machineId === req.machineId)) notes.push('device is not linked to this incident by any alert');

    // Untrusted telemetry text is displayed but never interpreted.
    const telemetryInjections = (incident?.alerts ?? []).flatMap((a) => findUntrustedInstructions(a.description).map((quote) => ({ alertId: a.alertId, quote })));
    if (telemetryInjections.length > 0) t.note('guard.untrustedTelemetry', 'info', { ignoredInstructionLikeStrings: telemetryInjections.length, alertIds: telemetryInjections.map((x) => x.alertId) });

    // Deterministic identity resolution: device → exactly one CMDB configuration item.
    const candidates = await read('identity.lookupConfigItems', 'mock-itsm', (o) => this.d.itsm.findConfigItemsByMachine(req.machineId, o), (c) => ({ candidates: c.map((x) => x.ciId) }));
    let identityMatch: PolicyInput['identityMatch'] = 'NONE';
    if (candidates && candidates.length === 1) {
      identityMatch = device && candidates[0]!.hostname.toLowerCase() !== device.computerDnsName.toLowerCase() ? 'AMBIGUOUS' : 'EXACT';
      if (identityMatch === 'AMBIGUOUS') notes.push(`CMDB hostname ${candidates[0]!.hostname} does not match Defender name ${device!.computerDnsName}`);
    } else if (candidates && candidates.length > 1) identityMatch = 'AMBIGUOUS';
    t.note('identity.resolve', identityMatch === 'EXACT' ? 'ok' : 'blocked', { identityMatch, candidates: candidates?.map((c) => c.ciId) ?? null });

    const bundle = identityMatch === 'EXACT' ? await read<ConfigItemBundle>('snapshot.cmdbBundle', 'mock-itsm', (o) => this.d.itsm.getConfigItemBundle(candidates![0]!.ciId, o), (b) => ({ ciId: b.configItem.ciId, tier: b.configItem.tier, dependencies: b.dependencies.length, freezes: b.changeFreezes.length, documents: b.documents.map((x) => `${x.documentId} v${x.version}`) })) : null;

    let extraction: ExtractionResult | null = null;
    if (bundle && device) {
      extraction = await t.call('extractor.extract', async () => this.d.extractor.extract(bundle.documents, { hostname: device.computerDnsName }), (x) => ({
        provider: x.provider,
        constraints: x.extraction.constraints.map((c) => `${c.category}:${c.normalizedValue}`),
        abstain: x.extraction.abstain,
        ambiguity: x.extraction.ambiguity,
        untrustedInstructionsIgnored: x.untrustedInstructions.length,
        verification: x.verificationNotes,
      }));
    }

    const commanders = await read('approvers.lookupIncidentCommander', 'mock-itsm', (o) => this.d.itsm.listUsers({ role: 'INCIDENT_COMMANDER', onCall: true }, o), (u) => ({ onCall: u.map((x) => x.userId) }));

    // Evidence freshness and derived facts (all deterministic arithmetic).
    const cmdbAgeMin = bundle ? (now - Date.parse(bundle.configItem.lastVerifiedAt)) / 60000 : null;
    const activityAgeMin = activity ? (now - Date.parse(activity.observedAt)) / 60000 : null;
    const stale: string[] = [];
    if (cmdbAgeMin !== null && cmdbAgeMin > POLICY_CONFIG.cmdbMaxAgeMinutes) stale.push('cmdb');
    if (activityAgeMin !== null && activityAgeMin > POLICY_CONFIG.activityMaxAgeMinutes) stale.push('activity');
    if (!activity && identityMatch === 'EXACT' && !unavailable.has('mock-security')) stale.push('activity');
    const activeDeps = bundle ? bundle.dependencies.filter((x) => x.status === 'ACTIVE' && x.criticality === 'CRITICAL') : [];
    const activeFreeze = bundle ? bundle.changeFreezes.find((f) => f.status === 'SCHEDULED' && Date.parse(f.startsAt) <= now && now < Date.parse(f.endsAt)) ?? null : null;

    const activeCommanders = (commanders ?? []).filter((u) => u.active);
    const commander = activeCommanders.length === 1 ? activeCommanders[0]! : null;
    const owner = bundle?.owner && bundle.owner.active && bundle.owner.role === 'SERVICE_OWNER' ? bundle.owner : null;
    const approverIds = commander && owner && commander.userId !== owner.userId ? [commander.userId, owner.userId] : [];
    t.note('approvers.resolve', approverIds.length === 2 ? 'ok' : 'blocked', { incidentCommander: commander?.userId ?? null, serviceOwner: owner?.userId ?? null, candidatesOnCall: activeCommanders.length });

    // CH-6: another active request for this device under a different incident, inside the window.
    const windowMs = POLICY_CONFIG.duplicateWindowHours * 3600_000;
    const duplicateMatches = this.d.store
      .relatedActiveRequests(req.machineId, req.requestId)
      .filter((r) => r.incidentId !== req.incidentId && Math.abs(now - Date.parse(r.createdAt)) <= windowMs)
      .map((r) => ({ requestId: r.requestId, incidentId: r.incidentId, state: r.state, approvalId: r.approvalId, createdAt: r.createdAt }));
    t.note('guard.possibleDuplicate', duplicateMatches.length > 0 ? 'blocked' : 'ok', { windowHours: POLICY_CONFIG.duplicateWindowHours, matches: duplicateMatches });

    const ownerApprovalConstraint = !!extraction?.extraction.constraints.some((c) => c.category === 'OWNER_APPROVAL');
    const policyInput: PolicyInput = {
      requestedAction: 'FULL_ISOLATION',
      defenderCriticality: device?.defenderCriticality ?? 'UNKNOWN',
      cmdbCriticality: bundle?.configItem.tier ?? 'UNKNOWN',
      activeDependencyCount: bundle ? activeDeps.length : null,
      activeSessionCount: activity ? activity.activeSessionCount : null,
      changeFreezeActive: bundle ? activeFreeze !== null : null,
      evidenceFresh: stale.length === 0,
      staleSources: stale,
      unavailableSources: [...unavailable],
      identityMatch: !incident || !device ? (unavailable.size > 0 ? identityMatch : 'NONE') : identityMatch,
      extractionAbstained: extraction?.extraction.abstain ?? false,
      ownerApprovalConstraint,
      approversResolved: approverIds.length === 2,
      separationOfDutiesConflict: approverIds.includes(req.requestedBy),
      possibleDuplicate: duplicateMatches.length > 0,
    };
    const policy = evaluatePolicy(policyInput);
    t.note('policy.evaluate', policy.decision === 'REQUIRE_DUAL_APPROVAL' || policy.decision === 'STANDARD_RESPONSE_ELIGIBLE' ? 'ok' : 'blocked', {
      policyVersion: POLICY_VERSION,
      decision: policy.decision,
      reasonCodes: policy.reasonCodes,
      rulesFired: policy.rulesFired,
      checks: policy.checks.map((c) => `${c.checkId}:${c.status}`),
    });

    const hashes: Record<string, string> = {};
    if (incident) hashes.incident = sha256(canonical(incident));
    if (device) hashes.device = sha256(canonical(device));
    if (activity) hashes.liveActivity = sha256(canonical(activity));
    if (bundle) hashes.cmdb = sha256(canonical(bundle));
    if (extraction) hashes.extraction = sha256(canonical(extraction.extraction));
    hashes.policyInput = sha256(canonical(policyInput));

    const evaluation: EvaluationRecord = {
      evaluationId: newId('EVAL'),
      requestId: req.requestId,
      incidentRevision: incident?.revision ?? null,
      decision: policy.decision,
      reasonCodes: policy.reasonCodes,
      summary: {
        ...buildSummary({ req, incident, device, activity, bundle, extraction, activeDeps, activeFreeze, cmdbAgeMin, activityAgeMin, commander, owner, policyDecision: policy.decision, notes, unavailable: [...unavailable], identityMatch, candidates: candidates ?? null, telemetryInjections, duplicateMatches }),
        // CH-19: the checks exactly as the policy engine ran them for this evaluation.
        evidenceChecks: policy.checks,
      },
      policyInput,
      evidenceHashes: hashes,
      approverIds,
      ciId: bundle?.configItem.ciId ?? null,
      idempotencyKey: policy.decision === 'REQUIRE_DUAL_APPROVAL' && incident ? sha256(`${req.eventId}|${incident.revision}|${req.machineId}|${req.requestedAction}`) : null,
      machineActionCount: actionsBefore ? actionsBefore.length : null,
      createdAt: this.d.clock.nowIso(),
      validUntil: new Date(now + POLICY_CONFIG.evaluationValidMinutes * 60000).toISOString(),
      policyVersion: POLICY_VERSION,
      policyConfig: { ...POLICY_CONFIG },
    };
    this.d.store.saveEvaluation(evaluation);
    if (policy.decision !== 'REQUIRE_DUAL_APPROVAL') {
      this.d.store.transition(req.requestId, req.version, policy.decision);
    }
    t.note('state.after', 'info', { state: this.mustGet(req.requestId).state, mutationPerformed: false });
    this.d.store.audit(actor.userId, 'EVALUATED', req.requestId, { decision: policy.decision, reasonCodes: policy.reasonCodes, evaluationId: evaluation.evaluationId, policyVersion: POLICY_VERSION });
    this.d.store.saveRun({ runId: newId('RUN'), requestId: req.requestId, kind: 'EVALUATE', actor: actor.userId, startedAt, outcome: policy.decision, trace: t.steps });
    return evaluation;
  }

  // ------------------------------------------------------------------ stage (the one tool)
  async stage(requestId: string, actorId: string | undefined) {
    const actor = await this.resolveActor(actorId, ACTOR_ROLES_FOR_REQUESTS);
    let req = this.mustGet(requestId);
    if (req.state === 'WAITING_FOR_DUAL_APPROVAL' && req.approvalId) {
      return { approvalId: req.approvalId, alreadyStaged: true };
    }
    if (req.state !== 'RESPONSE_READY') throw new GateError(409, 'NOT_STAGEABLE', `A request in state ${req.state} cannot be staged`);
    const ev = this.d.store.latestEvaluation(requestId);
    if (!ev || ev.decision !== 'REQUIRE_DUAL_APPROVAL' || !ev.idempotencyKey || !ev.ciId || ev.incidentRevision === null) {
      throw new GateError(409, 'NO_DUAL_APPROVAL_DECISION', 'The current evaluation does not require a dual-approval packet');
    }
    const t = new Trace(this.d.clock);
    const startedAt = this.d.clock.nowIso();
    const finish = (outcome: string) => this.d.store.saveRun({ runId: newId('RUN'), requestId, kind: 'STAGE', actor: actor.userId, startedAt, outcome, trace: t.steps });

    // CH-16: the evidence must have been judged by the policy that is in force now.
    if (ev.policyVersion !== POLICY_VERSION) {
      t.note('guard.policyVersion', 'blocked', { evaluatedWith: ev.policyVersion, current: POLICY_VERSION });
      req = this.d.store.transition(requestId, req.version, 'REEVALUATION_REQUIRED', { lastError: { code: 'POLICY_CHANGED', evaluatedWith: ev.policyVersion, current: POLICY_VERSION } });
      this.d.store.audit(actor.userId, 'STAGE_BLOCKED_POLICY_CHANGED', requestId, { evaluationId: ev.evaluationId, evaluatedWith: ev.policyVersion, current: POLICY_VERSION });
      finish('REEVALUATION_REQUIRED');
      throw new GateError(409, 'POLICY_CHANGED', `This evaluation was made with policy ${ev.policyVersion ?? '(not recorded)'}; the current policy is ${POLICY_VERSION}. Re-evaluate before staging.`);
    }
    if (this.d.clock.nowMs() > Date.parse(ev.validUntil)) {
      t.note('guard.evaluationAge', 'blocked', { validUntil: ev.validUntil, now: this.d.clock.nowIso() });
      req = this.d.store.transition(requestId, req.version, 'REEVALUATION_REQUIRED', { lastError: { code: 'EVALUATION_EXPIRED', validUntil: ev.validUntil } });
      this.d.store.audit(actor.userId, 'STAGE_BLOCKED_EVALUATION_EXPIRED', requestId, { evaluationId: ev.evaluationId });
      finish('REEVALUATION_REQUIRED');
      throw new GateError(409, 'EVALUATION_EXPIRED', 'Evidence is older than the staging window; re-evaluate before staging');
    }

    // Optimistic concurrency: the incident must still be at the revision the evidence was taken from.
    let current: IncidentWithAlerts;
    try {
      current = await t.call('precheck.incidentRevision', (o) => this.d.security.getIncident(req.incidentId, o), (i) => ({ expected: ev.incidentRevision, actual: i.revision }));
    } catch (e) {
      const d = describeError(e);
      this.d.store.setLastError(requestId, { ...d, upstreamCode: d.code ?? null, code: 'PRECHECK_FAILED' });
      this.d.store.audit(actor.userId, 'STAGE_FAILED', requestId, { phase: 'precheck', error: describeError(e) });
      finish('PRECHECK_FAILED');
      throw new GateError(503, 'PRECHECK_FAILED', 'Could not confirm the incident revision; nothing was staged. Retry when the source recovers.', describeError(e));
    }
    if (current.revision !== ev.incidentRevision) {
      t.note('precheck.incidentRevision', 'blocked', { reason: 'STALE_INCIDENT_VERSION', expected: ev.incidentRevision, actual: current.revision });
      this.d.store.transition(requestId, req.version, 'REEVALUATION_REQUIRED', { lastError: { code: 'STALE_INCIDENT_VERSION', expected: ev.incidentRevision, actual: current.revision } });
      this.d.store.audit(actor.userId, 'STAGE_BLOCKED_STALE_INCIDENT', requestId, { expected: ev.incidentRevision, actual: current.revision });
      finish('REEVALUATION_REQUIRED');
      throw new GateError(409, 'STALE_INCIDENT_VERSION', `Incident changed from revision ${ev.incidentRevision} to ${current.revision} during evaluation; re-evaluate with current evidence`);
    }

    // Outbox: the exact tool payload is persisted before the call, so every retry is byte-identical.
    let input = this.d.store.getStageInput(ev.evaluationId);
    if (!input) {
      input = {
        idempotencyKey: ev.idempotencyKey,
        incidentId: req.incidentId,
        expectedIncidentVersion: ev.incidentRevision,
        machineId: req.machineId,
        ciId: ev.ciId,
        requestedAction: 'FULL_ISOLATION',
        decision: 'REQUIRE_DUAL_APPROVAL',
        reasonCodes: ev.reasonCodes,
        approverIds: [ev.approverIds[0]!, ev.approverIds[1]!],
        evidenceHashes: Object.values(ev.evidenceHashes),
        policyVersion: POLICY_VERSION,
        requestedBy: req.requestedBy,
        expiresAt: new Date(this.d.clock.nowMs() + POLICY_CONFIG.approvalExpiryMinutes * 60000).toISOString().replace('.000Z', 'Z'),
      };
      this.d.store.setStageInput(ev.evaluationId, input);
    }
    t.note('tool.payload', 'info', { tool: 'stageContainmentApproval', payload: { ...input, idempotencyKey: `${input.idempotencyKey.slice(0, 12)}…` } });

    let packet: ApprovalPacket & { duplicate?: boolean };
    try {
      try {
        packet = await t.call('tool.stageContainmentApproval', (o) => this.d.itsm.stageContainmentApproval(input!, o), (p) => ({ approvalId: p.approvalId, status: p.status, duplicate: p.duplicate }));
      } catch (e) {
        // Recovery for a write that committed earlier but whose response was lost, followed by a
        // re-evaluation (same key, new expiry). Adopt the existing packet only if its core fields match.
        if (!(e instanceof UpstreamError && e.code === 'IDEMPOTENCY_KEY_REUSED')) throw e;
        const orphan = await t.call('tool.reconcile.lookupByKey', (o) => this.d.itsm.findApprovalPacketByKey(input!.idempotencyKey, o), (p) => ({ found: !!p, approvalId: p?.approvalId ?? null, status: p?.status ?? null }));
        const coreMatches =
          !!orphan &&
          (orphan.status === 'WAITING_FOR_DUAL_APPROVAL' || orphan.status === 'PARTIALLY_APPROVED') &&
          orphan.incidentId === input.incidentId &&
          orphan.machineId === input.machineId &&
          orphan.ciId === input.ciId &&
          orphan.requestedBy === input.requestedBy &&
          orphan.policyVersion === input.policyVersion &&
          orphan.expectedIncidentVersion === input.expectedIncidentVersion &&
          canonical(orphan.approverIds) === canonical(input.approverIds) &&
          canonical(orphan.reasonCodes) === canonical(input.reasonCodes) &&
          canonical(orphan.evidenceHashes) === canonical(input.evidenceHashes);
        if (!coreMatches) {
          t.note('tool.reconcile', 'blocked', { reason: 'Existing packet for this key does not match or is closed; manual reconciliation required' });
          throw e;
        }
        t.note('tool.reconcile', 'ok', { adopted: orphan!.approvalId, reason: 'earlier committed write recovered' });
        // Verify against the stored packet's own expiry, which is authoritative.
        input = { ...input, expiresAt: orphan!.expiresAt };
        packet = { ...orphan!, duplicate: true };
      }
    } catch (e) {
      const d = describeError(e);
      const err = { ...d, upstreamCode: d.code ?? null, code: 'STAGE_FAILED' };
      this.d.store.setLastError(requestId, err);
      this.d.store.audit(actor.userId, 'STAGE_FAILED', requestId, { phase: 'tool', error: describeError(e) });
      finish('STAGE_FAILED');
      const status = e instanceof UpstreamError && e.status && e.status < 500 && e.status !== 429 ? 409 : 503;
      throw new GateError(status, e instanceof UpstreamError ? e.code : 'STAGE_FAILED', `stageContainmentApproval failed: ${(e as Error).message}. The request is unchanged and safe to retry.`, describeError(e));
    }

    // Read-after-write verification. Success is only claimed when the stored packet matches the payload.
    const mismatches: Array<{ field: string; expected: unknown; actual: unknown }> = [];
    try {
      const readback = await t.call('verify.readbackPacket', (o) => this.d.itsm.getApprovalPacket(packet.approvalId, o), (p) => ({ approvalId: p.approvalId, status: p.status, approvers: p.approverIds }));
      const check = (field: string, expected: unknown, actual: unknown) => {
        if (canonical(expected) !== canonical(actual)) mismatches.push({ field, expected, actual });
      };
      check('incidentId', input.incidentId, readback.incidentId);
      check('expectedIncidentVersion', input.expectedIncidentVersion, readback.expectedIncidentVersion);
      check('machineId', input.machineId, readback.machineId);
      check('ciId', input.ciId, readback.ciId);
      check('approverIds', input.approverIds, readback.approverIds);
      check('reasonCodes', input.reasonCodes, readback.reasonCodes);
      check('evidenceHashes', input.evidenceHashes, readback.evidenceHashes);
      check('policyVersion', input.policyVersion, readback.policyVersion);
      check('expiresAt', Date.parse(input.expiresAt), Date.parse(readback.expiresAt));
      check('status', 'WAITING_FOR_DUAL_APPROVAL', readback.status);
    } catch (e) {
      mismatches.push({ field: 'readback', expected: 'packet readable', actual: describeError(e) });
    }
    // Independent proof that no endpoint was touched.
    let deviceMutationPerformed: boolean | null = null;
    try {
      const after = await t.call('verify.deviceUnchanged', async (o) => ({ device: await this.d.security.getDevice(req.machineId, o), actions: await this.d.security.getMachineActions(req.machineId, o) }), (v) => ({ isolationState: v.device.isolationState, machineActions: v.actions.length }));
      deviceMutationPerformed = after.device.isolationState !== 'NOT_ISOLATED' || after.actions.length !== (ev.machineActionCount ?? 0);
    } catch (e) {
      mismatches.push({ field: 'deviceReadback', expected: 'device readable', actual: describeError(e) });
    }
    if (deviceMutationPerformed) mismatches.push({ field: 'deviceMutationPerformed', expected: false, actual: true });

    if (mismatches.length > 0) {
      t.note('verify.result', 'failed', { mismatches });
      req = this.mustGet(requestId);
      this.d.store.transition(requestId, req.version, 'VERIFICATION_FAILED', { approvalId: packet.approvalId, lastError: { code: 'READBACK_MISMATCH', mismatches } });
      this.d.store.audit(actor.userId, 'STAGE_VERIFICATION_FAILED', requestId, { approvalId: packet.approvalId, mismatches });
      finish('VERIFICATION_FAILED');
      throw new GateError(502, 'READBACK_MISMATCH', 'The approval packet was written but did not read back as expected. Escalate; do not treat as staged.', { approvalId: packet.approvalId, mismatches });
    }
    t.note('verify.result', 'ok', { readback: 'VERIFIED', deviceMutationPerformed: false });

    try {
      req = this.mustGet(requestId);
      this.d.store.transition(requestId, req.version, 'WAITING_FOR_DUAL_APPROVAL', { approvalId: packet.approvalId, lastError: null });
    } catch (e) {
      const latest = this.mustGet(requestId);
      if (e instanceof TransitionError && latest.state === 'WAITING_FOR_DUAL_APPROVAL' && latest.approvalId === packet.approvalId) {
        t.note('state.transition', 'info', { note: 'concurrent stage already recorded the same packet' });
        finish('ALREADY_STAGED');
        return { approvalId: packet.approvalId, alreadyStaged: true };
      }
      throw e;
    }
    t.note('state.transition', 'ok', { from: 'RESPONSE_READY', to: 'WAITING_FOR_DUAL_APPROVAL' });
    this.d.store.audit(actor.userId, 'APPROVAL_PACKET_STAGED', requestId, { approvalId: packet.approvalId, duplicate: !!packet.duplicate, approvers: input.approverIds, expiresAt: input.expiresAt, deviceMutationPerformed: false });
    finish('WAITING_FOR_DUAL_APPROVAL');
    return {
      approvalId: packet.approvalId,
      alreadyStaged: false,
      duplicate: !!packet.duplicate,
      readback: 'VERIFIED' as const,
      deviceMutationPerformed: false,
    };
  }

  // ------------------------------------------------------------------ approvals
  async inbox(actorId: string | undefined) {
    const actor = await this.resolveActor(actorId);
    const packets = await this.d.itsm.listApprovalPackets(actor.userId);
    return packets.map(({ idempotencyKey: _key, ...p }) => {
      const requestId = this.d.store.getRequestByApproval(p.approvalId)?.requestId ?? null;
      return { ...p, requestId, impactFacts: requestId ? this.impactFacts(requestId) : null };
    });
  }

  /** CH-7: the recorded evaluation facts behind a packet, for the read-only projection. No upstream calls. */
  private impactFacts(requestId: string) {
    const ev = this.d.store.latestEvaluation(requestId);
    if (!ev) return null;
    const s = ev.summary as ReturnType<typeof buildSummary>;
    return {
      host: s.threat.device?.computerDnsName ?? this.mustGet(requestId).machineId,
      businessService: s.business.configItem?.businessService ?? null,
      activeSessionCount: s.business.liveActivity?.activeSessionCount ?? null,
      sessionsObservedAt: s.business.liveActivity?.observedAt ?? null,
      activeCriticalDependencies: s.business.configItem ? s.business.activeCriticalDependencies : null,
      changeFreeze: s.business.configItem ? s.business.changeFreeze : null,
      evaluatedAt: ev.createdAt,
    };
  }

  async decide(approvalId: string, actorId: string | undefined, decision: 'APPROVE' | 'REJECT', comment: string) {
    const actor = await this.resolveActor(actorId);
    const t = new Trace(this.d.clock);
    const startedAt = this.d.clock.nowIso();
    const req = this.d.store.getRequestByApproval(approvalId);
    try {
      await t.call('approval.recordDecision', (o) => this.d.itsm.recordApprovalDecision(approvalId, actor.userId, decision, comment, o), (p) => ({ approvalId: p.approvalId, status: p.status, decisions: p.decisions.length }));
    } catch (e) {
      if (req) this.d.store.saveRun({ runId: newId('RUN'), requestId: req.requestId, kind: 'DECIDE', actor: actor.userId, startedAt, outcome: 'REJECTED_BY_SIMULATOR', trace: t.steps });
      if (e instanceof UpstreamError && e.status && e.status < 500) throw new GateError(e.status, e.code, e.message);
      throw new GateError(503, 'ITSM_UNAVAILABLE', 'Could not record the decision; nothing changed', describeError(e));
    }
    if (req) {
      this.d.store.audit(actor.userId, `APPROVER_${decision}`, req.requestId, { approvalId, comment: comment.slice(0, 200) });
      this.d.store.saveRun({ runId: newId('RUN'), requestId: req.requestId, kind: 'DECIDE', actor: actor.userId, startedAt, outcome: decision, trace: t.steps });
      try {
        await this.sync(req.requestId);
      } catch (e) {
        // The decision is already recorded in ITSM. Report that truthfully; the Gate state catches up on the next view.
        this.d.store.audit('system:sync', 'SYNC_DEFERRED', req.requestId, { approvalId, error: describeError(e) });
      }
    }
  }

  /**
   * CH-9: approve up to 20 packets in one action. A convenience layer only: every item goes through the same
   * single-item path (assignment, separation of duties, one decision per approver, expiry, trace and audit are
   * all checked per item by ITSM and the Gate). Items run one after another; one failure never affects another.
   */
  async bulkApprove(actorId: string | undefined, items: Array<{ approvalId: string; expectedStatus: ApprovalPacket['status'] }>, comment: string) {
    const actor = await this.resolveActor(actorId);
    const results: Array<{ approvalId: string; outcome: 'APPROVED' | 'FAILED'; code: string | null; message: string; packetStatus: string | null }> = [];
    for (const item of items) {
      let current: ApprovalPacket;
      try {
        current = await this.d.itsm.getApprovalPacket(item.approvalId);
      } catch (e) {
        const code = e instanceof UpstreamError ? e.code : 'ITSM_UNAVAILABLE';
        results.push({ approvalId: item.approvalId, outcome: 'FAILED', code, message: e instanceof UpstreamError && e.status === 404 ? 'Approval packet not found' : 'Could not read the packet; nothing changed', packetStatus: null });
        continue;
      }
      if (current.status !== item.expectedStatus) {
        results.push({ approvalId: item.approvalId, outcome: 'FAILED', code: 'STALE_STATUS', message: `The packet is now ${current.status}, not ${item.expectedStatus}. Refresh and review it again.`, packetStatus: current.status });
        continue;
      }
      if (current.reasonCodes.includes('POSSIBLE_DUPLICATE_REQUEST')) {
        results.push({ approvalId: item.approvalId, outcome: 'FAILED', code: 'INDIVIDUAL_REVIEW_REQUIRED', message: 'This packet is flagged as a possible duplicate and must be approved on its own.', packetStatus: current.status });
        continue;
      }
      try {
        await this.decide(item.approvalId, actor.userId, 'APPROVE', comment);
        const after = await this.d.itsm.getApprovalPacket(item.approvalId).catch(() => null);
        results.push({ approvalId: item.approvalId, outcome: 'APPROVED', code: null, message: 'Your approval was recorded', packetStatus: after?.status ?? null });
      } catch (e) {
        results.push({ approvalId: item.approvalId, outcome: 'FAILED', code: e instanceof GateError ? e.code : 'UNKNOWN', message: (e as Error).message, packetStatus: current.status });
      }
    }
    const approved = results.filter((r) => r.outcome === 'APPROVED').length;
    return { summary: { requested: items.length, approved, failed: items.length - approved, partial: approved > 0 && approved < items.length }, results };
  }

  /** Pull the packet status from ITSM and apply the matching Gate transition. Never auto-approves. */
  async sync(requestId: string) {
    const req = this.mustGet(requestId);
    if (req.state !== 'WAITING_FOR_DUAL_APPROVAL' || !req.approvalId) return req;
    const p = await this.d.itsm.getApprovalPacket(req.approvalId);
    const to = requestStateForPacket(p.status);
    if (!to) return req;
    const next = this.d.store.transition(requestId, req.version, to);
    this.d.store.audit('system:sync', `REQUEST_${to}`, requestId, { approvalId: p.approvalId, packetStatus: p.status });
    return next;
  }

  // ------------------------------------------------------------------ views
  async view(requestId: string) {
    let req = this.mustGet(requestId);
    let packet: Omit<ApprovalPacket, 'idempotencyKey'> | null = null;
    let packetError: unknown = null;
    if (req.approvalId) {
      try {
        if (req.state === 'WAITING_FOR_DUAL_APPROVAL') req = await this.sync(requestId);
        const { idempotencyKey: _key, ...rest } = await this.d.itsm.getApprovalPacket(req.approvalId!);
        packet = rest;
      } catch (e) {
        packetError = describeError(e);
      }
    }
    const ev = this.d.store.latestEvaluation(requestId);
    return {
      request: req,
      evaluation: ev
        ? {
            ...ev,
            reasons: ev.reasonCodes.map((code) => ({ code, text: REASON_TEXT[code] ?? REASON_TEXT[code.replace(/^SOURCE_UNAVAILABLE_.*/, '')] ?? humanize(code) })),
            stageInput: this.d.store.getStageInput(ev.evaluationId),
          }
        : null,
      packet,
      packetError,
      runs: this.d.store.runsFor(requestId),
      audit: this.d.store.auditEvents(requestId),
      policyVersion: POLICY_VERSION,
      policyProvenance: { ...POLICY_PROVENANCE, rules: POLICY_RULES },
      deviceHistory: this.d.store.deviceHistory(req.machineId, req.requestId, this.d.clock.nowMs(), POLICY_CONFIG.historyWindowDays),
    };
  }

  /**
   * CH-18: read-only export of one request's evidence. SOC roles may export any request; a service owner only a
   * request where they were named as an approver. Reads the packet once and never syncs or writes.
   */
  async evidencePackage(actorId: string | undefined, requestId: string, mode: string) {
    const actor = await this.resolveActor(actorId);
    const req = this.mustGet(requestId);
    const evaluations = this.d.store.evaluationsFor(requestId);
    if (!ACTOR_ROLES_FOR_REQUESTS.includes(actor.role) && !evaluations.some((e) => e.approverIds.includes(actor.userId))) {
      throw new GateError(403, 'EXPORT_NOT_PERMITTED', 'Only SOC roles, or an approver named on this request, can export its evidence');
    }
    let packet: ApprovalPacket | null = null;
    let packetError: unknown = null;
    if (req.approvalId) {
      try {
        packet = await this.d.itsm.getApprovalPacket(req.approvalId);
      } catch (e) {
        packetError = describeError(e);
      }
    }
    return buildEvidencePackage({
      exportedAt: this.d.clock.nowIso(),
      exportedBy: { userId: actor.userId, role: actor.role },
      mode,
      request: req,
      evaluations,
      runs: this.d.store.runsFor(requestId),
      audit: this.d.store.auditEvents(requestId),
      chain: this.d.store.verifyAuditChain(),
      packet,
      packetError,
    });
  }

  private mustGet(id: string): RequestRecord {
    const r = this.d.store.getRequest(id);
    if (!r) throw new GateError(404, 'REQUEST_NOT_FOUND', `Response request ${id} not found`);
    return r;
  }
}

/** Gate request state that follows from a closed approval packet; null while the packet is still open. */
function requestStateForPacket(status: ApprovalPacket['status']): 'APPROVED_FOR_MANUAL_EXECUTION' | 'REJECTED' | 'EXPIRED' | null {
  switch (status) {
    case 'APPROVED':
      return 'APPROVED_FOR_MANUAL_EXECUTION';
    case 'REJECTED':
      return 'REJECTED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'WAITING_FOR_DUAL_APPROVAL':
    case 'PARTIALLY_APPROVED':
      return null;
  }
}

export const newId = (prefix: string) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const humanize = (code: string) => code.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function buildSummary(x: {
  req: RequestRecord;
  incident: IncidentWithAlerts | null;
  device: DeviceRow | null;
  activity: DeviceActivityRow | null;
  bundle: ConfigItemBundle | null;
  extraction: ExtractionResult | null;
  activeDeps: ConfigItemBundle['dependencies'];
  activeFreeze: ConfigItemBundle['changeFreezes'][number] | null;
  cmdbAgeMin: number | null;
  activityAgeMin: number | null;
  commander: UserRow | null;
  owner: UserRow | null;
  policyDecision: string;
  notes: string[];
  unavailable: string[];
  identityMatch: string;
  candidates: ConfigItemBundle['configItem'][] | null;
  telemetryInjections: Array<{ alertId: string; quote: string }>;
  duplicateMatches: Array<{ requestId: string; incidentId: string; state: string; approvalId: string | null; createdAt: string }>;
}) {
  const host = x.device?.computerDnsName ?? x.req.machineId;
  const service = x.bundle?.configItem.businessService ?? 'the business service';
  const headline =
    x.policyDecision === 'REQUIRE_DUAL_APPROVAL'
      ? `Full isolation could interrupt ${service}`
      : x.policyDecision === 'STANDARD_RESPONSE_ELIGIBLE'
        ? `No business-service dependency found for ${host}`
        : x.policyDecision === 'MANUAL_REVIEW'
          ? `Operational instructions for ${host} conflict, so manual review is required`
          : `Not enough current evidence to assess business impact for ${host}`;
  return {
    headline,
    threat: {
      incident: x.incident ? { incidentId: x.incident.incidentId, displayName: x.incident.displayName, severity: x.incident.severity, status: x.incident.status, revision: x.incident.revision } : null,
      device: x.device,
      alerts: (x.incident?.alerts ?? []).filter((a) => a.machineId === x.req.machineId).map((a) => ({ alertId: a.alertId, source: a.source, title: a.title, detectedAt: a.detectedAt })),
      untrustedTelemetryIgnored: x.telemetryInjections.length,
    },
    business: {
      identity: { match: x.identityMatch, candidates: (x.candidates ?? []).map((c) => ({ ciId: c.ciId, name: c.name, tier: c.tier })) },
      configItem: x.bundle ? { ...x.bundle.configItem, ageMinutes: round(x.cmdbAgeMin), maxAgeMinutes: POLICY_CONFIG.cmdbMaxAgeMinutes } : null,
      liveActivity: x.activity ? { ...x.activity, ageMinutes: round(x.activityAgeMin), maxAgeMinutes: POLICY_CONFIG.activityMaxAgeMinutes } : null,
      activeCriticalDependencies: x.activeDeps.length,
      dependencySample: x.activeDeps.slice(0, 5).map((d) => d.workflowName),
      changeFreeze: x.activeFreeze ? { active: true, freezeId: x.activeFreeze.freezeId, reason: x.activeFreeze.reason, endsAt: x.activeFreeze.endsAt } : { active: false },
      owner: x.owner ? { userId: x.owner.userId, displayName: x.owner.displayName } : null,
      constraints: x.extraction?.extraction.constraints ?? [],
      extraction: x.extraction
        ? { provider: x.extraction.provider, abstain: x.extraction.extraction.abstain, ambiguity: x.extraction.extraction.ambiguity, untrustedInstructions: x.extraction.untrustedInstructions, verificationNotes: x.extraction.verificationNotes }
        : null,
      unavailableSources: x.unavailable,
      notes: x.notes,
    },
    duplicateCheck: { windowHours: POLICY_CONFIG.duplicateWindowHours, matches: x.duplicateMatches },
    nextStep: {
      approvers: [x.commander, x.owner].filter((u): u is UserRow => !!u).map((u) => ({ userId: u.userId, displayName: u.displayName, role: u.role })),
      approvalExpiryMinutes: POLICY_CONFIG.approvalExpiryMinutes,
    },
  };
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export type StageInput = StageContainmentApprovalInput;
