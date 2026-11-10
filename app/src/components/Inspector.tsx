import { useState } from 'react';
import { api, ApiError } from '../api';
import { auditCheckText, type AuditCheck } from '../auditCheck';
import type { RequestView, TraceStep } from '../types';
import { fmtDateTime, Json } from '../ui';

type Sub = 'trace' | 'policy' | 'evidence' | 'tool' | 'audit';

/** Secondary, truthful technical view. Everything shown here is read from persisted execution records. */
export function Inspector({ view }: { view: RequestView }) {
  const [sub, setSub] = useState<Sub>('trace');
  const ev = view.evaluation;
  return (
    <details className="inspector" data-testid="inspector">
      <summary>
        <span>Technical evidence</span>
        <span className="hint">event · source versions · extraction citations · policy · tool payload · read-back · audit hash chain</span>
      </summary>
      <div className="inspector-body">
        <div className="subtabs" role="tablist" aria-label="Technical evidence views">
          {(
            [
              ['trace', `Execution trace (${view.runs.length} runs)`],
              ['policy', 'Policy input'],
              ['evidence', 'Evidence & citations'],
              ['tool', 'Tool payload & read-back'],
              ['audit', `Audit (${view.audit.length})`],
            ] as Array<[Sub, string]>
          ).map(([id, label]) => (
            <button key={id} role="tab" className="subtab" aria-selected={sub === id} onClick={() => setSub(id)}>
              {label}
            </button>
          ))}
        </div>

        {sub === 'trace' && (
          <div className="stack">
            {view.runs.map((run) => (
              <div key={run.runId}>
                <div className="row small">
                  <strong>{run.kind}</strong> <code>{run.runId}</code> · by {run.actor} · {fmtDateTime(run.startedAt)} → <strong>{run.outcome}</strong>
                </div>
                <ol className="trace" style={{ marginTop: 6 }}>
                  {run.trace.map((s) => (
                    <TraceRow key={s.seq} step={s} />
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}

        {sub === 'policy' && ev && (
          <div className="grid-2">
            <div>
              <h3 className="small eyebrow">Policy input ({view.policyVersion})</h3>
              <Json value={ev.policyInput} />
            </div>
            <div>
              <h3 className="small eyebrow">Decision</h3>
              <Json value={{ decision: ev.decision, reasonCodes: ev.reasonCodes, evaluationId: ev.evaluationId, validUntil: ev.validUntil, incidentRevision: ev.incidentRevision }} />
            </div>
          </div>
        )}

        {sub === 'evidence' && ev && (
          <div className="stack">
            <div>
              <h3 className="small eyebrow">Evidence hashes (SHA-256 of canonical snapshots)</h3>
              <table className="data">
                <tbody>
                  {Object.entries(ev.evidenceHashes).map(([k, v]) => (
                    <tr key={k}>
                      <th scope="row">{k}</th>
                      <td>
                        <code>{v}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="small eyebrow">Extraction ({ev.summary.business.extraction?.provider ?? 'not run'})</h3>
              <Json value={{ constraints: ev.summary.business.constraints, ...(ev.summary.business.extraction ?? {}) }} />
            </div>
            <div>
              <h3 className="small eyebrow">Business evidence snapshot</h3>
              <Json value={{ configItem: ev.summary.business.configItem, liveActivity: ev.summary.business.liveActivity, changeFreeze: ev.summary.business.changeFreeze, dependencySample: ev.summary.business.dependencySample, notes: ev.summary.business.notes }} />
            </div>
          </div>
        )}

        {sub === 'tool' && (
          <div className="grid-2">
            <div>
              <h3 className="small eyebrow">stageContainmentApproval payload (outbox)</h3>
              {ev?.stageInput ? <Json value={{ ...ev.stageInput, idempotencyKey: `${String(ev.stageInput.idempotencyKey).slice(0, 16)}…` }} /> : <p className="muted">Not called for this evaluation.</p>}
            </div>
            <div>
              <h3 className="small eyebrow">Independent read-back from Mock ITSM</h3>
              {view.packet ? <Json value={view.packet} /> : <p className="muted">No packet.</p>}
              {view.request.lastError ? (
                <>
                  <h3 className="small eyebrow">Last error</h3>
                  <Json value={view.request.lastError} />
                </>
              ) : null}
            </div>
          </div>
        )}

        {sub === 'audit' && <AuditVerify />}
        {sub === 'audit' && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>At</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Details</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {view.audit.map((a) => (
                  <tr key={a.seq}>
                    <td>{a.seq}</td>
                    <td className="mono">{a.at.slice(11, 19)}</td>
                    <td>{a.actor}</td>
                    <td>
                      <code>{a.action}</code>
                    </td>
                    <td className="mono small">{JSON.stringify(a.details).slice(0, 160)}</td>
                    <td className="mono small" title={a.hash}>
                      {a.hash.slice(0, 10)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}

function TraceRow({ step }: { step: TraceStep }) {
  const tone = step.status === 'ok' ? 'badge-ok' : step.status === 'failed' ? 'badge-danger' : step.status === 'blocked' ? 'badge-warn' : 'badge-info';
  return (
    <li className="trace-step">
      <div className="trace-head">
        <span className={`badge ${tone}`}>{step.status.toUpperCase()}</span>
        <code>{step.step}</code>
        <span className="trace-time">{step.at.slice(11, 19)}</span>
      </div>
      {step.calls.map((c, i) => (
        <div key={i} className="call-line">
          {c.method} {c.system}
          {c.path} →{' '}
          {c.attempts.map((a) => `#${a.attempt} ${a.status ?? a.outcome}${a.fault ? ` [fault:${a.fault}]` : ''} ${a.durationMs}ms`).join(' · ')}
        </div>
      ))}
      {step.summary !== null && step.summary !== undefined && (
        <details>
          <summary className="small muted">details</summary>
          <Json value={step.summary} />
        </details>
      )}
    </li>
  );
}

/** CH-17: re-checks the whole Gate audit chain on the server and shows the result in plain words. */
function AuditVerify() {
  const [result, setResult] = useState<(AuditCheck & { notCovered: string[]; limitations: string }) | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setFailed(null);
    try {
      setResult(await api('GET', '/audit/verify'));
    } catch (e) {
      setFailed(`${(e as ApiError).code ?? 'ERROR'}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ marginBottom: 8 }}>
      <div className="row">
        <button className="btn btn-sm" onClick={() => void run()} disabled={busy} data-testid="audit-verify">
          {busy ? 'Checking…' : 'Check the audit log'}
        </button>
        <span className="small muted">Checks every entry in the Gate audit log, not only this request.</span>
      </div>
      {failed && <p role="alert">{failed}</p>}
      {result && (
        <div role="status" data-testid="audit-verify-result">
          <p className={result.intact ? '' : 'badge badge-danger'}>{auditCheckText(result)}</p>
          <p className="small muted">
            Not covered: {result.notCovered.join('; ')}. {result.limitations}
          </p>
        </div>
      )}
    </div>
  );
}
