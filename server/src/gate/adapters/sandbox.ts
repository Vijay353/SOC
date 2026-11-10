/**
 * SANDBOX / LIVE adapter seams — PLACEHOLDERS, NOT_VERIFIED.
 *
 * These classes exist so the composition root can select a real provider without touching domain logic.
 * They fail closed: construction throws when configuration is missing, and every method throws
 * NOT_CONFIGURED until the mapping in INTEGRATIONS.md has been implemented and verified against a sandbox.
 * They never return simulated data.
 */
import type { AppConfig } from '../../config';
import { UpstreamError } from './http-client';
import type { ItsmPort, SecurityPort } from './ports';

export class IntegrationSetupError extends Error {
  constructor(
    message: string,
    public missing: string[],
  ) {
    super(message);
  }
}

const notVerified = (system: string, op: string): never => {
  throw new UpstreamError(system, op, 'NOT_CONFIGURED', null, 'ADAPTER_NOT_VERIFIED', `${system}.${op} is a TO_VERIFY placeholder. See INTEGRATIONS.md; switch to SIMULATED mode to continue.`);
};

/** Target: Microsoft Graph security incidents + Defender for Endpoint machine APIs (read-only scopes). */
export class GraphDefenderSecurityAdapter implements SecurityPort {
  readonly providerName = 'microsoft-graph-defender (SANDBOX, NOT_VERIFIED)';
  constructor(cfg: AppConfig) {
    const missing = (['tenantId', 'clientId', 'clientSecret'] as const).filter((k) => !cfg.sandbox[k]).map((k) => ({ tenantId: 'MS_TENANT_ID', clientId: 'MS_CLIENT_ID', clientSecret: 'MS_CLIENT_SECRET' })[k]);
    if (missing.length) throw new IntegrationSetupError('Microsoft Security sandbox adapter selected but not configured', missing);
  }
  listIncidents() {
    return notVerified('microsoft-security', 'listIncidents');
  }
  listDevices() {
    return notVerified('microsoft-security', 'listDevices');
  }
  getIncident() {
    return notVerified('microsoft-security', 'getIncident');
  }
  getDevice() {
    return notVerified('microsoft-security', 'getDevice');
  }
  getActivitySummary() {
    return notVerified('microsoft-security', 'getActivitySummary');
  }
  getMachineActions() {
    return notVerified('microsoft-security', 'getMachineActions');
  }
}

/** Target: ServiceNow CMDB Table API + an approval record (table/flow TO_VERIFY per customer instance). */
export class ServiceNowItsmAdapter implements ItsmPort {
  readonly providerName = 'servicenow (SANDBOX, NOT_VERIFIED)';
  constructor(cfg: AppConfig) {
    const missing = (['serviceNowInstance', 'serviceNowUser', 'serviceNowPassword'] as const)
      .filter((k) => !cfg.sandbox[k])
      .map((k) => ({ serviceNowInstance: 'SERVICENOW_INSTANCE', serviceNowUser: 'SERVICENOW_USER', serviceNowPassword: 'SERVICENOW_PASSWORD' })[k]);
    if (missing.length) throw new IntegrationSetupError('ServiceNow sandbox adapter selected but not configured', missing);
  }
  findConfigItemsByMachine() {
    return notVerified('servicenow', 'findConfigItemsByMachine');
  }
  getConfigItemBundle() {
    return notVerified('servicenow', 'getConfigItemBundle');
  }
  listUsers() {
    return notVerified('servicenow', 'listUsers');
  }
  stageContainmentApproval() {
    return notVerified('servicenow', 'stageContainmentApproval');
  }
  getApprovalPacket() {
    return notVerified('servicenow', 'getApprovalPacket');
  }
  findApprovalPacketByKey() {
    return notVerified('servicenow', 'findApprovalPacketByKey');
  }
  listApprovalPackets() {
    return notVerified('servicenow', 'listApprovalPackets');
  }
  recordApprovalDecision() {
    return notVerified('servicenow', 'recordApprovalDecision');
  }
}
