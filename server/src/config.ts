import crypto from 'node:crypto';
import path from 'node:path';
import type { AccessConfig } from './access/access-gate';

export type IntegrationMode = 'SIMULATED' | 'SANDBOX' | 'LIVE';

const pick = (env: NodeJS.ProcessEnv, ...names: string[]): string | undefined => {
  for (const n of names) {
    const v = env[n];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
};

/** Accepts on/true/1/yes (any case) as enabled. Used for Coolify aliases that send "true" instead of "on". */
const isOn = (v: string | undefined): boolean => !!v && ['1', 'true', 'on', 'yes'].includes(v.toLowerCase());

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  clockMode: 'frozen' | 'ticking';
  integrationMode: IntegrationMode;
  liveEnabled: boolean;
  extractorProvider: 'deterministic' | 'anthropic';
  anthropicApiKey: string | undefined;
  extractorModelId: string | undefined;
  http: { timeoutMs: number; maxAttempts: number; baseDelayMs: number };
  tokens: { gateSecurity: string; gateItsm: string; simAdmin: string };
  /** CH-22: NODE_ENV=production. Turns on the production start-up checks; never changes local development. */
  production: boolean;

  /** Seed empty simulator stores on start. Off in production: seeding there is the explicit bootstrap step. */
  seedOnEmpty: boolean;
  /** Keep the scenario clock across restarts (stored in gate.db). On in production only. */
  persistClock: boolean;
  /** CH-20: visitor passcode gate. Always on in production; off locally unless ACCESS_GATE=on. */
  access: AccessConfig;
  /** CH-20: Express 'trust proxy' value for exactly one known reverse proxy, for example 1. Unset means trust none. */
  trustProxy: number | string | undefined;
  /** CH-21: optional Microsoft Clarity project ID (a public identifier, not a secret). Null means analytics off. */
  clarityProjectId: string | null;
  /** Demo reset switch. Off in production unless ALLOW_DEMO_RESET (or SOC_ALLOW_DEMO_RESET) is on. */
  allowDemoReset: boolean;
  sandbox: { tenantId?: string; clientId?: string; clientSecret?: string; serviceNowInstance?: string; serviceNowUser?: string; serviceNowPassword?: string };
}

const randomToken = () => crypto.randomBytes(24).toString('hex');

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const mode = (pick(env, 'INTEGRATION_MODE') ?? 'SIMULATED').toUpperCase();
  const integrationMode: IntegrationMode = mode === 'SANDBOX' || mode === 'LIVE' ? mode : 'SIMULATED';
  const production = env.NODE_ENV === 'production';
  const base: AppConfig = {
    port: Number(env.PORT ?? 4300),
    host: env.HOST ?? '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR ?? 'data/runtime'),
    clockMode: env.CLOCK_MODE === 'frozen' ? 'frozen' : 'ticking',
    integrationMode,
    liveEnabled: env.ENABLE_LIVE_INTEGRATIONS === 'true',
    extractorProvider: env.EXTRACTOR_PROVIDER === 'anthropic' ? 'anthropic' : 'deterministic',
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    extractorModelId: env.EXTRACTOR_MODEL_ID || undefined,
    http: {
      timeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 1500),
      maxAttempts: Number(env.UPSTREAM_MAX_ATTEMPTS ?? 3),
      baseDelayMs: Number(env.UPSTREAM_RETRY_BASE_MS ?? 150),
    },
    // Simulator service tokens are generated per process unless supplied. They never reach the browser.
    tokens: {
      gateSecurity: env.SIM_GATE_SECURITY_TOKEN || randomToken(),
      gateItsm: env.SIM_GATE_ITSM_TOKEN || randomToken(),
      simAdmin: env.SIM_ADMIN_TOKEN || randomToken(),
    },
    production,
    seedOnEmpty: !production,
    persistClock: production,
    access: {
      // Coolify aliases: SOC_ACCESS_GATE / SOC_ACCESS_PIN / SOC_SESSION_SECRET (PULSE_ still accepted).
      // "true"/"1"/"on" all count as on; in production the gate is always on anyway.
      enabled: production || isOn(pick(env, 'ACCESS_GATE', 'SOC_ACCESS_GATE', 'PULSE_ACCESS_GATE')),
      pin: pick(env, 'ACCESS_PIN', 'SOC_ACCESS_PIN', 'PULSE_ACCESS_PIN') || undefined,
      secret: pick(env, 'ACCESS_SESSION_SECRET', 'SOC_SESSION_SECRET', 'PULSE_SESSION_SECRET') || undefined,
      sessionMinutes: Number(pick(env, 'ACCESS_SESSION_MINUTES', 'SOC_SESSION_MINUTES', 'PULSE_SESSION_MINUTES') ?? 120),
      secureCookie: env.ACCESS_COOKIE_SECURE ? env.ACCESS_COOKIE_SECURE === 'true' : production,
    },
    // Analytics is off locally and in tests unless ANALYTICS_ENABLED=true (or VITE_CLARITY_ALLOW_LOCAL=true); in production it needs only the ID.
    // Coolify aliases: SOC_CLARITY_PROJECT_ID / VITE_CLARITY_PROJECT_ID (read server-side via /api/session, never via Vite).
    clarityProjectId: (() => {
      const id = pick(env, 'CLARITY_PROJECT_ID', 'SOC_CLARITY_PROJECT_ID', 'PULSE_CLARITY_PROJECT_ID', 'VITE_CLARITY_PROJECT_ID', 'VITE_PUBLIC_CLARITY_PROJECT_ID');
      const localOk = isOn(pick(env, 'ANALYTICS_ENABLED', 'CLARITY_ALLOW_LOCAL', 'VITE_CLARITY_ALLOW_LOCAL', 'SOC_ANALYTICS_ENABLED', 'PULSE_ANALYTICS_ENABLED'));
      return id && /^[a-z0-9]{6,20}$/i.test(id) && (production || localOk) ? id : null;
    })(),
    // Coolify alias: SOC_TRUST_PROXY. "true" means exactly one proxy (1); digits stay numeric.
    trustProxy: (() => {
      const raw = pick(env, 'TRUST_PROXY', 'SOC_TRUST_PROXY', 'PULSE_TRUST_PROXY');
      if (!raw) return undefined;
      if (/^\d+$/.test(raw)) return Number(raw);
      if (raw.toLowerCase() === 'true') return 1;
      return raw;
    })(),
    // Coolify alias: SOC_ALLOW_DEMO_RESET. Explicit value wins; otherwise on locally, off in production.
    allowDemoReset: (() => {
      const raw = pick(env, 'ALLOW_DEMO_RESET', 'SOC_ALLOW_DEMO_RESET', 'PULSE_ALLOW_DEMO_RESET');
      if (raw === undefined) return !production;
      return isOn(raw);
    })(),
    sandbox: {
      tenantId: env.MS_TENANT_ID || undefined,
      clientId: env.MS_CLIENT_ID || undefined,
      clientSecret: env.MS_CLIENT_SECRET || undefined,
      serviceNowInstance: env.SERVICENOW_INSTANCE || undefined,
      serviceNowUser: env.SERVICENOW_USER || undefined,
      serviceNowPassword: env.SERVICENOW_PASSWORD || undefined,
    },
  };
  return { ...base, ...overrides, access: { ...base.access, ...(overrides.access ?? {}) }, http: { ...base.http, ...(overrides.http ?? {}) }, tokens: { ...base.tokens, ...(overrides.tokens ?? {}) } };
}
