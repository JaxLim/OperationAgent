import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { BootstrapSchema, CONTROL_POLICY, CONTROL_ROUTES, ControlFailureSchema, ControlHealthSchema, PROTOCOL_VERSION,
  SidecarReadySchema, SmokeBatchSchema, SmokeRecordsSchema, requestProof, responseProof } from '@operation-agent/contracts';
import type { Bootstrap, SidecarReady, SmokeBatch, ControlHealth, SmokeRecords, DesktopStatus } from '@operation-agent/contracts';
import { verifyStagedRuntime } from './staged-runtime.js';

interface Instance { child: ChildProcess; bootstrap: Bootstrap; exited: Promise<void>; ready?: SidecarReady; accepted: boolean }
export class SidecarSupervisor {
  private readonly mainRunId = randomUUID();
  private active: Instance | undefined;
  private wanted = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts: number[] = [];
  private pending = 0;
  private state: DesktopStatus['service']['state'] = 'stopped';
  private launchPromise: Promise<void> | undefined;
  constructor(private readonly stageDirectory: string, private readonly dataDirectory: string) {}
  snapshot(): { state: DesktopStatus['service']['state']; pid: number | null; port: number | null; expressRunId: string | null; restarts: number } {
    return { state: this.state, pid: this.active?.child.pid ?? null, port: this.active?.ready?.port ?? null,
      expressRunId: this.active?.bootstrap.expressRunId ?? null, restarts: this.attempts.length };
  }
  async start(): Promise<void> {
    if (this.wanted || this.active) throw new Error('SERVICE_ALREADY_STARTED');
    this.wanted = true;
    try { await this.beginLaunch(); } catch { this.wanted = false; this.state = 'unavailable'; throw new Error('SERVICE_UNAVAILABLE'); }
  }
  private async beginLaunch(): Promise<void> {
    this.launchPromise = this.launch();
    try { await this.launchPromise; } finally { this.launchPromise = undefined; }
  }
  private async launch(): Promise<void> {
    this.state = 'starting';
    const runtime = await verifyStagedRuntime(this.stageDirectory);
    if (!this.wanted || this.active) throw new Error('SERVICE_UNAVAILABLE');
    const bootstrap = BootstrapSchema.parse({ kind: 'bootstrap', protocolVersion: PROTOCOL_VERSION, mainRunId: this.mainRunId,
      expressRunId: randomUUID(), parentPid: process.pid, token: randomBytes(32).toString('hex'), dataDirectory: this.dataDirectory });
    // spawn avoids Electron's fork shim and ELECTRON_RUN_AS_NODE. No PATH, NODE_OPTIONS or user argv are inherited.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(runtime.node, [runtime.entry], { cwd: runtime.cwd, env, windowsHide: true,
      shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let markExited: () => void = () => {};
    const instance: Instance = { child, bootstrap, accepted: false, exited: new Promise<void>(resolve => { markExited = resolve; }) };
    this.active = instance;
    child.once('error', () => { if (child.pid === undefined) markExited(); });
    child.once('exit', () => {
      markExited();
      if (this.active !== instance) return;
      this.active = undefined; clearInterval(this.heartbeat); this.state = this.wanted ? 'unavailable' : 'stopped';
      if (instance.accepted && this.wanted) this.scheduleRestart();
    });
    try {
      instance.ready = await new Promise<SidecarReady>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HANDSHAKE_TIMEOUT')), CONTROL_POLICY.handshakeMs);
        const fail = (): void => { clearTimeout(timer); reject(new Error('SERVICE_UNAVAILABLE')); };
        child.once('exit', fail); child.once('error', fail);
        child.once('message', (message: unknown) => {
          clearTimeout(timer);
          const ready = SidecarReadySchema.safeParse(message);
          if (!ready.success || ready.data.pid !== child.pid || ready.data.parentPid !== process.pid || ready.data.mainRunId !== bootstrap.mainRunId ||
            ready.data.expressRunId !== bootstrap.expressRunId || ready.data.node !== runtime.version || ready.data.abi !== runtime.abi) {
            reject(new Error('IDENTITY_MISMATCH')); return;
          }
          child.removeListener('exit', fail); child.removeListener('error', fail); resolve(ready.data);
        });
        child.send(bootstrap, error => { if (error) fail(); });
      });
      const health = ControlHealthSchema.parse(await this.http(instance, 'GET', CONTROL_ROUTES.health));
      if (!this.wanted || this.active !== instance || health.mainRunId !== bootstrap.mainRunId || health.expressRunId !== bootstrap.expressRunId) throw new Error('IDENTITY_MISMATCH');
      instance.accepted = true; this.state = 'ready';
      let missed = 0; let probing = false;
      this.heartbeat = setInterval(() => {
        if (probing || this.active !== instance || !this.wanted) return;
        probing = true;
        void this.readHealth(instance, CONTROL_ROUTES.heartbeat).then(() => { missed = 0; }).catch(() => {
          if (++missed >= CONTROL_POLICY.missedHeartbeats) {
            this.state = 'unavailable'; clearInterval(this.heartbeat);
            void this.retire(instance).catch(() => { this.wanted = false; this.state = 'unavailable'; });
          }
        }).finally(() => { probing = false; });
      }, CONTROL_POLICY.heartbeatMs);
    } catch {
      instance.accepted = false;
      await this.retire(instance);
      if (this.active === instance) this.active = undefined;
      throw new Error('SERVICE_UNAVAILABLE');
    }
  }
  private scheduleRestart(): void {
    if (!this.wanted || this.restartTimer) return;
    const now = Date.now(); this.attempts = this.attempts.filter(time => now - time < CONTROL_POLICY.restartWindowMs);
    if (this.attempts.length >= CONTROL_POLICY.maxRestarts) { this.state = 'budget-exhausted'; return; }
    this.attempts.push(now);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.wanted) return;
      void this.beginLaunch().catch(() => { if (this.wanted) { this.state = 'unavailable'; this.scheduleRestart(); } });
    }, 250 * 2 ** (this.attempts.length - 1));
  }
  private async retire(instance: Instance): Promise<void> {
    const child = instance.child;
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    if (child.connected) child.send({ kind: 'shutdown', mainRunId: instance.bootstrap.mainRunId, expressRunId: instance.bootstrap.expressRunId }, () => {});
    let force: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      force = setTimeout(() => child.kill('SIGKILL'), CONTROL_POLICY.shutdownMs);
      await Promise.race([instance.exited, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('SIDECAR_CLEANUP_UNCONFIRMED')), CONTROL_POLICY.shutdownMs + CONTROL_POLICY.killWaitMs);
      })]);
    } finally { clearTimeout(force); clearTimeout(timeout); }
  }
  async stop(): Promise<void> {
    this.wanted = false; this.state = 'stopping'; clearInterval(this.heartbeat); clearTimeout(this.restartTimer); this.restartTimer = undefined;
    if (this.launchPromise) await this.launchPromise.catch(() => {});
    if (this.active) await this.retire(this.active);
    this.active = undefined; this.state = 'stopped';
  }
  private instance(): Instance {
    if (this.state !== 'ready' || !this.wanted || !this.active?.ready) throw new Error('SERVICE_UNAVAILABLE');
    return this.active;
  }
  async getHealth(): Promise<ControlHealth> {
    return this.readHealth(this.instance(), CONTROL_ROUTES.health);
  }
  private async readHealth(instance: Instance, path: string): Promise<ControlHealth> {
    const result = ControlHealthSchema.parse(await this.http(instance, 'GET', path));
    if (result.mainRunId !== instance.bootstrap.mainRunId || result.expressRunId !== instance.bootstrap.expressRunId) throw new Error('IDENTITY_MISMATCH');
    return result;
  }
  async listRecords(): Promise<SmokeRecords> { return SmokeRecordsSchema.parse(await this.http(this.instance(), 'GET', CONTROL_ROUTES.records)); }
  async writeRecords(input: SmokeBatch): Promise<SmokeRecords> {
    return SmokeRecordsSchema.parse(await this.http(this.instance(), 'POST', CONTROL_ROUTES.records, SmokeBatchSchema.parse(input)));
  }
  /** Authenticated call to one fixed control route; the caller validates input and the reply schema. */
  async call<T>(method: 'GET' | 'POST' | 'PUT', path: (typeof CONTROL_ROUTES)[keyof typeof CONTROL_ROUTES], schema: { parse(value: unknown): T }, input?: unknown): Promise<T> {
    return schema.parse(await this.http(this.instance(), method, path, input));
  }
  /** A user-initiated retry: stop whatever is left of the tree, forget the exhausted budget and start fresh. */
  async restart(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting' || this.state === 'stopping') return;
    await this.stop(); this.attempts = [];
    await this.start();
  }
  private async http(instance: Instance, method: 'GET' | 'POST' | 'PUT', path: string, input?: unknown): Promise<unknown> {
    const pendingLimit = path === CONTROL_ROUTES.heartbeat ? 16 : 15;
    if (!instance.ready || this.pending >= pendingLimit || !this.wanted) throw new Error('SERVICE_UNAVAILABLE');
    const body = input ? JSON.stringify(input) : '';
    const auth = { mainRunId: instance.bootstrap.mainRunId, expressRunId: instance.bootstrap.expressRunId,
      requestId: randomUUID(), timestamp: String(Date.now()) };
    const signature = createHmac('sha256', instance.bootstrap.token).update(requestProof(auth, method, path, body)).digest('hex');
    this.pending++;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: instance.ready!.port, path, method, agent: false,
          maxHeaderSize: 8192, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
            'x-oa-main-run': auth.mainRunId, 'x-oa-express-run': auth.expressRunId, 'x-oa-request-id': auth.requestId,
            'x-oa-timestamp': auth.timestamp, 'x-oa-protocol': PROTOCOL_VERSION, 'x-oa-signature': signature } }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => { size += chunk.length;
            if (size > CONTROL_POLICY.maxResponseBytes) req.destroy(new Error('RESPONSE_LIMIT')); else chunks.push(chunk);
          });
          res.on('error', () => reject(new Error('SERVICE_UNAVAILABLE')));
          res.on('end', () => {
            clearTimeout(deadline);
            if (this.active !== instance || !this.wanted) { reject(new Error('SERVICE_UNAVAILABLE')); return; }
            const bytes = Buffer.concat(chunks).toString('utf8');
            const proof = res.headers['x-oa-proof'];
            const expected = createHmac('sha256', instance.bootstrap.token).update(responseProof(auth, res.statusCode ?? 0, bytes)).digest();
            if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(expected, Buffer.from(proof, 'hex'))) {
              reject(new Error('IDENTITY_MISMATCH')); return;
            }
            try {
              const value: unknown = JSON.parse(bytes);
              if (res.statusCode !== 200 && res.statusCode !== 201) { reject(new Error(ControlFailureSchema.parse(value).error)); return; }
              resolve(value);
            } catch { reject(new Error('VALIDATION_ERROR')); }
          });
        });
        const deadline = setTimeout(() => req.destroy(new Error('SERVICE_UNAVAILABLE')), CONTROL_POLICY.requestMs);
        req.on('error', () => { clearTimeout(deadline); reject(new Error('SERVICE_UNAVAILABLE')); }); req.end(body);
      });
    } finally { this.pending--; }
  }
}
