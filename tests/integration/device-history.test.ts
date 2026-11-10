/** CH-8: trailing device history from this system's own records. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

let n = 0;
const WKS = { incidentId: 'INC-90484', machineId: 'device-91aa02fe', requestedAction: 'FULL_ISOLATION' };
const submit = (body: Record<string, unknown>) => h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: `evt-hist-${++n}`, ...body });

describe('device history', () => {
  it('the seeded primary scenario has no prior history', async () => {
    const r = await submit(PRIMARY);
    expect(r.body.view.deviceHistory).toMatchObject({ windowDays: 90, total: 0 });
  });

  it('counts each earlier request once by its current outcome and excludes the current one', async () => {
    const a = await submit(PRIMARY);
    const st = await h.api<Json>('POST', `/api/requests/${a.body.requestId}/stage`);
    await h.api('POST', `/api/approvals/${st.body.result.approvalId}/decision`, { decision: 'REJECT', comment: '' }, 'owner-sap-ewm');
    const b = await submit(PRIMARY);
    const st2 = await h.api<Json>('POST', `/api/requests/${b.body.requestId}/stage`);
    await h.api('POST', `/api/approvals/${st2.body.result.approvalId}/decision`, { decision: 'APPROVE', comment: '' }, 'soc-incident-commander');
    await h.api('POST', `/api/approvals/${st2.body.result.approvalId}/decision`, { decision: 'APPROVE', comment: '' }, 'owner-sap-ewm');
    const c = await submit(PRIMARY);
    const hist = c.body.view.deviceHistory;
    expect(hist).toMatchObject({ total: 2, approved: 1, rejectedOrExpired: 1, blocked: 0, inProgress: 0, standardEligible: 0 });
    expect(hist.approved + hist.rejectedOrExpired + hist.blocked + hist.inProgress + hist.standardEligible).toBe(hist.total);
    // Another device's history is separate.
    expect((await submit(WKS)).body.view.deviceHistory.total).toBe(0);
  });

  it('a request whose state changes is still counted once, under its new state', async () => {
    const a = await submit(WKS); // standard eligible, terminal
    expect(a.body.view.request.state).toBe('STANDARD_RESPONSE_ELIGIBLE');
    const b = await submit(WKS);
    expect(b.body.view.deviceHistory).toMatchObject({ total: 1, standardEligible: 1 });
  });

  it('window edge: exactly 90 days old is counted, one minute more is not', async () => {
    await submit(WKS);
    h.system.clock.advance(90 * 24 * 60);
    const b = await submit(WKS);
    expect(b.body.view.deviceHistory.total).toBe(1);
    h.system.clock.advance(1);
    const view = await h.api<Json>('GET', `/api/requests/${b.body.requestId}`);
    expect(view.body.deviceHistory.total).toBe(0);
  });
});
