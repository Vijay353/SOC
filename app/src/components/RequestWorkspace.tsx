import type { RequestView } from '../types';
import { fmtDateTime, fmtTime, personLabel, personName, STATE_LABEL, StateBadge } from '../ui';
import { DECISION_WORDS } from '../activity';
import { activitySummary, OPEN_HISTORY_STATES } from '../activity';
import { ageBar } from '../ageBar';
import { historyLine } from '../history';
import { lifecycleSteps, type StepStatus } from '../lifecycle';
import { sourceBadge, type SourceBadgeView } from '../sourceBadge';
import { EvidenceChecks } from './EvidenceChecks';
import { EvidenceExport } from './EvidenceExport';
import { Inspector } from './Inspector';

interface Props {
  view: RequestView;
  busy: string | null;
  stageResult: Record<string, unknown> | null;
  onStage: () => void;
  onReevaluate: () => void;
  onNewReview: () => void;
}

const VERDICT = {
  REQUIRE_DUAL_APPROVAL: { tone: 'v-warn', icon: '!', title: 'Dual approval required' },
  INSUFFICIENT_EVIDENCE: { tone: 'v-danger', icon: '×', title: 'Insufficient evidence: nothing will be staged' },
  MANUAL_REVIEW: { tone: 'v-warn', icon: '?', title: 'Manual review required' },
  STANDARD_RESPONSE_ELIGIBLE: { tone: 'v-ok', icon: '✓', title: 'Standard response path eligible' },
} as const;

