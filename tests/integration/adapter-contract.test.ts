/**
 * CH-1: adapter contract coverage.
 * Every simulated adapter method is called against live simulators and its result must match the shared
 * contract schemas. Every Graph and ServiceNow placeholder method must refuse rather than return data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AlertRow,
  ApprovalPacket,
  ConfigItemBundle,
  ConfigItemRow,
  DeviceActivityRow,
  DeviceRow,
  IncidentRow,
  UserRow,
} from '../../packages/contracts/src/domain';
import { loadConfig } from '../../server/src/config';
import { UpstreamError } from '../../server/src/gate/adapters/http-client';
import { GraphDefenderSecurityAdapter, ServiceNowItsmAdapter } from '../../server/src/gate/adapters/sandbox';
import { SimulatedItsmAdapter, SimulatedSecurityAdapter } from '../../server/src/gate/adapters/simulated';
import { PRIMARY, startHarness, type Harness, type Json } from '../helpers';

let h: Harness;
let security: SimulatedSecurityAdapter;
let itsm: SimulatedItsmAdapter;
beforeAll(async () => {
  h = await startHarness();
  const opts = { timeoutMs: 1000, maxAttempts: 1, baseDelayMs: 1 };
  security = new SimulatedSecurityAdapter(() => `${h.url}/sim/security`, h.system.config.tokens.gateSecurity, opts);
  itsm = new SimulatedItsmAdapter(() => `${h.url}/sim/itsm`, h.system.config.tokens.gateItsm, opts);
});
afterAll(async () => {
  await h.close();
});

// The read model of an approval packet. Stored idempotency keys are opaque strings, not new keys.
const StoredPacket = ApprovalPacket.extend({ idempotencyKey: z.string().min(1) });

describe('SimulatedSecurityAdapter satisfies the SecurityPort contract', () => {
  it('listIncidents', async () => {
    const v = await security.listIncidents();
    expect(v.length).toBe(6);
    for (const i of v) IncidentRow.parse(i);
  });
  it('listDevices', async () => {
    for (const d of await security.listDevices()) DeviceRow.parse(d);
  });
  it('getIncident includes alerts', async () => {
    const i = await security.getIncident(PRIMARY.incidentId);
    IncidentRow.extend({ alerts: z.array(AlertRow) }).parse(i);
    expect(i.alerts.length).toBe(3);
  });
  it('getDevice', async () => {
    DeviceRow.parse(await security.getDevice(PRIMARY.machineId));
  });
  it('getActivitySummary', async () => {
    expect(DeviceActivityRow.parse(await security.getActivitySummary(PRIMARY.machineId)).activeSessionCount).toBe(1420);
  });
  it('getMachineActions', async () => {
    expect(await security.getMachineActions(PRIMARY.machineId)).toEqual([]);
  });
  it('unknown ids surface a typed 404, not empty data', async () => {
    const e = (await security.getDevice('device-missing').catch((x) => x)) as UpstreamError;
    expect(e).toBeInstanceOf(UpstreamError);
    expect(e.status).toBe(404);
  });
});

describe('SimulatedItsmAdapter satisfies the ItsmPort contract', () => {
  it('findConfigItemsByMachine', async () => {
    const v = await itsm.findConfigItemsByMachine(PRIMARY.machineId);
    expect(v.map((c) => ConfigItemRow.parse(c).ciId)).toEqual(['CI-009481']);
  });
  it('getConfigItemBundle', async () => {
    const b = ConfigItemBundle.parse(await itsm.getConfigItemBundle('CI-009481'));
    expect(b.dependencies.length).toBe(19);
  });
  it('listUsers with role and on-call filter', async () => {
    const v = await itsm.listUsers({ role: 'INCIDENT_COMMANDER', onCall: true });
    expect(v.map((u) => UserRow.parse(u).userId)).toEqual(['soc-incident-commander']);
  });
  it('stage, read back, look up by key, list and decide', async () => {
    const r = await h.api<Json>('POST', '/api/events/manual-isolation-requested', { eventId: 'evt-contract', ...PRIMARY });
    await h.api('POST', `/api/requests/${r.body.requestId}/stage`);
    const listed = await itsm.listApprovalPackets('owner-sap-ewm');
    expect(listed).toHaveLength(1);
    const p = StoredPacket.parse(listed[0]);
    StoredPacket.parse(await itsm.getApprovalPacket(p.approvalId));
    expect((await itsm.findApprovalPacketByKey(p.idempotencyKey))?.approvalId).toBe(p.approvalId);
    expect(await itsm.findApprovalPacketByKey('0'.repeat(64))).toBeNull();
    const decided = StoredPacket.parse(await itsm.recordApprovalDecision(p.approvalId, 'soc-incident-commander', 'APPROVE', 'contract test'));
    expect(decided.status).toBe('PARTIALLY_APPROVED');
  });
});

describe('placeholder adapters fail closed on every port method', () => {
  const cfg = loadConfig({
    MS_TENANT_ID: 'x',
    MS_CLIENT_ID: 'x',
    MS_CLIENT_SECRET: 'x',
    SERVICENOW_INSTANCE: 'x',
    SERVICENOW_USER: 'x',
    SERVICENOW_PASSWORD: 'x',
  });
  const graph = new GraphDefenderSecurityAdapter(cfg);
  const snow = new ServiceNowItsmAdapter(cfg);
  const calls: Array<[string, () => unknown]> = [
    ['graph.listIncidents', () => graph.listIncidents()],
    ['graph.listDevices', () => graph.listDevices()],
    ['graph.getIncident', () => graph.getIncident()],
    ['graph.getDevice', () => graph.getDevice()],
    ['graph.getActivitySummary', () => graph.getActivitySummary()],
    ['graph.getMachineActions', () => graph.getMachineActions()],
    ['servicenow.findConfigItemsByMachine', () => snow.findConfigItemsByMachine()],
    ['servicenow.getConfigItemBundle', () => snow.getConfigItemBundle()],
    ['servicenow.listUsers', () => snow.listUsers()],
    ['servicenow.stageContainmentApproval', () => snow.stageContainmentApproval()],
    ['servicenow.getApprovalPacket', () => snow.getApprovalPacket()],
    ['servicenow.findApprovalPacketByKey', () => snow.findApprovalPacketByKey()],
    ['servicenow.listApprovalPackets', () => snow.listApprovalPackets()],
    ['servicenow.recordApprovalDecision', () => snow.recordApprovalDecision()],
  ];
  for (const [name, fn] of calls) {
    it(name, () => {
      expect(fn).toThrow(expect.objectContaining({ code: 'ADAPTER_NOT_VERIFIED' }));
    });
  }
});
