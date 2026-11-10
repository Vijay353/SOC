/**
 * Shared infrastructure for the behavioural simulators: scenario clock, token auth with scopes,
 * configurable fault injection and an append-only audit table. Each simulator owns its own SQLite file.
 */
import { Db } from './sqlite';
import type { NextFunction, Request, Response, RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * SYNTHETIC scenario clock shared by every in-process component so demo timestamps are coherent.
 * - frozen: time only moves when advance() is called (used by tests for determinism)
 * - ticking: scenario start + real elapsed time + manual advances (used by the demo app)
 * Production components would use wall-clock time instead.
 */
export class ScenarioClock {
  private baseMs: number;
  private realAnchor: number;
  private offsetMs = 0;
  constructor(
    private startIso: string,
    private mode: 'frozen' | 'ticking',
  ) {
    this.baseMs = Date.parse(startIso);
    this.realAnchor = Date.now();
  }
  nowMs(): number {
    const elapsed = this.mode === 'ticking' ? Date.now() - this.realAnchor : 0;
    return this.baseMs + elapsed + this.offsetMs;
  }
  nowIso(): string {
    return new Date(this.nowMs()).toISOString().replace('.000Z', 'Z');
  }
  advance(minutes: number): void {
    this.offsetMs += Math.round(minutes * 60_000);
  }
  reset(): void {
    this.baseMs = Date.parse(this.startIso);
    this.realAnchor = Date.now();
    this.offsetMs = 0;
  }
  describe() {
    return { now: this.nowIso(), mode: this.mode, scenarioStart: this.startIso, manualOffsetMinutes: this.offsetMs / 60_000 };
  }
  /** CH-22: the scenario time at a real moment, so a restarted process can continue instead of going back to the start. */
  snapshot(): { scenarioMs: number; realMs: number } {
    return { scenarioMs: this.nowMs(), realMs: Date.now() };
  }
  restore(s: { scenarioMs: number; realMs: number }): void {
    this.baseMs = s.scenarioMs;
    this.realAnchor = s.realMs;
    this.offsetMs = 0;
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 2000');
  return db;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SimError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function sendError(res: Response, err: unknown): void {
  if (err instanceof SimError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    return;
  }
  console.error('[simulator] unexpected error', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected simulator error' } });
}

/** Wrap an async/sync handler so thrown SimErrors become structured responses. */
export function handle(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

// ---------------------------------------------------------------------------
// Auth (DEMO service tokens — not production identity)
// ---------------------------------------------------------------------------

export interface TokenGrant {
  principal: string;
  scopes: string[];
}

export function requireScope(tokens: Map<string, TokenGrant>, scope: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const grant = tokens.get(token);
    if (!grant) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Missing or unknown bearer token' } });
      return;
    }
    if (!grant.scopes.includes(scope) && !grant.scopes.includes('*')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: `Token for ${grant.principal} lacks scope ${scope}` } });
      return;
    }
    res.locals.principal = grant.principal;
    next();
  };
}

// ---------------------------------------------------------------------------
// Fault injection
// ---------------------------------------------------------------------------

export const FAULT_MODES = ['none', 'http_401', 'http_429', 'http_500', 'http_503', 'latency', 'timeout_after_commit', 'corrupt_readback'] as const;
export type FaultMode = (typeof FAULT_MODES)[number];

export interface FaultConfig {
  mode: FaultMode;
  /** Which requests are affected. */
  target: 'all' | 'reads' | 'writes';
  /** How many matching requests to affect; -1 means until cleared. */
  remaining: number;
  latencyMs: number;
}

export class FaultInjector {
  private config: FaultConfig = { mode: 'none', target: 'all', remaining: 0, latencyMs: 0 };
  public injectedCount = 0;

  set(cfg: Partial<FaultConfig> & { mode: FaultMode }): FaultConfig {
    this.config = { target: 'all', remaining: -1, latencyMs: 0, ...cfg };
    this.injectedCount = 0;
    return this.config;
  }
  clear(): void {
    this.config = { mode: 'none', target: 'all', remaining: 0, latencyMs: 0 };
  }
  get(): FaultConfig {
    return { ...this.config };
  }

  /** Returns the active fault for this request (and consumes one use) or null. */
  take(isWrite: boolean, modes: readonly FaultMode[]): FaultConfig | null {
    const c = this.config;
    if (c.mode === 'none' || !modes.includes(c.mode)) return null;
    if (c.target === 'reads' && isWrite) return null;
    if (c.target === 'writes' && !isWrite) return null;
    if (c.remaining === 0) return null;
    if (c.remaining > 0) c.remaining -= 1;
    this.injectedCount += 1;
    return { ...c };
  }

  /** Express middleware for faults that happen before the handler runs. */
  middleware(): RequestHandler {
    return async (req, res, next) => {
      if (req.path.startsWith('/_admin')) return next();
      const isWrite = req.method !== 'GET';
      const f = this.take(isWrite, ['http_401', 'http_429', 'http_500', 'http_503', 'latency']);
      if (!f) return next();
      res.setHeader('x-sim-fault', f.mode);
      switch (f.mode) {
        case 'http_401':
          res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Injected fault: token rejected' } });
          return;
        case 'http_429':
          res.setHeader('retry-after', '0');
          res.status(429).json({ error: { code: 'THROTTLED', message: 'Injected fault: too many requests' } });
          return;
        case 'http_500':
          res.status(500).json({ error: { code: 'INTERNAL', message: 'Injected fault: internal error' } });
          return;
        case 'http_503':
          res.status(503).json({ error: { code: 'UNAVAILABLE', message: 'Injected fault: service unavailable' } });
          return;
        case 'latency':
          await sleep(f.latencyMs);
          next();
          return;
        default:
          next();
      }
    };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AUDIT_DDL = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  principal TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
`;

export function writeAudit(
  db: Db,
  clock: ScenarioClock,
  entry: { principal: string; action: string; entity: string; entityId: string; outcome: string; details?: unknown },
): void {
  db.prepare('INSERT INTO audit_log (at, principal, action, entity, entity_id, outcome, details) VALUES (?,?,?,?,?,?,?)').run(
    clock.nowIso(),
    entry.principal,
    entry.action,
    entry.entity,
    entry.entityId,
    entry.outcome,
    JSON.stringify(entry.details ?? {}),
  );
}

export function readAudit(db: Db, limit = 200) {
  return db
    .prepare('SELECT seq, at, principal, action, entity, entity_id as entityId, outcome, details FROM audit_log ORDER BY seq DESC LIMIT ?')
    .all(limit)
    .map((r) => {
      const row = r as Record<string, unknown>;
      return { ...row, details: JSON.parse(String(row.details)) };
    });
}
