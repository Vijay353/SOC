/**
 * CH-20: the visitor passcode gate, checked at the server: pages, assets and the API need a signed session cookie;
 * wrong guesses are rate limited with a generic message; sessions expire; logout ends them.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { accessProblems, COOKIE, createAccessGate, type AccessConfig } from '../../server/src/access/access-gate';
import { loadConfig } from '../../server/src/config';
import { productionProblems } from '../../server/src/ops/production';
import { startHarness, type Harness } from '../helpers';

const PIN = '4826';
const SECRET = 's'.repeat(40);
const ON: AccessConfig = { enabled: true, pin: PIN, secret: SECRET, sessionMinutes: 60, secureCookie: false };
const open: Harness[] = [];
const servers: Array<{ close: () => void }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  while (servers.length) servers.pop()!.close();
});
const gated = async () => {
  const h = await startHarness({ access: ON });
  open.push(h);
  return h;
};
const login = (url: string, pin: unknown) => fetch(`${url}/api/access/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;

describe('access gate on the real app', () => {
  it('without a session: the page is the passcode page, the API and assets are refused, health stays open', async () => {
    const h = await gated();
    const page = await fetch(`${h.url}/approvals`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(401);
    const html = await page.text();
    expect(html).toContain('Enter the four-digit passcode');
    expect(html).not.toContain(PIN);
    expect(html).not.toContain('/assets/');
    const api = await fetch(`${h.url}/api/queue`);
    expect(api.status).toBe(401);
    expect((await api.json()).error.code).toBe('ACCESS_REQUIRED');
    expect((await fetch(`${h.url}/assets/index.js`)).status).toBe(401);
    expect((await fetch(`${h.url}/api/health`)).status).toBe(200);
    expect((await fetch(`${h.url}/api/ready`)).status).toBe(200);
    // Simulator routes keep their own service-token check.
    expect((await fetch(`${h.url}/sim/security/api/incidents`)).status).toBe(401);
  });

  it('the right PIN gives a signed HttpOnly session that opens the API and deep links; logout ends it', async () => {
    const h = await gated();
    const r = await login(h.url, PIN);
    expect(r.status).toBe(200);
    const set = r.headers.get('set-cookie')!;
    expect(set).toMatch(new RegExp(`^${COOKIE}=`));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).not.toContain(PIN);
    const cookie = cookieOf(r);
    const q = await fetch(`${h.url}/api/queue`, { headers: { cookie, 'x-demo-user': 'analyst-priya' } });
    expect(q.status).toBe(200);
    const status = await (await fetch(`${h.url}/api/access/status`, { headers: { cookie } })).json();
    expect(status).toMatchObject({ enabled: true, authenticated: true });
    // The workflow itself is unchanged behind the gate.
    const ev = await fetch(`${h.url}/api/events/manual-isolation-requested`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-demo-user': 'analyst-priya' },
      body: JSON.stringify({ eventId: 'evt-gate-1', incidentId: 'INC-90482', machineId: 'device-d8f92a10', requestedAction: 'FULL_ISOLATION' }),
    });
    expect((await ev.json()).view.evaluation.decision).toBe('REQUIRE_DUAL_APPROVAL');
    const out = await fetch(`${h.url}/api/access/logout`, { method: 'POST', headers: { cookie } });
    expect(out.headers.get('set-cookie')).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('a tampered or forged cookie is refused', async () => {
    const h = await gated();
    const cookie = cookieOf(await login(h.url, PIN));
    const [name, value] = cookie.split('=');
    const [body, mac] = value!.split('.');
    const longer = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 9e9 })).toString('base64url');
    for (const bad of [`${name}=${longer}.${mac}`, `${name}=${body}.AAAA`, `${name}=garbage`]) {
      expect((await fetch(`${h.url}/api/queue`, { headers: { cookie: bad } })).status).toBe(401);
    }
  });

  it('wrong and malformed PINs get one generic message, then growing waits', async () => {
    const h = await gated();
    const bodies = [];
    for (const pin of ['0000', '4825', '48a6']) {
      const r = await login(h.url, pin);
      expect(r.status).toBe(401);
      bodies.push(await r.json());
    }
    expect(new Set(bodies.map((b) => b.error.message))).toEqual(new Set(['That passcode did not work.']));
    expect((await login(h.url, '1111')).status).toBe(401); // 4th failure starts a wait
    const locked = await login(h.url, PIN);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('with the gate off (local default) nothing changes', async () => {
    const h = await startHarness();
    open.push(h);
    expect((await fetch(`${h.url}/api/queue`)).status).toBe(200);
    expect((await (await fetch(`${h.url}/api/session`)).json()).access).toEqual({ enabled: false });
  });
});

describe('session expiry, backoff and configuration', () => {
  async function standalone(now: () => number) {
    const app = express();
    const gate = createAccessGate(ON, 'Test', now);
    app.use(gate.middleware);
    app.use('/api/access', gate.router);
    app.get('/api/data', (_q, r) => r.json({ ok: true }));
    const server = app.listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('an expired session returns to the gate', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const url = await standalone(() => t);
    const cookie = cookieOf(await login(url, PIN));
    expect((await fetch(`${url}/api/data`, { headers: { cookie } })).status).toBe(200);
    t += 61 * 60_000;
    expect((await fetch(`${url}/api/data`, { headers: { cookie } })).status).toBe(401);
  });

  it('waits double after each failure past three and stop at 15 minutes', async () => {
    let t = Date.parse('2026-11-09T12:00:00Z');
    const url = await standalone(() => t);
    const waits: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await login(url, '0000');
      if (r.status === 429) {
        const s = Number(r.headers.get('retry-after'));
        waits.push(s);
        t += s * 1000;
        i--;
      }
    }
    expect(waits.slice(0, 4)).toEqual([2, 4, 8, 16]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(15 * 60);
  });

  it('refuses bad settings, and production never runs without the gate', () => {
    expect(accessProblems({ ...ON, pin: '123' })).toEqual(['ACCESS_PIN must be exactly four digits.']);
    expect(accessProblems({ ...ON, secret: 'short' })[0]).toContain('ACCESS_SESSION_SECRET');
    expect(() => createAccessGate({ ...ON, pin: undefined }, 'x')).toThrow(/misconfigured/);
    const p = productionProblems({ DATA_DIR: '/tmp', ACCESS_GATE: 'off', ACCESS_COOKIE_SECURE: 'false' });
    expect(p.join(' ')).toContain('ACCESS_GATE=off is not allowed in production');
    expect(p.join(' ')).toContain('ACCESS_PIN must be exactly four digits');
    expect(p.join(' ')).toContain('ACCESS_COOKIE_SECURE=false is not allowed');
    expect(loadConfig({ NODE_ENV: 'production' }).access).toMatchObject({ enabled: true, secureCookie: true });
    expect(loadConfig({}).access).toMatchObject({ enabled: false, secureCookie: false });
  });
});
