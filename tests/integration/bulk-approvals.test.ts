/**
 * CH-9: bulk approval is a convenience layer over individually checked decisions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness, type Json } from '../helpers';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

let n = 0;
async function stage(incidentId: string, machineId: string): Promise<{ requestId: string; approvalId: string }> {
  const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: `evt-bulk-${++n}`, incidentId, machineId, requestedAction: 'FULL_ISOLATION' });
  const st = await h.api<Json>('POST', `/api/requests/${r.body.requestId}/stage`);
  expect(st.status).toBe(200);
  return { requestId: r.body.requestId, approvalId: st.body.result.approvalId };
}
/** Three packets assigned to the incident commander: SAP gateway, payments node, and MES (after re-verifying its CMDB record). */
async function threePackets() {
  const a = await stage('INC-90482', 'device-d8f92a10');
  const b = await stage('INC-90486', 'device-a7d3e915');
  h.system.itsmRepo.upsertDataset({ configItems: [{ ...h.system.itsmRepo.getBundle('CI-007120')!.configItem, lastVerifiedAt: '2026-10-18T06:05:00Z' }] });
  const c = await stage('INC-90483', 'device-3be1c771');
  return [a, b, c] as const;
}
const bulk = (items: unknown, actor = 'soc-incident-commander') => h.api<Json>('POST', '/api/approvals/bulk', { items }, actor);

describe('bulk approvals', () => {
  it('two valid, one stale, one unknown: two approved and two explicit failures, nothing rolled back', async () => {
    const [a, b, c] = await threePackets();
    const r = await bulk([
      { approvalId: a.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
      { approvalId: b.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
      { approvalId: c.approvalId, expectedStatus: 'PARTIALLY_APPROVED' },
      { approvalId: 'CAP-2026-9999', expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ requested: 4, approved: 2, failed: 2, partial: true });
    expect(r.body.results.map((x: Json) => [x.approvalId, x.outcome, x.code])).toEqual([
      [a.approvalId, 'APPROVED', null],
      [b.approvalId, 'APPROVED', null],
      [c.approvalId, 'FAILED', 'STALE_STATUS'],
      ['CAP-2026-9999', 'FAILED', 'NOT_FOUND'],
    ]);
    expect(h.system.itsmRepo.getPacket(a.approvalId)!.status).toBe('PARTIALLY_APPROVED');
    expect(h.system.itsmRepo.getPacket(b.approvalId)!.status).toBe('PARTIALLY_APPROVED');
    expect(h.system.itsmRepo.getPacket(c.approvalId)!.decisions).toHaveLength(0);
  });

  it('each approved item gets its own audit entry and trace; there is no shared record', async () => {
    const [a, b] = await threePackets();
    await bulk([
      { approvalId: a.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
      { approvalId: b.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
    ]);
    for (const x of [a, b]) {
      const audit = h.system.store.auditEvents(x.requestId).filter((e) => e.action === 'APPROVER_APPROVE');
      expect(audit).toHaveLength(1);
      expect(h.system.store.runsFor(x.requestId).filter((r) => r.kind === 'DECIDE')).toHaveLength(1);
    }
  });

  it('the second approver can finish a packet in bulk; per-item rules still apply', async () => {
    const [a] = await threePackets();
    await bulk([{ approvalId: a.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' }]);
    const owner = await bulk([{ approvalId: a.approvalId, expectedStatus: 'PARTIALLY_APPROVED' }], 'owner-sap-ewm');
    expect(owner.body.results[0].outcome).toBe('APPROVED');
    expect(h.system.store.getRequest(a.requestId)!.state).toBe('APPROVED_FOR_MANUAL_EXECUTION');
    expect(h.system.securityRepo.getDevice('device-d8f92a10')!.isolationState).toBe('NOT_ISOLATED');
  });

  it('repeating the same submission is safe: already-decided items fail, nothing is recorded twice', async () => {
    const [a] = await threePackets();
    const items = [{ approvalId: a.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' }];
    await bulk(items);
    const again = await bulk([{ approvalId: a.approvalId, expectedStatus: 'PARTIALLY_APPROVED' }]);
    expect(again.body.results[0]).toMatchObject({ outcome: 'FAILED', code: 'ALREADY_DECIDED' });
    expect(h.system.itsmRepo.getPacket(a.approvalId)!.decisions).toHaveLength(1);
  });

  it('someone who is not an assigned approver gets a per-item refusal, not a shared one', async () => {
    const [a, b] = await threePackets();
    const r = await bulk(
      [
        { approvalId: a.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
        { approvalId: b.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
      ],
      'owner-sap-ewm',
    );
    // The SAP owner is an approver on the SAP packet only.
    expect(r.body.results.map((x: Json) => x.code)).toEqual([null, 'NOT_AN_APPROVER']);
  });

  it('a packet flagged as a possible duplicate must be approved on its own', async () => {
    await h.api('POST', '/api/lab/scenarios/possible-duplicate');
    await stage('INC-90482', 'device-d8f92a10');
    const dup = await stage('INC-90488', 'device-d8f92a10');
    const r = await bulk([{ approvalId: dup.approvalId, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' }]);
    expect(r.body.results[0]).toMatchObject({ outcome: 'FAILED', code: 'INDIVIDUAL_REVIEW_REQUIRED' });
    // The individual path still works for the same person.
    const single = await h.api<Json>('POST', `/api/approvals/${dup.approvalId}/decision`, { decision: 'APPROVE', comment: 'reviewed both' }, 'soc-incident-commander');
    expect(single.status).toBe(200);
  });

  it('enforces 1 to 20 unique items and rejects an approver named in the body', async () => {
    expect((await bulk([])).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ approvalId: `CAP-X-${i}`, expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' }));
    expect((await bulk(many)).status).toBe(400);
    const dupIds = [
      { approvalId: 'CAP-1', expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
      { approvalId: 'CAP-1', expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' },
    ];
    expect((await bulk(dupIds)).status).toBe(400);
    const forged = await h.api<Json>('POST', '/api/approvals/bulk', { items: [{ approvalId: 'CAP-1', expectedStatus: 'WAITING_FOR_DUAL_APPROVAL', actorId: 'owner-sap-ewm' }] }, 'analyst-priya');
    expect(forged.status).toBe(400);
    const anon = await h.api<Json>('POST', '/api/approvals/bulk', { items: [{ approvalId: 'CAP-1', expectedStatus: 'WAITING_FOR_DUAL_APPROVAL' }] }, '');
    expect(anon.status).toBe(401);
  });
});
