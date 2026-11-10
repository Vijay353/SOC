/**
 * Mock Microsoft Security — a narrow behavioural simulator of the Defender capabilities this workflow reads.
 * It is NOT the Defender or Graph API: paths and payloads are simplified and documented in SIMULATOR-CONTRACTS.md.
 */
import type { Db } from '../shared/sqlite';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { AlertRow, DeviceActivityRow, DeviceRow, IncidentRow } from '../../packages/contracts/src/domain';
import type { SecurityDataset } from '../../fixtures/seed';
import { AUDIT_DDL, FaultInjector, handle, readAudit, requireScope, ScenarioClock, SimError, writeAudit, type TokenGrant } from '../shared/infra';

const DDL = `
CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('informational','low','medium','high')),
  status TEXT NOT NULL CHECK (status IN ('active','inProgress','resolved','redirected')),
  created_at TEXT NOT NULL,
  last_update_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE TABLE IF NOT EXISTS devices (
  machine_id TEXT PRIMARY KEY,
  computer_dns_name TEXT NOT NULL,
  os_platform TEXT NOT NULL,
  defender_criticality TEXT NOT NULL CHECK (defender_criticality IN ('CRITICAL','STANDARD','UNKNOWN')),
  isolation_state TEXT NOT NULL CHECK (isolation_state IN ('NOT_ISOLATED','ISOLATED')),
  last_seen TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1)
);
CREATE TABLE IF NOT EXISTS alerts (
  alert_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL REFERENCES devices(machine_id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('DEFENDER_ENDPOINT','THIRD_PARTY_FIREWALL')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  detected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_activity (
  machine_id TEXT PRIMARY KEY REFERENCES devices(machine_id) ON DELETE CASCADE,
  active_session_count INTEGER NOT NULL CHECK (active_session_count >= 0),
  distinct_remote_hosts INTEGER NOT NULL CHECK (distinct_remote_hosts >= 0),
  observed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_actions (
  action_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES devices(machine_id),
  action_type TEXT NOT NULL,
  isolation_type TEXT,
  requested_by TEXT NOT NULL,
  comment TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${AUDIT_DDL}
`;

export class SecurityRepository {
  constructor(
    public db: Db,
    private clock: ScenarioClock,
  ) {
    db.exec(DDL);
  }

  // --- reads ---------------------------------------------------------------
  getIncident(id: string): IncidentRow | null {
    const r = this.db.prepare('SELECT * FROM incidents WHERE incident_id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapIncident(r) : null;
  }
  listIncidents(): IncidentRow[] {
    return (this.db.prepare('SELECT * FROM incidents ORDER BY incident_id').all() as Record<string, unknown>[]).map(mapIncident);
  }
  getDevice(id: string): DeviceRow | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE machine_id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapDevice(r) : null;
  }
  listDevices(): DeviceRow[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY computer_dns_name').all() as Record<string, unknown>[]).map(mapDevice);
  }
  alertsForIncident(id: string): AlertRow[] {
    return (this.db.prepare('SELECT * FROM alerts WHERE incident_id = ? ORDER BY detected_at').all(id) as Record<string, unknown>[]).map(mapAlert);
  }
  listAlerts(): AlertRow[] {
    return (this.db.prepare('SELECT * FROM alerts ORDER BY alert_id').all() as Record<string, unknown>[]).map(mapAlert);
  }
  getActivity(id: string): DeviceActivityRow | null {
    const r = this.db.prepare('SELECT * FROM device_activity WHERE machine_id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? mapActivity(r) : null;
  }
  listActivity(): DeviceActivityRow[] {
    return (this.db.prepare('SELECT * FROM device_activity ORDER BY machine_id').all() as Record<string, unknown>[]).map(mapActivity);
  }
  machineActions(machineId?: string) {
    const sql = machineId ? 'SELECT * FROM machine_actions WHERE machine_id = ? ORDER BY created_at' : 'SELECT * FROM machine_actions ORDER BY created_at';
    return (machineId ? this.db.prepare(sql).all(machineId) : this.db.prepare(sql).all()) as Record<string, unknown>[];
  }

  // --- writes --------------------------------------------------------------
  /** Optimistic-concurrency update of analyst-editable incident fields. */
  updateIncident(id: string, ifRevision: number, patch: { status?: IncidentRow['status']; severity?: IncidentRow['severity'] }, principal: string): IncidentRow {
    const tx = this.db.transaction(() => {
      const current = this.getIncident(id);
      if (!current) throw new SimError(404, 'NOT_FOUND', `Incident ${id} not found`);
      if (current.revision !== ifRevision) {
        throw new SimError(409, 'REVISION_CONFLICT', `Incident ${id} is at revision ${current.revision}, not ${ifRevision}`, { currentRevision: current.revision });
      }
      const next = { ...current, ...patch, revision: current.revision + 1, lastUpdateDateTime: this.clock.nowIso() };
      this.db
        .prepare('UPDATE incidents SET status=?, severity=?, revision=?, last_update_at=? WHERE incident_id=?')
        .run(next.status, next.severity, next.revision, next.lastUpdateDateTime, id);
      writeAudit(this.db, this.clock, { principal, action: 'INCIDENT_UPDATED', entity: 'incident', entityId: id, outcome: 'OK', details: { fromRevision: current.revision, toRevision: next.revision, patch } });
      return next;
    });
    return tx();
  }

  /** Behavioural stand-in for a device isolation machine action. Requires the machine.isolate scope. */
  isolate(machineId: string, isolationType: 'Full' | 'Selective', comment: string, principal: string) {
    const tx = this.db.transaction(() => {
      const d = this.getDevice(machineId);
      if (!d) throw new SimError(404, 'NOT_FOUND', `Device ${machineId} not found`);
      if (d.isolationState === 'ISOLATED') throw new SimError(409, 'ALREADY_ISOLATED', 'Device is already isolated');
      const actionId = `MA-${machineId.slice(-6)}-${this.machineActions().length + 1}`;
      const now = this.clock.nowIso();
      this.db
        .prepare('INSERT INTO machine_actions (action_id, machine_id, action_type, isolation_type, requested_by, comment, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(actionId, machineId, 'Isolate', isolationType, principal, comment, 'Succeeded', now);
      this.db.prepare("UPDATE devices SET isolation_state='ISOLATED', revision = revision + 1 WHERE machine_id=?").run(machineId);
      writeAudit(this.db, this.clock, { principal, action: 'DEVICE_ISOLATED', entity: 'device', entityId: machineId, outcome: 'OK', details: { actionId, isolationType } });
      return { actionId, machineId, type: 'Isolate', isolationType, status: 'Succeeded', createdAt: now };
    });
    return tx();
  }

  // --- dataset management ----------------------------------------------------
  replaceAll(ds: SecurityDataset): void {
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM machine_actions; DELETE FROM device_activity; DELETE FROM alerts; DELETE FROM devices; DELETE FROM incidents;');
      this.upsertDataset(ds);
    });
    tx();
  }

