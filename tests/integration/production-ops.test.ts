/**
 * CH-22: production start-up checks, explicit bootstrap, restart persistence (no reseed, clock continues) and
 * backups that pass a restore check. Every test uses throwaway directories.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupAll, pruneBackups, verifyBackup } from '../../server/src/ops/backup';
import { productionProblems } from '../../server/src/ops/production';
import { createSystem } from '../../server/src/system';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

const dirs: string[] = [];
const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};
const prodHarness = async (dataDir: string) => {
  const h = await startHarness({ dataDir, production: true, seedOnEmpty: false, persistClock: true });
  open.push(h);
  return h;
};
const bootstrap = (dataDir: string) => {
  const s = createSystem({ dataDir, clockMode: 'frozen', seedOnEmpty: true, persistClock: true });
  s.close();
};

describe('production start-up checks', () => {
  it('refuse a missing, relative, non-directory or missing data directory, and accept a writable one', () => {
    const ok = tmp('prod-ok-');
    const file = path.join(ok, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    expect(productionProblems({})[0]).toContain('DATA_DIR is not set');
    expect(productionProblems({ DATA_DIR: 'data/runtime' })[0]).toContain('absolute path');
    expect(productionProblems({ DATA_DIR: file })[0]).toContain('is not a directory');
    expect(productionProblems({ DATA_DIR: path.join(ok, 'missing') })[0]).toContain('missing or not writable');
    const access = { ACCESS_PIN: '4826', ACCESS_SESSION_SECRET: 'x'.repeat(32) };
    expect(productionProblems({ DATA_DIR: ok, HOST: '0.0.0.0', ...access })).toEqual([]);
    expect(fs.readdirSync(ok)).toEqual(['not-a-dir']);
  });
});

describe('bootstrap and restart', () => {
  it('production never seeds on start; bootstrap seeds once and is safe to run again', async () => {
    const dir = tmp('prod-boot-');
    const empty = createSystem({ dataDir: dir, clockMode: 'frozen', seedOnEmpty: false, persistClock: true });
    expect(empty.securityRepo.listIncidents()).toHaveLength(0);
    empty.close();
    bootstrap(dir);
    const h = await prodHarness(dir);
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-boot-1', ...PRIMARY });
    await h.api('POST', `/api/requests/${r.body.requestId}/stage`);
    const audit = h.system.store.auditEvents().length;
    await h.close();
    open.pop();
    bootstrap(dir); // second run: nothing is reset or reseeded
    const again = await prodHarness(dir);
    expect(again.system.store.auditEvents().length).toBe(audit);
    expect(again.system.itsmRepo.listPackets()).toHaveLength(1);
    expect(again.system.securityRepo.listIncidents().length).toBeGreaterThan(0);
  });

  it('after a restart the request, packet, audit chain and scenario clock continue, with no duplicate writes', async () => {
    const dir = tmp('prod-restart-');
    bootstrap(dir);
    const a = await prodHarness(dir);
    const r = await a.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-restart-1', ...PRIMARY });
    await a.api('POST', `/api/requests/${r.body.requestId}/stage`);
    await a.api('POST', '/api/lab/clock', { advanceMinutes: 20 });
    const before = {
      now: a.system.clock.nowMs(),
      audit: a.system.store.auditEvents().length,
      packets: a.system.itsmRepo.listPackets().length,
      state: (await a.api<Json>('GET', `/api/requests/${r.body.requestId}`)).body.request.state,
    };
    expect(before.state).toBe('EXPIRED');
    const auditAfterView = a.system.store.auditEvents().length;
    await a.close();
    open.pop();
    const b = await prodHarness(dir);
    expect(b.system.clock.nowMs()).toBeGreaterThanOrEqual(before.now);
    const view = (await b.api<Json>('GET', `/api/requests/${r.body.requestId}`)).body;
    expect(view.request.state).toBe('EXPIRED');
    expect(b.system.itsmRepo.listPackets()).toHaveLength(before.packets);
    expect(b.system.store.auditEvents().length).toBe(auditAfterView);
    expect(b.system.store.verifyAuditChain().intact).toBe(true);
    expect((await b.api<Json>('GET', '/api/ready')).body).toEqual({ ready: true });
  });

  it('development keeps its old behaviour: seeds on first start and the clock starts at the scenario start', async () => {
    const h = await startHarness();
    open.push(h);
    expect(h.system.config.production).toBe(false);
    expect(h.system.clock.nowIso()).toBe('2026-10-18T06:14:00Z');
    expect(h.system.store.getSetting('scenario_clock')).toBeNull();
  });
});

describe('backups', () => {
  it('a backup taken while the server is running passes the restore check and matches live state', async () => {
    const dir = tmp('prod-bk-data-');
    const out = tmp('prod-bk-out-');
    bootstrap(dir);
    const h = await prodHarness(dir);
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-bk-1', ...PRIMARY });
    await h.api('POST', `/api/requests/${r.body.requestId}/stage`);
    const { dir: bdir, manifest } = backupAll(dir, out, '2026-11-09T00-00-00Z');
    expect(manifest.files.map((f) => f.name)).toEqual(['security.db', 'itsm.db', 'gate.db']);
    expect(manifest.gateAuditChain).toMatchObject({ intact: true, length: h.system.store.auditEvents().length });
    expect(manifest.files.find((f) => f.name === 'itsm.db')!.rows.approval_packets).toBe(1);
    const check = verifyBackup(bdir);
    dirs.push(check.restoredTo);
    expect(check).toMatchObject({ ok: true, problems: [] });
    // A changed backup file is caught.
    fs.appendFileSync(path.join(bdir, 'gate.db'), 'x');
    const bad = verifyBackup(bdir);
    dirs.push(bad.restoredTo);
    expect(bad.ok).toBe(false);
  });

  it('pruning lists old backups first and removes them only when asked', () => {
    const dir = tmp('prod-prune-data-');
    const out = tmp('prod-prune-out-');
    bootstrap(dir);
    for (const s of ['2026-11-01T00-00-00Z', '2026-11-02T00-00-00Z', '2026-11-03T00-00-00Z']) backupAll(dir, out, s);
    fs.mkdirSync(path.join(out, 'keep-me'));
    expect(pruneBackups(out, 2, true)).toEqual(['2026-11-01T00-00-00Z']);
    expect(fs.readdirSync(out).sort()).toHaveLength(4);
    pruneBackups(out, 2, false);
    expect(fs.readdirSync(out).sort()).toEqual(['2026-11-02T00-00-00Z', '2026-11-03T00-00-00Z', 'keep-me']);
  });
});
