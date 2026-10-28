import express from 'express';
import type { Express, ErrorRequestHandler, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AuthHeadersSchema, CONTROL_POLICY, CONTROL_ROUTES, ControlHealthSchema, PROTOCOL_VERSION,
  requestProof, responseProof, SmokeBatchSchema } from '@operation-agent/contracts';
import type { Bootstrap, AuthHeaders } from '@operation-agent/contracts';
import type { Store } from './persistence/store.js';

export function createControlPlane(bootstrap: Bootstrap, store: Store, getPort: () => number, contact: () => void): Express {
  const app = express();
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
  app.post(CONTROL_ROUTES.taskStart, (_req, res) => { res.status(503).json({ error: 'WORKER_ISOLATION_UNAVAILABLE' }); });
  app.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });
  const fail: ErrorRequestHandler = (_error, _req, res, next) => { void next; res.status(400).json({ error: 'VALIDATION_ERROR' }); };
  app.use(fail);
  return app;
}
