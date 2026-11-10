/**
 * CH-6: possible duplicate request (same device, different incident).
 * Uses the opt-in "possible-duplicate" fixture; the base seed is untouched unless the fixture is loaded.
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
const submit = (incidentId: string, machineId: string, actor = 'analyst-priya') =>
  h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: `evt-dup-${++n}`, incidentId, machineId, requestedAction: 'FULL_ISOLATION' }, actor);
const loadFixture = () => h.api<Json>('POST', '/api/lab/scenarios/possible-duplicate');
const SAP_SECOND = { incidentId: 'INC-90488', machineId: PRIMARY.machineId };
const WKS_FIRST = { incidentId: 'INC-90484', machineId: 'device-91aa02fe' };
const WKS_SECOND = { incidentId: 'INC-90489', machineId: 'device-91aa02fe' };

describe('base fixture is unchanged', () => {
  it('without the opt-in fixture there are six incidents and no duplicate flags', async () => {
    expect(h.system.securityRepo.listIncidents()).toHaveLength(6);
    for (const s of SCENARIOS) {
      const r = await submit(s.incidentId, s.machineId);
      expect(r.body.view.evaluation.decision).toBe(s.expected);
      expect(r.body.view.evaluation.reasonCodes).not.toContain('POSSIBLE_DUPLICATE_REQUEST');
      expect(r.body.view.evaluation.summary.duplicateCheck.matches).toEqual([]);
    }
  });

  it('loading the fixture only adds records', async () => {
    expect((await loadFixture()).body.incidents).toEqual(['INC-90488', 'INC-90489']);
    expect(h.system.securityRepo.listIncidents()).toHaveLength(8);
    expect(h.system.securityRepo.getIncident('INC-90482')!.revision).toBe(12);
    expect((await h.api<Json>('POST', '/api/lab/scenarios/nope')).status).toBe(404);
  });
});

describe('detection', () => {
  it('a second incident on a device with a staged packet is flagged, and approvers see the reason', async () => {
    await loadFixture();
    const first = await submit(PRIMARY.incidentId, PRIMARY.machineId);
    await h.api('POST', `/api/requests/${first.body.requestId}/stage`);
    const second = await submit(SAP_SECOND.incidentId, SAP_SECOND.machineId);
    const ev = second.body.view.evaluation;
    expect(ev.decision).toBe('REQUIRE_DUAL_APPROVAL');
    expect(ev.reasonCodes).toContain('POSSIBLE_DUPLICATE_REQUEST');
    expect(ev.summary.duplicateCheck.matches).toEqual([
      expect.objectContaining({ requestId: first.body.requestId, incidentId: 'INC-90482', state: 'WAITING_FOR_DUAL_APPROVAL', approvalId: 'CAP-2026-1042' }),
    ]);
    // The human approval path is the disposition: the packet carries the reason to both approvers.
    const st = await h.api<Json>('POST', `/api/requests/${second.body.requestId}/stage`);
    expect(st.status).toBe(200);
    expect(h.system.itsmRepo.getPacket(st.body.result.approvalId)!.reasonCodes).toContain('POSSIBLE_DUPLICATE_REQUEST');
  });

  it('a duplicate on an otherwise standard device goes to manual review instead of the standard path', async () => {
    await loadFixture();
    expect((await submit(WKS_FIRST.incidentId, WKS_FIRST.machineId)).body.view.evaluation.decision).toBe('STANDARD_RESPONSE_ELIGIBLE');
    const second = await submit(WKS_SECOND.incidentId, WKS_SECOND.machineId);
    expect(second.body.view.evaluation).toMatchObject({ decision: 'MANUAL_REVIEW', reasonCodes: ['POSSIBLE_DUPLICATE_REQUEST'] });
    expect(second.body.view.request.state).toBe('MANUAL_REVIEW');
  });

  it('the same incident on a different device is not flagged', async () => {
    const a = await submit(PRIMARY.incidentId, PRIMARY.machineId);
    await h.api('POST', `/api/requests/${a.body.requestId}/stage`);
    const b = await submit(WKS_FIRST.incidentId, WKS_FIRST.machineId);
    expect(b.body.view.evaluation.summary.duplicateCheck.matches).toEqual([]);
  });

  it('a closed earlier request (rejected) is not flagged', async () => {
    await loadFixture();
    const a = await submit(PRIMARY.incidentId, PRIMARY.machineId);
    const st = await h.api<Json>('POST', `/api/requests/${a.body.requestId}/stage`);
    await h.api('POST', `/api/approvals/${st.body.result.approvalId}/decision`, { decision: 'REJECT', comment: '' }, 'owner-sap-ewm');
    const b = await submit(SAP_SECOND.incidentId, SAP_SECOND.machineId);
    expect(b.body.view.evaluation.reasonCodes).not.toContain('POSSIBLE_DUPLICATE_REQUEST');
  });

  it('a blocked earlier request (insufficient evidence) is not flagged', async () => {
    await loadFixture();
    h.system.itsmRepo.upsertDataset({ configItems: [{ ...h.system.itsmRepo.getBundle('CI-020455')!.configItem, lastVerifiedAt: '2026-10-17T00:00:00Z' }] });
    expect((await submit(WKS_FIRST.incidentId, WKS_FIRST.machineId)).body.view.evaluation.decision).toBe('INSUFFICIENT_EVIDENCE');
    h.system.itsmRepo.upsertDataset({ configItems: [{ ...h.system.itsmRepo.getBundle('CI-020455')!.configItem, lastVerifiedAt: '2026-10-18T05:40:00Z' }] });
    expect((await submit(WKS_SECOND.incidentId, WKS_SECOND.machineId)).body.view.evaluation.decision).toBe('STANDARD_RESPONSE_ELIGIBLE');
  });

  it('time window: exactly 24 hours old still counts, one minute more does not', async () => {
    await loadFixture();
    const a = await submit(WKS_FIRST.incidentId, WKS_FIRST.machineId); // standard eligible, created 06:14
    expect(a.body.view.request.state).toBe('STANDARD_RESPONSE_ELIGIBLE');
    h.system.clock.advance(24 * 60);
    const atEdge = await submit(WKS_SECOND.incidentId, WKS_SECOND.machineId);
    expect(atEdge.body.view.evaluation.summary.duplicateCheck.matches).toHaveLength(1);
    // Start a fresh comparison one minute past the window (the request above is itself relevant only if not blocked).
    h.system.clock.advance(1);
    const r = await h.api<Json>('POST', `/api/requests/${atEdge.body.requestId}/evaluate`);
    expect(r.body.evaluation.summary.duplicateCheck.matches).toEqual([]);
  });

  it('re-evaluating gives exactly one flag, not one per run', async () => {
    await loadFixture();
    const a = await submit(WKS_FIRST.incidentId, WKS_FIRST.machineId);
    expect(a.status).toBe(201);
    const b = await submit(WKS_SECOND.incidentId, WKS_SECOND.machineId);
    for (let i = 0; i < 2; i++) {
      const r = await h.api<Json>('POST', `/api/requests/${b.body.requestId}/evaluate`);
      expect(r.body.evaluation.summary.duplicateCheck.matches).toHaveLength(1);
      expect(r.body.evaluation.reasonCodes.filter((c: string) => c === 'POSSIBLE_DUPLICATE_REQUEST')).toHaveLength(1);
    }
  });

  it('someone without request rights cannot bypass the flag by evaluating', async () => {
    await loadFixture();
    await submit(WKS_FIRST.incidentId, WKS_FIRST.machineId);
    const b = await submit(WKS_SECOND.incidentId, WKS_SECOND.machineId);
    const r = await h.api<Json>('POST', `/api/requests/${b.body.requestId}/evaluate`, undefined, 'owner-fin-it');
    expect(r.status).toBe(403);
    expect(h.system.store.getRequest(b.body.requestId)!.state).toBe('MANUAL_REVIEW');
  });
});
