/**
 * G2–G4: scenario coverage, duplicate protection, concurrency, faults, partial failure, recovery,
 * approvals, separation of duties, expiry, reset/replay and integration-mode fail-closed behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCENARIOS } from '../../fixtures/seed';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

let n = 0;
const submit = (body: Record<string, unknown> = PRIMARY, actor = 'analyst-priya') => h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: `evt-test-${++n}`, ...body }, actor);
const fault = (system: 'security' | 'itsm', mode: string, target = 'all', remaining = -1, latencyMs = 0) => h.api('POST', '/api/lab/faults', { system, mode, target, remaining, latencyMs });
const stepOf = (view: Json, kind: string, step: string) => [...view.runs].reverse().find((r: Json) => r.kind === kind)?.trace.find((s: Json) => s.step === step);

describe('seeded scenarios produce their documented decisions', () => {
  for (const s of SCENARIOS) {
    it(`${s.label} → ${s.expected}`, async () => {
      const r = await submit({ incidentId: s.incidentId, machineId: s.machineId, requestedAction: 'FULL_ISOLATION' });
      expect(r.status).toBe(201);
      expect(r.body.view.evaluation.decision).toBe(s.expected);
    });
  }

  it('criticality conflict + prompt injection: stricter path wins and injected text is ignored', async () => {
    const r = await submit({ incidentId: 'INC-90486', machineId: 'device-a7d3e915', requestedAction: 'FULL_ISOLATION' });
    const ev = r.body.view.evaluation;
    expect(ev.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(ev.reasonCodes).toContain('CRITICALITY_CONFLICT');
    expect(ev.summary.threat.untrustedTelemetryIgnored).toBe(1);
    expect(ev.summary.business.extraction.untrustedInstructions).toHaveLength(1);
    expect(ev.summary.business.constraints.every((c: Json) => !/ignore previous/i.test(c.quote))).toBe(true);
    expect(ev.policyInput.cmdbCriticality).toBe('TIER_1'); // not the TIER_3 the injected text demanded
  });

  it('ambiguous identity names both candidate CIs', async () => {
    const r = await submit({ incidentId: 'INC-90485', machineId: 'device-5c0e44d2', requestedAction: 'FULL_ISOLATION' });
    expect(r.body.view.evaluation.reasonCodes).toEqual(['IDENTITY_AMBIGUOUS']);
    expect(r.body.view.evaluation.summary.business.identity.candidates.map((c: Json) => c.ciId)).toEqual(['CI-011902', 'CI-011977']);
  });
});

describe('duplicate protection and concurrency', () => {
  it('same eventId delivered twice returns the original request', async () => {
    const a = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-dup', ...PRIMARY });
    const b = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-dup', ...PRIMARY });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ requestId: a.body.requestId, duplicate: true, reason: 'SAME_EVENT_ID' });
    expect(h.system.store.listRequests()).toHaveLength(1);
  });

  it('a second event for an open target is folded into the open request', async () => {
    const a = await submit();
    const b = await submit();
    expect(b.body).toMatchObject({ requestId: a.body.requestId, duplicate: true, reason: 'OPEN_REQUEST_EXISTS' });
  });

  it('repeated and concurrent stage calls create exactly one packet and one notification per approver', async () => {
    const { requestId } = (await submit()).body;
    const [x, y] = await Promise.all([h.api<Json>('POST', `/api/requests/${requestId}/stage`), h.api<Json>('POST', `/api/requests/${requestId}/stage`)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    const again = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(again.body.result.alreadyStaged).toBe(true);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);
    expect(h.system.itsmRepo.notifications()).toHaveLength(2);
  });

  it('stale incident revision fails closed, then re-evaluation stages against the new revision', async () => {
    const { requestId } = (await submit()).body;
    const upd = await h.api<Json>('POST', '/api/lab/incidents/INC-90482/concurrent-update');
    expect(upd.body.revision).toBe(13);
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(409);
    expect(st.body.error.code).toBe('STALE_INCIDENT_VERSION');
    expect(st.body.view.request.state).toBe('REEVALUATION_REQUIRED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);

    const re = await h.api<Json>('POST', `/api/requests/${requestId}/evaluate`);
    expect(re.body.request.state).toBe('RESPONSE_READY');
    expect(re.body.evaluation.incidentRevision).toBe(13);
    const ok = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(ok.status).toBe(200);
    expect(h.system.itsmRepo.listPackets()[0]!.expectedIncidentVersion).toBe(13);
  });

  it('simulator rejects a stale If-Match revision with 409', async () => {
    const res = await fetch(`${h.url}/sim/security/api/incidents/INC-90482`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${h.system.config.tokens.simAdmin}`, 'content-type': 'application/json', 'if-match': '"r11"' },
      body: JSON.stringify({ status: 'inProgress' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('REVISION_CONFLICT');
  });

  it('an evaluation older than the staging window must be refreshed', async () => {
    const { requestId } = (await submit()).body;
    await h.api('POST', '/api/lab/clock', { advanceMinutes: 6 });
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(409);
    expect(st.body.error.code).toBe('EVALUATION_EXPIRED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
  });
});

describe('faults, partial failure and recovery', () => {
  it('ITSM outage during evaluation fails closed after bounded retries, and recovers after the fault clears', async () => {
    await fault('itsm', 'http_503', 'reads');
    const r = await submit();
    expect(r.body.view.evaluation.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.body.view.evaluation.reasonCodes).toContain('SOURCE_UNAVAILABLE_MOCK_ITSM');
    const lookup = stepOf(r.body.view, 'EVALUATE', 'identity.lookupConfigItems');
    expect(lookup.status).toBe('failed');
    expect(lookup.calls[0].attempts.map((a: Json) => a.status)).toEqual([503, 503, 503]);
    await fault('itsm', 'none');
    const re = await h.api<Json>('POST', `/api/requests/${r.body.requestId}/evaluate`);
    expect(re.body.evaluation.decision).toBe('REQUIRE_DUAL_APPROVAL');
  });

  it('security token rejected (401) makes the source unavailable rather than guessing', async () => {
    await fault('security', 'http_401');
    const r = await submit();
    expect(r.body.view.evaluation.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.body.view.evaluation.reasonCodes).toContain('SOURCE_UNAVAILABLE_MOCK_SECURITY');
  });

  it('transient 500s on idempotent reads are retried and recovered', async () => {
    await fault('security', 'http_500', 'reads', 2);
    const r = await submit();
    expect(r.body.view.evaluation.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(stepOf(r.body.view, 'EVALUATE', 'snapshot.incident').calls[0].attempts.map((a: Json) => a.status)).toEqual([500, 500, 200]);
  });

  it('a throttled write (429) is retried safely because the tool is idempotency-keyed', async () => {
    const { requestId } = (await submit()).body;
    await fault('itsm', 'http_429', 'writes', 1);
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(200);
    expect(stepOf(st.body.view, 'STAGE', 'tool.stageContainmentApproval').calls[0].attempts.map((a: Json) => a.status)).toEqual([429, 201]);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);
  });

  it('write committed but response lost: the retry returns the existing packet (duplicate=true)', async () => {
    const { requestId } = (await submit()).body;
    await fault('itsm', 'timeout_after_commit', 'writes', 1, 800);
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(200);
    expect(st.body.result.duplicate).toBe(true);
    expect(stepOf(st.body.view, 'STAGE', 'tool.stageContainmentApproval').calls[0].attempts.map((a: Json) => a.outcome)).toEqual(['TIMEOUT', 'OK']);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);
    expect(h.system.itsmRepo.notifications()).toHaveLength(2);
  });

  it('all attempts time out: request stays RESPONSE_READY; a later retry reuses the outbox payload and adopts the committed packet', async () => {
    const { requestId } = (await submit()).body;
    await fault('itsm', 'timeout_after_commit', 'writes', -1, 800);
    const failed = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(failed.status).toBe(503);
    expect(failed.body.view.request.state).toBe('RESPONSE_READY');
    expect(failed.body.view.request.lastError.code).toBe('STAGE_FAILED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1); // the write really landed
    await fault('itsm', 'none');
    const ok = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(ok.status).toBe(200);
    expect(ok.body.result.duplicate).toBe(true);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);
  });

  it('reconciliation: after re-evaluation the same key with a new expiry adopts the orphaned packet instead of duplicating', async () => {
    const { requestId } = (await submit()).body;
    await fault('itsm', 'timeout_after_commit', 'writes', -1, 800);
    await h.api('POST', `/api/requests/${requestId}/stage`);
    await fault('itsm', 'none');
    await h.api('POST', '/api/lab/clock', { advanceMinutes: 6 });
    const expired = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(expired.body.error.code).toBe('EVALUATION_EXPIRED');
    await h.api('POST', `/api/requests/${requestId}/evaluate`);
    const ok = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(ok.status).toBe(200);
    expect(stepOf(ok.body.view, 'STAGE', 'tool.reconcile').status).toBe('ok');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(1);
    expect(ok.body.view.request.state).toBe('WAITING_FOR_DUAL_APPROVAL');
  });

  it('a corrupted read-back is never reported as success', async () => {
    const { requestId } = (await submit()).body;
    await fault('itsm', 'corrupt_readback', 'reads', 1);
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(502);
    expect(st.body.error.code).toBe('READBACK_MISMATCH');
    expect(st.body.view.request.state).toBe('VERIFICATION_FAILED');
    expect(st.body.view.request.lastError.mismatches.map((m: Json) => m.field)).toContain('approverIds');
    expect(h.system.securityRepo.machineActions()).toHaveLength(0);
  });

  it('staging precheck outage changes nothing', async () => {
    const { requestId } = (await submit()).body;
    await fault('security', 'http_503', 'reads');
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(503);
    expect(st.body.error.code).toBe('PRECHECK_FAILED');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
    expect(h.system.store.getRequest(requestId)!.state).toBe('RESPONSE_READY');
  });
});

describe('approvals, separation of duties and expiry', () => {
  const staged = async () => {
    const { requestId } = (await submit()).body;
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    return { requestId, approvalId: st.body.result.approvalId as string };
  };
  const decide = (id: string, actor: string, decision: 'APPROVE' | 'REJECT') => h.api<Json>('POST', `/api/approvals/${id}/decision`, { decision, comment: 'test' }, actor);

  it('two distinct assigned approvers are required; requester and non-approvers are refused', async () => {
    const { requestId, approvalId } = await staged();
    expect((await decide(approvalId, 'analyst-priya', 'APPROVE')).status).toBe(403);
    expect((await decide(approvalId, 'owner-mes', 'APPROVE')).body.error.code).toBe('NOT_AN_APPROVER');
    expect((await decide(approvalId, 'soc-incident-commander', 'APPROVE')).status).toBe(200);
    expect(h.system.itsmRepo.getPacket(approvalId)!.status).toBe('PARTIALLY_APPROVED');
    expect((await decide(approvalId, 'soc-incident-commander', 'APPROVE')).body.error.code).toBe('ALREADY_DECIDED');
    expect((await decide(approvalId, 'owner-sap-ewm', 'APPROVE')).status).toBe(200);
    expect(h.system.itsmRepo.getPacket(approvalId)!.status).toBe('APPROVED');
    expect(h.system.store.getRequest(requestId)!.state).toBe('APPROVED_FOR_MANUAL_EXECUTION');
    expect(h.system.securityRepo.getDevice('device-d8f92a10')!.isolationState).toBe('NOT_ISOLATED'); // approval ≠ execution
  });

  it('one rejection closes the packet', async () => {
    const { requestId, approvalId } = await staged();
    await decide(approvalId, 'owner-sap-ewm', 'REJECT');
    expect(h.system.store.getRequest(requestId)!.state).toBe('REJECTED');
    expect((await decide(approvalId, 'soc-incident-commander', 'APPROVE')).body.error.code).toBe('PACKET_CLOSED');
  });

  it('expiry never approves', async () => {
    const { requestId, approvalId } = await staged();
    await decide(approvalId, 'soc-incident-commander', 'APPROVE');
    await h.api('POST', '/api/lab/clock', { advanceMinutes: 16 });
    const view = await h.api<Json>('GET', `/api/requests/${requestId}`);
    expect(view.body.request.state).toBe('EXPIRED');
    expect(view.body.packet.status).toBe('EXPIRED');
    expect((await decide(approvalId, 'owner-sap-ewm', 'APPROVE')).body.error.code).toBe('PACKET_EXPIRED');
  });

  it('inbox shows only packets assigned to the caller', async () => {
    await staged();
    expect((await h.api<Json>('GET', '/api/approvals', undefined, 'owner-sap-ewm')).body.value).toHaveLength(1);
    expect((await h.api<Json>('GET', '/api/approvals', undefined, 'owner-mes')).body.value).toHaveLength(0);
  });
});

describe('authorization, validation and lifecycle guards', () => {
  it('service owners cannot raise containment requests; missing identity is rejected', async () => {
    expect((await submit(PRIMARY, 'owner-sap-ewm')).body.error.code).toBe('ROLE_NOT_PERMITTED');
    const anon = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'x', ...PRIMARY }, '');
    expect(anon.status).toBe(401);
  });

  it('rejects malformed events and unsupported actions', async () => {
    const r = await submit({ ...PRIMARY, requestedAction: 'SELECTIVE_ISOLATION_WITH_PORTS' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_EVENT');
  });

  it('the simulator rejects malformed tool payloads (schema) and the Gate store rejects invalid transitions', async () => {
    const res = await fetch(`${h.url}/sim/itsm/api/approval-packets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.system.config.tokens.gateItsm}`, 'content-type': 'application/json' },
      body: JSON.stringify({ incidentId: 'INC-90482', command: 'isolate --all' }),
    });
    expect(res.status).toBe(400);
    const { requestId } = (await submit({ incidentId: 'INC-90484', machineId: 'device-91aa02fe', requestedAction: 'FULL_ISOLATION' })).body;
    const req = h.system.store.getRequest(requestId)!;
    expect(() => h.system.store.transition(requestId, req.version, 'WAITING_FOR_DUAL_APPROVAL')).toThrow(/not allowed/);
  });

  it('audit logs are append-only and the hash chain verifies', async () => {
    const { requestId } = (await submit()).body;
    await h.api('POST', `/api/requests/${requestId}/stage`);
    expect(h.system.store.verifyAuditChain()).toMatchObject({ intact: true });
    expect(() => h.system.store.db.prepare("UPDATE audit_events SET actor='mallory'").run()).toThrow(/append-only/);
    expect(() => h.system.itsmRepo.db.prepare("UPDATE audit_log SET principal='mallory'").run()).toThrow(/append-only/);
  });
});

describe('reset and replay', () => {
  it('reset restores the seed and replaying the same event reproduces the same decision', async () => {
    const first = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-replay', ...PRIMARY });
    await h.api('POST', `/api/requests/${first.body.requestId}/stage`);
    await h.api('POST', '/api/lab/clock', { advanceMinutes: 30 });
    await h.api('POST', '/api/lab/reset');
    expect(h.system.store.listRequests()).toHaveLength(0);
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
    expect(h.system.clock.nowIso()).toBe('2026-10-18T06:14:00Z');
    const replay = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-replay', ...PRIMARY });
    expect(replay.status).toBe(201);
    expect(replay.body.view.evaluation.reasonCodes).toEqual(first.body.view.evaluation.reasonCodes);
    expect(replay.body.view.evaluation.evidenceHashes).toEqual(first.body.view.evaluation.evidenceHashes);
  });
});

describe('integration modes fail closed', () => {
  it('SANDBOX without credentials reports setup error, serves no simulated data, and allows an explicit switch back', async () => {
    const s = await startHarness({ integrationMode: 'SANDBOX' });
    try {
      const session = await s.api<Json>('GET', '/api/session');
      expect(session.body.setupError.missing).toEqual(expect.arrayContaining(['MS_TENANT_ID', 'MS_CLIENT_ID']));
      const q = await s.api<Json>('GET', '/api/queue');
      expect(q.status).toBe(503);
      expect(q.body.error.code).toBe('SETUP_REQUIRED');
      const sw = await s.api<Json>('POST', '/api/lab/mode', { mode: 'SIMULATED' });
      expect(sw.body).toMatchObject({ mode: 'SIMULATED', setupError: null });
      expect((await s.api<Json>('GET', '/api/queue')).status).toBe(200);
      expect((await s.api<Json>('POST', '/api/lab/mode', { mode: 'LIVE' })).status).toBe(400);
    } finally {
      await s.close();
    }
  });

  it('SANDBOX with credentials still refuses to fabricate data (adapters are TO_VERIFY placeholders)', async () => {
    const s = await startHarness({
      integrationMode: 'SANDBOX',
      sandbox: { tenantId: 'dummy', clientId: 'dummy', clientSecret: 'dummy', serviceNowInstance: 'dummy', serviceNowUser: 'dummy', serviceNowPassword: 'dummy' },
    });
    try {
      const q = await s.api<Json>('GET', '/api/queue');
      expect(q.status).toBe(503);
      expect(q.body.error.code).toBe('ADAPTER_NOT_VERIFIED');
    } finally {
      await s.close();
    }
  });

  it('LIVE requires an explicit enable flag; the model extractor requires a key', async () => {
    const live = await startHarness({ integrationMode: 'LIVE' });
    const model = await startHarness({ extractorProvider: 'anthropic' });
    try {
      expect((await live.api<Json>('GET', '/api/session')).body.setupError.missing).toContain('ENABLE_LIVE_INTEGRATIONS');
      expect((await model.api<Json>('GET', '/api/session')).body.setupError.message).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      await live.close();
      await model.close();
    }
  });
});

describe('CH-7 impact facts on the inbox are read-only', () => {
  it('the inbox carries the recorded facts and reading it writes nothing to the Gate or ITSM', async () => {
    const { requestId } = (await submit()).body;
    await h.api('POST', `/api/requests/${requestId}/stage`);
    const gateAudit = h.system.store.auditEvents().length;
    const itsmAudit = (h.system.itsmRepo.db.prepare('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n;
    const inbox = await h.api<Json>('GET', '/api/approvals', undefined, 'owner-sap-ewm');
    expect(inbox.body.value[0].impactFacts).toMatchObject({ host: 'PRD-SAP-GW02', activeSessionCount: 1420, activeCriticalDependencies: 18, changeFreeze: { active: true, freezeId: 'FRZ-2210' } });
    expect(h.system.store.auditEvents().length).toBe(gateAudit);
    expect((h.system.itsmRepo.db.prepare('SELECT COUNT(*) n FROM audit_log').get() as { n: number }).n).toBe(itsmAudit);
  });
});

describe('CH-13 session exposes eligible roles from the server', () => {
  it('lists exactly the roles the Gate enforces for request actions', async () => {
    const s = await h.api<Json>('GET', '/api/session');
    expect(s.body.eligibleRoles).toEqual({ requestActions: ['ANALYST', 'INCIDENT_COMMANDER'] });
    // And the server still enforces it regardless of what the UI offers.
    expect((await submit(PRIMARY, 'owner-sap-ewm')).status).toBe(403);
  });
});
