/** CH-L1: people see words, not codes, and UI text has no em dashes. Seed data keeps its own format. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REASON_TEXT } from '../../server/src/gate/policy';
import { codeWords, personLabel, personName } from '../../app/src/ui';

const EM = '\u2014';
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('labels', () => {
  it('shows a seeded person as "Name (role)"', () => {
    expect(personLabel(`Priya Natarajan ${EM} SOC analyst`)).toBe('Priya Natarajan (SOC analyst)');
    expect(personName(`Maya Okafor ${EM} SAP EWM service owner`)).toBe('Maya Okafor');
    expect(personLabel('Imported Person')).toBe('Imported Person');
  });
  it('turns a code into words', () => {
    expect(codeWords('MERGE_UPDATE')).toBe('Merge update');
    expect(codeWords('COMMITTED')).toBe('Committed');
  });
  it('the browser app source contains no em dash', () => {
    const hits = files(path.resolve('app/src')).filter((f) => fs.readFileSync(f, 'utf8').includes(EM));
    expect(hits).toEqual([]);
  });
  it('reason texts shown to people contain no em dash', () => {
    expect(Object.values(REASON_TEXT).filter((t) => t.includes(EM))).toEqual([]);
  });
});
