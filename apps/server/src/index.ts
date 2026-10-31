import express from 'express';
import type { Express, ErrorRequestHandler, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiKeyInputSchema, AuthHeadersSchema, CONTROL_POLICY, CONTROL_ROUTES, ControlHealthSchema, ControlOverviewSchema, EmptyInputSchema,
  MODEL_PROVIDER, ModelChoiceSchema, ModelSettingsSchema, ModelTestResultSchema, PROTOCOL_VERSION,
  ProjectInputSchema, ProjectRefSchema, TASK_API_LIMITS, TaskEventPageSchema, TaskEventsQuerySchema, TaskListSchema, TaskRefSchema, TaskSnapshotSchema,
  TaskStartInputSchema, WorkbenchSettingsSchema, requestProof, responseProof, SmokeBatchSchema } from '@operation-agent/contracts';
import type { Bootstrap, AuthHeaders, ControlError, ModelSettings, ModelTestResult } from '@operation-agent/contracts';
import type { Store } from './persistence/store.js';
import { UNAVAILABLE_BRIDGE } from './credentials/bridge.js';
import type { CryptoBridge } from './credentials/bridge.js';
import { createCredentialService } from './credentials/service.js';
import { createModelGateway } from './models/gateway.js';
import type { ModelGateway } from './models/gateway.js';

export interface ModelServices { bridge?: CryptoBridge; gateway?: ModelGateway }

