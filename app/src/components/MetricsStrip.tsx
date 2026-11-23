import { useEffect, useState } from 'react';
import { api } from '../api';
import { MetricTile } from './primitives';

export interface Metrics {
  computedAt: string;
  requestsChecked: number;
  approvalRequestsCreated: number;
  waitingForApproval: number;
  approvedForManualExecution: number;
  blockedOrEscalated: number;
  containmentExecutedByGate: number;
  containmentExecutedByAnyone: number;
  auditChain: { intact: boolean; length: number };
}

const HIDE_KEY = 'gate.metrics.hidden';
const readHidden = () => {
  try {
    return sessionStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * Product-clarity CH-17: live counts for this demo workspace, read from GET /api/metrics every time `version` changes.
 * Shown once something has been checked (a first visit stays calm), always in Present mode. Hiding lasts for this
 * browser session only.
 */
export function MetricsStrip({ version, pinned }: { version: number; pinned: boolean }) {
  const [m, setM] = useState<Metrics | null>(null);
  const [hidden, setHidden] = useState(readHidden);
  useEffect(() => {
    let live = true;
    api<Metrics>('GET', '/metrics')
      .then((r) => live && setM(r))
      .catch(() => live && setM(null));
    return () => {
      live = false;
    };
  }, [version]);

  if (!m || (!pinned && (hidden || m.requestsChecked === 0))) return null;
  return (
    <section className="metrics-strip" aria-labelledby="metrics-h" data-testid="metrics-strip">
      <div className="metrics-head">
        <h2 id="metrics-h">This demo workspace · live counts</h2>
        {!pinned && (
          <button
            className="btn btn-sm btn-quiet-light"
            onClick={() => {
              try {
                sessionStorage.setItem(HIDE_KEY, '1');
              } catch {
                /* storage unavailable: hide for this page only */
              }
              setHidden(true);
            }}
          >
            Hide
          </button>
        )}
      </div>
      <div className="metrics-grid">
        <MetricTile label="Containment actions executed by the Gate" value={m.containmentExecutedByGate} tone={m.containmentExecutedByGate === 0 ? 'ok' : 'danger'} note="Counted from the simulator's isolation records" testId="metric-gate-executed" />
        <MetricTile label="Requests checked" value={m.requestsChecked} testId="metric-checked" />
        <MetricTile label="Sent for dual approval" value={m.approvalRequestsCreated} note={m.waitingForApproval ? `${m.waitingForApproval} waiting` : undefined} testId="metric-sent" />
        <MetricTile label="Approved for manual execution" value={m.approvedForManualExecution} testId="metric-approved" />
        <MetricTile label="Stopped for evidence or review" value={m.blockedOrEscalated} testId="metric-blocked" />
        <MetricTile label="Audit log" value={m.auditChain.intact ? 'Intact' : 'Broken'} tone={m.auditChain.intact ? undefined : 'danger'} note={`${m.auditChain.length} entries, local check`} testId="metric-audit" />
      </div>
    </section>
  );
}
