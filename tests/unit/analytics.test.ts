/** CH-21: the analytics loader adds one tag per page, asks for analytics storage only, and sends only fixed event names. */
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetForTests, ANALYTICS_EVENTS, installClarity, track } from '../../app/src/analytics';

function fakes() {
  const added: Array<{ src: string; async: boolean; dataset: Record<string, string> }> = [];
  const doc = { createElement: () => ({ src: '', async: false, dataset: {} as Record<string, string> }), head: { appendChild: (t: (typeof added)[number]) => added.push(t) } };
  const win = {} as { clarity?: ((...a: unknown[]) => void) & { q?: unknown[][] } };
  return { added, doc: doc as unknown as Document, win: win as unknown as Window & typeof win };
}

describe('analytics loader', () => {
  beforeEach(() => _resetForTests());

  it('does nothing with an invalid ID', () => {
    const f = fakes();
    expect(installClarity('bad id!', f.win, f.doc)).toBe(false);
    expect(f.added).toHaveLength(0);
  });

  it('adds the tag once, grants analytics storage only, and records project_entered', () => {
    const f = fakes();
    expect(installClarity('abc123xyz', f.win, f.doc)).toBe(true);
    expect(installClarity('abc123xyz', f.win, f.doc)).toBe(false);
    expect(f.added.map((t) => t.src)).toEqual(['https://www.clarity.ms/tag/abc123xyz']);
    expect(f.win.clarity!.q).toEqual([
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ['event', 'project_entered'],
    ]);
  });

  it('sends only approved event names, with nothing attached', () => {
    const f = fakes();
    installClarity('abc123xyz', f.win, f.doc);
    for (const e of ANALYTICS_EVENTS) track(e, f.win);
    track('record_id_REQ-1' as never, f.win);
    const events = f.win.clarity!.q!.filter((c) => c[0] === 'event');
    expect(events.every((c) => c.length === 2 && (ANALYTICS_EVENTS as readonly string[]).includes(c[1] as string))).toBe(true);
    expect(events).toHaveLength(ANALYTICS_EVENTS.length + 1);
  });

  it('tracks nothing before it is installed', () => {
    const f = fakes();
    track('record_opened', f.win);
    expect(f.win.clarity).toBeUndefined();
  });
});

import { loadConfig } from '../../server/src/config';

describe('analytics configuration', () => {
  it('is off without an ID, off locally unless enabled, and never accepts a malformed ID', () => {
    expect(loadConfig({}).clarityProjectId).toBeNull();
    expect(loadConfig({ CLARITY_PROJECT_ID: 'abc123xyz' }).clarityProjectId).toBeNull();
    expect(loadConfig({ CLARITY_PROJECT_ID: 'abc123xyz', ANALYTICS_ENABLED: 'true' }).clarityProjectId).toBe('abc123xyz');
    expect(loadConfig({ CLARITY_PROJECT_ID: 'abc123xyz', NODE_ENV: 'production' }).clarityProjectId).toBe('abc123xyz');
    expect(loadConfig({ CLARITY_PROJECT_ID: '"><script>', NODE_ENV: 'production' }).clarityProjectId).toBeNull();
  });
});
