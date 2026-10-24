// Node-only Main surrogate for lifecycle tests. This is NOT Electron or P1.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HostConfig, HostEvent } from './contracts.js';
const config = HostConfig.parse(JSON.parse(process.argv[2] ?? 'null') as unknown);
const host = fork(fileURLToPath(new URL('./host.js', import.meta.url)), [JSON.stringify(config)], {
  execPath: process.execPath, execArgv: [], env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', SystemDrive: process.env.SystemDrive ?? 'C:' },
  stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
});
host.on('message', (raw: unknown) => {
  const message = HostEvent.parse(raw);
  if (message.runId !== config.runId) throw new Error('Surrogate host instance mismatch');
  if (process.send && process.connected) process.send(message);
});
host.stderr?.pipe(process.stderr);
host.once('exit', code => process.exit(code ?? 1));
// Deliberately no process.on('exit') cleanup: test OS job-handle closure on SIGKILL.
