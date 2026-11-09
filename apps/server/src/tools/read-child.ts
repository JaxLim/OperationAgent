// SEC-08 Read Adapter child program. Express launches one per `read_file` call as a separate, short-lived Node process
// under the Node permission model: `--permission --allow-fs-read=<workspace root>` and nothing else, so this process can
// read only below the root, cannot write, spawn processes, start workers or load native addons. It is self-contained
// (Node built-ins only) so the permission grant never has to cover node_modules. Express never imports this module; the
// import-boundary lint enforces that no Express code reads workspace files in-process.
//
// Protocol: the root is argv[2]; one JSON request line arrives on stdin ({v, segments, maxBytes}); exactly one JSON
// reply line is written to stdout. Express validates both directions against packages/contracts.
//
// Symbolic link and race defence: every component below the root is checked with lstat (a link or junction is refused),
// the final file must have exactly one link, and after opening, the handle's (device, file id) must equal the checked
// identity. The whole chain is then re-checked, so a component swapped for a link between check and open is detected.
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL = 1;
const MAX_REQUEST_BYTES = 65_536;
const MAX_BYTES = 262_144;

type Refusal = 'INVALID_PATH' | 'NOT_FOUND' | 'NOT_A_FILE' | 'LINK_REJECTED' | 'MULTIPLE_LINKS' | 'BINARY_FILE' | 'CHANGED_DURING_READ' |
  'ACCESS_DENIED' | 'WORKSPACE_UNAVAILABLE';
class Refused extends Error { constructor(readonly code: Refusal) { super(code); } }

function reply(value: object): void { process.stdout.write(JSON.stringify({ v: PROTOCOL, ...value }) + '\n'); }

function errorCode(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : ''; }

function stat(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true, throwIfNoEntry: false }); }
  catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTDIR') return undefined;
    if (code === 'EACCES' || code === 'EPERM' || code === 'ERR_ACCESS_DENIED') throw new Refused('ACCESS_DENIED');
    throw error;
  }
}

function parse(raw: string): { segments: string[]; maxBytes: number } {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refused('INVALID_PATH');
  const { v, segments, maxBytes, ...rest } = value as Record<string, unknown>;
  if (v !== PROTOCOL || Object.keys(rest).length || !Array.isArray(segments) || segments.length < 1 || segments.length > 64 ||
    !Number.isInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > MAX_BYTES) throw new Refused('INVALID_PATH');
  // Express already normalized the path; anything that could leave the chain is refused again here.
  for (const segment of segments) {
    if (typeof segment !== 'string' || !segment || segment.length > 255 || segment === '.' || segment === '..' ||
      /[\\/:]|\p{Cc}/u.test(segment)) throw new Refused('INVALID_PATH');
  }
  return { segments: segments as string[], maxBytes: maxBytes as number };
}

type Identity = readonly [bigint, bigint];
const same = (stats: BigIntStats, identity: Identity): boolean => stats.dev === identity[0] && stats.ino === identity[1];

/** lstat every component; returns the identity of each, the last being the file. */
function walk(root: string, segments: readonly string[]): { path: string; chain: Identity[]; file: BigIntStats } {
  const chain: Identity[] = [];
  let path = root;
  let file: BigIntStats | undefined;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const stats = stat(path);
    if (!stats) throw new Refused('NOT_FOUND');
    if (stats.isSymbolicLink()) throw new Refused('LINK_REJECTED');
    const last = index === segments.length - 1;
    if (last) {
      if (!stats.isFile()) throw new Refused('NOT_A_FILE');
      if (stats.nlink !== 1n) throw new Refused('MULTIPLE_LINKS');
      file = stats;
    } else if (!stats.isDirectory()) throw new Refused('NOT_FOUND');
    chain.push([stats.dev, stats.ino]);
  }
  return { path, chain, file: file! };
}

function readBounded(fd: number, maxBytes: number): { data: Buffer; truncated: boolean } {
  // One extra byte tells whether the file continues past the limit, even if it grew after fstat.
  const buffer = Buffer.alloc(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const count = readSync(fd, buffer, total, buffer.length - total, null);
    if (count === 0) break;
    total += count;
  }
  const truncated = total > maxBytes;
  let end = Math.min(total, maxBytes);
  if (truncated) {
    // Do not cut a UTF-8 sequence: step back over continuation bytes to the start of the last character.
    let start = end;
    while (start > 0 && start > end - 4 && (buffer[start - 1]! & 0xc0) === 0x80) start--;
    if (start > 0) {
      const lead = buffer[start - 1]!;
      const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (width > 1 && start - 1 + width > end) end = start - 1;
    }
  }
  return { data: buffer.subarray(0, end), truncated };
}

function run(root: string, raw: string): void {
  const request = parse(raw);
  const rootStats = stat(root);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Refused('WORKSPACE_UNAVAILABLE');
  const checked = walk(root, request.segments);
  let fd: number;
  try { fd = openSync(checked.path, 'r'); }
  catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new Refused('CHANGED_DURING_READ');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'ERR_ACCESS_DENIED') throw new Refused('ACCESS_DENIED');
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !same(opened, checked.chain[checked.chain.length - 1]!)) throw new Refused('CHANGED_DURING_READ');
    // Re-walk: a directory swapped for a link, or the file replaced, after the first walk shows up here.
    const again = stat(root);
    if (!again || again.isSymbolicLink() || again.dev !== rootStats.dev || again.ino !== rootStats.ino) throw new Refused('CHANGED_DURING_READ');
    let rewalk: ReturnType<typeof walk>;
    try { rewalk = walk(root, request.segments); } catch { throw new Refused('CHANGED_DURING_READ'); }
    if (rewalk.chain.some((identity, index) => identity[0] !== checked.chain[index]![0] || identity[1] !== checked.chain[index]![1])) {
      throw new Refused('CHANGED_DURING_READ');
    }
    const { data, truncated } = readBounded(fd, request.maxBytes);
    if (data.includes(0)) throw new Refused('BINARY_FILE');
    try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Refused('BINARY_FILE'); }
    reply({ status: 'ok', content: data.toString('base64'), size: Number(opened.size), truncated });
  } finally { closeSync(fd); }
}

const chunks: Buffer[] = [];
let received = 0;
process.stdin.on('data', (chunk: Buffer) => {
  received += chunk.length;
  if (received > MAX_REQUEST_BYTES) { process.exitCode = 2; process.stdin.destroy(); return; }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  const root = process.argv[2];
  try {
    if (typeof root !== 'string' || !root) throw new Refused('WORKSPACE_UNAVAILABLE');
    run(root, Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof Refused) reply({ status: 'refused', code: error.code });
    // Anything else is an adapter failure: no reply line, a non-zero exit, and no path or message on any stream.
    else process.exitCode = 1;
  }
});
