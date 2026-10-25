import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
async function errors(filePath: string, code: string): Promise<string[]> {
  return (await eslint.lintText(code, { filePath })).flatMap(r => r.messages.filter(m => m.severity === 2).map(m => String(m.ruleId)));
}

test('pure contracts imports are accepted in every process', async () => {
  for (const path of ['apps/desktop/src/renderer/index.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/main/index.ts', 'apps/server/src/index.ts', 'apps/agent-worker/src/index.ts']) {
    assert.deepEqual(await errors(path, "import { PROTOCOL_VERSION } from '@operation-agent/contracts'; export const version = PROTOCOL_VERSION;"), []);
  }
});

test('real ESLint invocation rejects static, relative, aliased, require and dynamic import bypasses', async () => {
  for (const [path, code] of [
    ['apps/desktop/src/renderer/index.ts', "import 'node:fs';"],
    ['apps/desktop/src/renderer/index.ts', "import 'express';"],
    ['apps/desktop/src/renderer/index.ts', "import '../main/index.js';"],
    ['apps/desktop/src/renderer/index.ts', "import '@server/db';"],
    ['apps/desktop/src/renderer/index.ts', "import '@operation-agent/server';"],
    ['apps/desktop/src/renderer/index.ts', "import 'electron';"],
    ['apps/desktop/src/renderer/index.ts', "void fetch('http://127.0.0.1');"],
    ['apps/desktop/src/main/index.ts', "import 'better-sqlite3';"],
    ['apps/desktop/src/main/index.ts', "import 'node:child_process';"],
    ['packages/contracts/src/index.ts', "import 'node:fs';"],
    ['apps/server/src/index.ts', "import '@operation-agent/agent-worker';"],
    ['apps/agent-worker/src/index.ts', "import 'node:net';"],
    ['apps/agent-worker/src/index.ts', "import '@operation-agent/platform-worker/parent';"],
    ['apps/agent-worker/src/index.ts', "require('node:fs');"],
    ['apps/agent-worker/src/index.ts', "void import('node:fs');"],
    ['apps/agent-worker/src/index.ts', "export * from '../../../apps/server/src/index.js';"],
    ['apps/agent-worker/src/index.ts', "import fs = require('node:fs'); export { fs };"],
    ['apps/agent-worker/src/index.ts', "export type Fs = typeof import('node:fs');"],
  ]) assert.ok((await errors(path!, code!)).includes('architecture/boundaries'), path + ': ' + code);
});
