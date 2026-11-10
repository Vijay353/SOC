/**
 * CH-22: start-up checks for NODE_ENV=production. Each problem is reported in plain words and the process stops.
 * Local development and tests never run these checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { accessProblems } from '../access/access-gate';

export function productionProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const dir = env.DATA_DIR;
  if (!dir) problems.push('DATA_DIR is not set. Point it at a persistent mounted directory, for example /data.');
  else if (!path.isAbsolute(dir)) problems.push(`DATA_DIR must be an absolute path, got "${dir}".`);
  else {
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) problems.push(`DATA_DIR ${dir} is not a directory.`);
      else {
        const probe = path.join(dir, `.write-check-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
      }
    } catch (e) {
      problems.push(`DATA_DIR ${dir} is missing or not writable (${(e as NodeJS.ErrnoException).code ?? 'error'}). Mount a writable volume there.`);
    }
  }
  if (env.ACCESS_GATE === 'off') problems.push('ACCESS_GATE=off is not allowed in production. The passcode gate is always on there.');
  problems.push(
    ...accessProblems({ enabled: true, pin: env.ACCESS_PIN, secret: env.ACCESS_SESSION_SECRET, sessionMinutes: Number(env.ACCESS_SESSION_MINUTES ?? 120), secureCookie: true }),
  );
  if (env.ACCESS_COOKIE_SECURE === 'false') problems.push('ACCESS_COOKIE_SECURE=false is not allowed in production. Serve the demo over HTTPS.');
  if (env.HOST && env.HOST !== '0.0.0.0' && env.HOST !== '127.0.0.1' && env.HOST !== '::') problems.push(`HOST "${env.HOST}" is unusual for a container; use 0.0.0.0.`);
  return problems;
}

/** The simulators are empty until the one-time bootstrap has run. */
export const BOOTSTRAP_HINT = 'The databases are empty. Run the one-time bootstrap first: node dist-server/scripts/bootstrap.mjs (see docs/DEPLOYMENT.md).';
