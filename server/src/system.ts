/**
 * Composition root: builds the three stores, both simulators, the selected adapters and the Gate API
 * in one Express process. Simulators are mounted under /sim/* and the Gate reaches them over real HTTP.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { canonical } from '../../packages/contracts/src/canonical';
import { createAccessGate } from './access/access-gate';
import { ApprovalPacketStatus } from '../../packages/contracts/src/domain';
import { OPTIONAL_SCENARIOS } from '../../fixtures/scenarios/optional';
import { itsmSeed, SCENARIO_START, SCENARIOS, securitySeed } from '../../fixtures/seed';
import { createItsmRouter, ItsmRepository } from '../../simulators/itsm/itsm-sim';
import { createSecurityRouter, SecurityRepository } from '../../simulators/security/security-sim';
import { FAULT_MODES, FaultInjector, openDatabase, ScenarioClock, type TokenGrant } from '../../simulators/shared/infra';
import { loadConfig, type AppConfig, type IntegrationMode } from './config';
import { UpstreamError } from './gate/adapters/http-client';
import { evidenceFileName } from './gate/evidence-package';
import type { ItsmPort, SecurityPort } from './gate/adapters/ports';
import { GraphDefenderSecurityAdapter, IntegrationSetupError, ServiceNowItsmAdapter } from './gate/adapters/sandbox';
import { SimulatedItsmAdapter, SimulatedSecurityAdapter } from './gate/adapters/simulated';
import { DeterministicConstraintExtractor, ExtractorConfigError, type ConstraintExtractor } from './gate/extractor/extractor';
import { AnthropicConstraintExtractor } from './gate/extractor/model-extractor';
import { ACTOR_ROLES_FOR_REQUESTS, describeError, GateError, GateOrchestrator } from './gate/orchestrator';
import { POLICY_CONFIG, POLICY_VERSION } from './gate/policy';
import { GateStore, TransitionError } from './gate/store';
import { DataStudio, mountDataRoutes } from './imports/data-studio';

export interface System {
  config: AppConfig;
  app: express.Express;
  clock: ScenarioClock;
  securityRepo: SecurityRepository;
  itsmRepo: ItsmRepository;
  store: GateStore;
  faults: { security: FaultInjector; itsm: FaultInjector };
  gate: () => GateOrchestrator;
  setupError: () => { message: string; missing: string[] } | null;
  baseUrl: () => string;
  resetScenario: () => void;
  start: (port?: number) => Promise<{ url: string; close: () => Promise<void> }>;
  close: () => void;
}

export function createSystem(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = process.env): System {
  const config = loadConfig(env, overrides);
  const clock = new ScenarioClock(SCENARIO_START, config.clockMode);
  const securityDb = openDatabase(path.join(config.dataDir, 'security.db'));
  const itsmDb = openDatabase(path.join(config.dataDir, 'itsm.db'));
  const gateDb = openDatabase(path.join(config.dataDir, 'gate.db'));
  const securityRepo = new SecurityRepository(securityDb, clock);
  const itsmRepo = new ItsmRepository(itsmDb, clock);
  const store = new GateStore(gateDb, clock);
  const faults = { security: new FaultInjector(), itsm: new FaultInjector() };

  // First run: seed the simulators with the synthetic scenario. In production this happens only in the bootstrap step.
  if (config.seedOnEmpty && securityRepo.listIncidents().length === 0) securityRepo.replaceAll(securitySeed);
  if (config.seedOnEmpty && itsmRepo.listUsers().length === 0) itsmRepo.replaceAll(itsmSeed);

  // CH-22: in production the scenario clock continues across restarts instead of going back to the start.
  const saveClock = () => {
    if (config.persistClock) store.putSetting('scenario_clock', JSON.stringify(clock.snapshot()));
  };
  if (config.persistClock) {
    const saved = store.getSetting('scenario_clock');
    if (saved) clock.restore(JSON.parse(saved) as { scenarioMs: number; realMs: number });
    else saveClock();
  }

  // Least privilege: the Gate's security token cannot isolate; its ITSM token can only read CMDB and manage approvals.
  const GATE = 'svc-containment-gate';
  const securityTokens = new Map<string, TokenGrant>([
    [config.tokens.gateSecurity, { principal: GATE, scopes: ['incident.read', 'device.read', 'activity.read'] }],
    [config.tokens.simAdmin, { principal: 'sim-admin', scopes: ['*'] }],
  ]);
  const itsmTokens = new Map<string, TokenGrant>([
    [config.tokens.gateItsm, { principal: GATE, scopes: ['cmdb.read', 'approval.write', 'approval.read', 'approval.decide'] }],
    [config.tokens.simAdmin, { principal: 'sim-admin', scopes: ['*'] }],
  ]);

  let base = '';
  const baseUrl = () => base;
  let mode: IntegrationMode = config.integrationMode;
  let setupError: { message: string; missing: string[] } | null = null;
  let orchestrator: GateOrchestrator | null = null;

  const buildGate = () => {
    setupError = null;
    let security: SecurityPort;
    let itsm: ItsmPort;
    let extractor: ConstraintExtractor;
    try {
      if (mode === 'SIMULATED') {
        security = new SimulatedSecurityAdapter(() => `${base}/sim/security`, config.tokens.gateSecurity, config.http);
        itsm = new SimulatedItsmAdapter(() => `${base}/sim/itsm`, config.tokens.gateItsm, config.http);
      } else {
        if (mode === 'LIVE' && !config.liveEnabled) throw new IntegrationSetupError('LIVE mode requires ENABLE_LIVE_INTEGRATIONS=true and is never selected implicitly', ['ENABLE_LIVE_INTEGRATIONS']);
        security = new GraphDefenderSecurityAdapter(config);
        itsm = new ServiceNowItsmAdapter(config);
      }
      extractor =
        config.extractorProvider === 'anthropic'
          ? new AnthropicConstraintExtractor({ apiKey: config.anthropicApiKey, modelId: config.extractorModelId })
          : new DeterministicConstraintExtractor();
    } catch (e) {
      if (e instanceof IntegrationSetupError) setupError = { message: e.message, missing: e.missing };
      else if (e instanceof ExtractorConfigError) setupError = { message: e.message, missing: [] };
      else throw e;
      orchestrator = null;
      return;
    }
    orchestrator = new GateOrchestrator({ store, security, itsm, extractor, clock });
  };
  buildGate();

  const gate = () => {
    if (!orchestrator) throw new GateError(503, 'SETUP_REQUIRED', setupError?.message ?? 'Integration not configured', setupError);
    return orchestrator;
  };

  const resetScenario = () => {
    clock.reset();
    faults.security.clear();
    faults.itsm.clear();
    securityRepo.replaceAll(securitySeed);
    itsmRepo.replaceAll(itsmSeed);
    store.resetAll();
    saveClock();
    void orchestrator?.directory(true).catch(() => undefined);
  };

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy !== undefined) app.set('trust proxy', config.trustProxy);
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  });
  // CH-20: visitor passcode gate in front of pages, assets and the API (off locally unless ACCESS_GATE=on).
  const access = createAccessGate(config.access, 'Business Impact Gate');
  app.use(access.middleware);
  app.use('/api/access', access.router);
  app.use('/sim/security', createSecurityRouter(securityRepo, securityTokens, faults.security, clock));
  app.use('/sim/itsm', createItsmRouter(itsmRepo, itsmTokens, faults.itsm, clock));

  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  const user = (req: Request) => req.header('x-demo-user') ?? undefined;
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };

  api.get('/health', (_req, res) => res.json({ ok: true, mode, now: clock.nowIso() }));
  // CH-22: read-only readiness. Each database answers a trivial query; nothing is written.
  api.get('/ready', (_req, res) => {
    try {
      for (const db of [securityDb, itsmDb, gateDb]) db.prepare('SELECT 1').get();
      res.json({ ready: true });
    } catch {
      res.status(503).json({ ready: false });
    }
  });
  api.get(
    '/session',
    wrap(async (_req, res) => {
      let identities: unknown[] = [];
      let identityError: unknown = null;
      if (orchestrator) {
        try {
          identities = await orchestrator.directory();
        } catch (e) {
          identityError = describeError(e);
        }
      }
      res.json({
        mode,
        setupError,
        access: { enabled: config.access.enabled },
        // CH-21: only sent behind the passcode gate; the passcode page never loads analytics.
        analytics: config.clarityProjectId ? { provider: 'clarity', projectId: config.clarityProjectId } : null,
        clock: clock.describe(),
        identities,
        identityError,
        scenarios: SCENARIOS,
        optionalScenarios: OPTIONAL_SCENARIOS.map(({ name, label, description, queueLabels }) => ({ name, label, description, queueLabels })),
        policy: { version: POLICY_VERSION, ...POLICY_CONFIG },
        eligibleRoles: { requestActions: ACTOR_ROLES_FOR_REQUESTS },
        extractor: config.extractorProvider,
        disclaimer: 'Conceptual, synthetic prototype. Not a Microsoft or ServiceNow product. Demo identities are not authentication.',
      });
    }),
  );
  api.get('/queue', wrap(async (_req, res) => res.json({ value: await gate().queue() })));
  api.post(
    '/events/manual-isolation-requested',
    wrap(async (req, res) => {
      const r = await gate().submitEvent(req.body, user(req));
      res.status(r.duplicate ? 200 : 201).json({ ...r, view: await gate().view(r.requestId) });
    }),
  );
  api.get('/requests/:id', wrap(async (req, res) => res.json(await gate().view(String(req.params.id)))));
  // CH-18: read-only audit evidence package for one request (canonical JSON with a SHA-256 checksum, not a signature).
  api.get(
    '/requests/:id/evidence-package',
    wrap(async (req, res) => {
      const pkg = await gate().evidencePackage(user(req), String(req.params.id), mode);
      res.setHeader('content-disposition', `attachment; filename="${evidenceFileName(pkg.record.requestId)}"`);
      res.type('application/json').send(canonical(pkg));
    }),
  );
  api.post(
    '/requests/:id/evaluate',
    wrap(async (req, res) => {
      await gate().evaluate(String(req.params.id), user(req));
      res.json(await gate().view(String(req.params.id)));
    }),
  );
  api.post(
    '/requests/:id/stage',
    wrap(async (req, res) => {
      const id = String(req.params.id);
      try {
        const result = await gate().stage(id, user(req));
        res.json({ result, view: await gate().view(id) });
      } catch (e) {
        // Always return the current, truthful request view alongside the error.
        if (e instanceof GateError) {
          res.status(e.status).json({ error: { code: e.code, message: e.message, details: e.details ?? null }, view: await gate().view(id).catch(() => null) });
          return;
        }
        throw e;
      }
    }),
  );
  api.get('/approvals', wrap(async (req, res) => res.json({ value: await gate().inbox(user(req)) })));
  api.post(
    '/approvals/:id/decision',
    wrap(async (req, res) => {
      const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().max(500).default('') }).strict().safeParse(req.body);
      if (!body.success) throw new GateError(400, 'VALIDATION', 'Invalid decision body', body.error.issues);
      await gate().decide(String(req.params.id), user(req), body.data.decision, body.data.comment);
      res.json({ value: await gate().inbox(user(req)) });
    }),
  );
  api.post(
    '/approvals/bulk',
    wrap(async (req, res) => {
      // The approver is always the caller's own demo identity; the body cannot name an approver.
      const body = z
        .object({
          items: z
            .array(z.object({ approvalId: z.string().min(1).max(64), expectedStatus: ApprovalPacketStatus }).strict())
            .min(1)
            .max(20)
            .refine((a) => new Set(a.map((i) => i.approvalId)).size === a.length, 'approval IDs must be unique'),
          comment: z.string().max(500).default(''),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success) throw new GateError(400, 'VALIDATION', 'Invalid bulk approval: 1 to 20 unique packets, each with its expected status', body.error.issues);
      const result = await gate().bulkApprove(user(req), body.data.items, body.data.comment);
      res.json({ ...result, value: await gate().inbox(user(req)) });
    }),
  );
  api.get('/audit', (_req, res) => res.json({ value: store.auditEvents(), chain: store.verifyAuditChain() }));
  // CH-17: re-check the Gate audit chain on demand and say plainly what the check covers and what it does not.
  api.get('/audit/verify', (_req, res) =>
    res.json({
      ...store.verifyAuditChain(),
      checkedAt: clock.nowIso(),
      covers: 'The Gate audit log (gate.db, table audit_events), every row in sequence order.',
      notCovered: ['The security simulator audit log (security.db)', 'The ITSM simulator audit log (itsm.db)', 'Execution traces (runs table)'],
      limitations:
        'This is local tamper evidence only. Someone with full write access to gate.db can rewrite rows, hashes and the anchor together. The chain is not signed and not stored anywhere outside this database.',
    }),
  );

  // ---- Lab controls (demo-only simulator management; not part of the Gate trust boundary) ----
  api.post('/lab/reset', (_req, res) => {
    resetScenario();
    res.json({ ok: true, clock: clock.describe() });
  });
  api.post(
    '/lab/clock',
    wrap((req, res) => {
      const body = z.object({ advanceMinutes: z.number().min(-1440).max(1440) }).strict().safeParse(req.body);
      if (!body.success) throw new GateError(400, 'VALIDATION', 'advanceMinutes must be a number between -1440 and 1440');
      clock.advance(body.data.advanceMinutes);
      saveClock();
      res.json({ clock: clock.describe() });
    }),
  );
  api.get('/lab/faults', (_req, res) => res.json({ security: faults.security.get(), itsm: faults.itsm.get(), modes: FAULT_MODES }));
  api.post(
    '/lab/faults',
    wrap((req, res) => {
      const body = z
        .object({
          system: z.enum(['security', 'itsm']),
          mode: z.enum(FAULT_MODES),
          target: z.enum(['all', 'reads', 'writes']).default('all'),
          remaining: z.number().int().min(-1).max(100).default(-1),
          latencyMs: z.number().int().min(0).max(10000).default(0),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success) throw new GateError(400, 'VALIDATION', 'Invalid fault configuration', body.error.issues);
      const { system, ...cfg } = body.data;
      if (cfg.mode === 'none') faults[system].clear();
      else faults[system].set(cfg);
      res.json({ security: faults.security.get(), itsm: faults.itsm.get() });
    }),
  );
  api.post(
    '/lab/scenarios/:name',
    wrap((req, res) => {
      // Opt-in fixtures are merged on top of the current data; nothing in the base seed is changed or removed.
      const scenario = OPTIONAL_SCENARIOS.find((s) => s.name === String(req.params.name));
      if (!scenario) throw new GateError(404, 'UNKNOWN_SCENARIO', `No optional scenario named ${String(req.params.name)}`);
      securityRepo.upsertDataset(scenario.security);
      res.json({ loaded: scenario.name, incidents: (scenario.security.incidents ?? []).map((i) => i.incidentId) });
    }),
  );
  api.post(
    '/lab/incidents/:id/concurrent-update',
    wrap(async (req, res) => {
      // A different analyst edits the incident through the simulator's own API (If-Match concurrency).
      const id = encodeURIComponent(String(req.params.id));
      const headers = { authorization: `Bearer ${config.tokens.simAdmin}`, 'content-type': 'application/json' };
      const cur = await fetch(`${base}/sim/security/api/incidents/${id}`, { headers });
      if (!cur.ok) throw new GateError(cur.status, 'INCIDENT_READ_FAILED', `Could not read incident (${cur.status})`);
      const inc = (await cur.json()) as { revision: number; status: string };
      const upd = await fetch(`${base}/sim/security/api/incidents/${id}`, {
        method: 'PATCH',
        headers: { ...headers, 'if-match': `"r${inc.revision}"` },
        body: JSON.stringify({ status: inc.status === 'active' ? 'inProgress' : 'active' }),
      });
      res.status(upd.status).json(await upd.json());
    }),
  );
  api.post(
    '/lab/least-privilege-check',
    wrap(async (req, res) => {
      // Attempt an isolation with the Gate's own token to prove the scope boundary is enforced by the simulator.
      const machineId = z.string().min(1).max(64).parse(req.body?.machineId ?? 'device-d8f92a10');
      const r = await fetch(`${base}/sim/security/api/machines/${encodeURIComponent(machineId)}/isolate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.tokens.gateSecurity}`, 'content-type': 'application/json' },
        body: JSON.stringify({ Comment: 'least-privilege probe', IsolationType: 'Full' }),
      });
      res.json({ attempted: 'POST /sim/security/api/machines/:id/isolate with the Gate token', status: r.status, body: await r.json() });
    }),
  );
  api.post(
    '/lab/mode',
    wrap((req, res) => {
      const body = z.object({ mode: z.literal('SIMULATED') }).strict().safeParse(req.body);
      if (!body.success) throw new GateError(400, 'VALIDATION', 'Only an explicit switch back to SIMULATED is allowed at runtime');
      mode = 'SIMULATED';
      buildGate();
      res.json({ mode, setupError });
    }),
  );
  api.get(
    '/lab/simulator-audit',
    wrap(async (req, res) => {
      const system = req.query.system === 'itsm' ? 'itsm' : 'security';
      const r = await fetch(`${base}/sim/${system}/api/audit`, { headers: { authorization: `Bearer ${config.tokens.simAdmin}` } });
      res.status(r.status).json(await r.json());
    }),
  );
  api.get(
    '/lab/notifications',
    wrap(async (_req, res) => {
      const r = await fetch(`${base}/sim/itsm/api/notifications`, { headers: { authorization: `Bearer ${config.tokens.simAdmin}` } });
      res.status(r.status).json(await r.json());
    }),
  );

  const dataStudio = new DataStudio({ securityRepo, itsmRepo, store, clock, dataDir: config.dataDir, onCommitted: () => void orchestrator?.directory(true).catch(() => undefined) });
  mountDataRoutes(api, dataStudio, user);

  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GateError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    if (err instanceof TransitionError) return res.status(409).json({ error: { code: err.code, message: err.message } });
    if (err instanceof UpstreamError) return res.status(err.status && err.status < 500 ? 502 : 503).json({ error: { code: err.code, message: err.message, details: describeError(err) } });
    if (err instanceof z.ZodError) return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid request', details: err.issues } });
    if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    console.error('[gate] unexpected error', err);
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  });
  app.use('/api', api);

  const dist = path.resolve('app/dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false }));
    app.get(/^\/(?!api|sim).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  let server: Server | null = null;
  return {
    config,
    app,
    clock,
    securityRepo,
    itsmRepo,
    store,
    faults,
    gate,
    setupError: () => setupError,
    baseUrl,
    resetScenario,
    start: (port = config.port) =>
      new Promise((resolve) => {
        server = app.listen(port, config.host, () => {
          const addr = server!.address();
          const actual = typeof addr === 'object' && addr ? addr.port : port;
          base = `http://${config.host}:${actual}`;
          // Warm the demo identity directory so a later ITSM outage can be served from the last known copy.
          const warm = orchestrator ? orchestrator.directory().catch(() => undefined) : Promise.resolve();
          void warm.then(() =>
            resolve({
              url: base,
              close: () => new Promise<void>((r) => server!.close(() => r())),
            }),
          );
        });
      }),
    close: () => {
      securityDb.close();
      itsmDb.close();
      gateDb.close();
    },
  };
}
