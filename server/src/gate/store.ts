/**
 * The Gate's own durable store (gate.db). It owns response-request lifecycle, evaluations, execution
 * traces and a hash-chained audit log. It never stores credentials or raw tokens.
 */
import type { Db } from '../../../simulators/shared/sqlite';
import crypto from 'node:crypto';
import type { GateDecision, RequestState, StageContainmentApprovalInput } from '../../../packages/contracts/src/domain';
import { canonical } from '../../../packages/contracts/src/canonical';
import { REQUEST_TRANSITIONS } from '../../../packages/contracts/src/lifecycle';
import type { ScenarioClock } from '../../../simulators/shared/infra';

const DDL = `
CREATE TABLE IF NOT EXISTS gate_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS response_requests (
  request_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  incident_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL,
  approval_id TEXT,
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
  evaluation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES response_requests(request_id),
  incident_revision INTEGER,
  decision TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  summary TEXT NOT NULL,
  policy_input TEXT NOT NULL,
  evidence_hashes TEXT NOT NULL,
  approver_ids TEXT NOT NULL,
  ci_id TEXT,
  idempotency_key TEXT,
  machine_action_count INTEGER,
  stage_input TEXT,
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  trace TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT,
  details TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events WHEN (SELECT value FROM gate_settings WHERE key='allow_reset') IS NOT 'yes' BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE TABLE IF NOT EXISTS imports (
  import_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  preview TEXT NOT NULL,
  backup_dir TEXT,
  created_at TEXT NOT NULL,
  committed_at TEXT
);
`;

