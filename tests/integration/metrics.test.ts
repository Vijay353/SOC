/**
 * Product-clarity CH-17: /api/metrics counts persisted rows; nothing is hard-coded. The "executed by the Gate" count
 * is proven to be a real query: an isolation by another principal moves the total but not the Gate's count, and the
 * least-privilege probe (Gate token tries to isolate) is refused and changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIMARY, startHarness, type Harness } from '../helpers';

interface Metrics {
  requestsChecked: number;
  approvalRequestsCreated: number;
  waitingForApproval: number;
  approvedForManualExecution: number;
  blockedOrEscalated: number;
  containmentExecutedByGate: number;
  containmentExecutedByAnyone: number;
  gatePrincipal: string;
  auditChain: { intact: boolean; length: number };
}

describe('GET /api/metrics', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  const metrics = async () => (await h.api<Metrics>('GET', '/api/metrics')).body;

  it('starts at zero on a fresh seed, with an intact (empty or anchored) audit chain', async () => {
    const m = await metrics();
    expect(m).toMatchObject({ requestsChecked: 0, approvalRequestsCreated: 0, waitingForApproval: 0, approvedForManualExecution: 0, blockedOrEscalated: 0, containmentExecutedByGate: 0, containmentExecutedByAnyone: 0 });
    expect(m.gatePrincipal).toBe('svc-containment-gate');
    expect(m.auditChain.intact).toBe(true);
  });

  it('moves with the real journey: check, stage, two approvals; the Gate still executes nothing', async () => {
    const ev = await h.api<{ requestId: string }>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-metrics-1', ...PRIMARY });
    expect(ev.status).toBe(201);
    const blocked = await h.api('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-metrics-2', incidentId: 'INC-90483', machineId: 'device-3be1c771', requestedAction: 'FULL_ISOLATION' });
    expect(blocked.status).toBe(201);
    let m = await metrics();
    expect(m).toMatchObject({ requestsChecked: 2, approvalRequestsCreated: 0, blockedOrEscalated: 1 });

    expect((await h.api('POST', `/api/requests/${ev.body.requestId}/stage`)).status).toBe(200);
    m = await metrics();
    expect(m).toMatchObject({ approvalRequestsCreated: 1, waitingForApproval: 1 });

    for (const who of ['soc-incident-commander', 'owner-sap-ewm']) {
      expect((await h.api('POST', '/api/approvals/CAP-2026-1042/decision', { decision: 'APPROVE', comment: '' }, who)).status).toBe(200);
    }
    // The packet status reaches the Gate on the next view (pull-only sync), exactly as in the UI.
    await h.api('GET', `/api/requests/${ev.body.requestId}`);
    m = await metrics();
    expect(m).toMatchObject({ waitingForApproval: 0, approvedForManualExecution: 1, containmentExecutedByGate: 0, containmentExecutedByAnyone: 0 });
    expect(m.auditChain.intact).toBe(true);
    expect(m.auditChain.length).toBeGreaterThan(0);
  });

  it('the Gate token cannot isolate, so the probe changes no count', async () => {
    const probe = await h.api<{ status: number }>('POST', '/api/lab/least-privilege-check', { machineId: 'device-d8f92a10' });
    expect(probe.body.status).toBe(403);
    expect((await metrics()).containmentExecutedByGate).toBe(0);
  });

  it('counts are queries, not constants: an isolation by another principal moves the total only', async () => {
    h.system.securityRepo.isolate('device-91aa02fe', 'Full', 'analyst acted in Defender (simulated)', 'analyst-in-defender');
    const m = await metrics();
    expect(m.containmentExecutedByAnyone).toBe(1);
    expect(m.containmentExecutedByGate).toBe(0);
  });
});
