/**
 * Deterministic serialization and hashing shared by the Gate and the simulators.
 * Moved here from the ITSM simulator (CH-1) so that ports and adapters do not depend on a simulator module.
 * The implementation is unchanged, so every existing hash stays byte-identical.
 */
import crypto from 'node:crypto';

type Row = Record<string, unknown>;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** Deterministic JSON: object keys sorted recursively. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Row)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
