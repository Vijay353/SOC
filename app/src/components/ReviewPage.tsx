import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { QueueItem, RequestView, Session } from '../types';
import { ErrorBanner, personName, StateBadge } from '../ui';
import { track } from '../analytics';
import { MetricsStrip } from './MetricsStrip';
import { RequestWorkspace } from './RequestWorkspace';
import { triage } from '../triage';

interface Props {
  session: Session | null;
  onChanged: () => void;
  /** CH-13: demo-only identity switch, offered on a blocked action. */
  onSwitchUser?: (userId: string) => void;
  /** CH-18: Present mode pins the metrics strip. */
  present?: boolean;
}

/** Remembered across remounts (identity switches) so the reviewer keeps their place. */
let rememberedTarget: string | null = null;

export function ReviewPage({ session, onChanged, onSwitchUser, present = false }: Props) {
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [target, setTarget] = useState<string | null>(rememberedTarget);
  const [view, setView] = useState<RequestView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [stageResult, setStageResult] = useState<Record<string, unknown> | null>(null);

  const workspaceRef = useRef<HTMLElement>(null);
  const scrollWhenReady = useRef(false);
  const keyOf = (q: QueueItem) => `${q.incidentId}|${q.machineId}`;
  const selected = queue?.find((q) => keyOf(q) === target) ?? null;

  const [queueFailed, setQueueFailed] = useState(false);
  const [metricsVersion, setMetricsVersion] = useState(0);
  const loadQueue = useCallback(async () => {
    try {
      const r = await api<{ value: QueueItem[] }>('GET', '/queue');
      setQueue(r.value);
      setMetricsVersion((v) => v + 1);
      setQueueFailed(false);
      return r.value;
    } catch (e) {
      setQueueFailed(true);
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      return null;
    }
  }, []);

  // B11: responses that arrive after the person picked another device are dropped. Without this, a slow reload of
  // device A could render A's decision while device B is selected.
  const targetRef = useRef<string | null>(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  const stillCurrent = (forTarget: string | null) => targetRef.current === forTarget;

  const loadView = useCallback(async (requestId: string, forTarget: string | null = targetRef.current) => {
    try {
      const v = await api<RequestView>('GET', `/requests/${requestId}`);
      if (targetRef.current === forTarget) setView(v);
    } catch (e) {
      if (targetRef.current === forTarget) setError({ code: (e as ApiError).code, message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    // On narrow screens the queue stacks above the workspace; bring the selected review into view.
    if (target && target !== rememberedTarget && window.innerWidth < 1100) {
      workspaceRef.current?.scrollIntoView({ block: 'start' });
      // The queue above may regroup once the check finishes; scroll again when the decision has rendered.
      scrollWhenReady.current = true;
    }
    rememberedTarget = target;
    setStageResult(null);
    setError(null);
    if (selected?.latestRequest) void loadView(selected.latestRequest.requestId);
    else setView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, selected?.latestRequest?.requestId]);

  /** forTarget: the selection when the operation started; a view for an older selection is never shown. */
  useEffect(() => {
    if (view && scrollWhenReady.current) {
      scrollWhenReady.current = false;
      workspaceRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [view, queue]);

  const refreshAll = async (requestId: string | undefined, forTarget: string | null) => {
    await loadQueue();
    if (requestId) await loadView(requestId, forTarget);
    onChanged();
  };

  const prepare = async (item: QueueItem | null = selected) => {
    if (!item) return;
    track('scenario_started');
    setBusy('prepare');
    setError(null);
    try {
      const eventId = `evt-${item.incidentId.toLowerCase()}-isolate-${Date.now().toString(36)}`;
      const r = await api<{ requestId: string; duplicate: boolean; view: RequestView }>('POST', '/events/manual-isolation-requested', {
        eventId,
        incidentId: item.incidentId,
        machineId: item.machineId,
        requestedAction: 'FULL_ISOLATION',
      });
      if (stillCurrent(keyOf(item))) setView(r.view);
      await refreshAll(r.requestId, keyOf(item));
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const stage = async () => {
    if (!view) return;
    const forTarget = targetRef.current;
    setBusy('stage');
    setError(null);
    try {
      const r = await api<{ result: Record<string, unknown>; view: RequestView }>('POST', `/requests/${view.request.requestId}/stage`);
      if (stillCurrent(forTarget)) {
        setStageResult(r.result);
        setView(r.view);
      }
      track('scenario_completed');
      await refreshAll(view.request.requestId, forTarget);
    } catch (e) {
      const body = (e as ApiError).body as { view?: RequestView } | null;
      if (body?.view && stillCurrent(forTarget)) setView(body.view);
      setError({ code: (e as ApiError).code, message: (e as Error).message });
      await loadQueue();
    } finally {
      setBusy(null);
    }
  };

  const reevaluate = async () => {
    if (!view) return;
    const forTarget = targetRef.current;
    setBusy('evaluate');
    setError(null);
    try {
      const v = await api<RequestView>('POST', `/requests/${view.request.requestId}/evaluate`);
      if (stillCurrent(forTarget)) setView(v);
      await refreshAll(view.request.requestId, forTarget);
    } catch (e) {
      setError({ code: (e as ApiError).code, message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // CH-16: the primary seeded scenario, offered as a one-press example on first visit.
  const primary = session?.scenarios[0];
  const example = queue?.find((q) => primary && q.incidentId === primary.incidentId && q.machineId === primary.machineId) ?? null;
  const showExample = async () => {
    if (!example) return;
    setTarget(keyOf(example));
    track('record_opened');
    await prepare(example);
  };

  const scenarioLabel = (q: QueueItem) =>
    [...(session?.scenarios ?? []), ...(session?.optionalScenarios ?? []).flatMap((o) => o.queueLabels)].find((s) => s.incidentId === q.incidentId && s.machineId === q.machineId)?.label;

  return (
    <>
      {/* Pinned on top only in Present mode; otherwise at the bottom so it never shifts the decision while it loads. */}
      {present && <MetricsStrip version={metricsVersion} pinned />}
      <div className={`review-layout ${selected ? '' : 'nothing-selected'}`}>
        <aside className="queue" aria-label="Manual response queue">
          <h2>Containment requests</h2>
          <p className="queue-hint">Devices an analyst may want to cut off from the network. Pick one to check its business impact.</p>
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
          {queue &&
            triage(queue).map((g) => (
              <div key={g.group} className="queue-group" data-testid={`queue-group-${g.group}`}>
                <h3 className="queue-group-title">
                  {g.label} <span className="queue-group-count">{g.items.length}</span>
                </h3>
                <ul>
                  {g.items.map((q) => (
                    <li key={keyOf(q)} className="queue-item" data-active={keyOf(q) === target}>
                      <button
                        onClick={() => {
                          setTarget(keyOf(q));
                          track('record_opened');
                        }}
                        aria-current={keyOf(q) === target ? 'true' : undefined}
                        data-testid={`queue-${q.incidentId}`}
                      >
                        <span className="queue-row">
                          <span className="queue-host">{q.computerDnsName}</span>
                          {q.latestRequest ? <StateBadge state={q.latestRequest.state} /> : <span className="badge">Not checked yet</span>}
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
              </div>
            ))}
        </aside>

        <section aria-live="polite" ref={workspaceRef}>
          <ErrorBanner error={error} />
          {error?.code === 'ROLE_NOT_PERMITTED' && <DemoSwitch session={session} onSwitchUser={onSwitchUser} />}
          {!selected && target && !queue && <div className="panel">Loading review…</div>}
          {!selected && !(target && !queue) && (
            <div className="empty story" data-testid="first-run">
              <h2>Check business impact before a high-risk containment</h2>
              <p className="story-lead">Cutting a device off the network stops an attacker. On the wrong device it can also stop a warehouse, a payment system or a factory line.</p>
              <ol className="story-steps">
                <li>
                  <strong>The risk.</strong> One click on <em>Full isolation</em> in Defender can interrupt a business service nobody checked.
                </li>
                <li>
                  <strong>What the Gate does.</strong> It checks the device against business records (owner, live users, change freezes, runbooks) and decides whether two owners must approve first.
                </li>
                <li>
                  <strong>What it never does.</strong> It never isolates anything. Every name and number here is synthetic demo data.
                </li>
              </ol>
              {example && (
                <button className="btn btn-primary btn-lg" onClick={() => void showExample()} disabled={busy !== null || !!session?.setupError} data-testid="show-example">
                  {busy === 'prepare' ? 'Checking the evidence…' : `Show me the ${example.computerDnsName} example`}
                </button>
              )}
              <p className="small muted">Or pick any device from the list. Checking reads evidence only; nothing upstream changes.</p>
            </div>
          )}
          {selected && !view && (
            <div className="panel">
              <div className="eyebrow">Proposed manual response</div>
              <h1 style={{ margin: '4px 0 6px', fontSize: 'var(--text-2xl)' }}>Full isolate {selected.computerDnsName}</h1>
              <p className="muted" style={{ marginTop: 0 }}>
                {selected.incidentId} · {selected.displayName} · {selected.alertCount} alert(s) · device currently {selected.isolationState.replace('_', ' ').toLowerCase()}
              </p>
              <p>The Gate will read Defender, CMDB, live-activity and runbook evidence, then apply policy {session?.policy.version ?? '(loading)'}. Checking changes nothing upstream.</p>
              <button className="btn btn-primary btn-lg" onClick={() => void prepare()} disabled={busy !== null || !!session?.setupError}>
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
      {!present && <MetricsStrip version={metricsVersion} pinned={false} />}
    </>
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
