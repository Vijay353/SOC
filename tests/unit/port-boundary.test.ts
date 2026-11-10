/**
 * CH-1: the Gate reaches simulator data only through its ports.
 * Gate code may use shared infrastructure (scenario clock, database wrapper), but never a simulator module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const GATE_DIR = path.resolve('server/src/gate');
const ALLOWED = /simulators\/shared\//;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('port boundary', () => {
  it('no Gate file imports a simulator module', () => {
    const offenders: string[] = [];
    for (const f of files(GATE_DIR)) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1]!;
        if (spec.includes('simulators/') && !ALLOWED.test(spec)) offenders.push(`${path.relative('.', f)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard actually inspects files', () => {
    expect(files(GATE_DIR).length).toBeGreaterThan(8);
  });
});
