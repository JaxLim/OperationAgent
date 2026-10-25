import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = file => readFileSync(resolve(root, file), 'utf8');
for (const path of ['apps/desktop/dist/main/index.js', 'apps/server/dist/index.js', 'apps/agent-worker/dist/index.js',
  'packages/contracts/dist/index.js', 'packages/worker-transport/dist/index.js',
  'packages/platform-worker/dist/parent.js', 'packages/platform-worker/dist/child.js', 'packages/platform-supervision/dist/index.js']) {
  assert.ok(read(path).trim().length > 0, `Missing compiled entry: ${path}`);
}
const preload = read('apps/desktop/dist/preload/index.cjs');
const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map(match => match[1]);
assert.deepEqual(requires, ['electron'], 'Sandboxed preload must bundle all non-Electron dependencies');
const html = read('apps/desktop/dist/renderer/index.html');
assert.ok(html.includes("connect-src 'none'") && !html.includes('unsafe-eval'), 'Renderer CSP weakened');
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
assert.ok(scripts.length > 0);
for (const script of scripts) {
  assert.ok(script.startsWith('./assets/'));
  assert.ok(read('apps/desktop/dist/renderer/' + script).length > 0);
}
for (const file of readdirSync(resolve(root, 'apps/desktop/dist/renderer/assets'))) {
  if (file.endsWith('.js')) assert.doesNotMatch(read('apps/desktop/dist/renderer/assets/' + file), /\bfetch\s*\(|\brequire\s*\(/);
}
console.log(JSON.stringify({ check: 'BUILT_ARTIFACT_STRUCTURE', passed: true, electronLaunched: false, installedSmokeTests: 'NOT_RUN' }));
