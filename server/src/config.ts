import crypto from 'node:crypto';
import path from 'node:path';
import type { AccessConfig } from './access/access-gate';

export type IntegrationMode = 'SIMULATED' | 'SANDBOX' | 'LIVE';

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
  sandbox: { tenantId?: string; clientId?: string; clientSecret?: string; serviceNowInstance?: string; serviceNowUser?: string; serviceNowPassword?: string };
}

const randomToken = () => crypto.randomBytes(24).toString('hex');

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const mode = (env.INTEGRATION_MODE ?? 'SIMULATED').toUpperCase();
  const integrationMode: IntegrationMode = mode === 'SANDBOX' || mode === 'LIVE' ? mode : 'SIMULATED';
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
    production: env.NODE_ENV === 'production',
    seedOnEmpty: env.NODE_ENV !== 'production',
    persistClock: env.NODE_ENV === 'production',
    access: {
      enabled: env.NODE_ENV === 'production' || env.ACCESS_GATE === 'on',
      pin: env.ACCESS_PIN || undefined,
      secret: env.ACCESS_SESSION_SECRET || undefined,
      sessionMinutes: Number(env.ACCESS_SESSION_MINUTES ?? 120),
      secureCookie: env.ACCESS_COOKIE_SECURE ? env.ACCESS_COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    // Analytics is off locally and in tests unless ANALYTICS_ENABLED=true; in production it needs only the ID.
    clarityProjectId:
      env.CLARITY_PROJECT_ID && /^[a-z0-9]{6,20}$/i.test(env.CLARITY_PROJECT_ID) && (env.NODE_ENV === 'production' || env.ANALYTICS_ENABLED === 'true') ? env.CLARITY_PROJECT_ID : null,
    trustProxy: env.TRUST_PROXY ? (/^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY) : undefined,
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
