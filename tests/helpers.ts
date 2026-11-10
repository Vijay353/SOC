import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSystem, type System } from '../server/src/system';

export interface Harness {
  system: System;
  url: string;
  api: <T = unknown>(method: string, p: string, body?: unknown, actor?: string) => Promise<{ status: number; body: T }>;
  close: () => Promise<void>;
}

/** Boots an isolated system (own temp DBs, frozen clock, fast retries) on an ephemeral port. */
export async function startHarness(overrides: Parameters<typeof createSystem>[0] = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cag-test-'));
  const system = createSystem({ dataDir, clockMode: 'frozen', http: { timeoutMs: 400, maxAttempts: 3, baseDelayMs: 5 }, ...overrides }, {});
  const { url, close } = await system.start(0);
  const api = async <T,>(method: string, p: string, body?: unknown, actor = 'analyst-priya') => {
    const res = await fetch(`${url}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(actor ? { 'x-demo-user': actor } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return {
    system,
    url,
    api,
    close: async () => {
      await close();
      system.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export const PRIMARY = { incidentId: 'INC-90482', machineId: 'device-d8f92a10', requestedAction: 'FULL_ISOLATION' as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
