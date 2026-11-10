/**
 * CH-20: a four-digit visitor passcode for the hosted portfolio demo. It is a convenience gate, not strong
 * authentication: four digits are only 10,000 combinations. It is separate from the demo identity switch (CH-13),
 * which is not authentication either.
 *
 * - The PIN is checked on the server only and never sent to the browser or logged.
 * - A successful entry sets a short-lived HMAC-signed cookie: HttpOnly, SameSite=Lax, Secure in production.
 * - Every page, asset and /api route needs that cookie, except health, readiness and the /api/access routes.
 *   /sim routes are not covered by the cookie: they need the per-process service tokens instead, and the Gate
 *   calls them from the server itself.
 * - Failed attempts are rate limited per client address with growing waits, plus a global limit.
 */
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { gatePage } from './gate-page';

export interface AccessConfig {
  enabled: boolean;
  pin: string | undefined;
  secret: string | undefined;
  sessionMinutes: number;
  secureCookie: boolean;
}

export const COOKIE = 'big_access';
const FREE_ATTEMPTS = 3;
const MAX_WAIT_MS = 15 * 60_000;
const GLOBAL_WINDOW_MS = 10 * 60_000;
const GLOBAL_MAX_FAILURES = 30;

export function accessProblems(a: AccessConfig): string[] {
  if (!a.enabled) return [];
  const p: string[] = [];
  if (!a.pin || !/^\d{4}$/.test(a.pin)) p.push('ACCESS_PIN must be exactly four digits.');
  if (!a.secret || a.secret.length < 32) p.push('ACCESS_SESSION_SECRET must be at least 32 characters.');
  if (!(a.sessionMinutes >= 5 && a.sessionMinutes <= 24 * 60)) p.push('ACCESS_SESSION_MINUTES must be between 5 and 1440.');
  return p;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const sign = (secret: string, body: string) => crypto.createHmac('sha256', secret).update(body).digest('base64url');
const sameBytes = (a: string, b: string) => {
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function createAccessGate(cfg: AccessConfig, projectName: string, now: () => number = Date.now) {
  const problems = accessProblems(cfg);
  if (problems.length) throw new Error(`Access gate misconfigured: ${problems.join(' ')}`);

  const failures = new Map<string, { count: number; until: number }>();
  let globalFailures: number[] = [];

  const issue = (res: Response) => {
    const exp = now() + cfg.sessionMinutes * 60_000;
    const body = b64(JSON.stringify({ v: 1, exp }));
    const value = `${body}.${sign(cfg.secret!, body)}`;
    res.cookie(COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: cfg.secureCookie, path: '/', maxAge: cfg.sessionMinutes * 60_000 });
    return exp;
  };
  const session = (req: Request): { exp: number } | null => {
    const raw = readCookie(req, COOKIE);
    if (!raw) return null;
    const [body, mac] = raw.split('.');
    if (!body || !mac || !sameBytes(mac, sign(cfg.secret!, body))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { v: number; exp: number };
      return p.v === 1 && typeof p.exp === 'number' && p.exp > now() ? { exp: p.exp } : null;
    } catch {
      return null;
    }
  };

  const router = express.Router();
  router.use(express.json({ limit: '1kb' }));
  router.get('/status', (req, res) => {
    const s = cfg.enabled ? session(req) : null;
    res.set('cache-control', 'no-store').json({ enabled: cfg.enabled, authenticated: !cfg.enabled || !!s, expiresAt: s ? new Date(s.exp).toISOString() : null });
  });
  router.post('/login', (req: Request, res: Response) => {
    res.set('cache-control', 'no-store');
    if (!cfg.enabled) return res.json({ ok: true });
    const t = now();
    globalFailures = globalFailures.filter((x) => t - x < GLOBAL_WINDOW_MS);
    const key = req.ip ?? 'unknown';
    const f = failures.get(key);
    const waitMs = Math.max(f && f.until > t ? f.until - t : 0, globalFailures.length >= GLOBAL_MAX_FAILURES ? GLOBAL_WINDOW_MS - (t - globalFailures[0]!) : 0);
    if (waitMs > 0) {
      const secs = Math.ceil(waitMs / 1000);
      res.set('retry-after', String(secs));
      return res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: `Too many attempts. Try again in ${secs} seconds.`, retryAfterSeconds: secs } });
    }
    const pin = (req.body as { pin?: unknown } | undefined)?.pin;
    if (typeof pin === 'string' && /^\d{4}$/.test(pin) && sameBytes(pin, cfg.pin!)) {
      failures.delete(key);
      const exp = issue(res);
      return res.json({ ok: true, expiresAt: new Date(exp).toISOString() });
    }
    const count = (f?.count ?? 0) + 1;
    const until = count > FREE_ATTEMPTS ? t + Math.min(MAX_WAIT_MS, 1000 * 2 ** (count - FREE_ATTEMPTS)) : 0;
    if (failures.size > 10_000) failures.clear();
    failures.set(key, { count, until });
    globalFailures.push(t);
    // The same message for every wrong or malformed passcode: it never says how close a guess was.
    return res.status(401).json({ error: { code: 'ACCESS_DENIED', message: 'That passcode did not work.' } });
  });
  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: cfg.secureCookie, path: '/' });
    res.set('cache-control', 'no-store').json({ ok: true });
  });

  const OPEN_API = new Set(['/api/health', '/api/ready']);
  const middleware = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.enabled) return next();
    const p = req.path;
    if (p.startsWith('/sim/') || OPEN_API.has(p) || p.startsWith('/api/access/')) return next();
    if (session(req)) return next();
    res.set('cache-control', 'no-store');
    if (p === '/api' || p.startsWith('/api/')) return res.status(401).json({ error: { code: 'ACCESS_REQUIRED', message: 'Enter the passcode to continue.' } });
    if (req.method === 'GET' && !p.startsWith('/assets/') && req.accepts('html')) return res.status(401).type('html').send(gatePage(projectName));
    return res.status(401).type('text/plain').send('Passcode required.');
  };

  return { router, middleware, enabled: cfg.enabled };
}
