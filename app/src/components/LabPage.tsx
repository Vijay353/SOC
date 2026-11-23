import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Session } from '../types';
import { ErrorBanner, fmtDateTime, Json } from '../ui';

interface Props {
  session: Session | null;
  onChanged: () => void;
}

interface FaultState {
  security: { mode: string; target: string; remaining: number; latencyMs: number };
  itsm: { mode: string; target: string; remaining: number; latencyMs: number };
  modes: string[];
}

const PRESETS: Array<{ label: string; system: 'security' | 'itsm'; mode: string; target: string; remaining: number; latencyMs: number; help: string }> = [
  { label: 'ITSM outage (reads, until cleared)', system: 'itsm', mode: 'http_503', target: 'reads', remaining: -1, latencyMs: 0, help: 'Evaluation fails closed with SOURCE_UNAVAILABLE.' },
  { label: 'ITSM throttles one write (429)', system: 'itsm', mode: 'http_429', target: 'writes', remaining: 1, latencyMs: 0, help: 'Staging retries with jitter and succeeds; trace shows two attempts.' },
  { label: 'ITSM write commits but response times out', system: 'itsm', mode: 'timeout_after_commit', target: 'writes', remaining: 1, latencyMs: 2500, help: 'Retry returns the existing packet (duplicate=true). No second packet.' },
  { label: 'ITSM corrupts the next read-back', system: 'itsm', mode: 'corrupt_readback', target: 'reads', remaining: 1, latencyMs: 0, help: 'Gate refuses to claim success → VERIFICATION_FAILED.' },
  { label: 'Security simulator rejects token (401)', system: 'security', mode: 'http_401', target: 'all', remaining: -1, latencyMs: 0, help: 'Evaluation marks mock-security unavailable (auth).' },
  { label: 'Security simulator 500s twice', system: 'security', mode: 'http_500', target: 'reads', remaining: 2, latencyMs: 0, help: 'Idempotent reads retry and recover.' },
];

