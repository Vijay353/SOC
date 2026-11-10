import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpJsonClient, UpstreamError, type CallRecord } from '../../server/src/gate/adapters/http-client';
import { canonical, sha256 } from '../../packages/contracts/src/canonical';

let server: http.Server;
let url = '';
const hits: Record<string, number> = {};
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits[key] = (hits[key] ?? 0) + 1;
    if (req.url === '/flaky' && hits[key]! < 3) return res.writeHead(503).end('{"error":{"code":"UNAVAILABLE"}}');
    if (req.url === '/conflict') return res.writeHead(409).end('{"error":{"code":"REVISION_CONFLICT","message":"stale"}}');
    if (req.url === '/slow') return setTimeout(() => res.writeHead(200).end('{}'), 300);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const anyJson = z.unknown();
const client = () => new HttpJsonClient('test', () => url, 'tok', { timeoutMs: 100, maxAttempts: 3, baseDelayMs: 1, random: () => 0.5 });

describe('HttpJsonClient', () => {
  it('retries idempotent reads on 503 and records every attempt', async () => {
    let rec: CallRecord | null = null;
    const r = await client().request('flaky', 'GET', '/flaky', { schema: anyJson, observer: (x) => (rec = x) });
    expect(r.status).toBe(200);
    expect(rec!.attempts.map((a) => a.status)).toEqual([503, 503, 200]);
  });

  it('does not retry non-idempotent writes unless marked safe', async () => {
    hits['POST /flaky'] = 0;
    await expect(client().request('w', 'POST', '/flaky', { schema: anyJson, body: {} })).rejects.toBeInstanceOf(UpstreamError);
    expect(hits['POST /flaky']).toBe(1);
  });

  it('does not retry 4xx and surfaces the simulator error code', async () => {
    const e = (await client()
      .request('c', 'GET', '/conflict', { schema: anyJson })
      .catch((x) => x)) as UpstreamError;
    expect(e.code).toBe('REVISION_CONFLICT');
    expect(e.retryable).toBe(false);
    expect(hits['GET /conflict']).toBe(1);
  });

  it('times out per attempt', async () => {
    const e = (await client()
      .request('s', 'GET', '/slow', { schema: anyJson })
      .catch((x) => x)) as UpstreamError;
    expect(e.kind).toBe('TIMEOUT');
  });
});

describe('canonical hashing', () => {
  it('is independent of key order', () => {
    expect(sha256(canonical({ b: 1, a: [{ y: 2, x: 1 }] }))).toBe(sha256(canonical({ a: [{ x: 1, y: 2 }], b: 1 })));
  });
});
