/**
 * CH-2: cross-boundary responses are validated, never cast.
 * A malformed simulator body becomes a typed INVALID_RESPONSE failure. It is not turned into zero, empty
 * or default data, it is not retried, and the Gate fails closed when it happens during an evaluation.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UpstreamError, type CallRecord } from '../../server/src/gate/adapters/http-client';
import { SimulatedItsmAdapter, SimulatedSecurityAdapter } from '../../server/src/gate/adapters/simulated';
import { DeterministicConstraintExtractor } from '../../server/src/gate/extractor/extractor';
import { GateOrchestrator } from '../../server/src/gate/orchestrator';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

/** Per-path overrides. Anything not overridden is forwarded unchanged to the live simulator. */
let overrides: Record<string, unknown> = {};
let h: Harness;
let proxy: http.Server;
let proxyUrl = '';
const opts = { timeoutMs: 1000, maxAttempts: 3, baseDelayMs: 1 };

beforeAll(async () => {
  h = await startHarness();
  proxy = http.createServer(async (req, res) => {
    const pathOnly = (req.url ?? '').split('?')[0]!;
    if (pathOnly in overrides) {
      const body = overrides[pathOnly];
      res.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const up = await fetch(`${h.url}${req.url}`, {
      method: req.method,
      headers: { authorization: String(req.headers.authorization ?? ''), 'content-type': 'application/json' },
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(up.status, { 'content-type': 'application/json' }).end(await up.text());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterEach(() => {
  overrides = {};
});
afterAll(async () => {
  await new Promise<void>((r) => proxy.close(() => r()));
  await h.close();
});

const security = () => new SimulatedSecurityAdapter(() => `${proxyUrl}/sim/security`, h.system.config.tokens.gateSecurity, opts);
const itsm = () => new SimulatedItsmAdapter(() => `${proxyUrl}/sim/itsm`, h.system.config.tokens.gateItsm, opts);

async function expectInvalid(p: Promise<unknown>) {
  const e = (await p.catch((x) => x)) as UpstreamError;
  expect(e).toBeInstanceOf(UpstreamError);
  expect(e.kind).toBe('INVALID_RESPONSE');
  expect(e.code).toBe('INVALID_RESPONSE');
  expect(e.retryable).toBe(false);
}

describe('adapters reject malformed bodies', () => {
  it('a device with missing fields is rejected, and the call is made once (no retry)', async () => {
    overrides['/sim/security/api/devices/device-d8f92a10'] = { machineId: 'device-d8f92a10' };
    let rec: CallRecord | null = null;
    const e = (await security()
      .getDevice('device-d8f92a10', (r) => (rec = r))
      .catch((x) => x)) as UpstreamError;
    expect(e.kind).toBe('INVALID_RESPONSE');
    expect(rec!.attempts).toHaveLength(1);
    expect(rec!.attempts[0]).toMatchObject({ status: 200, outcome: 'INVALID_RESPONSE', errorCode: 'INVALID_RESPONSE' });
    expect(rec!.ok).toBe(false);
    expect((e.details as { issues: string[] }).issues.join(' ')).toMatch(/computerDnsName/);
  });

  it('a session count sent as text is not coerced to a number', async () => {
    overrides['/sim/security/api/devices/device-d8f92a10/activity-summary'] = { machineId: 'device-d8f92a10', activeSessionCount: '1420', distinctRemoteHosts: 212, observedAt: '2026-10-18T06:12:00Z' };
    await expectInvalid(security().getActivitySummary('device-d8f92a10'));
  });

  it('an unknown role value is rejected (real enums are kept)', async () => {
    overrides['/sim/itsm/api/users'] = { value: [{ userId: 'x', displayName: 'X', role: 'ADMIN', onCall: true, active: true }] };
    await expectInvalid(itsm().listUsers({}));
  });

  it('a non-JSON success body is rejected', async () => {
    overrides['/sim/security/api/incidents'] = '<html>ok</html>';
    await expectInvalid(security().listIncidents());
  });

  it('an approval packet with a status the contract does not know is rejected', async () => {
    overrides['/sim/itsm/api/approval-packets/CAP-2026-1042'] = {
      approvalId: 'CAP-2026-1042',
      status: 'AUTO_APPROVED',
    };
    await expectInvalid(itsm().getApprovalPacket('CAP-2026-1042'));
  });

  it('well-formed bodies still pass through unchanged', async () => {
    const d = await security().getDevice('device-d8f92a10');
    expect(d).toEqual(h.system.securityRepo.getDevice('device-d8f92a10'));
  });
});

describe('the Gate fails closed on a malformed source', () => {
  it('a malformed live-activity summary makes the security source unavailable, so no packet can be staged', async () => {
    overrides['/sim/security/api/devices/device-d8f92a10/activity-summary'] = { activeSessionCount: -5 };
    const gate = new GateOrchestrator({ store: h.system.store, security: security(), itsm: itsm(), extractor: new DeterministicConstraintExtractor(), clock: h.system.clock });
    const r = await gate.submitEvent({ eventId: 'evt-malformed-activity', ...PRIMARY }, 'analyst-priya');
    const view: Json = await gate.view(r.requestId);
    expect(view.evaluation.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(view.evaluation.reasonCodes).toContain('SOURCE_UNAVAILABLE_MOCK_SECURITY');
    const step = view.runs[0].trace.find((s: Json) => s.step === 'snapshot.liveActivity');
    expect(step.status).toBe('failed');
    expect(step.summary.kind).toBe('INVALID_RESPONSE');
    await expect(gate.stage(r.requestId, 'analyst-priya')).rejects.toMatchObject({ code: 'NOT_STAGEABLE' });
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
  });
});
