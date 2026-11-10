/**
 * CH-17: the Gate audit chain is re-checked in sequence order, with an end-of-chain anchor so that removing the
 * last rows is detected too. Every tamper test runs on a throwaway database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonical } from '../../packages/contracts/src/canonical';
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

/** Writes a few real audit rows through the normal workflow. */
async function withRows(h: Harness) {
  const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-audit-1', ...PRIMARY });
  await h.api('POST', `/api/requests/${r.body.requestId}/stage`);
  const n = h.system.store.auditEvents().length;
  expect(n).toBeGreaterThanOrEqual(3);
  return r.body.requestId as string;
}
const unlock = (h: Harness) => h.system.store.db.exec('DROP TRIGGER IF EXISTS audit_events_no_update; DROP TRIGGER IF EXISTS audit_events_no_delete;');

describe('audit chain verification', () => {
  it('rows written by the workflow verify, and the verify route says what it covers', async () => {
    const h = await harness();
    await withRows(h);
    const v = await h.api<Json>('GET', '/api/audit/verify');
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ intact: true, brokenAt: null, reason: null, fromSeq: 1, genesis: 'GENESIS', unhashedRows: 0 });
    expect(v.body.toSeq).toBe(v.body.length);
    expect(v.body.anchor).toMatchObject({ seq: v.body.toSeq, preexistingRows: 0 });
    expect(v.body.notCovered.join(' ')).toContain('ITSM simulator');
    expect(v.body.limitations).toContain('local tamper evidence only');
  });

  it('a changed middle row fails at that row', async () => {
    const h = await harness();
    await withRows(h);
    unlock(h);
    h.system.store.db.prepare(`UPDATE audit_events SET details = '{"edited":true}' WHERE seq = 2`).run();
    expect(h.system.store.verifyAuditChain()).toMatchObject({ intact: false, brokenAt: 2, reason: 'HASH_MISMATCH' });
  });

  it('a changed row with a recomputed hash still fails at the next row', async () => {
    const h = await harness();
    await withRows(h);
    unlock(h);
    h.system.store.db.prepare(`UPDATE audit_events SET hash = '${'f'.repeat(64)}' WHERE seq = 2`).run();
    const v = h.system.store.verifyAuditChain();
    expect(v.intact).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it('a deleted middle row is detected as a gap', async () => {
    const h = await harness();
    await withRows(h);
    unlock(h);
    h.system.store.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
    expect(h.system.store.verifyAuditChain()).toMatchObject({ intact: false, brokenAt: 3, reason: 'SEQUENCE_GAP' });
  });

  it('a deleted last row is detected only because of the anchor', async () => {
    const h = await harness();
    await withRows(h);
    unlock(h);
    const last = h.system.store.verifyAuditChain().toSeq!;
    h.system.store.db.prepare('DELETE FROM audit_events WHERE seq = ?').run(last);
    expect(h.system.store.verifyAuditChain()).toMatchObject({ intact: false, brokenAt: last, reason: 'END_DOES_NOT_MATCH_ANCHOR' });
  });

  it('a repeated stage request writes no second APPROVAL_PACKET_STAGED row and leaves the chain intact', async () => {
    const h = await harness();
    const id = await withRows(h);
    const staged = () => h.system.store.auditEvents(id).filter((a) => a.action === 'APPROVAL_PACKET_STAGED').length;
    expect(staged()).toBe(1);
    await h.api('POST', `/api/requests/${id}/stage`);
    expect(staged()).toBe(1);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);
    expect(h.system.store.verifyAuditChain().intact).toBe(true);
  });

  it('the chain still verifies after a restart, and reset starts a fresh anchored chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-audit-'));
    dirs.push(dir);
    const a = await harness({ dataDir: dir });
    await withRows(a);
    const len = a.system.store.verifyAuditChain().length;
    await a.close();
    open.pop();
    const b = await harness({ dataDir: dir });
    expect(b.system.store.verifyAuditChain()).toMatchObject({ intact: true, length: len });
    await b.api('POST', '/api/lab/reset');
    const v = b.system.store.verifyAuditChain();
    expect(v.intact).toBe(true);
    expect(v.anchor?.seq).toBe(v.toSeq ?? 0);
  });

  it('canonical JSON does not depend on key order', () => {
    expect(canonical({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(canonical({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  });
});

describe('databases created before the anchor existed', () => {
  it('get an anchor on first open that records how many rows already existed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-legacy-audit-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'gate.db'));
    db.exec(LEGACY_SQL);
    db.close();
    // Write real rows with the current code, then remove the anchor to imitate a pre-V3 file.
    const a = await harness({ dataDir: dir });
    await withRows(a);
    const len = a.system.store.verifyAuditChain().length;
    a.system.store.db.prepare("DELETE FROM gate_settings WHERE key = 'audit_anchor'").run();
    await a.close();
    open.pop();
    const b = await harness({ dataDir: dir });
    const v = b.system.store.verifyAuditChain();
    expect(v).toMatchObject({ intact: true, length: len });
    expect(v.anchor).toMatchObject({ seq: v.toSeq, preexistingRows: len });
  });
});
