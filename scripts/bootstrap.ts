/**
 * CH-22: one-time, idempotent first-install step. Seeds only simulator stores that are empty. It never resets,
 * never deletes, and never touches gate.db rows, so running it again is safe.
 * Usage: DATA_DIR=/data node dist-server/scripts/bootstrap.mjs   (or: npm run bootstrap)
 */
import { createSystem } from '../server/src/system';

const system = createSystem({ seedOnEmpty: true });
const s = system.securityRepo.snapshot();
const i = system.itsmRepo.snapshot();
console.info(`[bootstrap] ${system.config.dataDir}: ${s.incidents.length} incidents, ${i.users.length} users, ${system.store.auditEvents().length} recent Gate audit rows kept as they were.`);
system.close();
