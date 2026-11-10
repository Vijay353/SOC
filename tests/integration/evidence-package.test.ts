/**
 * CH-18: one request's audit evidence package. Read-only, canonical JSON with a SHA-256 checksum (not a signature),
 * honest about missing evidence, and limited to SOC roles or a named approver.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical, sha256 } from '../../packages/contracts/src/canonical';
import { openDatabase } from '../../simulators/shared/infra';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

const open: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const harness = async (o: Parameters<typeof startHarness>[0] = {}) => {
  const h = await startHarness(o);
  open.push(h);
  return h;
};
async function raw(h: Harness, id: string, actor = 'analyst-priya') {
  const res = await fetch(`${h.url}/api/requests/${id}/evidence-package`, { headers: actor ? { 'x-demo-user': actor } : {} });
  return { status: res.status, text: await res.text(), disposition: res.headers.get('content-disposition') };
}
const decide = (h: Harness, id: string, actor: string, decision: 'APPROVE' | 'REJECT') => h.api<Json>('POST', `/api/approvals/${id}/decision`, { decision, comment: 'test' }, actor);
const withoutDigest = (p: Json) => {
  const { digest: _d, ...rest } = p;
  return rest;
};

async function approvedRun(h: Harness) {
  const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-pkg-1', ...PRIMARY });
  const st = await h.api<Json>('POST', `/api/requests/${r.body.requestId}/stage`);
  const approvalId = st.body.view.request.approvalId as string;
  await decide(h, approvalId, 'soc-incident-commander', 'APPROVE');
  await decide(h, approvalId, 'owner-sap-ewm', 'APPROVE');
  await h.api('GET', `/api/requests/${r.body.requestId}`);
  return { requestId: r.body.requestId as string, approvalId };
}

describe('audit evidence package', () => {
  it('a resolved run exports complete, consistent, canonical JSON with a checksum that verifies', async () => {
    const h = await harness();
    const { requestId, approvalId } = await approvedRun(h);
    const res = await raw(h, requestId);
    expect(res.status).toBe(200);
    expect(res.disposition).toBe(`attachment; filename="audit-evidence-${requestId}.json"`);
    const p = JSON.parse(res.text) as Json;
    expect(res.text).toBe(canonical(p));
    expect(p).toMatchObject({ schema: 'gate.audit-evidence-package', schemaVersion: 1, title: 'Audit evidence package', evidenceStatus: 'complete', statusReasons: [], mode: 'SIMULATED' });
    expect(p.record).toMatchObject({ requestId, state: 'APPROVED_FOR_MANUAL_EXECUTION', approvalId });
    expect(p.decisions[0].policy).toMatchObject({ recorded: true, version: 'CAP-1.1' });
    // The same IDs across the decision, the write and the audit rows.
    expect(p.writes.approvalPacket).toMatchObject({ approvalId, status: 'APPROVED', policyVersion: 'CAP-1.1' });
    expect(p.writes.approvalPacket.idempotencyKey).toBe(p.decisions[0].idempotencyKey);
    expect(p.audit.rows.every((a: Json) => a.requestId === requestId)).toBe(true);
    expect(p.audit.rows.map((a: Json) => a.action)).toEqual(expect.arrayContaining(['MANUAL_ISOLATION_REQUESTED', 'EVALUATED', 'APPROVAL_PACKET_STAGED', 'REQUEST_APPROVED_FOR_MANUAL_EXECUTION']));
    expect(p.audit.chain).toMatchObject({ intact: true, scope: expect.stringContaining('whole Gate audit log') });
    expect(p.runs.map((r: Json) => r.kind)).toEqual(['EVALUATE', 'STAGE', 'DECIDE', 'DECIDE']);
    expect(p.digest.value).toBe(sha256(canonical(withoutDigest(p))));
    // No claim of a signature, and no secrets.
    expect(res.text).not.toMatch(/"signature"/);
    for (const t of Object.values(h.system.config.tokens)) expect(res.text).not.toContain(t);
  });

  it('exporting twice changes nothing and gives the same bytes', async () => {
    const h = await harness();
    const { requestId } = await approvedRun(h);
    const auditBefore = h.system.store.auditEvents().length;
    const a = await raw(h, requestId);
    const b = await raw(h, requestId);
    expect(a.text).toBe(b.text);
    expect(h.system.store.auditEvents().length).toBe(auditBefore);
  });

  it('a blocked request exports with no write, and a packet that cannot be read makes the package partial', async () => {
    const h = await harness();
    const blocked = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-pkg-2', incidentId: 'INC-90483', machineId: 'device-3be1c771', requestedAction: 'FULL_ISOLATION' });
    const pb = JSON.parse((await raw(h, blocked.body.requestId)).text) as Json;
    expect(blocked.status).toBe(201);
    expect(pb).toMatchObject({ evidenceStatus: 'complete', record: { state: 'INSUFFICIENT_EVIDENCE', approvalId: null } });
    expect(pb.writes.approvalPacket).toBeNull();
    expect(pb.decisions[0]).toMatchObject({ decision: 'INSUFFICIENT_EVIDENCE', reasonCodes: ['CMDB_STALE'] });
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-pkg-3', ...PRIMARY });
    await h.api('POST', `/api/requests/${r.body.requestId}/stage`);
    await h.api('POST', '/api/lab/faults', { system: 'itsm', mode: 'http_500', target: 'reads' });
    const p = JSON.parse((await raw(h, r.body.requestId)).text) as Json;
    expect(p.evidenceStatus).toBe('partial');
    expect(p.statusReasons.join(' ')).toContain('could not be read');
    expect(p.writes.approvalPacket).toBeNull();
    expect(p.writes.approvalPacketReadError).not.toBeNull();
  });

  it('a broken audit chain makes the package unverifiable', async () => {
    const h = await harness();
    const { requestId } = await approvedRun(h);
    h.system.store.db.exec('DROP TRIGGER IF EXISTS audit_events_no_update;');
    h.system.store.db.prepare(`UPDATE audit_events SET actor = 'someone-else' WHERE seq = 1`).run();
    const p = JSON.parse((await raw(h, requestId)).text) as Json;
    expect(p.evidenceStatus).toBe('unverifiable');
    expect(p.audit.chain).toMatchObject({ intact: false, brokenAt: 1 });
  });

  it('SOC roles and a named approver may export; another service owner and an anonymous caller may not', async () => {
    const h = await harness();
    const { requestId } = await approvedRun(h);
    expect((await raw(h, requestId, 'soc-incident-commander')).status).toBe(200);
    expect((await raw(h, requestId, 'owner-sap-ewm')).status).toBe(200);
    const other = await raw(h, requestId, 'owner-payments');
    expect(other.status).toBe(403);
    expect(JSON.parse(other.text).error.code).toBe('EXPORT_NOT_PERMITTED');
    expect((await raw(h, requestId, '')).status).toBe(401);
    expect((await raw(h, 'REQ-NOPE', 'analyst-priya')).status).toBe(404);
  });

  it('outside SIMULATED mode without configuration the export fails closed', async () => {
    const h = await harness({ integrationMode: 'SANDBOX' });
    const res = await raw(h, 'REQ-ANY');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text).error.code).toBe('SETUP_REQUIRED');
  });
});

describe('an evaluation written before policy capture', () => {
  it('is flagged as not recorded, never filled in from current settings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-pkg-legacy-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'gate.db'));
    db.exec(fs.readFileSync(path.resolve('tests/fixtures/legacy-gate-v0.sql'), 'utf8'));
    db.prepare("INSERT INTO response_requests (request_id, event_id, incident_id, machine_id, requested_action, requested_by, state, created_at, updated_at) VALUES ('REQ-LEGACY02','evt-legacy2','INC-90482','device-d8f92a10','FULL_ISOLATION','analyst-priya','RESPONSE_READY','2026-10-18T06:14:00Z','2026-10-18T06:14:00Z')").run();
    db.prepare(
      `INSERT INTO evaluations (evaluation_id, request_id, incident_revision, decision, reason_codes, summary, policy_input, evidence_hashes, approver_ids, ci_id, idempotency_key, machine_action_count, created_at, valid_until)
       VALUES ('EVAL-LEGACY02','REQ-LEGACY02',12,'REQUIRE_DUAL_APPROVAL','["CMDB_TIER_0"]','{}','{}','{}','["soc-incident-commander","owner-sap-ewm"]','CI-009481',NULL,0,'2026-10-18T06:14:00Z','2026-10-18T06:19:00Z')`,
    ).run();
    db.close();
    const h = await harness({ dataDir: dir });
    const p = JSON.parse((await raw(h, 'REQ-LEGACY02')).text) as Json;
    expect(p.evidenceStatus).toBe('partial');
    expect(p.decisions[0].policy).toEqual({ recorded: false, version: null, config: null, note: 'Not recorded at decision time. Not reconstructed from current settings.' });
  });
});
