// Trusted transport bootstrap (ADR-WIN-001 narrow native exception). It is bundled into the P1 fixture
// runtime only, never into the release sidecar. It loads the fixed child artifact next to itself, which
// accepts only the parent-granted inherited pipe, and injects that channel and a clock into the fixture.
import { fileURLToPath } from 'node:url';
import { runFixture } from '../dist/fixture.js';

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
await runFixture(channel, clock);
