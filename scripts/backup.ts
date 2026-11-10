/**
 * CH-22: consistent backup of the three databases, then a restore check of that backup.
 * Usage: DATA_DIR=/data BACKUP_DIR=/backups [BACKUP_KEEP=7] node dist-server/scripts/backup.mjs
 * Old backups beyond BACKUP_KEEP are listed first; they are removed only when BACKUP_PRUNE=yes.
 */
import path from 'node:path';
import { backupAll, pruneBackups, verifyBackup } from '../server/src/ops/backup';

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data/runtime');
const outRoot = process.env.BACKUP_DIR;
if (!outRoot) {
  console.error('[backup] BACKUP_DIR is required (a directory outside DATA_DIR).');
  process.exit(2);
}
const { dir, manifest } = backupAll(dataDir, path.resolve(outRoot));
const check = verifyBackup(dir);
console.info(`[backup] wrote ${dir}: ${manifest.files.map((f) => `${f.name} ${f.bytes} bytes`).join(', ')}; audit chain ${manifest.gateAuditChain.intact ? 'intact' : 'BROKEN'} (${manifest.gateAuditChain.length} rows)`);
console.info(`[backup] restore check: ${check.ok ? 'passed' : `FAILED: ${check.problems.join('; ')}`}`);
const keep = Number(process.env.BACKUP_KEEP ?? 7);
const prune = process.env.BACKUP_PRUNE === 'yes';
const old = pruneBackups(path.resolve(outRoot), keep, !prune);
if (old.length) console.info(`[backup] ${prune ? 'removed' : 'would remove (set BACKUP_PRUNE=yes)'}: ${old.join(', ')}`);
process.exit(check.ok ? 0 : 1);
