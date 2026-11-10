/**
 * Minimal synchronous SQLite wrapper over Node's built-in `node:sqlite` (Node ≥ 22.13).
 * Chosen over native addons so `npm install` needs no compiler or Node headers.
 * Provides the small API surface this project uses: exec, prepare().run/get/all, transaction(), pragma.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';

// node:sqlite prints an ExperimentalWarning on load; silence only that specific warning.
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg?.includes('SQLite is an experimental feature')) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
process.emitWarning = originalEmit;

type Param = string | number | bigint | null | Uint8Array;
const toParam = (v: unknown): Param => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

export class Statement {
  private named: Set<string>;
  constructor(
    private stmt: StatementSync,
    sql: string,
  ) {
    this.named = new Set([...sql.matchAll(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
  }
  private bind(args: unknown[]): Param[] | [Record<string, Param>] {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array)) {
      // Like better-sqlite3: ignore extra keys, bind only the named parameters present in the SQL.
      const src = args[0] as Record<string, unknown>;
      const out: Record<string, Param> = {};
      for (const k of this.named) out[k] = toParam(src[k]);
      return [out];
    }
    return args.map(toParam);
  }
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt.run(...(this.bind(args) as Param[]));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }
  get(...args: unknown[]): unknown {
    return this.stmt.get(...(this.bind(args) as Param[]));
  }
  all(...args: unknown[]): unknown[] {
    return this.stmt.all(...(this.bind(args) as Param[]));
  }
}

export class Db {
  private db: DatabaseSyncType;
  private depth = 0;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql), sql);
  }
  pragma(p: string): void {
    this.db.exec(`PRAGMA ${p}`);
  }
  get inTransaction(): boolean {
    return this.db.isTransaction;
  }
  /** Returns a function that runs `fn` atomically; nests via SAVEPOINTs (better-sqlite3 semantics). */
  transaction<T>(fn: () => T): () => T {
    return () => {
      const nested = this.db.isTransaction;
      const sp = `sp_${++this.depth}`;
      this.db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
      try {
        const result = fn();
        this.db.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
        return result;
      } catch (e) {
        if (this.db.isTransaction) this.db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
        throw e;
      } finally {
        this.depth--;
      }
    };
  }
  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
