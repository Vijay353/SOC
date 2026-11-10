/**
 * Mock ITSM / CMDB — a narrow behavioural simulator of the configuration-item, ownership, change-freeze,
 * document and approval capabilities this workflow needs. It is NOT ServiceNow and uses its own simplified API.
 */
import type { Db } from '../shared/sqlite';
import express, { type Router } from 'express';
import { z } from 'zod';
import {
  StageContainmentApprovalInput,
  type ApprovalPacket,
  type ApprovalPacketStatus,
  type ChangeFreezeRow,
  type ConfigItemBundle,
  type ConfigItemRow,
  type DependencyRow,
  type DocumentRow,
  type UserRow,
} from '../../packages/contracts/src/domain';
import { canonical, sha256 } from '../../packages/contracts/src/canonical';
import type { ItsmDataset } from '../../fixtures/seed';
import { AUDIT_DDL, FaultInjector, handle, readAudit, requireScope, ScenarioClock, SimError, sleep, writeAudit, type TokenGrant } from '../shared/infra';

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ANALYST','INCIDENT_COMMANDER','SERVICE_OWNER')),
  on_call INTEGER NOT NULL CHECK (on_call IN (0,1)),
  active INTEGER NOT NULL CHECK (active IN (0,1))
);
CREATE TABLE IF NOT EXISTS config_items (
  ci_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  machine_id TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('TIER_0','TIER_1','TIER_2','TIER_3','UNKNOWN')),
  business_service TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('PRODUCTION','STAGING','DEVELOPMENT')),
  owner_user_id TEXT NOT NULL REFERENCES users(user_id),
  last_verified_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE INDEX IF NOT EXISTS ci_machine ON config_items(machine_id);
