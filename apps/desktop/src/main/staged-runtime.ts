import { createHash } from 'node:crypto';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { PROTOCOL_VERSION } from '@operation-agent/contracts';

interface Manifest { schemaVersion: number; protocolVersion: string; node: string; abi: string; platform: string;
  arch: string; agentReady: boolean; files: Record<string, string> }
export async function verifyStagedRuntime(directory: string): Promise<{ node: string; entry: string; cwd: string; version: string; abi: string }> {
  const root = await realpath(directory);
  const bytes = await readFile(resolve(root, 'manifest.json'));
  if (bytes.length > 4 * 1024 * 1024) throw new Error('STAGE_MANIFEST_INVALID');
  const manifest = JSON.parse(bytes.toString('utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== PROTOCOL_VERSION || manifest.node !== '24.22.1' ||
    manifest.abi !== '137' || manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.agentReady !== false ||
    !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('STAGE_MANIFEST_INVALID');
  const files = Object.entries(manifest.files);
  if (files.length < 3 || files.length > 20_000) throw new Error('STAGE_MANIFEST_INVALID');
  for (const [name, expected] of files) {
    if (!/^(node|server)\/[\w@+./-]+$/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') ||
      typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('STAGE_MANIFEST_INVALID');
    const path = resolve(root, name);
    if (!path.startsWith(root + sep) || !(await realpath(path)).startsWith(root + sep) || (await lstat(path)).isSymbolicLink()) throw new Error('STAGE_PATH_ESCAPE');
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== expected) throw new Error('STAGE_INTEGRITY_FAILED');
  }
  const nodePath = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
  if (!manifest.files[nodePath] || !manifest.files['server/dist/entry.js'] || !files.some(([name]) => name.endsWith(`/prebuilds/${process.platform}-${process.arch}.node`))) throw new Error('STAGE_INCOMPLETE');
  return { node: resolve(root, nodePath), entry: resolve(root, 'server/dist/entry.js'), cwd: root, version: manifest.node, abi: manifest.abi };
}
