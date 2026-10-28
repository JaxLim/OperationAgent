// Trusted transport bootstrap (ADR-WIN-001 narrow native exception). It is bundled into the P1 fixture
// runtime only, never into the release sidecar. It loads the fixed child artifact next to itself, which
// accepts only the parent-granted inherited pipe, and injects that channel and a clock into the fixture.
import { createRequire } from 'node:module';
import { runFixture } from '../dist/fixture.js';

const native = createRequire(import.meta.url)('./channel.node');
const channel = {
  read: (maxBytes, deadlineMs) => native.read(maxBytes, deadlineMs),
  write: (frame, deadlineMs) => native.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), deadlineMs),
  close: () => native.close(),
};
const clock = { schedule(milliseconds, callback) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } };
await runFixture(channel, clock);