/** Demo-only simulator management. Not part of the Gate's trust boundary. */
export function LabPage({ session, onChanged }: Props) {
  const [faults, setFaults] = useState<FaultState | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const [incident, setIncident] = useState('INC-90482');
  const [auditSystem, setAuditSystem] = useState<'security' | 'itsm'>('itsm');
  const [audit, setAudit] = useState<unknown[] | null>(null);

  const loadFaults = useCallback(async () => {
    try {
      setFaults(await api<FaultState>('GET', '/lab/faults'));
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void loadFaults();
  }, [loadFaults]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      setOutput(await fn());
      await loadFaults();
      onChanged();
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      setOutput((e as ApiError).body ?? null);
    }
  };

  return (
    <div>
      <div className="banner banner-info lab-frame" data-testid="lab-frame">
        <strong>Demo controls, not part of the Gate.</strong> These buttons make the simulated Defender and ITSM misbehave so you can see the Gate fail safely. A real deployment has none of them.
      </div>
      <ErrorBanner error={error} />
      <div className="grid-2">
        <section className="panel">
          <h2>Start over</h2>
          <p className="lead">
            Reset puts all three demo stores (Mock Security, Mock ITSM, Gate) back to the synthetic starting data and rewinds the scenario clock to {session ? fmtDateTime(session.clock.scenarioStart) : '…'}.
          </p>
          <div className="row">
            {session?.demoReset?.allowed === false ? (
              <p className="small muted">Reset scenario is disabled in production.</p>
            ) : (
              <button className="btn btn-primary" onClick={() => run(() => api('POST', '/lab/reset'))} data-testid="reset-scenario">
                Reset scenario
              </button>
            )}
          </div>
        </section>

        <section className="panel">
          <h2>Optional scenarios</h2>
          <p className="lead">Extra synthetic records added on top of the current data. The base scenario is not changed. Reset removes them.</p>
          {(session?.optionalScenarios ?? []).map((o) => (
            <div key={o.name} className="row" style={{ marginBottom: 8 }}>
              <button className="btn btn-sm" onClick={() => run(() => api('POST', `/lab/scenarios/${o.name}`))} data-testid={`load-scenario-${o.name}`}>
                Load
              </button>
              <span>
                <strong>{o.label}</strong> <span className="muted small">{o.description}</span>
              </span>
            </div>
          ))}
        </section>
      </div>

      <section className="panel">
        <h2>Failure drills</h2>
        <p className="lead">Each drill makes the next calls fail inside a simulator, so the Gate meets real HTTP errors, delays and corrupted answers. Then go back to Review and try again.</p>
        <div className="row small" style={{ marginBottom: 10 }}>
          <span>
            Mock Security: <code>{faults ? `${faults.security.mode} (${faults.security.target}, remaining ${faults.security.remaining})` : '…'}</code>
          </span>
          <span>
            Mock ITSM: <code>{faults ? `${faults.itsm.mode} (${faults.itsm.target}, remaining ${faults.itsm.remaining})` : '…'}</code>
          </span>
        </div>
        <div className="stack">
          {PRESETS.map((p) => (
            <div key={p.label} className="row">
              <button className="btn btn-sm" onClick={() => run(() => api('POST', '/lab/faults', { system: p.system, mode: p.mode, target: p.target, remaining: p.remaining, latencyMs: p.latencyMs }))}>
                Inject
              </button>
              <span>
                <strong>{p.label}</strong> <span className="muted small">{p.help}</span>
              </span>
            </div>
          ))}
          <div className="row">
            <button
              className="btn btn-sm"
              onClick={() =>
                run(async () => {
                  await api('POST', '/lab/faults', { system: 'security', mode: 'none' });
                  return api('POST', '/lab/faults', { system: 'itsm', mode: 'none' });
                })
              }
              data-testid="clear-faults"
            >
              Clear all faults
            </button>
          </div>
        </div>
      </section>

      {output !== null && (
        <section className="panel" data-testid="lab-last-result">
          <h2>Last action</h2>
          <p style={{ marginTop: 0 }}>{error ? 'The last action failed; the message is shown above.' : 'Done. The simulator accepted the change.'}</p>
          <details>
            <summary className="small">Show the raw response</summary>
            <Json value={output} />
          </details>
        </section>
      )}

      <details className="panel advanced" data-testid="lab-advanced">
        <summary>
          <strong>Advanced simulator controls</strong> <span className="small muted">clock, concurrency, least privilege, simulator logs</span>
        </summary>

        <section className="advanced-block">
          <h3>Scenario clock</h3>
          <div className="row">
            <button className="btn" onClick={() => run(() => api('POST', '/lab/clock', { advanceMinutes: 6 }))}>
              Advance clock +6 min
            </button>
            <button className="btn" onClick={() => run(() => api('POST', '/lab/clock', { advanceMinutes: 16 }))} data-testid="advance-16">
              Advance clock +16 min
            </button>
          </div>
          <p className="small muted">
            Clock mode: {session?.clock.mode} · manual offset {session?.clock.manualOffsetMinutes ?? 0} min. +6 min expires an unstaged evaluation; +16 min expires a staged approval packet.
          </p>
        </section>

        <section className="advanced-block">
          <h3>Concurrency & least privilege</h3>
          <p className="small muted">Simulate another analyst editing the incident (If-Match revision bump), or prove the Gate token cannot isolate.</p>
          <div className="row">
            <label className="field">
              Incident
              <select value={incident} onChange={(e) => setIncident(e.target.value)}>
                {(session?.scenarios ?? []).map((s) => (
                  <option key={s.incidentId} value={s.incidentId}>
                    {s.incidentId}: {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" onClick={() => run(() => api('POST', `/lab/incidents/${incident}/concurrent-update`))} data-testid="concurrent-update">
              Concurrent incident update
            </button>
            <button className="btn" onClick={() => run(() => api('POST', '/lab/least-privilege-check', { machineId: 'device-d8f92a10' }))}>
              Try isolation with Gate token
            </button>
          </div>
        </section>

        <section className="advanced-block">
          <h3>Simulator audit logs</h3>
          <p className="small muted">Append-only logs kept by each simulator. They are separate from the Gate&apos;s own hash-chained audit log.</p>
          <div className="row">
            <select value={auditSystem} onChange={(e) => setAuditSystem(e.target.value as 'security' | 'itsm')} aria-label="Simulator" className="select-input">
              <option value="itsm">Mock ITSM / CMDB</option>
              <option value="security">Mock Microsoft Security</option>
            </select>
            <button className="btn btn-sm" onClick={async () => setAudit((await api<{ value: unknown[] }>('GET', `/lab/simulator-audit?system=${auditSystem}`)).value)}>
              Load
            </button>
            <button className="btn btn-sm" onClick={async () => setOutput(await api('GET', '/lab/notifications'))}>
              Show approver notifications
            </button>
          </div>
          {audit && <Json value={audit.slice(0, 40)} />}
        </section>
      </details>
    </div>
  );
}