  upsertDataset(ds: Partial<SecurityDataset>): void {
    const incStmt = this.db.prepare(
      `INSERT INTO incidents (incident_id, display_name, severity, status, created_at, last_update_at, revision) VALUES (@incidentId,@displayName,@severity,@status,@createdDateTime,@lastUpdateDateTime,@revision)
       ON CONFLICT(incident_id) DO UPDATE SET display_name=excluded.display_name, severity=excluded.severity, status=excluded.status, created_at=excluded.created_at, last_update_at=excluded.last_update_at, revision=excluded.revision`,
    );
    const devStmt = this.db.prepare(
      `INSERT INTO devices (machine_id, computer_dns_name, os_platform, defender_criticality, isolation_state, last_seen, revision) VALUES (@machineId,@computerDnsName,@osPlatform,@defenderCriticality,@isolationState,@lastSeen,@revision)
       ON CONFLICT(machine_id) DO UPDATE SET computer_dns_name=excluded.computer_dns_name, os_platform=excluded.os_platform, defender_criticality=excluded.defender_criticality, isolation_state=excluded.isolation_state, last_seen=excluded.last_seen, revision=excluded.revision`,
    );
    const alStmt = this.db.prepare(
      `INSERT INTO alerts (alert_id, incident_id, machine_id, source, title, description, detected_at) VALUES (@alertId,@incidentId,@machineId,@source,@title,@description,@detectedAt)
       ON CONFLICT(alert_id) DO UPDATE SET incident_id=excluded.incident_id, machine_id=excluded.machine_id, source=excluded.source, title=excluded.title, description=excluded.description, detected_at=excluded.detected_at`,
    );
    const actStmt = this.db.prepare(
      `INSERT INTO device_activity (machine_id, active_session_count, distinct_remote_hosts, observed_at) VALUES (@machineId,@activeSessionCount,@distinctRemoteHosts,@observedAt)
       ON CONFLICT(machine_id) DO UPDATE SET active_session_count=excluded.active_session_count, distinct_remote_hosts=excluded.distinct_remote_hosts, observed_at=excluded.observed_at`,
    );
    for (const r of ds.incidents ?? []) incStmt.run(r);
    for (const r of ds.devices ?? []) devStmt.run(r);
    for (const r of ds.alerts ?? []) alStmt.run(r);
    for (const r of ds.deviceActivity ?? []) actStmt.run(r);
  }

  snapshot(): SecurityDataset {
    return { incidents: this.listIncidents(), devices: this.listDevices(), alerts: this.listAlerts(), deviceActivity: this.listActivity() };
  }
}

