// SEC-08 Read Adapter child program. Express launches one per `read_file` call as a separate, short-lived Node process
// under the Node permission model: `--permission --allow-fs-read=<workspace root>` and nothing else, so this process can
// read only below the root, cannot write, spawn processes, start workers or load native addons. It is self-contained
// (Node built-ins only) so the permission grant never has to cover node_modules. Express never imports this module; the
// import-boundary lint enforces that no Express code reads workspace files in-process.
//
// Protocol: the root is argv[2]; one JSON request line arrives on stdin ({v, op: 'read' | 'list', ...}); exactly one JSON
// reply line is written to stdout. Express validates both directions against packages/contracts.
//
// Symbolic link and race defence: every component below the root is checked with lstat (a link or junction is refused),
// the final file must have exactly one link, and after opening, the handle's identity must equal the checked identity.
// The whole chain is then re-checked, so a component swapped for a link between check and open is detected.
//
// Identity is not just (device, file id): Node exposes 64 bits of the Windows file id, and on volumes with 128-bit ids
// (ReFS) those 64 bits are not guaranteed unique, so two different files can report the same `ino`. Every identity
// therefore also carries the creation time, and for the file the change and modification times and the size, all read
// from the same handle or link-free path. Two distinct files must collide on every field to be confused.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL = 1;
const MAX_REQUEST_BYTES = 65_536;
const MAX_BYTES = 262_144;
const MAX_ENTRIES = 1_000;
const MAX_DEPTH = 4;

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

type Request = { op: 'read'; segments: string[]; maxBytes: number }
  | { op: 'list'; segments: string[]; depth: number; maxEntries: number; skip: string[] };

const validSegment = (segment: unknown): segment is string => typeof segment === 'string' && segment.length > 0 && segment.length <= 255 &&
  segment !== '.' && segment !== '..' && !/[\\/:]|\p{Cc}/u.test(segment);
const bounded = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;

function parse(raw: string): Request {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refused('INVALID_PATH');
  const { v, op, segments, maxBytes, depth, maxEntries, skip, ...rest } = value as Record<string, unknown>;
  // Express already normalized the path; anything that could leave the chain is refused again here.
  if (v !== PROTOCOL || Object.keys(rest).length || !Array.isArray(segments) || segments.length > 64 || !segments.every(validSegment)) {
    throw new Refused('INVALID_PATH');
  }
  if (op === 'read' && segments.length >= 1 && bounded(maxBytes, MAX_BYTES) && depth === undefined && maxEntries === undefined && skip === undefined) {
    return { op, segments, maxBytes };
  }
  if (op === 'list' && maxBytes === undefined && bounded(depth, MAX_DEPTH) && bounded(maxEntries, MAX_ENTRIES) && Array.isArray(skip) &&
    skip.length <= 64 && skip.every(validSegment)) {
    return { op, segments, depth, maxEntries, skip: skip.map(name => name.toLowerCase()) };
  }
  throw new Refused('INVALID_PATH');
}

type Identity = readonly bigint[];
/** Directory identity: volume, file id and creation time. A file also adds change time, modification time and size. */
const identityOf = (stats: BigIntStats): Identity => stats.isFile()
  ? [stats.dev, stats.ino, stats.birthtimeNs, stats.ctimeNs, stats.mtimeNs, stats.size]
  : [stats.dev, stats.ino, stats.birthtimeNs];
const equal = (left: Identity, right: Identity): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

/** lstat every component; returns the identity of each, the last being the target (a file, or a directory to list). */
function walk(root: string, segments: readonly string[], target: 'file' | 'directory' = 'file'): { path: string; chain: Identity[]; file: BigIntStats } {
  const chain: Identity[] = [];
  let path = root;
  let file: BigIntStats | undefined;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const stats = stat(path);
    if (!stats) throw new Refused('NOT_FOUND');
    if (stats.isSymbolicLink()) throw new Refused('LINK_REJECTED');
    const last = index === segments.length - 1;
    if (last && target === 'directory') {
      if (!stats.isDirectory()) throw new Refused('NOT_A_FILE');
    } else if (last) {
      if (!stats.isFile()) throw new Refused('NOT_A_FILE');
      if (stats.nlink !== 1n) throw new Refused('MULTIPLE_LINKS');
      file = stats;
    } else if (!stats.isDirectory()) throw new Refused('NOT_FOUND');
    chain.push(identityOf(stats));
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

/** Re-walks root and chain; any component that changed identity or became a link means the result cannot be trusted. */
function verifyChain(root: string, rootStats: BigIntStats, segments: readonly string[], chain: readonly Identity[], target: 'file' | 'directory'): void {
  const again = stat(root);
  if (!again || again.isSymbolicLink() || !equal(identityOf(again), identityOf(rootStats))) throw new Refused('CHANGED_DURING_READ');
  let rewalk: ReturnType<typeof walk>;
  try { rewalk = walk(root, segments, target); } catch { throw new Refused('CHANGED_DURING_READ'); }
  if (rewalk.chain.length !== chain.length || rewalk.chain.some((identity, index) => !equal(identity, chain[index]!))) {
    throw new Refused('CHANGED_DURING_READ');
  }
}

type Entry = { segments: string[]; type: 'file' | 'directory' | 'link' | 'other'; size: number | null };
/** A directory to read: its absolute path, its segments below the listed directory, and every component from the root down. */
type Pending = { path: string; segments: string[]; chain: { path: string; identity: Identity }[] };

const MAX_PIN_CANDIDATES = 16;
const MAX_UNLISTED = 100;
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function readNames(path: string): string[] {
  try { return readdirSync(path).sort(byName); }
  catch (error) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM' || code === 'ERR_ACCESS_DENIED') throw new Refused('ACCESS_DENIED');
    throw new Refused('CHANGED_DURING_READ');
  }
}

