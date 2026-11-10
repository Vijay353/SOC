import { useEffect, useState } from 'react';
import { decline, grant, installClarity, storedConsent, withdraw, type Consent } from '../analytics';

/** CH-21: asks before any analytics loads, and lets the visitor change their mind. Renders nothing without an ID. */
export function AnalyticsNotice({ projectId }: { projectId: string | null | undefined }) {
  const [choice, setChoice] = useState<Consent | null>(() => storedConsent());

  useEffect(() => {
    if (projectId && choice === 'granted') installClarity(projectId);
  }, [projectId, choice]);

  if (!projectId) return null;
  if (choice === null) {
    return (
      <div className="analytics-notice" role="region" aria-label="Analytics choice" data-testid="analytics-notice">
        <p>
          May this demo use Microsoft Clarity to see how visitors use it? On-screen text is masked, nothing you type is recorded, and the passcode page is never recorded.
        </p>
        <div className="row">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              grant(projectId);
              setChoice('granted');
            }}
          >
            Allow
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              decline();
              setChoice('denied');
            }}
          >
            No thanks
          </button>
        </div>
      </div>
    );
  }
  return (
    <p className="analytics-status small muted" data-testid="analytics-status">
      Usage analytics is {choice === 'granted' ? 'on' : 'off'}.{' '}
      <button
        className="linklike"
        onClick={() => {
          if (choice === 'granted') withdraw();
          else {
            grant(projectId);
            setChoice('granted');
          }
        }}
      >
        {choice === 'granted' ? 'Turn it off' : 'Turn it on'}
      </button>
    </p>
  );
}