export interface RequestRecord {
  requestId: string;
  eventId: string;
  incidentId: string;
  machineId: string;
  requestedAction: 'FULL_ISOLATION';
  requestedBy: string;
  state: RequestState;
  approvalId: string | null;
  lastError: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EvaluationRecord {
  evaluationId: string;
  requestId: string;
  incidentRevision: number | null;
  decision: GateDecision;
  reasonCodes: string[];
  summary: Record<string, unknown>;
  policyInput: Record<string, unknown>;
  evidenceHashes: Record<string, string>;
  approverIds: string[];
  ciId: string | null;
  idempotencyKey: string | null;
  machineActionCount: number | null;
  createdAt: string;
  validUntil: string;
  /** CH-16: the policy version and thresholds that produced this evaluation. Null on rows written before V3. */
  policyVersion: string | null;
  policyConfig: Record<string, unknown> | null;
}

/** Allowed lifecycle transitions; anything else is rejected. The table lives in packages/contracts/src/lifecycle.ts (shared with the UI). */
const TRANSITIONS = REQUEST_TRANSITIONS;
/**
 * CH-6: states in which a request permits, or may soon permit, a containment action on its device.
 * Blocked (insufficient evidence, manual review) and closed (rejected, expired) requests do not count.
 */
export const DUPLICATE_RELEVANT_STATES: RequestState[] = ['RESPONSE_READY', 'REEVALUATION_REQUIRED', 'WAITING_FOR_DUAL_APPROVAL', 'VERIFICATION_FAILED', 'APPROVED_FOR_MANUAL_EXECUTION', 'STANDARD_RESPONSE_ELIGIBLE'];
export const OPEN_STATES: RequestState[] = ['RESPONSE_READY', 'WAITING_FOR_DUAL_APPROVAL', 'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'REEVALUATION_REQUIRED', 'VERIFICATION_FAILED'];

export class TransitionError extends Error {
  constructor(
    public code: 'INVALID_TRANSITION' | 'CONCURRENT_MODIFICATION',
    message: string,
  ) {
    super(message);
  }
}

export class GateStore {
  constructor(
    public db: Db,
    private clock: ScenarioClock,
  ) {
    db.exec(DDL);
    this.migrate();
  }

  createRequest(r: Omit<RequestRecord, 'state' | 'approvalId' | 'lastError' | 'version' | 'createdAt' | 'updatedAt'>): RequestRecord {
    const now = this.clock.nowIso();
    this.db
      .prepare(
        `INSERT INTO response_requests (request_id, event_id, incident_id, machine_id, requested_action, requested_by, state, created_at, updated_at) VALUES (?,?,?,?,?,?, 'RESPONSE_READY', ?, ?)`,
      )
      .run(r.requestId, r.eventId, r.incidentId, r.machineId, r.requestedAction, r.requestedBy, now, now);
    return this.getRequest(r.requestId)!;
  }

  getRequest(id: string): RequestRecord | null {
    const row = this.db.prepare('SELECT * FROM response_requests WHERE request_id = ?').get(id) as Row | undefined;
    return row ? mapRequest(row) : null;
  }
  getRequestByEvent(eventId: string): RequestRecord | null {
    const row = this.db.prepare('SELECT * FROM response_requests WHERE event_id = ?').get(eventId) as Row | undefined;
    return row ? mapRequest(row) : null;
  }
  getRequestByApproval(approvalId: string): RequestRecord | null {
    const row = this.db.prepare('SELECT * FROM response_requests WHERE approval_id = ?').get(approvalId) as Row | undefined;
    return row ? mapRequest(row) : null;
  }
  findOpenRequest(incidentId: string, machineId: string, action: string): RequestRecord | null {
    const placeholders = OPEN_STATES.map(() => '?').join(',');
    const row = this.db
      .prepare(`SELECT * FROM response_requests WHERE incident_id=? AND machine_id=? AND requested_action=? AND state IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`)
      .get(incidentId, machineId, action, ...OPEN_STATES) as Row | undefined;
    return row ? mapRequest(row) : null;
  }
  /** Other requests for the same device in a duplicate-relevant state (CH-6). The caller applies the time window. */
  relatedActiveRequests(machineId: string, excludeRequestId: string): RequestRecord[] {
    const placeholders = DUPLICATE_RELEVANT_STATES.map(() => '?').join(',');
    return (
      this.db
        .prepare(`SELECT * FROM response_requests WHERE machine_id = ? AND request_id <> ? AND state IN (${placeholders}) ORDER BY created_at, request_id`)
        .all(machineId, excludeRequestId, ...DUPLICATE_RELEVANT_STATES) as Row[]
    ).map(mapRequest);
  }
  /**
   * CH-8: this system's own past requests for one device, created inside the trailing window.
   * Each request is counted once, by its current state. The current request is excluded.
   */
  deviceHistory(machineId: string, excludeRequestId: string, nowMs: number, windowDays: number) {
    const from = nowMs - windowDays * 86_400_000;
    const rows = (this.db.prepare('SELECT * FROM response_requests WHERE machine_id = ? AND request_id <> ?').all(machineId, excludeRequestId) as Row[])
      .map(mapRequest)
      .filter((r) => {
        const t = Date.parse(r.createdAt);
        return t >= from && t <= nowMs;
      });
    const bucket = (states: RequestState[]) => rows.filter((r) => states.includes(r.state)).length;
    return {
      windowDays,
      excludesCurrentRequest: true,
      total: rows.length,
      approved: bucket(['APPROVED_FOR_MANUAL_EXECUTION']),
      standardEligible: bucket(['STANDARD_RESPONSE_ELIGIBLE']),
      rejectedOrExpired: bucket(['REJECTED', 'EXPIRED']),
      blocked: bucket(['INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'VERIFICATION_FAILED']),
      inProgress: bucket(['RESPONSE_READY', 'REEVALUATION_REQUIRED', 'WAITING_FOR_DUAL_APPROVAL']),
    };
  }
  listRequests(): RequestRecord[] {
    return (this.db.prepare('SELECT * FROM response_requests ORDER BY created_at DESC, request_id DESC').all() as Row[]).map(mapRequest);
  }

  /** Optimistic-concurrency state transition with an allow-list. */
  transition(id: string, expectedVersion: number, to: RequestState, patch: { approvalId?: string | null; lastError?: unknown } = {}): RequestRecord {
    const current = this.getRequest(id);
    if (!current) throw new TransitionError('INVALID_TRANSITION', `Request ${id} not found`);
    if (!TRANSITIONS[current.state].includes(to)) throw new TransitionError('INVALID_TRANSITION', `Transition ${current.state} → ${to} is not allowed`);
    const res = this.db
      .prepare(
        `UPDATE response_requests SET state=?, approval_id=COALESCE(?, approval_id), last_error=?, version=version+1, updated_at=? WHERE request_id=? AND version=?`,
      )
      .run(to, patch.approvalId ?? null, patch.lastError === undefined ? null : JSON.stringify(patch.lastError), this.clock.nowIso(), id, expectedVersion);
    if (res.changes !== 1) throw new TransitionError('CONCURRENT_MODIFICATION', `Request ${id} was modified concurrently (expected version ${expectedVersion})`);
    return this.getRequest(id)!;
  }

  setLastError(id: string, err: unknown): void {
    this.db.prepare('UPDATE response_requests SET last_error=?, updated_at=? WHERE request_id=?').run(err === null ? null : JSON.stringify(err), this.clock.nowIso(), id);
  }

  /**
   * Additive, idempotent migrations. Each step only adds a nullable column, so it is safe on a fresh database,
   * on a database from before V3, and on every restart. Existing rows are never rewritten.
   */
  private migrate(): void {
    const has = (table: string, col: string) => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((c) => c.name === col);
    const tx = this.db.transaction(() => {
      if (!has('evaluations', 'policy_version')) this.db.exec('ALTER TABLE evaluations ADD COLUMN policy_version TEXT');
      if (!has('evaluations', 'policy_config')) this.db.exec('ALTER TABLE evaluations ADD COLUMN policy_config TEXT');
      // CH-17: databases from before V3 have no end-of-chain anchor. Anchor the current end once, and record how
      // many rows already existed: rows removed from the end before this moment cannot be detected.
      if (!this.readAnchor()) {
        const last = this.db.prepare('SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
        const count = Number((this.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as Row).n);
        this.writeAnchor({ seq: last ? Number(last.seq) : 0, hash: last ? String(last.hash) : AUDIT_GENESIS, establishedAt: this.clock.nowIso(), preexistingRows: count });
      }
    });
    tx();
  }

  saveEvaluation(e: EvaluationRecord): void {
    this.db
      .prepare(
        `INSERT INTO evaluations (evaluation_id, request_id, incident_revision, decision, reason_codes, summary, policy_input, evidence_hashes, approver_ids, ci_id, idempotency_key, machine_action_count, created_at, valid_until, policy_version, policy_config)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.evaluationId,
        e.requestId,
        e.incidentRevision,
        e.decision,
        JSON.stringify(e.reasonCodes),
        JSON.stringify(e.summary),
        JSON.stringify(e.policyInput),
        JSON.stringify(e.evidenceHashes),
        JSON.stringify(e.approverIds),
        e.ciId,
        e.idempotencyKey,
        e.machineActionCount,
        e.createdAt,
        e.validUntil,
        e.policyVersion,
        e.policyConfig === null ? null : JSON.stringify(e.policyConfig),
      );
  }
  latestEvaluation(requestId: string): EvaluationRecord | null {
    const r = this.db.prepare('SELECT * FROM evaluations WHERE request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(requestId) as Row | undefined;
    return r ? this.mapEvaluation(r) : null;
  }

  /** CH-18: every evaluation of one request, oldest first. */
  evaluationsFor(requestId: string): EvaluationRecord[] {
    return (this.db.prepare('SELECT * FROM evaluations WHERE request_id = ? ORDER BY created_at, rowid').all(requestId) as Row[]).map((r) => this.mapEvaluation(r));
  }

  private mapEvaluation(r: Row): EvaluationRecord {
    return {
      evaluationId: String(r.evaluation_id),
      requestId: String(r.request_id),
      incidentRevision: r.incident_revision === null ? null : Number(r.incident_revision),
      decision: r.decision as GateDecision,
      reasonCodes: JSON.parse(String(r.reason_codes)),
      summary: JSON.parse(String(r.summary)),
      policyInput: JSON.parse(String(r.policy_input)),
      evidenceHashes: JSON.parse(String(r.evidence_hashes)),
      approverIds: JSON.parse(String(r.approver_ids)),
      ciId: r.ci_id === null ? null : String(r.ci_id),
      idempotencyKey: r.idempotency_key === null ? null : String(r.idempotency_key),
      machineActionCount: r.machine_action_count === null ? null : Number(r.machine_action_count),
      createdAt: String(r.created_at),
      validUntil: String(r.valid_until),
      policyVersion: r.policy_version == null ? null : String(r.policy_version),
      policyConfig: r.policy_config == null ? null : JSON.parse(String(r.policy_config)),
    };
  }

  saveRun(run: { runId: string; requestId: string; kind: string; actor: string; startedAt: string; outcome: string; trace: unknown[] }): void {
    this.db
      .prepare('INSERT INTO runs (run_id, request_id, kind, actor, started_at, finished_at, outcome, trace) VALUES (?,?,?,?,?,?,?,?)')
      .run(run.runId, run.requestId, run.kind, run.actor, run.startedAt, this.clock.nowIso(), run.outcome, JSON.stringify(run.trace));
  }
  /** Outbox: the exact tool payload, persisted before the first call so retries are byte-identical. */
  getStageInput(evaluationId: string): StageContainmentApprovalInput | null {
    const r = this.db.prepare('SELECT stage_input FROM evaluations WHERE evaluation_id = ?').get(evaluationId) as Row | undefined;
    return r && r.stage_input ? (JSON.parse(String(r.stage_input)) as StageContainmentApprovalInput) : null;
  }
  setStageInput(evaluationId: string, input: StageContainmentApprovalInput): void {
    this.db.prepare('UPDATE evaluations SET stage_input = ? WHERE evaluation_id = ? AND stage_input IS NULL').run(JSON.stringify(input), evaluationId);
  }

  runsFor(requestId: string) {
    return (this.db.prepare('SELECT * FROM runs WHERE request_id = ? ORDER BY started_at, rowid').all(requestId) as Row[]).map((r) => ({
      runId: String(r.run_id),
      kind: String(r.kind),
      actor: String(r.actor),
      startedAt: String(r.started_at),
      finishedAt: String(r.finished_at),
      outcome: String(r.outcome),
      trace: JSON.parse(String(r.trace)),
    }));
  }

  /**
   * Append one audit row. The row, its hash link and the end-of-chain anchor are written in one transaction.
   * The hash covers exactly what is stored (details are normalized through JSON first), so a row written with
   * an undefined field can never later look tampered.
   */
  audit(actor: string, action: string, requestId: string | null, details: unknown): void {
    const stored = JSON.stringify(details ?? {});
    const tx = this.db.transaction(() => {
      const last = this.db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
      const prev = last ? String(last.hash) : AUDIT_GENESIS;
      const at = this.clock.nowIso();
      const hash = auditHash(prev, { at, actor, action, requestId, details: JSON.parse(stored) });
      const ins = this.db.prepare('INSERT INTO audit_events (at, actor, action, request_id, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?)').run(at, actor, action, requestId, stored, prev, hash);
      const anchor = this.readAnchor();
      this.writeAnchor({ seq: Number(ins.lastInsertRowid), hash, establishedAt: anchor?.establishedAt ?? at, preexistingRows: anchor?.preexistingRows ?? 0 });
    });
    tx();
  }

  /** CH-22: small key-value settings kept in gate.db. */
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM gate_settings WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }
  putSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO gate_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private readAnchor(): AuditAnchor | null {
    const r = this.db.prepare("SELECT value FROM gate_settings WHERE key = 'audit_anchor'").get() as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as AuditAnchor) : null;
  }
  private writeAnchor(a: AuditAnchor): void {
    this.db.prepare("INSERT INTO gate_settings (key, value) VALUES ('audit_anchor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(a));
  }

  auditEvents(requestId?: string) {
    const rows = (requestId
      ? this.db.prepare('SELECT * FROM audit_events WHERE request_id = ? ORDER BY seq').all(requestId)
      : this.db.prepare('SELECT * FROM audit_events ORDER BY seq DESC LIMIT 300').all()) as Row[];
    return rows.map((r) => ({ seq: Number(r.seq), at: String(r.at), actor: String(r.actor), action: String(r.action), requestId: r.request_id as string | null, details: JSON.parse(String(r.details)), hash: String(r.hash), prevHash: String(r.prev_hash) }));
  }
  /**
   * CH-17: re-checks every row in sequence order (never by timestamp): contiguous sequence numbers, each row's
   * link to the previous hash, each row's own hash, and that the last row still matches the end-of-chain anchor.
   * Returns the first problem found. Kept fields `intact`, `brokenAt`, `length` for existing callers.
   */
  verifyAuditChain(): AuditVerification {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq').all() as Row[];
    const anchor = this.readAnchor();
    const base = {
      algorithm: AUDIT_ALGORITHM,
      genesis: AUDIT_GENESIS,
      length: rows.length,
      fromSeq: rows.length ? Number(rows[0]!.seq) : null,
      toSeq: rows.length ? Number(rows[rows.length - 1]!.seq) : null,
      anchor,
      unhashedRows: 0,
    };
    const fail = (seq: number | null, reason: AuditVerification['reason']): AuditVerification => ({ ...base, intact: false, brokenAt: seq, reason });
    let prev = AUDIT_GENESIS;
    let expectedSeq = 1;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== expectedSeq) return fail(seq, expectedSeq === 1 ? 'START_MISSING' : 'SEQUENCE_GAP');
      if (r.prev_hash !== prev) return fail(seq, 'LINK_MISMATCH');
      const h = auditHash(prev, { at: r.at, actor: r.actor, action: r.action, requestId: r.request_id, details: JSON.parse(String(r.details)) });
      if (r.hash !== h) return fail(seq, 'HASH_MISMATCH');
      prev = h;
      expectedSeq = seq + 1;
    }
    if (anchor) {
      const lastSeq = rows.length ? Number(rows[rows.length - 1]!.seq) : 0;
      if (lastSeq !== anchor.seq || prev !== anchor.hash) return fail(lastSeq < anchor.seq ? lastSeq + 1 : lastSeq, 'END_DOES_NOT_MATCH_ANCHOR');
    }
    return { ...base, intact: true, brokenAt: null, reason: null };
  }
  resetAll(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO gate_settings (key, value) VALUES ('allow_reset','yes') ON CONFLICT(key) DO UPDATE SET value='yes'").run();
      this.db.exec(`DELETE FROM runs; DELETE FROM evaluations; DELETE FROM response_requests; DELETE FROM audit_events; DELETE FROM sqlite_sequence WHERE name = 'audit_events';`);
      this.db.prepare("UPDATE gate_settings SET value='no' WHERE key='allow_reset'").run();
      this.writeAnchor({ seq: 0, hash: AUDIT_GENESIS, establishedAt: this.clock.nowIso(), preexistingRows: 0 });
    });
    tx();
  }
}

type Row = Record<string, unknown>;

export const AUDIT_GENESIS = 'GENESIS';
export const AUDIT_ALGORITHM = 'sha256(prev_hash || canonical-json{action,actor,at,details,requestId}), keys sorted, v1';
const auditHash = (prev: string, payload: { at: unknown; actor: unknown; action: unknown; requestId: unknown; details: unknown }) =>
  crypto.createHash('sha256').update(prev + canonical(payload)).digest('hex');

/** The last row's sequence number and hash, updated in the same transaction as every insert. */
export interface AuditAnchor {
  seq: number;
  hash: string;
  establishedAt: string;
  /** Rows that already existed when the anchor was first created (pre-V3 databases). */
  preexistingRows: number;
}
export interface AuditVerification {
  intact: boolean;
  brokenAt: number | null;
  reason: null | 'START_MISSING' | 'SEQUENCE_GAP' | 'LINK_MISMATCH' | 'HASH_MISMATCH' | 'END_DOES_NOT_MATCH_ANCHOR';
  length: number;
  fromSeq: number | null;
  toSeq: number | null;
  algorithm: string;
  genesis: string;
  anchor: AuditAnchor | null;
  /** Rows without a hash. The schema requires a hash on every row, so this is always 0 here. */
  unhashedRows: number;
}
const mapRequest = (r: Row): RequestRecord => ({
  requestId: String(r.request_id),
  eventId: String(r.event_id),
  incidentId: String(r.incident_id),
  machineId: String(r.machine_id),
  requestedAction: 'FULL_ISOLATION',
  requestedBy: String(r.requested_by),
  state: r.state as RequestState,
  approvalId: r.approval_id === null ? null : String(r.approval_id),
  lastError: r.last_error === null ? null : JSON.parse(String(r.last_error)),
  version: Number(r.version),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});
