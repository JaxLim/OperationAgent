import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import ts from 'typescript';
import { readJson, object } from '../../scripts/p0-check.ts';
import { validateManifest, validateProject } from '../../scripts/check-workspace.ts';

test('manifest dependencies, exports and optional dependency backdoors are checked', () => {
  const manifest = readJson('packages/contracts/package.json');
  assert.deepEqual(validateManifest('contracts', manifest), []);
  for (const change of [
    { dependencies: { zod: '^4.6.7' } },
    { dependencies: { zod: '4.6.7', '@operation-agent/server': 'workspace:*' } },
    { devDependencies: { express: '5.3.0' } }, { optionalDependencies: { 'node-fetch': '3.3.2' } },
    { exports: { '.': '../../apps/server/dist/index.js' } }, { imports: { '#server': '../../apps/server/src/index.ts' } },
  ]) assert.notEqual(validateManifest('contracts', { ...manifest, ...change }).length, 0);
});

test('tsconfig cannot inject Node globals, aliases or weaker inherited checks', () => {
  const config = readJson('apps/agent-worker/tsconfig.json');
  assert.deepEqual(validateProject(config, false), []);
  for (const change of [{ types: ['node'] }, { paths: { '@db': ['../../apps/server/*'] } },
    { strict: false }, { strictNullChecks: false }, { skipLibCheck: true }, { allowJs: true }, { composite: false }]) {
    assert.notEqual(validateProject({ ...config, compilerOptions: { ...object(config.compilerOptions), ...change } }, false).length, 0);
  }
});

test('actual TypeScript projects reject Node in Renderer and DOM/network globals in Worker', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'type-boundary-'));
  try {
    for (const [configPath, code, expected] of [
      ['apps/desktop/tsconfig.renderer.json', "export {}; document.title = 'fixture';", false],
      ['apps/desktop/tsconfig.renderer.json', "import 'node:fs'; process.exit(0);", true],
      ['apps/agent-worker/tsconfig.json', "export {}; fetch('https://example.invalid'); document.title; process.exit(0); new URL('https://example.invalid');", true],
    ] as const) {
      const text = ts.readConfigFile(configPath, ts.sys.readFile);
      const config = ts.parseJsonConfigFileContent(text.config, ts.sys, resolve(configPath, '..'));
      const fixture = resolve(directory, 'fixture.ts'); writeFileSync(fixture, code, 'utf8');
      const program = ts.createProgram([...config.fileNames, fixture], { ...config.options, rootDir: resolve('.'), noEmit: true, composite: false, incremental: false });
      const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file && resolve(d.file.fileName) === fixture);
      assert.equal(diagnostics.length > 0, expected, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: name => name, getNewLine: () => '\n',
      }));
      if (configPath.includes('agent-worker')) for (const name of ['fetch', 'document', 'process', 'URL']) {
        assert.ok(diagnostics.some(d => ts.flattenDiagnosticMessageText(d.messageText, '\n').includes(name)), name);
      }
    }
  } finally {
    if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true });
  }
});