export function RequestWorkspace({ view, busy, stageResult, onStage, onReevaluate, onNewReview }: Props) {
  const { request: req, evaluation: ev, packet } = view;
  if (!ev) return <div className="panel">No evaluation recorded yet.</div>;
  const s = ev.summary;
  const v = VERDICT[ev.decision];
  const host = s.threat.device?.computerDnsName ?? req.machineId;
  const b = s.business;
  const ci = b.configItem;
  const terminal = ['STANDARD_RESPONSE_ELIGIBLE', 'APPROVED_FOR_MANUAL_EXECUTION', 'REJECTED', 'EXPIRED'].includes(req.state);
  const reevaluable = ['INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW', 'REEVALUATION_REQUIRED'].includes(req.state);
  const lastError = req.lastError;

  const shownReasons = ev.reasons.filter((r) => !(ev.decision === 'REQUIRE_DUAL_APPROVAL' && r.code === 'FULL_ISOLATION_HIGH_IMPACT'));
  const topReasons = shownReasons.slice(0, 3);
  const moreReasons = shownReasons.length - topReasons.length;
  const verdictLead =
    ev.decision === 'REQUIRE_DUAL_APPROVAL'
      ? 'Security evidence supports containment, but business evidence shows it could disrupt operations:'
      : ev.decision === 'STANDARD_RESPONSE_ELIGIBLE'
        ? 'Current, complete evidence shows no business-impact signal. Executing the isolation remains a separate step in Defender. This Gate never isolates a device.'
        : ev.decision === 'MANUAL_REVIEW'
          ? 'The Gate cannot decide safely on its own:'
          : 'The Gate will not guess. It needs better evidence first:';
  const next = nextAction(view);

  return (
    <div data-testid="workspace">
      <div className="ws-header">
        <div>
          <h1 data-testid="headline">{s.headline}</h1>
          <p className="ws-sub">
            {req.incidentId} · {host} · Manual full-isolation request · Evidence snapshot {fmtTime(ev.createdAt)} · <StateBadge state={req.state} />
          </p>
          {view.deviceHistory && (
            <p className="ws-sub small" data-testid="device-history">
              {historyLine(view.deviceHistory)}
            </p>
          )}
        </div>
        <div className="safety" role="status" aria-label="Current safety state">
          <span className="safety-dot" aria-hidden="true" />
          <div>
            <div className="safety-label">CURRENT SAFETY STATE</div>
            <div className="safety-value" data-testid="safety-state">
              NO CONTAINMENT EXECUTED
            </div>
          </div>
        </div>
      </div>

      <p className="print-only print-banner">
        Decision record · synthetic demo data, conceptual prototype · evidence snapshot {fmtDateTime(ev.createdAt)} · a snapshot, not live state
      </p>

      <div className={`verdict ${v.tone}`} data-testid="verdict">
        <span className="verdict-icon" aria-hidden="true">
          {v.icon}
        </span>
        <div className="verdict-body">
          <p className="verdict-title">{v.title}</p>
          <p className="verdict-text">{verdictLead}</p>
          {ev.decision !== 'STANDARD_RESPONSE_ELIGIBLE' && topReasons.length > 0 && (
            <ul className="verdict-reasons">
              {topReasons.map((r) => (
                <li key={r.code}>{sentence(r.text)}</li>
              ))}
              {moreReasons > 0 && <li className="muted">and {moreReasons} more, shown under How the Gate decided</li>}
            </ul>
          )}
        </div>
        <div className="verdict-code">
          <small>Decision</small>
          <strong>{(DECISION_WORDS[ev.decision] ?? ev.decision).replace(/^\w/, (c) => c.toUpperCase())}</strong>
          <code className="code-secondary" data-testid="decision-code">{ev.decision}</code>
        </div>
      </div>

      {(s.duplicateCheck?.matches.length ?? 0) > 0 && (
        <div className="banner banner-warn" role="status" data-testid="possible-duplicate">
          <strong>Possible duplicate request.</strong>{' '}
          {s.duplicateCheck!.matches.map((m) => `${m.incidentId} already has a request for this device (${STATE_LABEL[m.state].toLowerCase()}${m.approvalId ? `, packet ${m.approvalId}` : ''}, created ${fmtTime(m.createdAt)})`).join('; ')}
          . A second request can be legitimate, for example a new incident on the same device. A person must look at both before anyone acts.
        </div>
      )}

      {lastError && req.state !== 'WAITING_FOR_DUAL_APPROVAL' && (
        <div className={`banner ${req.state === 'VERIFICATION_FAILED' ? 'banner-error' : 'banner-warn'}`} role="alert" data-testid="last-error">
          <strong>{describeLastError(lastError)}</strong> <span className="small">(code: {lastError.code})</span>
        </div>
      )}

      {/* CH-4/CH-5/CH-7: the one next action, what it will do, and where the request is in its real lifecycle. */}
      <section className="nextstep" aria-labelledby="next-h" data-testid="next-step">
        <div className="nextstep-main">
          <h2 id="next-h">What happens next</h2>
          <ol className="stepper" aria-label="Request progress" data-testid="stepper">
            {lifecycleSteps(req.state).map((st) => (
              <li key={st.label} data-status={st.status} data-mark={STEP_MARK[st.status]} aria-current={st.status === 'current' ? 'step' : undefined}>
                <span>
                  {st.label}
                  <span className="sr-only"> ({STEP_WORDS[st.status]})</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="status-line" data-testid="state-transition">
            <span className="muted">Status now:</span> <StateBadge state={req.state} />{' '}
            <code className="code-inline" data-testid="current-state">
              {req.state}
            </code>
          </p>
        </div>
        <div className="cta-col">
          {req.state === 'RESPONSE_READY' && ev.decision === 'REQUIRE_DUAL_APPROVAL' && (
            <button className="btn btn-primary btn-lg" onClick={onStage} disabled={busy !== null} data-testid="stage-button">
              {busy === 'stage' ? 'Sending and verifying…' : 'Send for dual approval'}
            </button>
          )}
          {reevaluable && (
            <button className="btn btn-primary btn-lg" onClick={onReevaluate} disabled={busy !== null} data-testid="reevaluate-button">
              {busy === 'evaluate' ? 'Re-reading evidence…' : 'Re-evaluate with current evidence'}
            </button>
          )}
          {req.state === 'WAITING_FOR_DUAL_APPROVAL' && (
            <button className="btn btn-primary btn-lg" disabled>
              Waiting for approvers
            </button>
          )}
          {terminal && (
            <button className="btn btn-primary btn-lg" onClick={onNewReview} disabled={busy !== null}>
              Start a new review
            </button>
          )}
          {req.state === 'VERIFICATION_FAILED' && (
            <button className="btn btn-primary btn-lg" disabled>
              Escalated: manual reconciliation required
            </button>
          )}
          <p className="cta-note" data-testid="cta-note">
            {next}
          </p>
          <button className="btn btn-sm btn-quiet-light no-print" onClick={() => window.print()} data-testid="print-record">
            Print decision record
          </button>
        </div>
      </section>

      <div className="results">
        {packet && req.state !== 'VERIFICATION_FAILED' && (
          <section className="result result-ok" aria-labelledby="res" data-testid="result">
            <h2 id="res">
              <span aria-hidden="true">✓</span> Approval packet {packet.approvalId} staged and verified
            </h2>
            <dl className="result-grid">
              <div>
                <dt>Incident</dt>
                <dd>{packet.incidentId}</dd>
              </div>
              <div>
                <dt>Approvers</dt>
                <dd>{packet.approverIds.map((a) => approverName(view, a)).join(' + ')}</dd>
              </div>
              <div>
                <dt>Packet status</dt>
                <dd data-testid="packet-status">
                  <StateBadge state={packet.status} />
                </dd>
              </div>
              <div>
                <dt>Read-back</dt>
                <dd className="val-ok">Verified</dd>
              </div>
              <div>
                <dt>Device mutation</dt>
                <dd className="val-ok" data-testid="device-mutation">
                  None
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{fmtTime(packet.expiresAt)}</dd>
              </div>
              {stageResult && 'duplicate' in stageResult && (
                <div>
                  <dt>Already existed</dt>
                  <dd>{stageResult.duplicate ? 'Yes, the existing packet was returned' : 'No, new packet'}</dd>
                </div>
              )}
              <div>
                <dt>Decisions</dt>
                <dd>{packet.decisions.length ? packet.decisions.map((d) => `${approverName(view, d.approverId)}: ${d.decision === 'APPROVE' ? 'approved' : 'rejected'}`).join(', ') : 'none yet'}</dd>
              </div>
            </dl>
            <p className="result-foot">
              {req.state === 'APPROVED_FOR_MANUAL_EXECUTION'
                ? 'Both owners approved. Execution remains a manual Defender action outside this prototype.'
                : req.state === 'REJECTED'
                  ? 'An approver rejected the request. Isolation must not proceed on this evidence.'
                  : req.state === 'EXPIRED'
                    ? 'The packet expired without two approvals. Expiry never approves.'
                    : 'One risky response became owned, reviewable work without changing the endpoint.'}
            </p>
          </section>
        )}
        {req.state === 'VERIFICATION_FAILED' && (
          <section className="result result-fail" aria-labelledby="resf" data-testid="result-failed">
            <h2 id="resf">Read-back did not match, so it is not treated as staged</h2>
            <p style={{ margin: 0 }}>The tool reported success, but the stored packet differs from what was sent. The request is escalated for manual reconciliation; nobody should act on packet {req.approvalId}.</p>
          </section>
        )}
        {!packet && req.state !== 'VERIFICATION_FAILED' && (
          <section className="result result-none" aria-labelledby="resn">
            <h2 id="resn">No approval packet</h2>
            <p className="muted" style={{ margin: 0 }}>
              {ev.decision === 'REQUIRE_DUAL_APPROVAL' ? 'Nothing has been written yet. Staging creates exactly one packet.' : 'This decision does not create approval work. No upstream system was changed.'}
            </p>
          </section>
        )}
        <section className="boundary" aria-labelledby="db">
          <h2 id="db">Who decides what</h2>
          <dl>
            <dt style={{ color: 'var(--accent)' }}>AGENT</dt>
            <dd>Extracts cited constraints; may abstain</dd>
            <dt style={{ color: 'var(--warn)' }}>POLICY</dt>
            <dd>Chooses review path and approvers</dd>
            <dt style={{ color: 'var(--ok)' }}>TOOL</dt>
            <dd>Stages approval only; cannot isolate</dd>
          </dl>
        </section>
      </div>

      <EvidenceChecks checks={s.evidenceChecks} evidenceHashes={ev.evidenceHashes} />

      <h2 className="section-title">How the Gate decided</h2>
      <div className="cards">
        <article className="card" aria-labelledby="c1">
          <h2 className="card-step" id="c1">
            <span className="step-num">1</span>Threat evidence
          </h2>
          <span className="eyebrow">Requested response</span>
          <p className="card-title">Full isolate {host}</p>
          {(['DEFENDER_ENDPOINT', 'THIRD_PARTY_FIREWALL'] as const).map((src) => {
            const alerts = s.threat.alerts.filter((a) => a.source === src);
            if (!alerts.length) return null;
            return (
              <div key={src}>
                <div className={`source-label ${src === 'THIRD_PARTY_FIREWALL' ? 'alt' : ''}`}>{src === 'DEFENDER_ENDPOINT' ? 'MOCK DEFENDER XDR' : 'FIREWALL CORROBORATION'}</div>
                <ul className="plain-list">
                  {alerts.map((a) => (
                    <li key={a.alertId}>
                      {a.title} <span className="muted small">· {fmtTime(a.detectedAt)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <p className="muted small" style={{ margin: 0 }}>
            <SourceBadge view={sourceBadge('defender', s.threat.device?.defenderCriticality)} testId="badge-defender" /> · incident r{s.threat.incident?.revision ?? '?'} · snapshot is synthetic and versioned
          </p>
          {s.threat.untrustedTelemetryIgnored > 0 && (
            <div className="callout callout-warn">
              <b>UNTRUSTED TEXT IGNORED</b>
              {s.threat.untrustedTelemetryIgnored} instruction-like string(s) in alert text were treated as data and did not affect the decision.
            </div>
          )}
          <div className="callout callout-info">
            <b>SECURITY VIEW</b>
            {s.threat.alerts.length > 0 ? 'Security evidence supports urgent response.' : 'No alert evidence could be read for this device.'}
          </div>
        </article>

        <article className="card" aria-labelledby="c2">
          <h2 className="card-step" id="c2">
            <span className="step-num">2</span>Business impact evidence
          </h2>
          <span className="eyebrow">{ci ? `MOCK ITSM CMDB · ${ci.ciId}` : 'MOCK ITSM CMDB'}</span>
          <p className={`card-title ${ci && (ci.tier === 'TIER_0' || ci.tier === 'TIER_1') ? 'danger' : ''}`}>
            {ci ? `${ci.tier.replace('_', ' ').replace('TIER', 'Tier')} · ${ci.businessService}` : identityTitle(b.identity.match)}
          </p>
          {b.identity.match === 'EXACT' && (
            <p className="small" style={{ margin: 0 }}>
              <SourceBadge view={sourceBadge('cmdb', ci?.tier ?? null)} testId="badge-cmdb" />
            </p>
          )}
          {b.identity.match !== 'EXACT' && b.identity.candidates.length > 0 && (
            <div className="callout callout-danger">
              <b>IDENTITY CONFLICT</b>
              {b.identity.candidates.map((c) => `${c.ciId} (${c.name}, ${c.tier})`).join(' and ')} both claim this device.
            </div>
          )}
          {b.unavailableSources.length > 0 && (
            <div className="callout callout-danger">
              <b>SOURCE UNAVAILABLE</b>
              {b.unavailableSources.join(', ')} could not be read after retries. The Gate fails closed.
            </div>
          )}
          {ci && (
            <dl className="kv">
              <div>
                <dt>Active sessions (live)</dt>
                <dd>{b.liveActivity ? b.liveActivity.activeSessionCount.toLocaleString() : 'not available'}</dd>
              </div>
              <div>
                <dt>Active critical workflows</dt>
                <dd>{b.activeCriticalDependencies}</dd>
              </div>
              <div>
                <dt>Change freeze</dt>
                <dd className={b.changeFreeze.active ? 'val-danger' : ''}>{b.changeFreeze.active ? 'ACTIVE' : 'None'}</dd>
              </div>
              <div>
                <dt>CMDB record age</dt>
                <dd className={ci.ageMinutes > ci.maxAgeMinutes ? 'val-danger' : 'val-ok'}>
                  {formatAge(ci.ageMinutes)} · {ci.ageMinutes > ci.maxAgeMinutes ? `stale (max ${ci.maxAgeMinutes} min)` : 'current'}
                </dd>
              </div>
              <div>
                <dt>Service owner</dt>
                <dd>{b.owner ? personLabel(b.owner.displayName) : 'Unresolved'}</dd>
              </div>
            </dl>
          )}
          {ci && (
            <div className="agebars" aria-label="Evidence age compared with the allowed maximum" data-testid="age-bars">
              <AgeBarRow label="CMDB record" age={ci.ageMinutes} limit={ci.maxAgeMinutes} />
              {b.liveActivity && <AgeBarRow label="Live activity summary" age={b.liveActivity.ageMinutes} limit={b.liveActivity.maxAgeMinutes} />}
            </div>
          )}
          {b.constraints.length > 0 && (
            <div className="callout callout-danger" data-testid="constraints">
              <b>CITED RUNBOOK CONSTRAINTS</b>
              <ul className="plain-list">
                {b.constraints
                  .filter((c) => c.category === 'OWNER_APPROVAL' || c.category === 'SERVICE_WINDOW')
                  .map((c, i) => (
                    <li key={i}>
                      <span className="quote">“{c.quote}”</span>{' '}
                      <span className="small">
                        , {c.sourceDocumentId} v{c.sourceVersion}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {b.extraction?.abstain && (
            <div className="callout callout-warn">
              <b>EXTRACTOR ABSTAINED</b>
              {b.extraction.ambiguity.join(' · ')}
            </div>
          )}
        </article>

        <article className="card" aria-labelledby="c3">
          <h2 className="card-step" id="c3">
            <span className="step-num">3</span>Safe next step
          </h2>
          <span className="eyebrow">Deterministic policy · {ev.policyVersion ?? 'version not recorded'}</span>
          <PolicyProvenance view={view} />
          {ev.decision === 'REQUIRE_DUAL_APPROVAL' && (
            <>
              <p className="card-title">Stage one approval packet</p>
              <ul className="check-list">
                {s.nextStep.approvers.map((a) => (
                  <li key={a.userId}>{personLabel(a.displayName)}</li>
                ))}
                <li>{s.nextStep.approvalExpiryMinutes}-minute approval expiry</li>
                <li>Evidence and policy versions attached ({Object.keys(ev.evidenceHashes).length} hashes)</li>
              </ul>
              <div className="callout callout-ok">
                <b>ACTION BOUNDARY</b>Creates approval work only; no endpoint is changed.
              </div>
            </>
          )}
          {ev.decision === 'INSUFFICIENT_EVIDENCE' && (
            <>
              <p className="card-title">Fix the evidence, then re-evaluate</p>
              <ul className="check-list">
                {ev.reasons.map((r) => (
                  <li key={r.code} className="off">
                    {r.text}
                  </li>
                ))}
              </ul>
              <div className="callout callout-warn">
                <b>NO PACKET, NO ACTION</b>Correct the source record (for example in Data Studio) and re-evaluate. The Gate never guesses.
              </div>
            </>
          )}
          {ev.decision === 'MANUAL_REVIEW' && (
            <>
              <p className="card-title">Resolve the conflicting instructions</p>
              <ul className="check-list">
                {(b.extraction?.ambiguity ?? ev.reasons.map((r) => r.text)).map((t) => (
                  <li key={t} className="off">
                    {t}
                  </li>
                ))}
              </ul>
              <div className="callout callout-warn">
                <b>NO PACKET, NO ACTION</b>Ask the document owner to correct the runbook, then re-evaluate.
              </div>
            </>
          )}
          {ev.decision === 'STANDARD_RESPONSE_ELIGIBLE' && (
            <>
              <p className="card-title">Proceed through the normal Defender workflow</p>
              <ul className="check-list">
                <li>CMDB tier {ci?.tier.replace('TIER_', '') ?? '?'} with no active critical workflows</li>
                <li>No change freeze, no owner-approval constraint</li>
                <li>Evidence is current</li>
              </ul>
              <div className="callout callout-info">
                <b>OUTSIDE THIS SLICE</b>The Gate does not execute isolation. The analyst acts in Defender.
              </div>
            </>
          )}
        </article>
      </div>


      <ActivityHistory view={view} />

      <EvidenceExport requestId={view.request.requestId} />

      <Inspector view={view} />
    </div>
  );
}

/** First letter upper case, no trailing full stop: reason texts read as list items. */
function sentence(t: string) {
  const x = t.trim().replace(/\.$/, '');
  return x.charAt(0).toUpperCase() + x.slice(1);
}

function approverName(view: RequestView, userId: string) {
  const a = view.evaluation?.summary.nextStep.approvers.find((p) => p.userId === userId);
  return a ? personLabel(a.displayName) : userId;
}

/** CH-7: one truthful sentence about what the primary button will do, or what is happening, in this state. */
export function nextAction(view: RequestView): string {
  const { request: req, evaluation: ev, packet } = view;
  const approvers = ev?.summary.nextStep.approvers.map((a) => personName(a.displayName)) ?? [];
  switch (req.state) {
    case 'RESPONSE_READY':
      return `Creates one approval request for ${approvers.length ? approvers.join(' and ') : 'two approvers'} in the demo ITSM, then reads it back to verify it. No device is changed.`;
    case 'WAITING_FOR_DUAL_APPROVAL': {
      const done = packet?.decisions.filter((d) => d.decision === 'APPROVE').length ?? 0;
      return `${done} of 2 approvals recorded. Approvers decide in the Approvals tab${packet ? ` before ${fmtTime(packet.expiresAt)}` : ''}. Expiry never approves.`;
    }
    case 'APPROVED_FOR_MANUAL_EXECUTION':
      return 'Both owners approved. The analyst now runs the isolation in Defender; this tool never does. A new review re-checks the evidence from scratch.';
    case 'STANDARD_RESPONSE_ELIGIBLE':
      return 'No approval is needed. The analyst runs the isolation in Defender; the Gate does not. A new review re-checks the evidence from scratch.';
    case 'REJECTED':
      return 'An approver said no. Do not isolate on this evidence. A new review re-checks the evidence from scratch.';
    case 'EXPIRED':
      return 'The approval window closed without two approvals. A new review re-checks the evidence from scratch.';
    case 'INSUFFICIENT_EVIDENCE':
      return 'Fix the source record first (for example in Data Studio). Re-evaluating only reads evidence again; nothing is written to Defender or the ITSM.';
    case 'MANUAL_REVIEW':
      return 'Ask the document owner to resolve the conflict, then re-evaluate. Re-evaluating only reads evidence; nothing is written upstream.';
    case 'REEVALUATION_REQUIRED':
      return 'The evidence changed or is too old. Re-evaluating reads it again; nothing is written upstream until you send for approval.';
    case 'VERIFICATION_FAILED':
      return `Nobody should act on packet ${req.approvalId ?? ''} until a person reconciles it by hand.`;
  }
}

function identityTitle(match: string) {
  if (match === 'AMBIGUOUS') return 'Ambiguous CMDB identity';
  if (match === 'NONE') return 'No CMDB record found';
  return 'CMDB evidence unavailable';
}

function formatAge(min: number) {
  if (min < 90) return `${Math.round(min)} minutes`;
  return `${(min / 60).toFixed(1)} hours`;
}

function describeLastError(e: NonNullable<RequestView['request']['lastError']>) {
  switch (e.code) {
    case 'STALE_INCIDENT_VERSION':
      return `The incident changed from revision ${String(e.expected)} to ${String(e.actual)} after the evidence was read. Nothing was staged; re-evaluate with current evidence.`;
    case 'POLICY_CHANGED':
      return `This evaluation was made with policy ${String(e.evaluatedWith ?? '(not recorded)')}, and the current policy is ${String(e.current)}. Nothing was staged. Re-evaluate first.`;
    case 'EVALUATION_EXPIRED':
      return 'The evidence snapshot is older than the staging window. Re-evaluate before staging.';
    case 'READBACK_MISMATCH':
      return 'The stored approval packet did not match what was sent. See Technical evidence for the field-level diff.';
    default:
      return String(e.message ?? 'The last attempt failed. The request is unchanged and safe to retry.');
  }
}

function AgeBarRow({ label, age, limit }: { label: string; age: number; limit: number }) {
  const g = ageBar(age, limit);
  return (
    <div>
      <div className="agebar-label">
        <span>{label}</span>
        <span className={g.over ? 'val-danger' : 'val-ok'}>{g.text}</span>
      </div>
      <div className="agebar-track" role="img" aria-label={`${label}: ${g.text}`}>
        <div className={`agebar-fill ${g.over ? 'over' : ''}`} style={{ width: `${g.fillPct}%` }} />
        <div className="agebar-limit" style={{ left: `calc(${g.limitPct}% - 1px)` }} title={`Limit: ${limit} min`} />
      </div>
    </div>
  );
}

function ActivityHistory({ view }: { view: RequestView }) {
  const { latest, all } = activitySummary(view.audit);
  return (
    <section className="panel" aria-labelledby="activity-h" data-testid="activity">
      <h2 id="activity-h">Activity</h2>
      {!latest && <p className="muted">No activity recorded yet.</p>}
      {latest && (
        <p style={{ margin: 0 }} data-testid="activity-latest">
          <span className="mono small">{fmtTime(latest.at)}</span> {latest.text}
        </p>
      )}
      {all.length > 1 && (
        <details open={OPEN_HISTORY_STATES.includes(view.request.state)} style={{ marginTop: 8 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>
            View history ({all.length})
          </summary>
          <ol className="plain-list small" style={{ marginTop: 6 }} data-testid="activity-all">
            {all.map((a) => (
              <li key={a.seq}>
                <span className="mono">{fmtTime(a.at)}</span> {a.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function SourceBadge({ view, testId }: { view: SourceBadgeView; testId: string }) {
  return (
    <span className={`badge ${view.tone}`} data-testid={testId}>
      {view.text}
    </span>
  );
}

const STEP_MARK: Record<StepStatus, string> = { done: '\u2713', current: '\u2022', upcoming: '', blocked: '!', failed: '\u00d7', 'end-ok': '\u2713', 'end-bad': '\u00d7' };
const STEP_WORDS: Record<StepStatus, string> = { done: 'done', current: 'current step', upcoming: 'not yet', blocked: 'blocked', failed: 'failed', 'end-ok': 'finished', 'end-bad': 'closed' };

/** CH-16: what is known about the policy, from persisted fields only. Nothing is invented. */
function PolicyProvenance({ view }: { view: RequestView }) {
  const p = view.policyProvenance;
  const used = view.evaluation?.policyVersion ?? null;
  if (!p) return null;
  return (
    <details className="small" data-testid="policy-provenance">
      <summary style={{ cursor: 'pointer' }}>About this policy</summary>
      <p style={{ margin: '6px 0' }}>
        {used ? `This decision used policy ${used}.` : 'The policy version for this decision was not recorded (it was made before versions were stored).'}{' '}
        {used && used !== view.policyVersion ? `The current policy is ${view.policyVersion}.` : ''} It has {p.rules.length} ordered rules; the first that applies decides:
      </p>
      <ol style={{ margin: '0 0 6px', paddingLeft: 18 }}>
        {p.rules.map((r) => (
          <li key={r.id}>
            <code>{r.id}</code> {r.text}
          </li>
        ))}
      </ol>
      <p style={{ margin: 0 }} className="muted">
        {p.source}. {p.updatedAt && p.updatedBy ? `Last changed ${p.updatedAt} by ${p.updatedBy}.` : p.note}
      </p>
    </details>
  );
}
