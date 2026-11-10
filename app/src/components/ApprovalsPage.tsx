import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getDemoUser } from '../api';
import type { ApprovalPacket, Session } from '../types';
import { projectImpact } from '../impact';
import { ErrorBanner, fmtTime, personLabel, StateBadge } from '../ui';

interface Props {
  session: Session | null;
  onChanged: () => void;
}

/** Approver inbox. The ITSM simulator enforces assignment, separation of duties, one decision per approver and expiry. */
export function ApprovalsPage({ session, onChanged }: Props) {
  const [packets, setPackets] = useState<ApprovalPacket[] | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const me = session?.identities.find((i) => i.userId === getDemoUser());

  const load = useCallback(async () => {
    try {
      setPackets((await api<{ value: ApprovalPacket[] }>('GET', '/approvals')).value);
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (p: ApprovalPacket, decision: 'APPROVE' | 'REJECT') => {
    setBusy(`${p.approvalId}:${decision}`);
    setError(null);
    try {
      setPackets((await api<{ value: ApprovalPacket[] }>('POST', `/approvals/${p.approvalId}/decision`, { decision, comment: comments[p.approvalId] ?? '' })).value);
      onChanged();
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const nowMs = session ? Date.parse(session.clock.now) : Date.now();
  // CH-9: only packets this person can approve right now. The server re-checks every item anyway.
  const eligible = (p: ApprovalPacket) =>
    (p.status === 'WAITING_FOR_DUAL_APPROVAL' || p.status === 'PARTIALLY_APPROVED') &&
    !p.decisions.some((d) => d.approverId === getDemoUser()) &&
    !p.reasonCodes.includes('POSSIBLE_DUPLICATE_REQUEST');
  const chosen = (packets ?? []).filter((p) => selected.has(p.approvalId) && eligible(p));

  const bulkApprove = async () => {
    if (busy || chosen.length === 0) return;
    setBusy('bulk');
    setError(null);
    try {
      const r = await api<BulkResult & { value: ApprovalPacket[] }>('POST', '/approvals/bulk', {
        items: chosen.map((p) => ({ approvalId: p.approvalId, expectedStatus: p.status })),
        comment: 'Approved in bulk',
      });
      setBulkResult({ summary: r.summary, results: r.results });
      setPackets(r.value);
      setSelected(new Set());
      onChanged();
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      await load();
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <div>
      <div className="panel">
        <h2>Approval inbox: {me ? personLabel(me.displayName) : getDemoUser()}</h2>
        <p className="lead">
          Packets assigned to the current demo identity. Switch identity in the header (for example to Jordan Reyes, SOC incident commander, or Maya Okafor, SAP EWM service owner) to act as an approver. Approving
          does not isolate anything; it authorizes the analyst to act in Defender.
        </p>
        <div className="row">
          <button className="btn btn-sm" onClick={load}>
            Refresh
          </button>
          {!confirming && (
            <button className="btn btn-sm btn-ok" disabled={chosen.length === 0 || busy !== null} onClick={() => setConfirming(true)} data-testid="bulk-approve">
              Approve selected ({chosen.length})
            </button>
          )}
          {confirming && (
            <span className="row" role="group" aria-label="Confirm bulk approval">
              <span className="small">
                Approve {chosen.length} {chosen.length === 1 ? 'packet' : 'packets'}? Each one is checked and recorded on its own, and approving still does not isolate anything.
              </span>
              <button className="btn btn-sm btn-ok" onClick={bulkApprove} disabled={busy !== null} data-testid="bulk-confirm">
                {busy === 'bulk' ? 'Approving...' : 'Yes, approve'}
              </button>
              <button className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy !== null}>
                Cancel
              </button>
            </span>
          )}
        </div>
      </div>
      <ErrorBanner error={error} />
      {bulkResult && (
        <div className={`banner ${bulkResult.summary.failed ? 'banner-warn' : 'banner-info'}`} role="status" data-testid="bulk-result">
          <strong>
            {bulkResult.summary.approved} of {bulkResult.summary.requested} approved
            {bulkResult.summary.failed ? `, ${bulkResult.summary.failed} not approved` : ''}.
          </strong>
          <ul style={{ margin: '6px 0 0' }}>
            {bulkResult.results.map((r) => (
              <li key={r.approvalId}>
                {r.approvalId}: {r.outcome === 'APPROVED' ? 'approved' : `not approved. ${r.message}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {packets && packets.length === 0 && (
        <div className="empty" data-testid="approvals-empty">
          Nothing is assigned to you yet. A packet appears here when an analyst stages one that names you as an approver.
        </div>
      )}
      {packets && packets.length > 0 && !packets.some((p) => p.status === 'WAITING_FOR_DUAL_APPROVAL' || p.status === 'PARTIALLY_APPROVED') && (
        <div className="banner banner-info" data-testid="approvals-empty">
          {packets.length === 1 ? 'Your only packet is decided or closed.' : `All ${packets.length} of your packets are decided or closed.`} Nothing is waiting for you.
        </div>
      )}
      <div className="stack">
        {packets?.map((p) => {
          const mine = p.decisions.find((d) => d.approverId === getDemoUser());
          const open = p.status === 'WAITING_FOR_DUAL_APPROVAL' || p.status === 'PARTIALLY_APPROVED';
          const minsLeft = Math.round((Date.parse(p.expiresAt) - nowMs) / 60000);
          return (
            <article key={p.approvalId} className="packet" data-testid={`packet-${p.approvalId}`}>
              <div className="packet-head">
                {eligible(p) && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.approvalId} for bulk approval`}
                    checked={selected.has(p.approvalId)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(p.approvalId);
                      else next.delete(p.approvalId);
                      setSelected(next);
                    }}
                    data-testid={`select-${p.approvalId}`}
                  />
                )}
                <h3 style={{ marginRight: 'auto' }}>
                  {p.approvalId} · Full isolation of <code>{p.machineId}</code> ({p.ciId})
                </h3>
                <StateBadge state={p.status} />
              </div>
              <div className="small muted">
                {p.incidentId} r{p.expectedIncidentVersion} · requested by {p.requestedBy} · expires {fmtTime(p.expiresAt)}
                {open ? ` (${minsLeft >= 0 ? `${minsLeft} min left on scenario clock` : 'past expiry'})` : ''} · policy {p.policyVersion} · {p.evidenceHashes.length} evidence hashes
              </div>
              <div className="row">
                {p.reasonCodes.map((r) => (
                  <span key={r} className="badge">
                    {r}
                  </span>
                ))}
              </div>
              <div className="small">
                Approvers: {p.approverIds.map((a) => `${a}${p.decisions.find((d) => d.approverId === a) ? ` (${p.decisions.find((d) => d.approverId === a)!.decision})` : ' (pending)'}`).join(' · ')}
              </div>
              {open && p.impactFacts && <ImpactProjection packet={p} />}
              {open && !mine && (
                <div className="row">
                  <label className="field" style={{ flex: '1 1 260px' }}>
                    Comment (optional)
                    <input value={comments[p.approvalId] ?? ''} onChange={(e) => setComments({ ...comments, [p.approvalId]: e.target.value })} maxLength={500} />
                  </label>
                  <button className="btn btn-ok" onClick={() => decide(p, 'APPROVE')} disabled={busy !== null} data-testid={`approve-${p.approvalId}`}>
                    Approve
                  </button>
                  <button className="btn btn-danger" onClick={() => decide(p, 'REJECT')} disabled={busy !== null}>
                    Reject
                  </button>
                </div>
              )}
              {mine && <div className="small muted">You recorded {mine.decision === 'APPROVE' ? 'an approval' : 'a rejection'} at {fmtTime(mine.decidedAt)}.</div>}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ImpactProjection({ packet }: { packet: ApprovalPacket }) {
  const { lines, caveat } = projectImpact(packet.impactFacts!);
  return (
    <section className="callout callout-info" aria-label={`What approving ${packet.approvalId} would allow`} data-testid={`impact-${packet.approvalId}`}>
      <b>IF BOTH APPROVERS APPROVE</b>
      <dl className="kv" style={{ margin: '6px 0' }}>
        {lines.map((l) => (
          <div key={l.label}>
            <dt>{l.label}</dt>
            <dd className={l.known ? '' : 'val-warn'}>{l.value}</dd>
          </div>
        ))}
      </dl>
      <span className="small">{caveat}</span>
    </section>
  );
}

interface BulkResult {
  summary: { requested: number; approved: number; failed: number; partial: boolean };
  results: Array<{ approvalId: string; outcome: 'APPROVED' | 'FAILED'; code: string | null; message: string; packetStatus: string | null }>;
}
