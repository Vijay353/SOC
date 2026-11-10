/**
 * Domain-oriented ports. The orchestrator depends only on these interfaces, never on a vendor client.
 * SIMULATED implementations call the local behavioural simulators over HTTP.
 * SANDBOX/LIVE implementations are skeletons that fail closed until verified (see INTEGRATIONS.md).
 */
import type {
  ApprovalPacket,
  ConfigItemBundle,
  DeviceActivityRow,
  DeviceRow,
  IncidentRow,
  IncidentWithAlerts,
  MachineActionRecord,
  StageContainmentApprovalInput,
  StagedApprovalPacket,
  UserRow,
} from '../../../../packages/contracts/src/domain';
import type { CallObserver } from './http-client';

export type { IncidentWithAlerts };
export type StagedPacket = StagedApprovalPacket;

export interface SecurityPort {
  readonly providerName: string;
  listIncidents(o?: CallObserver): Promise<IncidentRow[]>;
  listDevices(o?: CallObserver): Promise<DeviceRow[]>;
  getIncident(incidentId: string, o?: CallObserver): Promise<IncidentWithAlerts>;
  getDevice(machineId: string, o?: CallObserver): Promise<DeviceRow>;
  getActivitySummary(machineId: string, o?: CallObserver): Promise<DeviceActivityRow>;
  getMachineActions(machineId: string, o?: CallObserver): Promise<MachineActionRecord[]>;
}

export interface ItsmPort {
  readonly providerName: string;
  findConfigItemsByMachine(machineId: string, o?: CallObserver): Promise<ConfigItemBundle['configItem'][]>;
  getConfigItemBundle(ciId: string, o?: CallObserver): Promise<ConfigItemBundle>;
  listUsers(filter: { role?: string; onCall?: boolean }, o?: CallObserver): Promise<UserRow[]>;
  /** The ONLY mutating tool the Gate uses during evaluation/staging. */
  stageContainmentApproval(input: StageContainmentApprovalInput, o?: CallObserver): Promise<StagedPacket>;
  getApprovalPacket(approvalId: string, o?: CallObserver): Promise<ApprovalPacket>;
  findApprovalPacketByKey(idempotencyKey: string, o?: CallObserver): Promise<ApprovalPacket | null>;
  listApprovalPackets(approverId: string | undefined, o?: CallObserver): Promise<ApprovalPacket[]>;
  recordApprovalDecision(approvalId: string, actorId: string, decision: 'APPROVE' | 'REJECT', comment: string, o?: CallObserver): Promise<ApprovalPacket>;
}