export function createControlPlane(bootstrap: Bootstrap, store: Store, getPort: () => number, contact: () => void, services: ModelServices = {}): Express {
  const app = express();
  // Without a Main Crypto Bridge every key operation fails closed (SEC-14).
  const credentials = createCredentialService(store, services.bridge ?? UNAVAILABLE_BRIDGE);
  const gateway = services.gateway ?? createModelGateway({ endpoint: bootstrap.modelEndpoint });
  const startedAt = new Date();
  app.disable('x-powered-by');
  app.disable('etag'); app.set('trust proxy', false);
  const seen = new Map<string, number>();
  const heartbeatsSeen = new Map<string, number>();
  let windowStart = Date.now();
  const requests = { unauthenticated: 0, authenticated: 0, heartbeat: 0 };
  const admit = (kind: keyof typeof requests): boolean => {
    const now = Date.now();
    if (now - windowStart >= CONTROL_POLICY.authWindowMs) {
      requests.unauthenticated = 0; requests.authenticated = 0; requests.heartbeat = 0; windowStart = now;
    }
    const limit = kind === 'heartbeat' ? CONTROL_POLICY.maxHeartbeatsPerWindow : CONTROL_POLICY.maxRequestsPerWindow;
    if (requests[kind] >= limit) return false;
    requests[kind]++; return true;
  };
  const rejectUnauthenticated = (res: Response, status = 401): void => {
    const admitted = admit('unauthenticated');
    res.status(admitted ? status : 429).json({ error: admitted ? 'AUTHENTICATION_FAILED' : 'RATE_LIMITED' });
  };
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const forbidden = ['origin', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'];
    const headerNames = req.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${getPort()}` ||
      forbidden.some(name => req.headers[name] !== undefined) || new Set(headerNames).size !== headerNames.length) {
      rejectUnauthenticated(res, 403); return;
    }
    next();
  });
  app.use(express.raw({ type: () => true, limit: CONTROL_POLICY.maxBodyBytes, inflate: false }));
  app.use((req, res, next) => {
    const parsed = AuthHeadersSchema.safeParse({ mainRunId: req.headers['x-oa-main-run'], expressRunId: req.headers['x-oa-express-run'],
      requestId: req.headers['x-oa-request-id'], timestamp: req.headers['x-oa-timestamp'], signature: req.headers['x-oa-signature'] });
    if (!parsed.success || req.headers['x-oa-protocol'] !== PROTOCOL_VERSION) { rejectUnauthenticated(res); return; }
    const auth: AuthHeaders = parsed.data;
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const expected = createHmac('sha256', bootstrap.token).update(requestProof(auth, req.method, req.originalUrl, body)).digest();
    if (auth.mainRunId !== bootstrap.mainRunId || auth.expressRunId !== bootstrap.expressRunId ||
      Math.abs(Date.now() - Number(auth.timestamp)) > CONTROL_POLICY.authWindowMs ||
      !timingSafeEqual(expected, Buffer.from(auth.signature, 'hex'))) {
      rejectUnauthenticated(res); return;
    }
    const now = Date.now();
    for (const cache of [seen, heartbeatsSeen]) {
      for (const [id, timestamp] of cache) if (now - timestamp > 2 * CONTROL_POLICY.authWindowMs) cache.delete(id);
    }
    if (seen.has(auth.requestId) || heartbeatsSeen.has(auth.requestId)) { rejectUnauthenticated(res); return; }
    // Only authenticated replies carry an instance-bound proof. Never send the bootstrap token over HTTP.
    const send = res.json.bind(res);
    res.json = value => {
      const serialized = JSON.stringify(value);
      res.setHeader('x-oa-proof', createHmac('sha256', bootstrap.token).update(responseProof(auth, res.statusCode, serialized)).digest('hex'));
      return send(value);
    };
    // The private Main heartbeat has its own bounded budget and replay capacity.
    // Renderer health queries stay in the ordinary request budget.
    const heartbeat = req.method === 'GET' && req.originalUrl === CONTROL_ROUTES.heartbeat && body === '';
    const cache = heartbeat ? heartbeatsSeen : seen;
    const limit = heartbeat ? CONTROL_POLICY.maxHeartbeatsPerWindow : CONTROL_POLICY.maxRequestsPerWindow;
    // Two timestamp windows can overlap three fixed admission windows.
    if (cache.size >= 3 * limit || !admit(heartbeat ? 'heartbeat' : 'authenticated')) {
      res.status(429).json({ error: 'RATE_LIMITED' }); return;
    }
    cache.set(auth.requestId, now); contact();
    if (body) {
      try { req.body = JSON.parse(body) as unknown; }
      catch { res.status(400).json({ error: 'VALIDATION_ERROR' }); return; }
    }
    next();
  });
  const health = (_req: unknown, res: Response): void => {
    res.json(ControlHealthSchema.parse({ protocolVersion: PROTOCOL_VERSION, mainRunId: bootstrap.mainRunId,
      expressRunId: bootstrap.expressRunId, controlPlaneReady: true, agentReady: false,
      databaseVersion: store.databaseVersion, recoveredRuns: store.recoveredRuns }));
  };
  app.get(CONTROL_ROUTES.health, health);
  app.get(CONTROL_ROUTES.heartbeat, health);
  app.get(CONTROL_ROUTES.records, (_req, res) => res.json({ records: store.listRecords() }));
  app.post(CONTROL_ROUTES.records, (req, res) => {
    const input = SmokeBatchSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'VALIDATION_ERROR' }); return; }
    try { res.status(201).json({ records: store.insertRecords(input.data.records) }); }
    catch (error) {
      const conflict = error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT');
      res.status(conflict ? 409 : 503).json({ error: conflict ? 'RECORD_CONFLICT' : 'DATABASE_UNAVAILABLE' });
    }
  });
  // Domain failures map to fixed codes; SQLite messages and paths never leave the control plane.
  const failure = (res: Response, error: unknown): void => {
    const message = error instanceof Error ? error.message : '';
    const constraint = error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT');
    const code: ControlError = constraint ? 'RECORD_CONFLICT' : message === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' :
      message === 'NOT_FOUND' ? 'NOT_FOUND' : 'DATABASE_UNAVAILABLE';
    res.status({ RECORD_CONFLICT: 409, LIMIT_EXCEEDED: 409, NOT_FOUND: 404 }[code as string] ?? 503).json({ error: code });
  };
  const validationError = (res: Response): void => { res.status(400).json({ error: 'VALIDATION_ERROR' }); };
  app.get(CONTROL_ROUTES.overview, (_req, res) => {
    try {
      const counts = store.counts();
      res.json(ControlOverviewSchema.parse({ protocolVersion: PROTOCOL_VERSION, mainRunId: bootstrap.mainRunId, expressRunId: bootstrap.expressRunId,
        controlPlaneReady: true, agentReady: false, startedAt: startedAt.toISOString(), uptimeMs: Date.now() - startedAt.getTime(),
        runtime: { node: process.versions.node, abi: process.versions.modules, sqlite: store.sqliteVersion, platform: process.platform, arch: process.arch },
        database: { version: store.databaseVersion, recoveredRuns: store.recoveredRuns, ...counts },
        worker: { state: 'unavailable', error: 'WORKER_ISOLATION_UNAVAILABLE', reason: 'SEC_W01_NOT_PASSED', fixtureLaunch: 'disabled-in-release' },
        tools: { read: 'READ_ADAPTER_UNAVAILABLE', highRisk: 'SANDBOX_UNAVAILABLE' },
        capabilities: { ui: 'unverified', read: 'unavailable', gitRead: 'unavailable', highRisk: 'unavailable', workerIsolation: 'unverified' } }));
    } catch (error) { failure(res, error); }
  });
  app.get(CONTROL_ROUTES.settings, (_req, res) => { try { res.json(store.getSettings()); } catch (error) { failure(res, error); } });
  app.put(CONTROL_ROUTES.settings, (req, res) => {
    const input = WorkbenchSettingsSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    try { res.json(store.saveSettings(input.data)); } catch (error) { failure(res, error); }
  });
  app.get(CONTROL_ROUTES.projects, (_req, res) => { try { res.json({ projects: store.listProjects() }); } catch (error) { failure(res, error); } });
  app.post(CONTROL_ROUTES.projects, (req, res) => {
    const input = ProjectInputSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    try { res.status(201).json(store.addProject(input.data)); } catch (error) { failure(res, error); }
  });
  app.post(CONTROL_ROUTES.projectRemove, (req, res) => {
    const input = ProjectRefSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    try {
      if (!store.removeProject(input.data.id)) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      res.json({ projects: store.listProjects() });
    } catch (error) { failure(res, error); }
  });
  app.get(CONTROL_ROUTES.runs, (_req, res) => { try { res.json({ runs: store.listRuns() }); } catch (error) { failure(res, error); } });
  // Read-only task views (P2.2). Every value comes from committed SQLite rows, never from process memory.
  app.get(CONTROL_ROUTES.tasks, (_req, res) => {
    try { res.json(TaskListSchema.parse({ tasks: store.listTasks(TASK_API_LIMITS.maxTasks) })); } catch (error) { failure(res, error); }
  });
  app.post(CONTROL_ROUTES.taskSnapshot, (req, res) => {
    const input = TaskRefSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    try {
      const task = store.getTask(input.data.taskId);
      if (!task) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      res.json(TaskSnapshotSchema.parse(task));
    } catch (error) { failure(res, error); }
  });
  app.post(CONTROL_ROUTES.taskEvents, (req, res) => {
    const input = TaskEventsQuerySchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    const { taskId, afterSeq, limit = TASK_API_LIMITS.maxEventsPerPage } = input.data;
    try {
      // Snapshot and page are read in the same synchronous turn of the single writer, so they agree.
      const task = store.getTask(taskId);
      if (!task) { res.status(404).json({ error: 'NOT_FOUND' }); return; }
      if (afterSeq > task.lastSeq) { res.status(409).json({ error: 'CURSOR_AHEAD' }); return; }
      const events = [];
      let bytes = 0;
      for (const event of store.listTaskEvents(taskId, afterSeq, limit)) {
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length > 0 && bytes + size > TASK_API_LIMITS.maxPageBytes) break;
        events.push(event); bytes += size;
      }
      res.json(TaskEventPageSchema.parse({ taskId, afterSeq, lastSeq: task.lastSeq, events, hasMore: afterSeq + events.length < task.lastSeq }));
    } catch (error) { failure(res, error); }
  });
  // M2 model settings (ARCHITECTURE §6.2/§6.3). Replies carry the model choice and credential status, never key material.
  // Bumped by every committed change to the model or key; a connection test belongs to one revision.
  let revision = 0;
  const modelSettings = (): ModelSettings => ModelSettingsSchema.parse({ provider: MODEL_PROVIDER, model: store.getModel(), credential: credentials.status() });
  app.get(CONTROL_ROUTES.modelSettings, (_req, res) => { try { res.json(modelSettings()); } catch (error) { failure(res, error); } });
  app.put(CONTROL_ROUTES.modelSettings, (req, res) => {
    const input = ModelChoiceSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    try { store.saveModel(input.data.model); revision++; res.json(modelSettings()); } catch (error) { failure(res, error); }
  });
  app.put(CONTROL_ROUTES.modelCredential, (req, res) => {
    const input = ApiKeyInputSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    // Only fixed codes are returned; the key is never part of a reply, log line or error.
    credentials.set(input.data.apiKey).then(() => { revision++; res.json(modelSettings()); }, (error: unknown) => {
      const code = error instanceof Error ? error.message : '';
      if (code === 'SECURE_STORAGE_UNAVAILABLE' || code === 'SERVICE_UNAVAILABLE') res.status(503).json({ error: code });
      else if (code === 'VALIDATION_ERROR') validationError(res);
      else res.status(503).json({ error: 'DATABASE_UNAVAILABLE' });
    });
  });
  app.post(CONTROL_ROUTES.modelCredentialClear, (req, res) => {
    if (!EmptyInputSchema.safeParse(req.body).success) { validationError(res); return; }
    credentials.clear().then(() => { revision++; res.json(modelSettings()); }, (error: unknown) => { failure(res, error); });
  });
  // A second test for the same configuration joins the one in flight; any change to the model or key starts a fresh
  // test, so a result is never reported for a configuration that no longer exists.
  let testing: { revision: number; result: Promise<ModelTestResult> } | undefined;
  app.post(CONTROL_ROUTES.modelTest, (req, res) => {
    if (!EmptyInputSchema.safeParse(req.body).success) { validationError(res); return; }
    if (testing?.revision !== revision) {
      const current = { revision, result: (async () => {
        const model = store.getModel();
        const used = await credentials.withKey(apiKey => gateway.testConnection(apiKey, model));
        return used.ok ? used.value : ModelTestResultSchema.parse({ status: used.reason, model, httpStatus: null, latencyMs: null, checkedAt: new Date().toISOString() });
      })() };
      testing = current;
      void current.result.finally(() => { if (testing === current) testing = undefined; }).catch(() => {});
    }
    testing.result.then(result => { res.json(result); }, (error: unknown) => { failure(res, error); });
  });
  // No qualified Worker exists (ADR-WIN-001 D4): validate, then refuse before anything is scheduled or persisted.
  app.post(CONTROL_ROUTES.taskStart, (req, res) => {
    const input = TaskStartInputSchema.safeParse(req.body);
    if (!input.success) { validationError(res); return; }
    res.status(503).json({ error: 'WORKER_ISOLATION_UNAVAILABLE' });
  });
  app.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });
  const fail: ErrorRequestHandler = (_error, _req, res, next) => { void next; res.status(400).json({ error: 'VALIDATION_ERROR' }); };
  app.use(fail);
  return app;
}