const mapIncident = (r: Record<string, unknown>): IncidentRow => ({
  incidentId: String(r.incident_id),
  displayName: String(r.display_name),
  severity: r.severity as IncidentRow['severity'],
  status: r.status as IncidentRow['status'],
  createdDateTime: String(r.created_at),
  lastUpdateDateTime: String(r.last_update_at),
  revision: Number(r.revision),
});
const mapDevice = (r: Record<string, unknown>): DeviceRow => ({
  machineId: String(r.machine_id),
  computerDnsName: String(r.computer_dns_name),
  osPlatform: String(r.os_platform),
  defenderCriticality: r.defender_criticality as DeviceRow['defenderCriticality'],
  isolationState: r.isolation_state as DeviceRow['isolationState'],
  lastSeen: String(r.last_seen),
  revision: Number(r.revision),
});
const mapAlert = (r: Record<string, unknown>): AlertRow => ({
  alertId: String(r.alert_id),
  incidentId: String(r.incident_id),
  machineId: String(r.machine_id),
  source: r.source as AlertRow['source'],
  title: String(r.title),
  description: String(r.description),
  detectedAt: String(r.detected_at),
});
const mapActivity = (r: Record<string, unknown>): DeviceActivityRow => ({
  machineId: String(r.machine_id),
  activeSessionCount: Number(r.active_session_count),
  distinctRemoteHosts: Number(r.distinct_remote_hosts),
  observedAt: String(r.observed_at),
});

const IncidentPatch = z.object({ status: z.enum(['active', 'inProgress', 'resolved', 'redirected']).optional(), severity: z.enum(['informational', 'low', 'medium', 'high']).optional() }).strict();
const IsolateBody = z.object({ Comment: z.string().min(1).max(500), IsolationType: z.enum(['Full', 'Selective']) }).strict();

export function createSecurityRouter(repo: SecurityRepository, tokens: Map<string, TokenGrant>, faults: FaultInjector, clock: ScenarioClock): Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  r.use(faults.middleware());

  r.get('/api/incidents', requireScope(tokens, 'incident.read'), handle((_req, res) => res.json({ value: repo.listIncidents() })));
  r.get(
    '/api/incidents/:id',
    requireScope(tokens, 'incident.read'),
    handle((req, res) => {
      const id = String(req.params.id);
      const incident = repo.getIncident(id);
      if (!incident) throw new SimError(404, 'NOT_FOUND', `Incident ${id} not found`);
      res.setHeader('etag', `"r${incident.revision}"`);
      res.json({ ...incident, alerts: repo.alertsForIncident(id) });
    }),
  );
  r.patch(
    '/api/incidents/:id',
    requireScope(tokens, 'incident.write'),
    handle((req, res) => {
      const ifMatch = req.header('if-match') ?? '';
      const m = /^"r(\d+)"$/.exec(ifMatch);
      if (!m) throw new SimError(428, 'PRECONDITION_REQUIRED', 'If-Match header with "r<revision>" is required');
      const patch = IncidentPatch.safeParse(req.body);
      if (!patch.success) throw new SimError(400, 'VALIDATION', 'Invalid incident patch', patch.error.issues);
      res.json(repo.updateIncident(String(req.params.id), Number(m[1]), patch.data, String(res.locals.principal)));
    }),
  );
  r.get('/api/devices', requireScope(tokens, 'device.read'), handle((_req, res) => res.json({ value: repo.listDevices() })));
  r.get(
    '/api/devices/:id',
    requireScope(tokens, 'device.read'),
    handle((req, res) => {
      const d = repo.getDevice(String(req.params.id));
      if (!d) throw new SimError(404, 'NOT_FOUND', `Device ${req.params.id} not found`);
      res.json(d);
    }),
  );
  r.get(
    '/api/devices/:id/activity-summary',
    requireScope(tokens, 'activity.read'),
    handle((req, res) => {
      const a = repo.getActivity(String(req.params.id));
      if (!a) throw new SimError(404, 'NOT_FOUND', `No activity summary for ${req.params.id}`);
      res.json(a);
    }),
  );
  r.get('/api/machines/:id/actions', requireScope(tokens, 'device.read'), handle((req, res) => res.json({ value: repo.machineActions(String(req.params.id)) })));
  r.post(
    '/api/machines/:id/isolate',
    requireScope(tokens, 'machine.isolate'),
    handle((req, res) => {
      const body = IsolateBody.safeParse(req.body);
      if (!body.success) throw new SimError(400, 'VALIDATION', 'Invalid isolate request', body.error.issues);
      res.status(201).json(repo.isolate(String(req.params.id), body.data.IsolationType, body.data.Comment, String(res.locals.principal)));
    }),
  );
  r.get('/api/audit', requireScope(tokens, 'audit.read'), handle((_req, res) => res.json({ value: readAudit(repo.db) })));
  r.get('/api/_health', handle((_req, res) => res.json({ ok: true, system: 'mock-security', now: clock.nowIso() })));
  return r;
}
