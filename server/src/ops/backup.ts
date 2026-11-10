/**
 * CH-22: consistent SQLite backups with VACUUM INTO (safe while the server is writing in WAL mode), a manifest with
 * checksums and row counts, and a restore check that opens the copy in a throwaway directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../../../packages/contracts/src/canonical';
import { openDatabase, ScenarioClock } from '../../../simulators/shared/infra';
import { GateStore } from '../gate/store';

export const DB_FILES = ['security.db', 'itsm.db', 'gate.db'] as const;

const COUNTS: Record<(typeof DB_FILES)[number], string[]> = {
  'security.db': ['incidents', 'devices', 'alerts'],
  'itsm.db': ['users', 'config_items', 'approval_packets'],
  'gate.db': ['response_requests', 'evaluations', 'audit_events'],
};

export interface BackupManifest {
  createdAt: string;
  files: Array<{ name: string; bytes: number; sha256: string; rows: Record<string, number> }>;
  gateAuditChain: { intact: boolean; length: number; toSeq: number | null };
}

function counts(file: string, tables: string[]): Record<string, number> {
  const db = openDatabase(file);
  try {
    const out: Record<string, number> = {};
    for (const t of tables) {
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      out[t] = exists ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n) : -1;
    }
    return out;
  } finally {
    db.close();
  }
}

function chainOf(dir: string) {
  const db = openDatabase(path.join(dir, 'gate.db'));
  try {
    const v = new GateStore(db, new ScenarioClock('2026-10-18T06:14:00Z', 'frozen')).verifyAuditChain();
    return { intact: v.intact, length: v.length, toSeq: v.toSeq };
  } finally {
    db.close();
  }
}

/** Writes <outRoot>/<stamp>/ with one consistent copy per database and a manifest. Never touches the live files. */
export function backupAll(dataDir: string, outRoot: string, stamp = new Date().toISOString().replace(/[:.]/g, '-')): { dir: string; manifest: BackupManifest } {
  if (!/^[A-Za-z0-9TZ-]+$/.test(stamp)) throw new Error('Invalid backup stamp');
  const dir = path.join(outRoot, stamp);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: BackupManifest['files'] = [];
  // Row counts and the chain check run on a scratch copy: opening a file changes its header, so the backup stays untouched.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-inspect-'));
  for (const name of DB_FILES) {
    const live = path.join(dataDir, name);
    if (!fs.existsSync(live)) continue;
    const target = path.join(dir, name);
    if (target.includes("'")) throw new Error('Backup path must not contain a quote');
    const db = openDatabase(live);
    try {
      db.exec(`VACUUM INTO '${target}'`);
    } finally {
      db.close();
    }
    fs.chmodSync(target, 0o600);
    const buf = fs.readFileSync(target);
    fs.copyFileSync(target, path.join(scratch, name));
    files.push({ name, bytes: buf.length, sha256: sha256(buf.toString('base64')), rows: counts(path.join(scratch, name), COUNTS[name]) });
  }
  const manifest: BackupManifest = { createdAt: new Date().toISOString(), files, gateAuditChain: chainOf(scratch) };
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { dir, manifest };
}

/** Copies a backup into a fresh temporary directory, opens it, and compares it with its manifest. */
export function verifyBackup(dir: string): { ok: boolean; problems: string[]; restoredTo: string } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-check-'));
  const problems: string[] = [];
  for (const f of manifest.files) {
    const src = path.join(dir, f.name);
    const buf = fs.readFileSync(src);
    if (sha256(buf.toString('base64')) !== f.sha256) problems.push(`${f.name}: checksum differs from the manifest`);
    fs.copyFileSync(src, path.join(tmp, f.name));
    const now = counts(path.join(tmp, f.name), Object.keys(f.rows));
    for (const [t, n] of Object.entries(f.rows)) if (now[t] !== n) problems.push(`${f.name}: ${t} has ${now[t]} rows, manifest says ${n}`);
  }
  const chain = chainOf(tmp);
  if (!chain.intact) problems.push('gate.db: the audit chain does not verify in the restored copy');
  if (chain.length !== manifest.gateAuditChain.length) problems.push(`gate.db: ${chain.length} audit rows restored, manifest says ${manifest.gateAuditChain.length}`);
  return { ok: problems.length === 0, problems, restoredTo: tmp };
}

/** Keeps the newest `keep` backup folders made by backupAll; returns what would be or was removed. */
export function pruneBackups(outRoot: string, keep: number, dryRun: boolean): string[] {
  if (!fs.existsSync(outRoot)) return [];
  const dirs = fs
    .readdirSync(outRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}T[0-9-]+Z$/.test(d.name) && fs.existsSync(path.join(outRoot, d.name, 'manifest.json')))
    .map((d) => d.name)
    .sort();
  const remove = dirs.slice(0, Math.max(0, dirs.length - keep));
  if (!dryRun) for (const d of remove) fs.rmSync(path.join(outRoot, d), { recursive: true, force: true });
  return remove;
}
