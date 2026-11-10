// Trusted transport bootstrap for the production agent runtime (ADR-WIN-001 narrow native exception). It is bundled
// into the staged Worker runtime only. It loads the fixed child artifact next to itself, which accepts only the
// parent-granted inherited pipe, and injects that channel, a clock and an id generator into the Agent runtime. The
// Agent runtime itself has no file, network, process or native capability; the AppContainer enforces that.
import { fileURLToPath } from 'node:url';
import { runAgentRuntime } from '../dist/runtime.js';

// dlopen on the fixed sibling path: no module resolution, so nothing outside the granted runtime is read.
const addon = { exports: {} };
process.dlopen(addon, fileURLToPath(new URL('./channel.node', import.meta.url)));
const native = addon.exports;
const channel = {
  read: (maxBytes, deadlineMs) => native.read(maxBytes, deadlineMs),
  write: (frame, deadlineMs) => native.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), deadlineMs),
  close: () => native.close(),
};
const clock = { schedule(milliseconds, callback) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } };
await runAgentRuntime({ channel, clock, newId: () => globalThis.crypto.randomUUID() });
