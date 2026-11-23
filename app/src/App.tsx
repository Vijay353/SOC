import { useCallback, useEffect, useState } from 'react';
import { api, getDemoUser, leaveDemo, setDemoUser } from './api';
import { AnalyticsNotice } from './components/AnalyticsNotice';
import { ApprovalsPage } from './components/ApprovalsPage';
import { DataStudioPage } from './components/DataStudioPage';
import { LabPage } from './components/LabPage';
import { ReviewPage } from './components/ReviewPage';
import { CountBadge } from './components/primitives';
import type { ApprovalPacket, Session } from './types';
import { fmtDateTime, personLabel, ShieldMark } from './ui';

type Tab = 'review' | 'approvals' | 'data' | 'lab';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'review', label: 'Review' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'data', label: 'Data Studio' },
  { id: 'lab', label: 'Simulator Lab' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('review');
  const [session, setSession] = useState<Session | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [user, setUser] = useState(getDemoUser());
  const [refreshKey, setRefreshKey] = useState(0);
  // CH-9: requests waiting for the acting identity's decision. Same 10 s cadence as the session; no extra timer.
  const [waiting, setWaiting] = useState(0);

  const loadWaiting = useCallback(async () => {
    try {
      const me = getDemoUser();
      const r = await api<{ value: ApprovalPacket[] }>('GET', '/approvals');
      if (me !== getDemoUser()) return;
      setWaiting(r.value.filter((p) => (p.status === 'WAITING_FOR_DUAL_APPROVAL' || p.status === 'PARTIALLY_APPROVED') && !p.decisions.some((d) => d.approverId === me)).length);
    } catch {
      setWaiting(0);
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api<Session>('GET', '/session'));
      setSessionError(null);
    } catch (e) {
      setSessionError((e as Error).message);
    }
    void loadWaiting();
  }, [loadWaiting]);

  useEffect(() => {
    void loadSession();
    const t = setInterval(loadSession, 10000);
    return () => clearInterval(t);
  }, [loadSession]);

  const changeUser = (u: string) => {
    setDemoUser(u);
    setUser(u);
    setRefreshKey((k) => k + 1);
    void loadWaiting();
  };
  // Data changes refresh the session (clock, identities) without remounting the page and losing context.
  const bump = () => {
    void loadSession();
  };

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <ShieldMark />
          <div>
            <div className="brand-name">Business Impact Gate</div>
            <div className="brand-sub">Containment Assurance · conceptual extension for Defender XDR manual response</div>
          </div>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} aria-controls="main" id={`tab-${t.id}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'approvals' && <CountBadge count={waiting} label={waiting === 1 ? 'request waiting for you' : 'requests waiting for you'} testId="approvals-waiting" />}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {session && (
            <span className="clock" title="Synthetic scenario clock shared by all simulators">
              Scenario clock <strong>{fmtDateTime(session.clock.now)}</strong>
            </span>
          )}
          <label className="identity">
            <span>Acting as</span>
            <select value={user} onChange={(e) => changeUser(e.target.value)} aria-describedby="identity-note" data-clarity-mask="true">
              {(session?.identities ?? [{ userId: user, displayName: user, role: 'ANALYST' as const }]).map((i) => (
                <option key={i.userId} value={i.userId}>
                  {personLabel(i.displayName)}
                </option>
              ))}
            </select>
            <span id="identity-note" className="sr-only">
              Demo identity switch. This is not authentication.
            </span>
          </label>
          <span className="pill pill-synthetic">
            <span className="pill-dot" aria-hidden="true" />
            SYNTHETIC DEMO · {session?.mode ?? '…'}
          </span>
          {session?.access?.enabled && (
            <button className="btn btn-sm btn-quiet" onClick={() => void leaveDemo()} data-testid="leave-demo">
              Leave demo
            </button>
          )}
        </div>
      </header>

      {/* CH-21: data-clarity-mask hides all on-screen text from recordings if analytics is ever turned on. */}
      <main id="main" className="page" role="tabpanel" aria-labelledby={`tab-${tab}`} data-clarity-mask="true">
        {sessionError && (
          <div className="banner banner-error" role="alert">
            Cannot reach the Gate API: {sessionError}
          </div>
        )}
        {session?.setupError && (
          <div className="banner banner-error" role="alert">
            <strong>Setup required.</strong> {session.setupError.message}
            {session.setupError.missing.length > 0 && <> Missing: <code>{session.setupError.missing.join(', ')}</code>.</>}{' '}
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api('POST', '/lab/mode', { mode: 'SIMULATED' });
                bump();
              }}
            >
              Switch to SIMULATED mode
            </button>
          </div>
        )}
        {tab === 'review' && <ReviewPage key={`r-${refreshKey}`} session={session} onChanged={bump} onSwitchUser={changeUser} />}
        {tab === 'approvals' && <ApprovalsPage key={`a-${refreshKey}`} session={session} onChanged={bump} />}
        {tab === 'data' && <DataStudioPage key={`d-${refreshKey}`} onChanged={bump} demoResetAllowed={session?.demoReset?.allowed ?? true} />}
        {tab === 'lab' && <LabPage key={`l-${refreshKey}`} session={session} onChanged={bump} />}
      </main>
      <footer className="foot">
        {session?.disclaimer ?? 'Conceptual, synthetic prototype. Not a Microsoft or ServiceNow product.'}
        <AnalyticsNotice projectId={session?.analytics?.projectId} userId={user} />
      </footer>
    </>
  );
}
