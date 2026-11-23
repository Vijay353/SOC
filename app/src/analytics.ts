/**
 * CH-21: optional Microsoft Clarity, loaded only inside the app (after the passcode gate) and only after the visitor
 * says yes. No ID configured means nothing happens. Events are a short fixed list with no data attached.
 */
export const ANALYTICS_EVENTS = ['project_entered', 'record_opened', 'scenario_started', 'scenario_completed', 'audit_export_clicked'] as const;
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];
export type Consent = 'granted' | 'denied';

const KEY = 'big-analytics-consent';
type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
type Win = Window & { clarity?: ClarityFn };

let installed = false;
let lastIdentified: string | null = null;

export function storedConsent(): Consent | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}
function store(c: Consent): void {
  try {
    window.localStorage.setItem(KEY, c);
  } catch {
    /* storage can be unavailable; the choice then lasts for this page only */
  }
}

/** Adds the Clarity tag once per page. Returns false when it was already added or the ID is not valid. */
export function installClarity(projectId: string, win: Win = window, doc: Document = document): boolean {
  if (installed || !/^[a-z0-9]{6,20}$/i.test(projectId)) return false;
  installed = true;
  // Queue stub, as in Clarity's published snippet: calls wait until the tag loads.
  win.clarity =
    win.clarity ??
    (function clarity(...args: unknown[]) {
      ((win.clarity as ClarityFn).q = (win.clarity as ClarityFn).q ?? []).push(args);
    } as ClarityFn);
  const tag = doc.createElement('script');
  tag.async = true;
  tag.src = `https://www.clarity.ms/tag/${projectId}`;
  tag.dataset.analytics = 'clarity';
  doc.head.appendChild(tag);
  win.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' });
  track('project_entered', win);
  return true;
}

export function track(event: AnalyticsEvent, win: Win = window): void {
  if (!installed || !win.clarity || !ANALYTICS_EVENTS.includes(event)) return;
  win.clarity('event', event);
}

/**
 * Tags the Clarity session with the synthetic demo identity (e.g. which demo role is acting),
 * so sessions can be segmented in the Clarity dashboard. No-op until the tag is installed.
 * Only the opaque demo user ID is sent, never display names, record IDs, or free text.
 * The same ID is sent at most once per page, so re-renders cannot repeat it.
 */
export function identifyClarity(userId: string, win: Win = window): void {
  if (!installed || !win.clarity) return;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 64) return;
  if (lastIdentified === userId) return;
  lastIdentified = userId;
  win.clarity('identify', userId);
}

export function grant(projectId: string): void {
  store('granted');
  installClarity(projectId);
}

/** Withdrawal: tell Clarity, remember the choice, and reload so the tag is gone from the page. */
export function withdraw(win: Win = window): void {
  store('denied');
  if (installed && win.clarity) {
    win.clarity('consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' });
    win.clarity('consent', false);
  }
  win.location.reload();
}

export function decline(): void {
  store('denied');
}

/** Test hook only. */
export const _resetForTests = () => {
  installed = false;
  lastIdentified = null;
};
