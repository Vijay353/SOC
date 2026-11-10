/**
 * CH-16: each evaluation records the policy that produced it; staging re-checks it; old databases migrate.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../simulators/shared/infra';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

const LEGACY_SQL = fs.readFileSync(path.resolve('tests/fixtures/legacy-gate-v0.sql'), 'utf8');
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

describe('policy version is recorded and re-checked', () => {
  it('a new evaluation stores the version and thresholds; the view shows honest provenance', async () => {
    const h = await harness();
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-prov-1', ...PRIMARY });
    expect(r.body.view.evaluation.policyVersion).toBe('CAP-1.1');
    expect(r.body.view.evaluation.policyConfig).toMatchObject({ cmdbMaxAgeMinutes: 60, approvalExpiryMinutes: 15, duplicateWindowHours: 24 });
    expect(r.body.view.policyProvenance).toMatchObject({ updatedAt: null, updatedBy: null });
    expect(r.body.view.policyProvenance.rules.map((x: Json) => x.id)).toEqual(['R1', 'R2', 'R3', 'R4a', 'R4']);
  });

  it('staging refuses evidence judged by a different policy version, then works after re-evaluation', async () => {
    const h = await harness();
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-prov-2', ...PRIMARY });
    h.system.store.db.prepare("UPDATE evaluations SET policy_version = 'CAP-1.0' WHERE request_id = ?").run(r.body.requestId);
    const st = await h.api<Json>('POST', `/api/requests/${r.body.requestId}/stage`);
    expect(st.status).toBe(409);
    expect(st.body.error.code).toBe('POLICY_CHANGED');
    expect(st.body.view.request.state).toBe('REEVALUATION_REQUIRED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
    await h.api('POST', `/api/requests/${r.body.requestId}/evaluate`);
    expect((await h.api<Json>('POST', `/api/requests/${r.body.requestId}/stage`)).status).toBe(200);
  });
});

describe('migration from a database created before V3', () => {
  function legacyDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-legacy-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'gate.db'));
    db.exec(LEGACY_SQL);
    db.prepare("INSERT INTO response_requests (request_id, event_id, incident_id, machine_id, requested_action, requested_by, state, created_at, updated_at) VALUES ('REQ-LEGACY01','evt-legacy','INC-90482','device-d8f92a10','FULL_ISOLATION','analyst-priya','RESPONSE_READY','2026-10-18T06:14:00Z','2026-10-18T06:14:00Z')").run();
    db.prepare(
      `INSERT INTO evaluations (evaluation_id, request_id, incident_revision, decision, reason_codes, summary, policy_input, evidence_hashes, approver_ids, ci_id, idempotency_key, machine_action_count, created_at, valid_until)
       VALUES ('EVAL-LEGACY01','REQ-LEGACY01',12,'REQUIRE_DUAL_APPROVAL','["CMDB_TIER_0"]','{}','{}','{"incident":"${'a'.repeat(64)}"}','["soc-incident-commander","owner-sap-ewm"]','CI-009481','${'b'.repeat(64)}',0,'2026-10-18T06:14:00Z','2026-10-18T06:19:00Z')`,
    ).run();
    db.close();
    return dir;
  }

  it('adds the new columns, keeps old rows as they were, and treats their policy as not recorded', async () => {
    const dir = legacyDir();
    const h = await harness({ dataDir: dir });
    const cols = (h.system.store.db.prepare('PRAGMA table_info(evaluations)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['policy_version', 'policy_config', 'stage_input']));
    const view = await h.api<Json>('GET', '/api/requests/REQ-LEGACY01');
    expect(view.body.evaluation).toMatchObject({ evaluationId: 'EVAL-LEGACY01', policyVersion: null, policyConfig: null, reasonCodes: ['CMDB_TIER_0'] });
    // A legacy evaluation cannot be staged: its policy is unknown.
    const st = await h.api<Json>('POST', '/api/requests/REQ-LEGACY01/stage');
    expect(st.body.error.code).toBe('POLICY_CHANGED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
  });

  it('the migration is safe to run again on restart', async () => {
    const dir = legacyDir();
    const a = await harness({ dataDir: dir });
    await a.close();
    open.pop();
    const b = await harness({ dataDir: dir });
    const cols = (b.system.store.db.prepare('PRAGMA table_info(evaluations)').all() as Array<{ name: string }>).filter((c) => c.name === 'policy_version');
    expect(cols).toHaveLength(1);
    expect((await b.api<Json>('GET', '/api/requests/REQ-LEGACY01')).body.evaluation.evaluationId).toBe('EVAL-LEGACY01');
  });
});