/** Root and every component down to the directory still have their recorded identities, and none has become a link. */
function verifyPending(root: string, rootStats: BigIntStats, directory: Pending): void {
  const again = stat(root);
  if (!again || again.isSymbolicLink() || !equal(identityOf(again), identityOf(rootStats))) throw new Refused('CHANGED_DURING_READ');
  for (const component of directory.chain) {
    const now = stat(component.path);
    if (!now || now.isSymbolicLink() || !now.isDirectory() || !equal(identityOf(now), component.identity)) throw new Refused('CHANGED_DURING_READ');
  }
}

/**
 * Pins a directory: on Windows a directory cannot be renamed, and neither can any of its ancestors, while a handle is
 * open on anything inside it. One non-link entry is opened and its handle's identity checked against the path, so once
 * the chain is re-verified the directory and everything above it are fixed for as long as the handle stays open.
 */
function pin(directory: Pending): { fd: number; path: string; identity: Identity } | 'empty' | null {
  const names = readNames(directory.path);
  if (!names.length) return 'empty';
  const candidates: { name: string; directory: boolean }[] = [];
  for (const name of names) {
    if (!validSegment(name)) continue;
    const stats = stat(join(directory.path, name));
    if (stats && !stats.isSymbolicLink() && (stats.isDirectory() || stats.isFile())) candidates.push({ name, directory: stats.isDirectory() });
    if (candidates.length >= MAX_PIN_CANDIDATES * 4) break;
  }
  // Directories first: opening one never blocks on another process's file lock.
  candidates.sort((left, right) => Number(right.directory) - Number(left.directory));
  for (const candidate of candidates.slice(0, MAX_PIN_CANDIDATES)) {
    const path = join(directory.path, candidate.name);
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { continue; }
    try {
      const opened = identityOf(fstatSync(fd, { bigint: true }));
      const now = stat(path);
      if (now && !now.isSymbolicLink() && equal(identityOf(now), opened)) return { fd, path, identity: opened };
    } catch { /* fall through to close */ }
    closeSync(fd);
  }
  return null;
}

/**
 * Breadth-first, names sorted, at most `depth` levels and `maxEntries` entries. Links are reported and never followed;
 * `.git`, `node_modules` and the sensitive directories Express names are reported but never entered.
 *
 * Every directory is read only while pinned (see `pin`) and after its whole chain from the root has been re-verified,
 * then verified again before its entries are accepted. A directory swapped for a junction before it is pinned fails
 * verification; after it is pinned it cannot be swapped. A non-empty directory that cannot be pinned (only links or
 * locked entries) is never read: it is reported as unlisted.
 */
function list(root: string, request: Extract<Request, { op: 'list' }>): void {
  const rootStats = stat(root);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Refused('WORKSPACE_UNAVAILABLE');
  const checked = request.segments.length ? walk(root, request.segments, 'directory') : { path: root, chain: [] as Identity[] };
  let prefix = root;
  const baseChain = request.segments.map((segment, index) => { prefix = join(prefix, segment); return { path: prefix, identity: checked.chain[index]! }; });
  const skip = new Set(['.git', 'node_modules', ...request.skip]);
  const entries: Entry[] = [];
  const unlisted: string[][] = [];
  let truncated = false;
  let level: Pending[] = [{ path: checked.path, segments: [], chain: baseChain }];
  for (let depth = 1; depth <= request.depth && level.length && !truncated; depth++) {
    const next: Pending[] = [];
    for (const directory of level) {
      const pinned = pin(directory);
      if (pinned === 'empty') continue;
      if (pinned === null) { if (unlisted.length < MAX_UNLISTED) unlisted.push(directory.segments); continue; }
      try {
        verifyPending(root, rootStats, directory);
        const names = readNames(directory.path);
        const found: Entry[] = []; const children: Pending[] = [];
        for (const name of names) {
          if (entries.length + found.length >= request.maxEntries) { truncated = true; break; }
          if (!validSegment(name)) continue;
          const path = join(directory.path, name);
          const stats = stat(path);
          if (!stats) continue;
          const segments = [...directory.segments, name];
          const type = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
          found.push({ segments, type, size: type === 'file' ? Number(stats.size) : null });
          if (type === 'directory' && depth < request.depth && !skip.has(name.toLowerCase())) {
            children.push({ path, segments, chain: [...directory.chain, { path, identity: identityOf(stats) }] });
          }
        }
        // Accept this directory's entries only if the pin and the whole chain are still exactly as verified.
        const still = stat(pinned.path);
        if (!still || still.isSymbolicLink() || !equal(identityOf(still), pinned.identity)) throw new Refused('CHANGED_DURING_READ');
        verifyPending(root, rootStats, directory);
        entries.push(...found); next.push(...children);
      } finally { closeSync(pinned.fd); }
      if (truncated) break;
    }
    level = next;
  }
  reply({ status: 'listed', entries, truncated, unlisted });
}

function run(root: string, raw: string): void {
  const request = parse(raw);
  if (request.op === 'list') { list(root, request); return; }
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
    if (!opened.isFile() || opened.nlink !== 1n || !equal(identityOf(opened), checked.chain[checked.chain.length - 1]!)) throw new Refused('CHANGED_DURING_READ');
    // Re-walk: a directory swapped for a link, or the file replaced, after the first walk shows up here.
    verifyChain(root, rootStats, request.segments, checked.chain, 'file');
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
