import { resolve, relative } from 'node:path';

export const zones = [
  ['apps/desktop/src/renderer', ['@operation-agent/contracts']],
  ['apps/desktop/src/preload', ['@operation-agent/contracts', 'electron']],
  ['apps/desktop/src/main', ['@operation-agent/contracts', '@operation-agent/platform-supervision', 'electron', 'node:path', 'node:url']],
  ['apps/server/src', ['@operation-agent/contracts', '@operation-agent/worker-transport', '@operation-agent/platform-worker/parent',
    '@operation-agent/platform-supervision', 'express',
    'better-sqlite3', 'node:crypto', 'node:fs', 'node:path', 'node:url', 'node:http']],
  ['apps/agent-worker/src', ['@operation-agent/contracts', '@operation-agent/worker-transport']],
  ['packages/contracts/src', ['zod']],
  ['packages/worker-transport/src', ['@operation-agent/contracts']],
  ['packages/platform-worker/src', ['@operation-agent/contracts']],
  ['packages/platform-supervision/src', ['@operation-agent/contracts']],
];

export function zoneFor(filename, cwd) {
  const name = relative(cwd, filename).replaceAll('\\', '/');
  return zones.find(([prefix]) => name.startsWith(prefix + '/'));
}

export default {
  meta: { type: 'problem', schema: [], messages: { forbidden: 'Forbidden process boundary or capability: {{reason}}' } },
  create(context) {
    const zone = zoneFor(context.filename, context.cwd);
    if (!zone) return {};
    const [prefix, baseAllowed] = zone;
    const source = relative(context.cwd, context.filename).replaceAll('\\', '/');
    const mainCapabilities = {
      'apps/desktop/src/main/sidecar.ts': ['node:child_process', 'node:crypto', 'node:http'],
      'apps/desktop/src/main/staged-runtime.ts': ['node:crypto', 'node:fs/promises'],
      // ADR-WIN-001 narrow native boundary: only the fixed package-relative parent artifact.
      'packages/platform-worker/src/parent.ts': ['node:module'],
    };
    const allowed = [...baseAllowed, ...(mainCapabilities[source] ?? [])];
    const report = (node, reason) => context.report({ node, messageId: 'forbidden', data: { reason } });
    function check(node, specifier) {
      if (typeof specifier !== 'string' || /[\\?#]/.test(specifier)) return report(node, 'unresolved module');
      if (specifier.startsWith('.')) {
        const target = resolve(context.filename, '..', specifier);
        if (zoneFor(target, context.cwd)?.[0] !== prefix) report(node, specifier);
      } else if (!allowed.includes(specifier)) report(node, specifier);
    }
    const noAmbientIO = !prefix.endsWith('/main') && prefix !== 'apps/server/src';
    return {
      ImportDeclaration(node) { check(node, node.source.value); },
      ExportNamedDeclaration(node) { if (node.source) check(node, node.source.value); },
      ExportAllDeclaration(node) { check(node, node.source.value); },
      ImportExpression(node) { report(node, 'dynamic import'); },
      TSImportEqualsDeclaration(node) { report(node, 'import equals'); },
      TSImportType(node) { check(node, node.argument.value); },
      Identifier(node) {
        if (['require', 'eval', 'Function'].includes(node.name)) report(node, node.name);
        if (noAmbientIO && ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
          'navigator', 'process', 'Buffer'].includes(node.name)) report(node, node.name);
        if (prefix.endsWith('/preload') && node.name === 'ipcRenderer' && node.parent.type !== 'ImportSpecifier' &&
          !(node.parent.type === 'MemberExpression' && node.parent.object === node && !node.parent.computed && node.parent.property.name === 'invoke')) report(node, 'raw IPC exposure');
      },
      MemberExpression(node) {
        if (prefix.endsWith('/preload') && node.object.type === 'Identifier' && node.object.name === 'ipcRenderer') {
          const call = node.parent;
          const channel = call.type === 'CallExpression' ? call.arguments[0] : undefined;
          if (node.computed || node.property.name !== 'invoke' || !channel || channel.type !== 'MemberExpression' ||
            channel.computed || channel.object.name !== 'IPC_CHANNELS' || !['health', 'listRecords', 'writeRecords'].includes(channel.property.name)) report(node, 'unlisted IPC channel');
        }
        if (noAmbientIO && node.computed && node.object.type === 'Identifier' && ['globalThis', 'window', 'self'].includes(node.object.name)) {
          report(node, 'computed global capability');
        }
      },
    };
  },
};
