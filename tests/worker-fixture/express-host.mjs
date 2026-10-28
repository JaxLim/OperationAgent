// Test-only Express host for the restricted fixture: the real Express launcher/supervisor in a separate
// pinned-Node process, so SEC-17 can kill it like a crashed Express. Never staged into the release sidecar.
import { randomUUID } from 'node:crypto';
import { FixtureSupervisor } from '../../apps/server/dist/worker/launcher.js';

const runtimeDirectory = process.argv[2];
if (!runtimeDirectory || !process.send) process.exit(2);
const expressRunId = randomUUID();
const supervisor = new FixtureSupervisor({ target: `${process.platform}-${process.arch}`, runtimeDirectory, expressRunId });
const handlers = {
  async start() { const worker = await supervisor.start(); return { expressRunId, hostPid: process.pid, baseline: worker.baseline, workerRunId: worker.identity.workerRunId }; },
  async health() { return supervisor.worker.health(); },
  // Capture the Worker first: the supervisor may already be restarting a replacement when it exits.
  async fault(mode) { const worker = supervisor.worker; void worker.fault(mode).catch(() => {}); return worker.closed; },
  async burst(count) {
    const worker = supervisor.worker;
    const results = await Promise.allSettled(Array.from({ length: count }, () => worker.health()));
    return { fulfilled: results.filter(result => result.status === 'fulfilled').length,
      rejected: results.filter(result => result.status === 'rejected').length, exit: await worker.closed };
  },
  async snapshot() { return supervisor.snapshot(); },
  async stop() { const worker = supervisor.worker; await supervisor.stop(); return worker ? worker.closed : null; },
};
process.on('message', message => {
  void (async () => {
    try { process.send({ id: message.id, value: await handlers[message.command](message.input) }); }
    catch (error) { process.send({ id: message.id, error: error.message }); }
  })();
});
process.on('disconnect', () => { void supervisor.stop().finally(() => process.exit(0)); });
process.send({ kind: 'ready', pid: process.pid });
