/**
 * CH-19: the evidence check matrix shown for a request is the one the policy engine recorded when it ran, and it
 * agrees with the recorded trace and decision for every seeded scenario, the duplicate scenario, a failed source and
 * an old evaluation with no recorded checks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SCENARIOS } from '../../fixtures/seed';
import { startHarness, type Harness, type Json } from '../helpers';

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
const harness = async () => {
  const h = await startHarness();
  open.push(h);
  return h;
};
const statuses = (checks: Json[]) => Object.fromEntries(checks.map((c) => [c.checkId, c.status]));
const fromTrace = (view: Json) => {
  const run = view.runs.find((r: Json) => r.kind === 'EVALUATE');
  const step = run.trace.find((s: Json) => s.step === 'policy.evaluate');
  return Object.fromEntries((step.summary.checks as string[]).map((x) => x.split(':')));
};

const EXPECTED: Record<string, Record<string, string>> = {
  'INC-90482': { SOURCES_AVAILABLE: 'PASS', DEVICE_IDENTITY: 'PASS', EVIDENCE_FRESH: 'PASS', MANDATORY_FIELDS: 'PASS', OPERATING_DOCUMENTS: 'PASS', SEPARATION_OF_DUTIES: 'PASS', BUSINESS_IMPACT: 'WARN', APPROVERS_RESOLVED: 'PASS', DUPLICATE_RISK: 'PASS' },
  'INC-90483': { EVIDENCE_FRESH: 'FAIL', OPERATING_DOCUMENTS: 'NOT_EVALUATED', BUSINESS_IMPACT: 'NOT_EVALUATED', APPROVERS_RESOLVED: 'NOT_EVALUATED', DUPLICATE_RISK: 'NOT_EVALUATED' },
  'INC-90484': { BUSINESS_IMPACT: 'PASS', APPROVERS_RESOLVED: 'NOT_EVALUATED', DUPLICATE_RISK: 'PASS' },
  'INC-90485': { DEVICE_IDENTITY: 'FAIL', MANDATORY_FIELDS: 'NOT_EVALUATED', BUSINESS_IMPACT: 'NOT_EVALUATED' },
  'INC-90486': { BUSINESS_IMPACT: 'WARN', APPROVERS_RESOLVED: 'PASS' },
  'INC-90487': { OPERATING_DOCUMENTS: 'FAIL', BUSINESS_IMPACT: 'NOT_EVALUATED', DUPLICATE_RISK: 'NOT_EVALUATED' },
};

describe('evidence check matrix', () => {
  it('matches the recorded trace and decision for every seeded scenario, with no change to decisions', async () => {
    const h = await harness();
    for (const sc of SCENARIOS) {
      const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: `evt-chk-${sc.incidentId}`, incidentId: sc.incidentId, machineId: sc.machineId, requestedAction: 'FULL_ISOLATION' });
      const view = r.body.view;
      expect(view.evaluation.decision, sc.incidentId).toBe(sc.expected);
      const checks = view.evaluation.summary.evidenceChecks as Json[];
      expect(checks).toHaveLength(9);
      expect(statuses(checks)).toEqual(fromTrace(view));
      expect(statuses(checks)).toMatchObject(EXPECTED[sc.incidentId]!);
      expect(checks.some((c) => c.blocksAutoAction), sc.incidentId).toBe(sc.expected !== 'STANDARD_RESPONSE_ELIGIBLE');
      const codes = new Set(checks.filter((c) => c.status === 'FAIL' || c.status === 'WARN').flatMap((c) => c.reasonCodes));
      for (const code of view.evaluation.reasonCodes) if (code !== 'NO_BUSINESS_IMPACT_SIGNAL') expect(codes.has(code), `${sc.incidentId} ${code}`).toBe(true);
    }
  });

  it('the duplicate scenario shows a duplicate warning that blocks the standard path', async () => {
    const h = await harness();
    await h.api('POST', '/api/lab/scenarios/possible-duplicate');
    await h.api('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-chk-d1', incidentId: 'INC-90484', machineId: 'device-91aa02fe', requestedAction: 'FULL_ISOLATION' });
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-chk-d2', incidentId: 'INC-90489', machineId: 'device-91aa02fe', requestedAction: 'FULL_ISOLATION' });
    const checks = r.body.view.evaluation.summary.evidenceChecks as Json[];
    expect(r.body.view.evaluation.decision).toBe('MANUAL_REVIEW');
    expect(checks.find((c) => c.checkId === 'DUPLICATE_RISK')).toMatchObject({ status: 'WARN', blocksAutoAction: true, reasonCodes: ['POSSIBLE_DUPLICATE_REQUEST'] });
    expect(statuses(checks)).toEqual(fromTrace(r.body.view));
  });

  it('a source that fails is a failed check, and what depends on it is not evaluated', async () => {
    const h = await harness();
    await h.api('GET', '/api/session');
    await h.api('POST', '/api/lab/faults', { system: 'itsm', mode: 'http_503', target: 'reads' });
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-chk-f1', incidentId: 'INC-90482', machineId: 'device-d8f92a10', requestedAction: 'FULL_ISOLATION' });
    const checks = r.body.view.evaluation.summary.evidenceChecks as Json[];
    expect(r.body.view.evaluation.decision).toBe('INSUFFICIENT_EVIDENCE');
    expect(statuses(checks)).toMatchObject({ SOURCES_AVAILABLE: 'FAIL', MANDATORY_FIELDS: 'NOT_EVALUATED', BUSINESS_IMPACT: 'NOT_EVALUATED' });
    expect(checks.filter((c) => c.status === 'PASS').map((c) => c.checkId)).not.toContain('BUSINESS_IMPACT');
  });

  it('an evaluation written before checks were recorded has none, and none are invented', async () => {
    const h = await harness();
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-chk-old', incidentId: 'INC-90482', machineId: 'device-d8f92a10', requestedAction: 'FULL_ISOLATION' });
    const ev = r.body.view.evaluation;
    const { evidenceChecks: _c, ...rest } = ev.summary;
    h.system.store.db.prepare('UPDATE evaluations SET summary = ? WHERE evaluation_id = ?').run(JSON.stringify(rest), ev.evaluationId);
    const view = (await h.api<Json>('GET', `/api/requests/${r.body.requestId}`)).body;
    expect(view.evaluation.summary.evidenceChecks).toBeUndefined();
  });
});
