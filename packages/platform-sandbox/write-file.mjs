// P3a adapter. The trusted host starts this script inside the tool AppContainer.
import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import process from 'node:process';

const file = process.argv[2];
const device = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
if (process.argv.length !== 3 || !file || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(file) ||
  file.endsWith('.') || device.test(file)) process.exit(64);

async function write() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 16_384) process.exit(65);
    chunks.push(chunk);
  }
  writeFileSync(file, Buffer.concat(chunks, length), { flag: 'wx' });
}

write().catch(() => { process.exitCode = 1; });
