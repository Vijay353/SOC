import { z } from 'zod';
import {
  ApprovalPacket,
  ConfigItemBundle,
  ConfigItemRow,
  DeviceActivityRow,
  DeviceRow,
  IncidentRow,
  IncidentWithAlerts,
  MachineActionRecord,
  StagedApprovalPacket,
  UserRow,
  type StageContainmentApprovalInput,
} from '../../../../packages/contracts/src/domain';
import { HttpJsonClient, type CallObserver, type HttpClientOptions } from './http-client';
import type { ItsmPort, SecurityPort } from './ports';

const enc = encodeURIComponent;
/** List endpoints wrap their rows as { value: [...] }. */
const list = <T extends z.ZodType>(row: T) => z.object({ value: z.array(row) });

/** SIMULATED adapter for Mock Microsoft Security. Token deliberately lacks machine.isolate. */
export class SimulatedSecurityAdapter implements SecurityPort {
  readonly providerName = 'mock-security (SIMULATED)';
  private http: HttpJsonClient;
  constructor(baseUrl: () => string, token: string, opts: HttpClientOptions) {
    this.http = new HttpJsonClient('mock-security', baseUrl, token, opts);
  }
  async listIncidents(o?: CallObserver) {
    return (await this.http.request('listIncidents', 'GET', '/api/incidents', { schema: list(IncidentRow), observer: o })).data.value;
  }
  async listDevices(o?: CallObserver) {
    return (await this.http.request('listDevices', 'GET', '/api/devices', { schema: list(DeviceRow), observer: o })).data.value;
  }
  async getIncident(id: string, o?: CallObserver) {
    return (await this.http.request('getIncident', 'GET', `/api/incidents/${enc(id)}`, { schema: IncidentWithAlerts, observer: o })).data;
  }
  async getDevice(id: string, o?: CallObserver) {
    return (await this.http.request('getDevice', 'GET', `/api/devices/${enc(id)}`, { schema: DeviceRow, observer: o })).data;
  }
  async getActivitySummary(id: string, o?: CallObserver) {
    return (await this.http.request('getActivitySummary', 'GET', `/api/devices/${enc(id)}/activity-summary`, { schema: DeviceActivityRow, observer: o })).data;
  }
  async getMachineActions(id: string, o?: CallObserver) {
    return (await this.http.request('getMachineActions', 'GET', `/api/machines/${enc(id)}/actions`, { schema: list(MachineActionRecord), observer: o })).data.value;
  }
}

/** SIMULATED adapter for Mock ITSM/CMDB. */
export class SimulatedItsmAdapter implements ItsmPort {
  readonly providerName = 'mock-itsm (SIMULATED)';
  private http: HttpJsonClient;
  constructor(baseUrl: () => string, token: string, opts: HttpClientOptions) {
    this.http = new HttpJsonClient('mock-itsm', baseUrl, token, opts);
  }
  async findConfigItemsByMachine(machineId: string, o?: CallObserver) {
    return (await this.http.request('findConfigItemsByMachine', 'GET', `/api/config-items?machineId=${enc(machineId)}`, { schema: list(ConfigItemRow), observer: o })).data.value;
  }
  async getConfigItemBundle(ciId: string, o?: CallObserver) {
    return (await this.http.request('getConfigItemBundle', 'GET', `/api/config-items/${enc(ciId)}`, { schema: ConfigItemBundle, observer: o })).data;
  }
  async listUsers(filter: { role?: string; onCall?: boolean }, o?: CallObserver) {
    const q = new URLSearchParams();
    if (filter.role) q.set('role', filter.role);
    if (filter.onCall !== undefined) q.set('onCall', String(filter.onCall));
    return (await this.http.request('listUsers', 'GET', `/api/users?${q}`, { schema: list(UserRow), observer: o })).data.value;
  }
  async stageContainmentApproval(input: StageContainmentApprovalInput, o?: CallObserver) {
    // Safe to retry: the simulator de-duplicates on idempotencyKey.
    return (await this.http.request('stageContainmentApproval', 'POST', '/api/approval-packets', { schema: StagedApprovalPacket, body: input, safeToRetry: true, observer: o })).data;
  }
  async getApprovalPacket(id: string, o?: CallObserver) {
    return (await this.http.request('getApprovalPacket', 'GET', `/api/approval-packets/${enc(id)}`, { schema: ApprovalPacket, observer: o })).data;
  }
  async findApprovalPacketByKey(key: string, o?: CallObserver) {
    const v = (await this.http.request('findApprovalPacketByKey', 'GET', `/api/approval-packets?idempotencyKey=${enc(key)}`, { schema: list(ApprovalPacket), observer: o })).data.value;
    return v[0] ?? null;
  }
  async listApprovalPackets(approverId: string | undefined, o?: CallObserver) {
    const q = approverId ? `?approverId=${enc(approverId)}` : '';
    return (await this.http.request('listApprovalPackets', 'GET', `/api/approval-packets${q}`, { schema: list(ApprovalPacket), observer: o })).data.value;
  }
  async recordApprovalDecision(id: string, actorId: string, decision: 'APPROVE' | 'REJECT', comment: string, o?: CallObserver) {
    // Not retried automatically: the simulator rejects a second decision by the same approver (409 ALREADY_DECIDED).
    return (await this.http.request('recordApprovalDecision', 'POST', `/api/approval-packets/${enc(id)}/decisions`, { schema: ApprovalPacket, body: { actorId, decision, comment }, observer: o })).data;
  }
}