CREATE TABLE IF NOT EXISTS ci_dependencies (
  dependency_id TEXT PRIMARY KEY,
  ci_id TEXT NOT NULL REFERENCES config_items(ci_id) ON DELETE CASCADE,
  workflow_name TEXT NOT NULL,
  criticality TEXT NOT NULL CHECK (criticality IN ('CRITICAL','NONCRITICAL')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RETIRED'))
);
CREATE TABLE IF NOT EXISTS change_freezes (
  freeze_id TEXT PRIMARY KEY,
  ci_id TEXT NOT NULL REFERENCES config_items(ci_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED','CANCELLED'))
);
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version >= 1),
  ci_id TEXT NOT NULL REFERENCES config_items(ci_id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('RUNBOOK','CHANGE_NOTE')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_packets (
  approval_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  expected_incident_version INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  ci_id TEXT NOT NULL REFERENCES config_items(ci_id),
  requested_action TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  approver_ids TEXT NOT NULL,
  evidence_hashes TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('WAITING_FOR_DUAL_APPROVAL','PARTIALLY_APPROVED','APPROVED','REJECTED','EXPIRED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approval_decisions (
  approval_id TEXT NOT NULL REFERENCES approval_packets(approval_id),
  approver_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  comment TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  PRIMARY KEY (approval_id, approver_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
${AUDIT_DDL}
`;

const OPEN: ApprovalPacketStatus[] = ['WAITING_FOR_DUAL_APPROVAL', 'PARTIALLY_APPROVED'];

export class ItsmRepository {
  constructor(
    public db: Db,
    private clock: ScenarioClock,
  ) {
    db.exec(DDL);
  }

  // --- CMDB reads ----------------------------------------------------------------
  findConfigItems(q: { machineId?: string; hostname?: string }): ConfigItemRow[] {
    if (q.machineId) return (this.db.prepare('SELECT * FROM config_items WHERE machine_id = ? ORDER BY ci_id').all(q.machineId) as Row[]).map(mapCi);
    if (q.hostname) return (this.db.prepare('SELECT * FROM config_items WHERE lower(hostname) = lower(?) ORDER BY ci_id').all(q.hostname) as Row[]).map(mapCi);
    return (this.db.prepare('SELECT * FROM config_items ORDER BY ci_id').all() as Row[]).map(mapCi);
  }
  getBundle(ciId: string): ConfigItemBundle | null {
    const row = this.db.prepare('SELECT * FROM config_items WHERE ci_id = ?').get(ciId) as Row | undefined;
    if (!row) return null;
    const configItem = mapCi(row);
    return {
      configItem,
      owner: this.getUser(configItem.ownerUserId),
      dependencies: (this.db.prepare('SELECT * FROM ci_dependencies WHERE ci_id = ? ORDER BY dependency_id').all(ciId) as Row[]).map(mapDep),
      changeFreezes: (this.db.prepare('SELECT * FROM change_freezes WHERE ci_id = ? ORDER BY starts_at').all(ciId) as Row[]).map(mapFreeze),
      documents: (this.db.prepare('SELECT * FROM documents WHERE ci_id = ? ORDER BY document_id').all(ciId) as Row[]).map(mapDoc),
    };
  }
  getUser(id: string): UserRow | null {
    const r = this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(id) as Row | undefined;
    return r ? mapUser(r) : null;
  }
  listUsers(filter: { role?: string; onCall?: boolean } = {}): UserRow[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY user_id').all() as Row[])
      .map(mapUser)
      .filter((u) => (filter.role ? u.role === filter.role : true) && (filter.onCall === undefined ? true : u.onCall === filter.onCall));
  }

  // --- approval packets ------------------------------------------------------------
  /** Lazily applies clock-based expiry. Expiry never approves anything. */
  private applyExpiry(approvalId: string): void {
    const r = this.db.prepare('SELECT status, expires_at FROM approval_packets WHERE approval_id = ?').get(approvalId) as Row | undefined;
    if (!r) return;
    if (OPEN.includes(r.status as ApprovalPacketStatus) && this.clock.nowMs() >= Date.parse(String(r.expires_at))) {
      this.db.prepare("UPDATE approval_packets SET status='EXPIRED' WHERE approval_id = ?").run(approvalId);
      writeAudit(this.db, this.clock, { principal: 'system:clock', action: 'APPROVAL_EXPIRED', entity: 'approval_packet', entityId: approvalId, outcome: 'OK' });
    }
  }

  getPacket(approvalId: string): ApprovalPacket | null {
    this.applyExpiry(approvalId);
    const r = this.db.prepare('SELECT * FROM approval_packets WHERE approval_id = ?').get(approvalId) as Row | undefined;
    if (!r) return null;
    const decisions = (this.db.prepare('SELECT * FROM approval_decisions WHERE approval_id = ? ORDER BY decided_at, approver_id').all(approvalId) as Row[]).map((d) => ({
      approverId: String(d.approver_id),
      decision: d.decision as 'APPROVE' | 'REJECT',
      decidedAt: String(d.decided_at),
      comment: String(d.comment),
    }));
    return mapPacket(r, decisions);
  }

  findPacketIdByKey(key: string): string | null {
    const r = this.db.prepare('SELECT approval_id FROM approval_packets WHERE idempotency_key = ?').get(key) as Row | undefined;
    return r ? String(r.approval_id) : null;
  }

  listPackets(filter: { approverId?: string } = {}): ApprovalPacket[] {
    const ids = (this.db.prepare('SELECT approval_id FROM approval_packets ORDER BY created_at DESC').all() as Row[]).map((r) => String(r.approval_id));
    return ids
      .map((id) => this.getPacket(id))
      .filter((p): p is ApprovalPacket => !!p)
      .filter((p) => (filter.approverId ? p.approverIds.includes(filter.approverId) : true));
  }

  /**
   * Idempotent create. Same key + same payload → returns the existing packet (duplicate=true).
   * Same key + different payload → 409. Another open packet for the same target → 409.
   */
  stagePacket(input: StageContainmentApprovalInput, principal: string): { packet: ApprovalPacket; duplicate: boolean } {
    const payloadHash = sha256(canonical(input));
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT approval_id, payload_hash FROM approval_packets WHERE idempotency_key = ?').get(input.idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new SimError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different payload');
        }
        writeAudit(this.db, this.clock, { principal, action: 'APPROVAL_STAGE_DUPLICATE', entity: 'approval_packet', entityId: String(existing.approval_id), outcome: 'RETURNED_EXISTING' });
        return { id: String(existing.approval_id), duplicate: true };
      }
      // Referential & domain validation.
      const ci = this.db.prepare('SELECT ci_id, machine_id FROM config_items WHERE ci_id = ?').get(input.ciId) as Row | undefined;
      if (!ci) throw new SimError(422, 'UNKNOWN_CI', `Configuration item ${input.ciId} does not exist`);
      if (ci.machine_id !== input.machineId) throw new SimError(422, 'CI_MACHINE_MISMATCH', 'Configuration item is not linked to the given machine');
      const [a, b] = input.approverIds;
      if (a === b) throw new SimError(422, 'APPROVERS_NOT_DISTINCT', 'Two distinct approvers are required');
      for (const id of input.approverIds) {
        const u = this.getUser(id);
        if (!u || !u.active) throw new SimError(422, 'UNKNOWN_APPROVER', `Approver ${id} is unknown or inactive`);
        if (u.role === 'ANALYST') throw new SimError(422, 'APPROVER_ROLE_INVALID', `Approver ${id} has role ANALYST`);
      }
      if (input.approverIds.includes(input.requestedBy)) throw new SimError(422, 'SEPARATION_OF_DUTIES', 'The requester cannot be an approver');
      if (Date.parse(input.expiresAt) <= this.clock.nowMs()) throw new SimError(422, 'EXPIRY_IN_PAST', 'expiresAt must be in the future');
      const open = this.db
        .prepare(`SELECT approval_id, status, expires_at FROM approval_packets WHERE incident_id=? AND machine_id=? AND requested_action=? AND status IN ('WAITING_FOR_DUAL_APPROVAL','PARTIALLY_APPROVED')`)
        .all(input.incidentId, input.machineId, input.requestedAction) as Row[];
      const stillOpen = open.filter((p) => this.clock.nowMs() < Date.parse(String(p.expires_at)));
      if (stillOpen.length > 0) {
        throw new SimError(409, 'OPEN_PACKET_EXISTS', `An open approval packet already exists (${stillOpen[0]!.approval_id})`, { approvalId: stillOpen[0]!.approval_id });
      }
      const seq = this.nextCounter('approval');
      const id = `CAP-${new Date(this.clock.nowMs()).getUTCFullYear()}-${String(1041 + seq)}`;
      const now = this.clock.nowIso();
      this.db
        .prepare(
          `INSERT INTO approval_packets (approval_id, idempotency_key, payload_hash, incident_id, expected_incident_version, machine_id, ci_id, requested_action, decision, reason_codes, approver_ids, evidence_hashes, policy_version, requested_by, status, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.idempotencyKey,
          payloadHash,
          input.incidentId,
          input.expectedIncidentVersion,
          input.machineId,
          input.ciId,
          input.requestedAction,
          input.decision,
          JSON.stringify(input.reasonCodes),
          JSON.stringify(input.approverIds),
          JSON.stringify(input.evidenceHashes),
          input.policyVersion,
          input.requestedBy,
          'WAITING_FOR_DUAL_APPROVAL',
          now,
          input.expiresAt,
        );
      for (const approver of input.approverIds) {
        this.db.prepare('INSERT INTO notifications (recipient_id, approval_id, kind, created_at) VALUES (?,?,?,?)').run(approver, id, 'APPROVAL_REQUESTED', now);
      }
      writeAudit(this.db, this.clock, { principal, action: 'APPROVAL_STAGED', entity: 'approval_packet', entityId: id, outcome: 'CREATED', details: { incidentId: input.incidentId, approvers: input.approverIds } });
      return { id, duplicate: false };
    });
    const { id, duplicate } = tx();
    return { packet: this.getPacket(id)!, duplicate };
  }

  decide(approvalId: string, actorId: string, decision: 'APPROVE' | 'REJECT', comment: string, principal: string): ApprovalPacket {
    const tx = this.db.transaction(() => {
      const p = this.getPacket(approvalId);
      if (!p) throw new SimError(404, 'NOT_FOUND', `Approval packet ${approvalId} not found`);
      if (p.status === 'EXPIRED') throw new SimError(409, 'PACKET_EXPIRED', 'This approval packet has expired; a new review is required');
      if (!OPEN.includes(p.status)) throw new SimError(409, 'PACKET_CLOSED', `Packet is already ${p.status}`);
      if (!p.approverIds.includes(actorId)) throw new SimError(403, 'NOT_AN_APPROVER', `${actorId} is not an assigned approver`);
      if (actorId === p.requestedBy) throw new SimError(403, 'SEPARATION_OF_DUTIES', 'The requester cannot approve their own request');
      if (p.decisions.some((d) => d.approverId === actorId)) throw new SimError(409, 'ALREADY_DECIDED', `${actorId} has already recorded a decision`);
      this.db.prepare('INSERT INTO approval_decisions (approval_id, approver_id, decision, comment, decided_at) VALUES (?,?,?,?,?)').run(approvalId, actorId, decision, comment, this.clock.nowIso());
      const approvals = p.decisions.filter((d) => d.decision === 'APPROVE').length + (decision === 'APPROVE' ? 1 : 0);
      const status: ApprovalPacketStatus = decision === 'REJECT' ? 'REJECTED' : approvals >= 2 ? 'APPROVED' : 'PARTIALLY_APPROVED';
      this.db.prepare('UPDATE approval_packets SET status = ? WHERE approval_id = ?').run(status, approvalId);
      writeAudit(this.db, this.clock, { principal, action: `APPROVAL_${decision}`, entity: 'approval_packet', entityId: approvalId, outcome: status, details: { actorId } });
    });
    tx();
    return this.getPacket(approvalId)!;
  }

  notifications(recipientId?: string) {
    const rows = recipientId
      ? this.db.prepare('SELECT * FROM notifications WHERE recipient_id = ? ORDER BY notification_id').all(recipientId)
      : this.db.prepare('SELECT * FROM notifications ORDER BY notification_id').all();
    return rows as Row[];
  }

  private nextCounter(name: string): number {
    this.db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(name);
    this.db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
    return Number((this.db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as Row).value);
  }

  // --- dataset management --------------------------------------------------------
  replaceAll(ds: ItsmDataset): void {
    const tx = this.db.transaction(() => {
      this.db.exec(
        'DELETE FROM notifications; DELETE FROM approval_decisions; DELETE FROM approval_packets; DELETE FROM documents; DELETE FROM change_freezes; DELETE FROM ci_dependencies; DELETE FROM config_items; DELETE FROM users; DELETE FROM counters;',
      );
      this.upsertDataset(ds);
    });
    tx();
  }

  upsertDataset(ds: Partial<ItsmDataset>): void {
    const u = this.db.prepare(
      `INSERT INTO users (user_id, display_name, role, on_call, active) VALUES (@userId,@displayName,@role,@onCall,@active)
       ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, role=excluded.role, on_call=excluded.on_call, active=excluded.active`,
    );
    const c = this.db.prepare(
      `INSERT INTO config_items (ci_id, name, hostname, machine_id, tier, business_service, environment, owner_user_id, last_verified_at, revision) VALUES (@ciId,@name,@hostname,@machineId,@tier,@businessService,@environment,@ownerUserId,@lastVerifiedAt,@revision)
       ON CONFLICT(ci_id) DO UPDATE SET name=excluded.name, hostname=excluded.hostname, machine_id=excluded.machine_id, tier=excluded.tier, business_service=excluded.business_service, environment=excluded.environment, owner_user_id=excluded.owner_user_id, last_verified_at=excluded.last_verified_at, revision=excluded.revision`,
    );
    const d = this.db.prepare(
      `INSERT INTO ci_dependencies (dependency_id, ci_id, workflow_name, criticality, status) VALUES (@dependencyId,@ciId,@workflowName,@criticality,@status)
       ON CONFLICT(dependency_id) DO UPDATE SET ci_id=excluded.ci_id, workflow_name=excluded.workflow_name, criticality=excluded.criticality, status=excluded.status`,
    );
    const f = this.db.prepare(
      `INSERT INTO change_freezes (freeze_id, ci_id, reason, starts_at, ends_at, status) VALUES (@freezeId,@ciId,@reason,@startsAt,@endsAt,@status)
       ON CONFLICT(freeze_id) DO UPDATE SET ci_id=excluded.ci_id, reason=excluded.reason, starts_at=excluded.starts_at, ends_at=excluded.ends_at, status=excluded.status`,
    );
    const doc = this.db.prepare(
      `INSERT INTO documents (document_id, version, ci_id, doc_type, title, body, updated_at) VALUES (@documentId,@version,@ciId,@docType,@title,@body,@updatedAt)
       ON CONFLICT(document_id) DO UPDATE SET version=excluded.version, ci_id=excluded.ci_id, doc_type=excluded.doc_type, title=excluded.title, body=excluded.body, updated_at=excluded.updated_at`,
    );
    for (const r of ds.users ?? []) u.run({ ...r, onCall: r.onCall ? 1 : 0, active: r.active ? 1 : 0 });
    for (const r of ds.configItems ?? []) c.run(r);
    for (const r of ds.dependencies ?? []) d.run(r);
    for (const r of ds.changeFreezes ?? []) f.run(r);
    for (const r of ds.documents ?? []) doc.run(r);
  }

  snapshot(): ItsmDataset {
    return {
      users: this.listUsers(),
      configItems: this.findConfigItems({}),
      dependencies: (this.db.prepare('SELECT * FROM ci_dependencies ORDER BY dependency_id').all() as Row[]).map(mapDep),
      changeFreezes: (this.db.prepare('SELECT * FROM change_freezes ORDER BY freeze_id').all() as Row[]).map(mapFreeze),
      documents: (this.db.prepare('SELECT * FROM documents ORDER BY document_id').all() as Row[]).map(mapDoc),
    };
  }
}

type Row = Record<string, unknown>;

const mapUser = (r: Row): UserRow => ({ userId: String(r.user_id), displayName: String(r.display_name), role: r.role as UserRow['role'], onCall: r.on_call === 1, active: r.active === 1 });
const mapCi = (r: Row): ConfigItemRow => ({
  ciId: String(r.ci_id),
  name: String(r.name),
  hostname: String(r.hostname),
  machineId: r.machine_id === null ? null : String(r.machine_id),
  tier: r.tier as ConfigItemRow['tier'],
  businessService: String(r.business_service),
  environment: r.environment as ConfigItemRow['environment'],
  ownerUserId: String(r.owner_user_id),
  lastVerifiedAt: String(r.last_verified_at),
  revision: Number(r.revision),
});
const mapDep = (r: Row): DependencyRow => ({ dependencyId: String(r.dependency_id), ciId: String(r.ci_id), workflowName: String(r.workflow_name), criticality: r.criticality as DependencyRow['criticality'], status: r.status as DependencyRow['status'] });
const mapFreeze = (r: Row): ChangeFreezeRow => ({ freezeId: String(r.freeze_id), ciId: String(r.ci_id), reason: String(r.reason), startsAt: String(r.starts_at), endsAt: String(r.ends_at), status: r.status as ChangeFreezeRow['status'] });
const mapDoc = (r: Row): DocumentRow => ({ documentId: String(r.document_id), version: Number(r.version), ciId: String(r.ci_id), docType: r.doc_type as DocumentRow['docType'], title: String(r.title), body: String(r.body), updatedAt: String(r.updated_at) });
const mapPacket = (r: Row, decisions: ApprovalPacket['decisions']): ApprovalPacket => ({
  approvalId: String(r.approval_id),
  idempotencyKey: String(r.idempotency_key),
  incidentId: String(r.incident_id),
  expectedIncidentVersion: Number(r.expected_incident_version),
  machineId: String(r.machine_id),
  ciId: String(r.ci_id),
  requestedAction: 'FULL_ISOLATION',
  decision: 'REQUIRE_DUAL_APPROVAL',
  reasonCodes: JSON.parse(String(r.reason_codes)),
  approverIds: JSON.parse(String(r.approver_ids)),
  evidenceHashes: JSON.parse(String(r.evidence_hashes)),
  policyVersion: String(r.policy_version),
  requestedBy: String(r.requested_by),
  status: r.status as ApprovalPacketStatus,
  createdAt: String(r.created_at),
  expiresAt: String(r.expires_at),
  decisions,
});

const DecisionBody = z.object({ actorId: z.string().min(1).max(64), decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().max(500).default('') }).strict();

export function createItsmRouter(repo: ItsmRepository, tokens: Map<string, TokenGrant>, faults: FaultInjector, clock: ScenarioClock): Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  r.use(faults.middleware());

  r.get(
    '/api/config-items',
    requireScope(tokens, 'cmdb.read'),
    handle((req, res) => {
      const machineId = typeof req.query.machineId === 'string' ? req.query.machineId : undefined;
      const hostname = typeof req.query.hostname === 'string' ? req.query.hostname : undefined;
      res.json({ value: repo.findConfigItems({ machineId, hostname }) });
    }),
  );
  r.get(
    '/api/config-items/:id',
    requireScope(tokens, 'cmdb.read'),
    handle((req, res) => {
      const b = repo.getBundle(String(req.params.id));
      if (!b) throw new SimError(404, 'NOT_FOUND', `Configuration item ${req.params.id} not found`);
      res.json(b);
    }),
  );
  r.get(
    '/api/users',
    requireScope(tokens, 'cmdb.read'),
    handle((req, res) => {
      const role = typeof req.query.role === 'string' ? req.query.role : undefined;
      const onCall = req.query.onCall === 'true' ? true : req.query.onCall === 'false' ? false : undefined;
      res.json({ value: repo.listUsers({ role, onCall }) });
    }),
  );

  r.post(
    '/api/approval-packets',
    requireScope(tokens, 'approval.write'),
    handle(async (req, res) => {
      const parsed = StageContainmentApprovalInput.safeParse(req.body);
      if (!parsed.success) throw new SimError(400, 'VALIDATION', 'Invalid approval packet', parsed.error.issues);
      const result = repo.stagePacket(parsed.data, String(res.locals.principal));
      // Partial-failure simulation: the write is committed but the response never arrives in time.
      const f = faults.take(true, ['timeout_after_commit']);
      if (f) await sleep(f.latencyMs);
      res.status(result.duplicate ? 200 : 201).json({ ...result.packet, duplicate: result.duplicate });
    }),
  );
  r.get(
    '/api/approval-packets',
    requireScope(tokens, 'approval.read'),
    handle((req, res) => {
      if (typeof req.query.idempotencyKey === 'string') {
        const id = repo.findPacketIdByKey(req.query.idempotencyKey);
        res.json({ value: id ? [repo.getPacket(id)] : [] });
        return;
      }
      const approverId = typeof req.query.approverId === 'string' ? req.query.approverId : undefined;
      res.json({ value: repo.listPackets({ approverId }) });
    }),
  );
  r.get(
    '/api/approval-packets/:id',
    requireScope(tokens, 'approval.read'),
    handle((req, res) => {
      const p = repo.getPacket(String(req.params.id));
      if (!p) throw new SimError(404, 'NOT_FOUND', `Approval packet ${req.params.id} not found`);
      const f = faults.take(false, ['corrupt_readback']);
      if (f) {
        res.setHeader('x-sim-fault', 'corrupt_readback');
        res.json({ ...p, approverIds: [p.approverIds[0], 'owner-unexpected'] });
        return;
      }
      res.json(p);
    }),
  );
  r.post(
    '/api/approval-packets/:id/decisions',
    requireScope(tokens, 'approval.decide'),
    handle((req, res) => {
      const body = DecisionBody.safeParse(req.body);
      if (!body.success) throw new SimError(400, 'VALIDATION', 'Invalid decision', body.error.issues);
      res.json(repo.decide(String(req.params.id), body.data.actorId, body.data.decision, body.data.comment, String(res.locals.principal)));
    }),
  );
  r.get(
    '/api/notifications',
    requireScope(tokens, 'approval.read'),
    handle((req, res) => res.json({ value: repo.notifications(typeof req.query.recipientId === 'string' ? req.query.recipientId : undefined) })),
  );
  r.get('/api/audit', requireScope(tokens, 'audit.read'), handle((_req, res) => res.json({ value: readAudit(repo.db) })));
  r.get('/api/_health', handle((_req, res) => res.json({ ok: true, system: 'mock-itsm', now: clock.nowIso() })));
  return r;
}
