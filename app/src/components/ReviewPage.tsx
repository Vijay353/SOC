import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { QueueItem, RequestView, Session } from '../types';
import { ErrorBanner, personName, StateBadge } from '../ui';
import { track } from '../analytics';
import { RequestWorkspace } from './RequestWorkspace';

interface Props {
  session: Session | null;
  onChanged: () => void;
  /** CH-13: demo-only identity switch, offered on a blocked action. */
  onSwitchUser?: (userId: string) => void;
}

/** Remembered across remounts (identity switches) so the reviewer keeps their place. */
let rememberedTarget: string | null = null;

export function ReviewPage({ session, onChanged, onSwitchUser }: Props) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [target, setTarget] = useState<string | null>(rememberedTarget);
  const [view, setView] = useState<RequestView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [stageResult, setStageResult] = useState<Record<string, unknown> | null>(null);

  const workspaceRef = useRef<HTMLElement>(null);
  const keyOf = (q: QueueItem) => `${q.incidentId}|${q.machineId}`;
  const selected = queue?.find((q) => keyOf(q) === target) ?? null;

  const [queueFailed, setQueueFailed] = useState(false);
  const loadQueue = useCallback(async () => {
    try {
      const r = await api<{ value: QueueItem[] }>('GET', '/queue');
      setQueue(r.value);
      setQueueFailed(false);
      return r.value;
    } catch (e) {
      setQueueFailed(true);
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      return null;
    }
  }, []);

  const loadView = useCallback(async (requestId: string) => {
    try {
      setView(await api<RequestView>('GET', `/requests/${requestId}`));
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    // On narrow screens the queue stacks above the workspace; bring the selected review into view.
    if (target && target !== rememberedTarget && window.innerWidth < 1100) workspaceRef.current?.scrollIntoView({ block: 'start' });
    rememberedTarget = target;
    setStageResult(null);
    setError(null);
    if (selected?.latestRequest) void loadView(selected.latestRequest.requestId);
    else setView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, selected?.latestRequest?.requestId]);

  const refreshAll = async (requestId?: string) => {
    await loadQueue();
    if (requestId) await loadView(requestId);
    onChanged();
  };

  const prepare = async () => {
    if (!selected) return;
    track('scenario_started');
    setBusy('prepare');
    setError(null);
    try {
      const eventId = `evt-${selected.incidentId.toLowerCase()}-isolate-${Date.now().toString(36)}`;
      const r = await api<{ requestId: string; duplicate: boolean; view: RequestView }>('POST', '/events/manual-isolation-requested', {
        eventId,
        incidentId: selected.incidentId,
        machineId: selected.machineId,
        requestedAction: 'FULL_ISOLATION',
      });
      setView(r.view);
      await refreshAll(r.requestId);
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const stage = async () => {
    if (!view) return;
    setBusy('stage');
    setError(null);
    try {
      const r = await api<{ result: Record<string, unknown>; view: RequestView }>('POST', `/requests/${view.request.requestId}/stage`);
      setStageResult(r.result);
      setView(r.view);
      track('scenario_completed');
      await refreshAll(view.request.requestId);
    } catch (e) {
      const body = (e as ApiError).body as { view?: RequestView } | null;
      if (body?.view) setView(body.view);
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      await loadQueue();
    } finally {
      setBusy(null);
    }
  };

  const reevaluate = async () => {
    if (!view) return;
    setBusy('evaluate');
    setError(null);
    try {
      setView(await api<RequestView>('POST', `/requests/${view.request.requestId}/evaluate`));
      await refreshAll(view.request.requestId);
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const scenarioLabel = (q: QueueItem) =>
    [...(session?.scenarios ?? []), ...(session?.optionalScenarios ?? []).flatMap((o) => o.queueLabels)].find((s) => s.incidentId === q.incidentId && s.machineId === q.machineId)?.label;

  return (
    <div className="review-layout">
      <aside className="queue" aria-label="Manual response queue">
        <h2>Manual response queue</h2>
        <p className="queue-hint">Active incidents with a device an analyst may want to isolate. Pick one to prepare a review.</p>
        {!queue && !queueFailed && <p className="queue-hint">Loading…</p>}
        {!queue && queueFailed && (
          <p className="queue-hint" data-testid="queue-empty">
            The queue could not be loaded.{' '}
            <button className="btn btn-sm" onClick={() => void loadQueue()}>
              Try again
            </button>
          </p>
        )}
        {queue && queue.length === 0 && (
          <p className="queue-hint" data-testid="queue-empty">
            No active incidents right now. When an incident with a device is active, it appears here.
          </p>
        )}
        <ul>
          {queue?.map((q) => (
            <li key={keyOf(q)} className="queue-item" data-active={keyOf(q) === target}>
              <button
                onClick={() => {
                  setTarget(keyOf(q));
                  track('record_opened');
                }}
                aria-current={keyOf(q) === target ? 'true' : undefined} data-testid={`queue-${q.incidentId}`}>
                <span className="row" style={{ justifyContent: 'space-between' }}>
                  <span className="queue-host">{q.computerDnsName}</span>
                  {q.latestRequest ? <StateBadge state={q.latestRequest.state} /> : <span className="badge">No review</span>}
                </span>
                <span className="queue-title">{q.displayName}</span>
                <span className="queue-meta">
                  {q.incidentId} · r{q.revision} · {q.severity}
                  {scenarioLabel(q) ? ` · ${scenarioLabel(q)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section aria-live="polite" ref={workspaceRef}>
        <ErrorBanner error={error} />
        {error?.code === 'ROLE_NOT_PERMITTED' && <DemoSwitch session={session} onSwitchUser={onSwitchUser} />}
        {!selected && target && !queue && <div className="panel">Loading review…</div>}
        {!selected && !(target && !queue) && (
          <div className="empty">
            <h2>Check business impact before a high-risk containment</h2>
            <p>Before a manual Full isolation runs, the Gate reconciles Defender evidence with CMDB ownership, live dependencies, change freezes and cited runbook constraints.</p>
            <ol>
              <li>Pick a device from the queue (the SAP gateway is the primary scenario).</li>
              <li>Select <strong>Prepare isolation review</strong> to evaluate current evidence.</li>
              <li>If the policy requires it, stage one verified dual-approval packet. No device is ever changed.</li>
            </ol>
          </div>
        )}
        {selected && !view && (
          <div className="panel">
            <div className="eyebrow">Proposed manual response</div>
            <h1 style={{ margin: '4px 0 6px', fontSize: 24 }}>Full isolate {selected.computerDnsName}</h1>
            <p className="muted" style={{ marginTop: 0 }}>
              {selected.incidentId} · {selected.displayName} · {selected.alertCount} alert(s) · device currently {selected.isolationState.replace('_', ' ').toLowerCase()}
            </p>
            <p>The Gate will read Defender, CMDB, live-activity and runbook evidence, then apply policy {session?.policy.version ?? '(loading)'}. Evaluating changes nothing upstream.</p>
            <button className="btn btn-primary" onClick={prepare} disabled={busy !== null || !!session?.setupError}>
              {busy === 'prepare' ? 'Evaluating evidence…' : 'Prepare isolation review'}
            </button>
          </div>
        )}
        {selected && view && (
          <RequestWorkspace
            view={view}
            busy={busy}
            stageResult={stageResult}
            onStage={stage}
            onReevaluate={reevaluate}
            onNewReview={() => {
              setView(null);
              void prepare();
            }}
          />
        )}
      </section>
    </div>
  );
}

const ROLE_WORDS: Record<string, string> = { ANALYST: 'SOC analyst', INCIDENT_COMMANDER: 'SOC incident commander', SERVICE_OWNER: 'service owner' };

/** CH-13: only in SIMULATED mode, and only when an identity with a role the server allows exists. Not authentication. */
function DemoSwitch({ session, onSwitchUser }: { session: Session | null; onSwitchUser?: (userId: string) => void }) {
  if (!session || session.mode !== 'SIMULATED' || !onSwitchUser) return null;
  const allowed = session.eligibleRoles?.requestActions ?? [];
  // Prefer someone on call; otherwise any eligible, active identity.
  const eligible = session.identities.filter((i) => allowed.includes(i.role) && i.active !== false);
  const target = eligible.find((i) => i.onCall) ?? eligible[0];
  if (!target) return null;
  const name = personName(target.displayName);
  return (
    <div className="banner banner-info" role="status" data-testid="demo-switch">
      Only a {allowed.map((r) => ROLE_WORDS[r] ?? r).join(' or ')} can do this.{' '}
      <button className="btn btn-sm" onClick={() => onSwitchUser(target.userId)}>
        Demo: switch to {name} ({ROLE_WORDS[target.role] ?? target.role})
      </button>{' '}
      <span className="small muted">This switches the demo identity. It is not a sign-in.</span>
    </div>
  );
}
