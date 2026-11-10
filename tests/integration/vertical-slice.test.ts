/**
 * G1 — the one complete transaction:
 * ManualIsolationRequested → evidence → REQUIRE_DUAL_APPROVAL → stageContainmentApproval →
 * independent read-back → RESPONSE_READY → WAITING_FOR_DUAL_APPROVAL, with zero endpoint mutations.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

describe('G1 vertical slice — primary scenario', () => {
  it('evaluates, stages exactly one verified packet, and never touches the device', async () => {
    // 1–3. Trigger + decision
    const ev = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-inc-90482-isolate-01', ...PRIMARY });
    expect(ev.status).toBe(201);
    const { requestId, view } = ev.body;
    expect(view.request.state).toBe('RESPONSE_READY');
    expect(view.evaluation.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(view.evaluation.reasonCodes).toEqual(
      expect.arrayContaining(['CMDB_TIER_0', 'ACTIVE_CRITICAL_DEPENDENCIES', 'CHANGE_FREEZE_ACTIVE', 'RUNBOOK_OWNER_APPROVAL_REQUIRED', 'FULL_ISOLATION_HIGH_IMPACT']),
    );
    expect(view.evaluation.summary.business.liveActivity.activeSessionCount).toBe(1420);
    expect(view.evaluation.summary.business.activeCriticalDependencies).toBe(18); // retired dependency excluded
    expect(view.evaluation.summary.business.configItem.ageMinutes).toBe(17);
    expect(view.evaluation.approverIds).toEqual(['soc-incident-commander', 'owner-sap-ewm']);
    // Evaluation alone mutates nothing upstream.
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);

    // 4–5. The one tool call
    const st = await h.api<Json>('POST', `/api/requests/${requestId}/stage`);
    expect(st.status).toBe(200);
    expect(st.body.result).toMatchObject({ readback: 'VERIFIED', deviceMutationPerformed: false, duplicate: false });
    const approvalId = st.body.result.approvalId;
    expect(approvalId).toBe('CAP-2026-1042');

    // 6–7. Independent read-back directly from the simulator store (not through the Gate).
    const packets = h.system.itsmRepo.listPackets();
    expect(packets).toHaveLength(1);
    const p = packets[0]!;
    expect(p).toMatchObject({
      approvalId,
      incidentId: 'INC-90482',
      expectedIncidentVersion: 12,
      machineId: 'device-d8f92a10',
      ciId: 'CI-009481',
      status: 'WAITING_FOR_DUAL_APPROVAL',
      approverIds: ['soc-incident-commander', 'owner-sap-ewm'],
      policyVersion: 'CAP-1.1', // CH-6 bumped the policy version; the decision and reason codes are unchanged
      requestedBy: 'analyst-priya',
      expiresAt: '2026-10-18T06:29:00Z',
    });
    expect(p.evidenceHashes.length).toBeGreaterThanOrEqual(5);
    expect(h.system.store.getRequest(requestId)!.state).toBe('WAITING_FOR_DUAL_APPROVAL');
    expect(h.system.securityRepo.getDevice('device-d8f92a10')!.isolationState).toBe('NOT_ISOLATED');
    expect(h.system.securityRepo.machineActions()).toHaveLength(0);
    expect(h.system.itsmRepo.notifications()).toHaveLength(2);

    // 8. Trace is derived from real execution: the tool call carries HTTP attempt records.
    const runs = st.body.view.runs as Json[];
    const stageRun = runs.find((r) => r.kind === 'STAGE');
    const toolStep = stageRun.trace.find((s: Json) => s.step === 'tool.stageContainmentApproval');
    expect(toolStep.calls[0]).toMatchObject({ system: 'mock-itsm', method: 'POST', path: '/api/approval-packets', finalStatus: 201, ok: true });
    expect(stageRun.trace.find((s: Json) => s.step === 'verify.result').summary).toEqual({ readback: 'VERIFIED', deviceMutationPerformed: false });
    expect(h.system.store.verifyAuditChain().intact).toBe(true);
  });

  it('negative path: a stale CMDB record yields INSUFFICIENT_EVIDENCE and no packet', async () => {
    const ev = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-mes-1', incidentId: 'INC-90483', machineId: 'device-3be1c771', requestedAction: 'FULL_ISOLATION' });
    expect(ev.status).toBe(201);
    expect(ev.body.view.request.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(ev.body.view.evaluation.reasonCodes).toContain('CMDB_STALE');
    const st = await h.api<Json>('POST', `/api/requests/${ev.body.requestId}/stage`);
    expect(st.status).toBe(409);
    expect(st.body.error.code).toBe('NOT_STAGEABLE');
    expect(h.system.itsmRepo.listPackets()).toHaveLength(0);
  });

  it('the Gate token is structurally unable to isolate a device (least privilege)', async () => {
    const r = await h.api<Json>('POST', '/api/lab/least-privilege-check', { machineId: 'device-d8f92a10' });
    expect(r.body.status).toBe(403);
    expect(r.body.body.error.code).toBe('FORBIDDEN');
    expect(h.system.securityRepo.getDevice('device-d8f92a10')!.isolationState).toBe('NOT_ISOLATED');
  });
});
