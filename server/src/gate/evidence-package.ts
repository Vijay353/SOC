/**
 * CH-18: one record's audit evidence package. Built only from persisted Gate records and one read of the
 * approval packet. It changes nothing. The digest is a SHA-256 checksum of the canonical JSON, not a signature.
 */
import { canonical, sha256 } from '../../../packages/contracts/src/canonical';
import type { ApprovalPacket } from '../../../packages/contracts/src/domain';
import type { AuditVerification, EvaluationRecord, RequestRecord } from './store';

export const EVIDENCE_PACKAGE_SCHEMA = 'gate.audit-evidence-package';
export const EVIDENCE_PACKAGE_VERSION = 1;

export type EvidenceStatus = 'complete' | 'partial' | 'unverifiable';

export interface EvidencePackageInput {
  exportedAt: string;
  exportedBy: { userId: string; role: string };
  mode: string;
  request: RequestRecord;
  evaluations: EvaluationRecord[];
  runs: Array<{ runId: string; kind: string; actor: string; startedAt: string; finishedAt: string; outcome: string; trace: unknown }>;
  audit: Array<{ seq: number; at: string; actor: string; action: string; requestId: string | null; details: unknown; hash: string; prevHash: string }>;
  chain: AuditVerification;
  packet: ApprovalPacket | null;
  packetError: unknown;
}

export function buildEvidencePackage(x: EvidencePackageInput) {
  const statusReasons: string[] = [];
  let status: EvidenceStatus = 'complete';
  const partial = (why: string) => {
    statusReasons.push(why);
    if (status === 'complete') status = 'partial';
  };

  if (!x.chain.intact) {
    status = 'unverifiable';
    statusReasons.push(`The Gate audit chain failed verification at entry ${x.chain.brokenAt} (${x.chain.reason}). The rows below cannot be trusted as written.`);
  }
  if (x.evaluations.length === 0) partial('No evaluation was recorded for this request.');
  for (const e of x.evaluations) {
    if (!e.policyVersion) partial(`Evaluation ${e.evaluationId} has no recorded policy version. It was written before policy capture existed, so its policy is not shown.`);
  }
  const latest = x.evaluations[x.evaluations.length - 1] ?? null;
  if (x.request.approvalId && !x.packet) partial(`The approval packet ${x.request.approvalId} could not be read from the ITSM system at export time.`);
  if (x.packet) {
    if (x.packet.approvalId !== x.request.approvalId) partial(`The packet read back is ${x.packet.approvalId}, but the request records ${x.request.approvalId}.`);
    const keyed = x.evaluations.find((e) => e.idempotencyKey === x.packet!.idempotencyKey);
    if (!keyed) partial('The packet idempotency key does not match any recorded evaluation of this request.');
  }
  if (x.audit.length === 0) partial('No audit rows exist for this request.');

  const body = {
    schema: EVIDENCE_PACKAGE_SCHEMA,
    schemaVersion: EVIDENCE_PACKAGE_VERSION,
    title: 'Audit evidence package',
    notice:
      'Synthetic demo data. This package is a record of what the Gate stored. It is not a compliance certification and it is not digitally signed.',
    exportedAt: x.exportedAt,
    exportedBy: x.exportedBy,
    mode: x.mode,
    evidenceStatus: status,
    statusReasons,
    record: {
      requestId: x.request.requestId,
      eventId: x.request.eventId,
      incidentId: x.request.incidentId,
      machineId: x.request.machineId,
      requestedAction: x.request.requestedAction,
      requestedBy: x.request.requestedBy,
      state: x.request.state,
      revision: x.request.version,
      approvalId: x.request.approvalId,
      createdAt: x.request.createdAt,
      updatedAt: x.request.updatedAt,
      lastError: x.request.lastError ?? null,
    },
    sourceReferences: latest
      ? { incidentRevision: latest.incidentRevision, configItemId: latest.ciId, evidenceHashes: latest.evidenceHashes, machineActionCountAtEvaluation: latest.machineActionCount }
      : null,
    decisions: x.evaluations.map((e) => ({
      evaluationId: e.evaluationId,
      createdAt: e.createdAt,
      validUntil: e.validUntil,
      decision: e.decision,
      reasonCodes: e.reasonCodes,
      incidentRevision: e.incidentRevision,
      approverIds: e.approverIds,
      idempotencyKey: e.idempotencyKey,
      evidenceHashes: e.evidenceHashes,
      evidenceChecks: (e.summary as { evidenceChecks?: unknown }).evidenceChecks ?? null,
      policy: e.policyVersion
        ? { recorded: true, version: e.policyVersion, config: e.policyConfig }
        : { recorded: false, version: null, config: null, note: 'Not recorded at decision time. Not reconstructed from current settings.' },
    })),
    actors: x.audit.map((a) => ({ seq: a.seq, at: a.at, actor: a.actor, action: a.action })),
    runs: x.runs.map((r) => ({ runId: r.runId, kind: r.kind, actor: r.actor, startedAt: r.startedAt, finishedAt: r.finishedAt, outcome: r.outcome, trace: r.trace })),
    writes: {
      approvalPacket: x.packet
        ? {
            approvalId: x.packet.approvalId,
            status: x.packet.status,
            idempotencyKey: x.packet.idempotencyKey,
            approverIds: x.packet.approverIds,
            decisions: x.packet.decisions,
            expiresAt: x.packet.expiresAt,
            createdAt: x.packet.createdAt,
            evidenceHashes: x.packet.evidenceHashes,
            reasonCodes: x.packet.reasonCodes,
            policyVersion: x.packet.policyVersion,
            requestedBy: x.packet.requestedBy,
          }
        : null,
      approvalPacketReadError: x.packet ? null : x.packetError ?? null,
      deviceChangesByGate: 'None. The Gate has no permission to isolate a device.',
    },
    audit: {
      rows: x.audit,
      chain: {
        scope: 'The whole Gate audit log (gate.db). Rows for this request are a subset of that chain.',
        intact: x.chain.intact,
        brokenAt: x.chain.brokenAt,
        reason: x.chain.reason,
        fromSeq: x.chain.fromSeq,
        toSeq: x.chain.toSeq,
        length: x.chain.length,
        algorithm: x.chain.algorithm,
        anchor: x.chain.anchor,
        notCovered: ['Simulator audit logs (security.db, itsm.db)'],
      },
    },
    verification: {
      digestAlgorithm: 'sha256',
      digestCovers: 'The canonical JSON (keys sorted, no spaces) of this whole object without the "digest" field.',
      howToCheck: [
        'Remove the "digest" field from the file.',
        'Serialize the rest as canonical JSON: keys sorted at every level, no extra spaces.',
        'Compute SHA-256 of that text and compare it with digest.value.',
        'A match shows the file was not changed after export. It does not show who exported it.',
      ],
    },
  };
  return { ...body, digest: { algorithm: 'sha256', value: sha256(canonical(body)) } };
}

/** Request IDs are generated by the Gate; anything else is replaced so the file name is always safe. */
export const evidenceFileName = (requestId: string) => `audit-evidence-${requestId.replace(/[^A-Za-z0-9-]/g, '_')}.json`;
