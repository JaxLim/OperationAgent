// SEC-08 Read Adapter child program. Express launches one per read-only tool call as a separate, short-lived Node
// process under the Node permission model: `--permission --allow-fs-read=<workspace root>` and nothing else, so this
// process can read only below the root, cannot write, spawn processes, start workers or load native addons. It is
// self-contained (Node built-ins only) so the permission grant never has to cover node_modules. Express never imports
// this module; the import-boundary lint enforces that no Express code reads workspace files in-process.
//
// Protocol: the root is argv[2]; one JSON request line arrives on stdin ({v, op, ...}); exactly one JSON reply line is
// written to stdout. The operations are `read` (a file, whole or a range of lines), `list` (a directory, a few levels),
// `search` (text in the files below a directory, or in one file) and `find` (entries by name below a directory).
// Express validates both directions against packages/contracts.
//
// Symbolic link and race defence: every component below the root is checked with lstat (a link or junction is refused),
// the final file must have exactly one link, and after opening, the handle's identity must equal the checked identity.
// The whole chain is then re-checked, so a component swapped for a link between check and open is detected. Operations
// that walk a tree read each directory only while it is pinned (see `pin` and `traverse`).
//
// Identity is not just (device, file id): Node exposes 64 bits of the Windows file id, and on volumes with 128-bit ids
// (ReFS) those 64 bits are not guaranteed unique, so two different files can report the same `ino`. Every identity
// therefore also carries the creation time, and for the file the change and modification times and the size, all read
// from the same handle or link-free path. Two distinct files must collide on every field to be confused.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL = 2;
const MAX_REQUEST_BYTES = 65_536;
const MAX_BYTES = 262_144;
const MAX_ENTRIES = 1_000;
const MAX_DEPTH = 4;
// Line ranges: how many lines one call may return, and how far into a file the scan goes to reach and count them.
const MAX_LINE_COUNT = 2_000;
const MAX_START_LINE = 10_000_000;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
// Tree operations (search, find): bounds on what one call may walk, open and return, whatever Express asks for.
const MAX_WALK_DEPTH = 24;
const MAX_RESULTS = 500;
const MAX_QUERY_CHARS = 256;
const MAX_GLOB_CHARS = 128;
const MAX_BUDGET_MS = 25_000;
const MAX_SEARCH_FILES = 5_000;
const MAX_SEARCH_FILE_BYTES = 1_048_576;
const MAX_SEARCH_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_MATCH_CHARS = 240;
/** A regular expression is only ever run against this much of one line, so a minified file cannot stall the search. */

type Refusal = 'INVALID_PATH' | 'INVALID_QUERY' | 'NOT_FOUND' | 'NOT_A_FILE' | 'LINK_REJECTED' | 'MULTIPLE_LINKS' | 'BINARY_FILE' |
  'CHANGED_DURING_READ' | 'ACCESS_DENIED' | 'WORKSPACE_UNAVAILABLE';
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

/** File names Express never lets anyone read (secrets, keys, credentials); a tree operation never opens one. */
type SensitivePolicy = { names: string[]; suffixes: string[]; prefixes: string[]; envAllow: string[] };
/** What every tree operation carries: where to start, how long and how much, and which directories never to enter. */
type Walk = { segments: string[]; budgetMs: number; maxResults: number; skip: string[]; skipSequences: string[][] };
type Request = { op: 'read'; segments: string[]; maxBytes: number; lines: { start: number; count: number } | null }
  | { op: 'list'; segments: string[]; depth: number; maxEntries: number; skip: string[] }
  | ({ op: 'search'; query: string; regex: boolean; ignoreCase: boolean; glob: string | null; sensitive: SensitivePolicy } & Walk)
  | ({ op: 'find'; glob: string } & Walk);

const validSegment = (segment: unknown): segment is string => typeof segment === 'string' && segment.length > 0 && segment.length <= 255 &&
  segment !== '.' && segment !== '..' && !/[\\/:]|\p{Cc}/u.test(segment);
const bounded = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;
const nameList = (value: unknown, max = 64): value is string[] => Array.isArray(value) && value.length <= max && value.every(validSegment);
/** A file-name pattern: `*` and `?` wildcards, no path separators. */
const validGlob = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= MAX_GLOB_CHARS &&
  !/[\\/]|\p{Cc}/u.test(value);
const lowered = (list: string[]): string[] => list.map(name => name.toLowerCase());

function parse(raw: string): Request {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Refused('INVALID_PATH');
  const { v, op, segments, ...rest } = value as Record<string, unknown>;
  // Express already normalized the path; anything that could leave the chain is refused again here.
  if (v !== PROTOCOL || !Array.isArray(segments) || segments.length > 64 || !segments.every(validSegment)) throw new Refused('INVALID_PATH');
  // Each operation takes exactly its own fields: a missing or an extra one is refused.
  const exactly = (...keys: string[]): boolean => Object.keys(rest).length === keys.length && keys.every(key => key in rest);
  if (op === 'read' && segments.length >= 1 && bounded(rest.maxBytes, MAX_BYTES)) {
    if (exactly('maxBytes')) return { op, segments, maxBytes: rest.maxBytes, lines: null };
    if (exactly('maxBytes', 'startLine', 'lineCount') && bounded(rest.startLine, MAX_START_LINE) && bounded(rest.lineCount, MAX_LINE_COUNT)) {
      return { op, segments, maxBytes: rest.maxBytes, lines: { start: rest.startLine, count: rest.lineCount } };
    }
  }
  if (op === 'list' && exactly('depth', 'maxEntries', 'skip') && bounded(rest.depth, MAX_DEPTH) && bounded(rest.maxEntries, MAX_ENTRIES) && nameList(rest.skip)) {
    return { op, segments, depth: rest.depth, maxEntries: rest.maxEntries, skip: lowered(rest.skip) };
  }
  const walkFields = (): Walk | null => {
    const { budgetMs, maxResults, skip, skipSequences } = rest;
    if (!bounded(budgetMs, MAX_BUDGET_MS) || !bounded(maxResults, MAX_RESULTS) || !nameList(skip) || !Array.isArray(skipSequences) ||
      skipSequences.length > 32 || !skipSequences.every((sequence): sequence is string[] => nameList(sequence, 8) && sequence.length >= 2)) return null;
    return { segments, budgetMs, maxResults, skip: lowered(skip), skipSequences: skipSequences.map(lowered) };
  };
  if (op === 'search' && exactly('budgetMs', 'maxResults', 'skip', 'skipSequences', 'query', 'regex', 'ignoreCase', 'glob', 'sensitive')) {
    const tree = walkFields();
    const { query, regex, ignoreCase, glob } = rest;
    const policy = rest.sensitive;
    if (tree && typeof query === 'string' && query.length >= 1 && query.length <= MAX_QUERY_CHARS && !/[\n\r\0]/.test(query) && typeof regex === 'boolean' &&
      typeof ignoreCase === 'boolean' && (glob === null || validGlob(glob)) && typeof policy === 'object' && policy !== null && !Array.isArray(policy)) {
      const { names, suffixes, prefixes, envAllow, ...extra } = policy as Record<string, unknown>;
      if (!Object.keys(extra).length && nameList(names) && nameList(suffixes) && nameList(prefixes) && nameList(envAllow)) {
        return { op, ...tree, query, regex, ignoreCase, glob, sensitive: { names: lowered(names), suffixes: lowered(suffixes), prefixes: lowered(prefixes),
          envAllow: lowered(envAllow) } };
      }
    }
  }
  if (op === 'find' && exactly('budgetMs', 'maxResults', 'skip', 'skipSequences', 'glob')) {
    const tree = walkFields();
    if (tree && validGlob(rest.glob)) return { op, ...tree, glob: rest.glob };
  }
  throw new Refused('INVALID_PATH');
}
type Identity = readonly bigint[];
/** Directory identity: volume, file id and creation time. A file also adds change time, modification time and size. */
const identityOf = (stats: BigIntStats): Identity => stats.isFile()
  ? [stats.dev, stats.ino, stats.birthtimeNs, stats.ctimeNs, stats.mtimeNs, stats.size]
  : [stats.dev, stats.ino, stats.birthtimeNs];
const equal = (left: Identity, right: Identity): boolean => left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * lstat every component; returns the identity of each, the last being the target. `any` accepts a file or a directory
 * and says which it found; a file must have exactly one link whichever way it was asked for.
 */
function walk(root: string, segments: readonly string[], target: 'file' | 'directory' | 'any' = 'file'):
  { path: string; chain: Identity[]; file: BigIntStats; kind: 'file' | 'directory' } {
  const chain: Identity[] = [];
  let path = root;
  let file: BigIntStats | undefined;
  let kind: 'file' | 'directory' = 'directory';
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const stats = stat(path);
    if (!stats) throw new Refused('NOT_FOUND');
    if (stats.isSymbolicLink()) throw new Refused('LINK_REJECTED');
    const last = index === segments.length - 1;
    if (last && (target === 'directory' || (target === 'any' && stats.isDirectory()))) {
      if (!stats.isDirectory()) throw new Refused('NOT_A_FILE');
    } else if (last) {
      if (!stats.isFile()) throw new Refused('NOT_A_FILE');
      if (stats.nlink !== 1n) throw new Refused('MULTIPLE_LINKS');
      file = stats; kind = 'file';
    } else if (!stats.isDirectory()) throw new Refused('NOT_FOUND');
    chain.push(identityOf(stats));
  }
  return { path, chain, file: file!, kind };
}
function readBounded(fd: number, maxBytes: number): { data: Buffer; truncated: boolean; bytes: number } {
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
  return { data: buffer.subarray(0, end), truncated, bytes: total };
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

/** One entry of a pinned directory, as lstat saw it. */
type Item = { name: string; path: string; segments: string[]; stats: BigIntStats; type: Entry['type'] };
/** What one directory contributes: `commit` runs only once the directory is verified unchanged; `children` are entered next. */
type Visited = { commit: () => void; children: Item[]; stop: boolean };

/**
 * The one way this program reads a tree. Breadth-first and in name order, at most `maxDepth` levels below `start`.
 *
 * Every directory is read only while pinned (see `pin`) and after its whole chain from the root has been re-verified,
 * and what `visit` gathered from it is committed only after the pin and the chain have been verified again. A directory
 * swapped for a junction before it is pinned fails verification; after it is pinned it cannot be swapped. So anything a
 * visitor read from a directory's own entries while it was pinned came from inside the workspace, or is discarded with
 * CHANGED_DURING_READ. A non-empty directory that cannot be pinned (only links or locked entries) is never read: it is
 * reported as unlisted. Links are never followed: a visitor sees them as `link` items and they are never children.
 */
function traverse(root: string, rootStats: BigIntStats, start: Pending, maxDepth: number, deadline: number,
  visit: (directory: Pending, entries: string[], itemOf: (name: string) => Item | null, depth: number) => Visited): { unlisted: string[][]; expired: boolean } {
  const unlisted: string[][] = [];
  let level: Pending[] = [start];
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    const next: Pending[] = [];
    for (const directory of level) {
      if (Date.now() > deadline) return { unlisted, expired: true };
      const pinned = pin(directory);
      if (pinned === 'empty') continue;
      if (pinned === null) { if (unlisted.length < MAX_UNLISTED) unlisted.push(directory.segments); continue; }
      let stop: boolean;
      try {
        verifyPending(root, rootStats, directory);
        const itemOf = (name: string): Item | null => {
          if (!validSegment(name)) return null;
          const path = join(directory.path, name);
          const stats = stat(path);
          if (!stats) return null;
          return { name, path, segments: [...directory.segments, name], stats,
            type: stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other' };
        };
        const visited = visit(directory, readNames(directory.path), itemOf, depth);
        // Accept this directory's results only if the pin and the whole chain are still exactly as verified.
        const still = stat(pinned.path);
        if (!still || still.isSymbolicLink() || !equal(identityOf(still), pinned.identity)) throw new Refused('CHANGED_DURING_READ');
        verifyPending(root, rootStats, directory);
        visited.commit();
        if (depth < maxDepth) {
          for (const child of visited.children) {
            next.push({ path: child.path, segments: child.segments, chain: [...directory.chain, { path: child.path, identity: identityOf(child.stats) }] });
          }
        }
        stop = visited.stop;
      } finally { closeSync(pinned.fd); }
      if (stop) return { unlisted, expired: false };
    }
    level = next;
  }
  return { unlisted, expired: false };
}

/** The directory a tree operation starts in, with the checked chain from the root down to it. */
function startOf(root: string, segments: readonly string[], checked: { path: string; chain: Identity[] }): Pending {
  let prefix = root;
  return { path: checked.path, segments: [], chain: segments.map((segment, index) => { prefix = join(prefix, segment); return { path: prefix, identity: checked.chain[index]! }; }) };
}

function workspace(root: string): BigIntStats {
  const rootStats = stat(root);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Refused('WORKSPACE_UNAVAILABLE');
  return rootStats;
}

/**
 * At most `depth` levels and `maxEntries` entries. Links are reported and never followed; `.git`, `node_modules` and the
 * sensitive directories Express names are reported but never entered.
 */
function list(root: string, request: Extract<Request, { op: 'list' }>): void {
  const rootStats = workspace(root);
  const checked = request.segments.length ? walk(root, request.segments, 'directory') : { path: root, chain: [] as Identity[] };
  const skip = new Set(['.git', 'node_modules', ...request.skip]);
  const entries: Entry[] = [];
  let truncated = false;
  const { unlisted } = traverse(root, rootStats, startOf(root, request.segments, checked), request.depth, Infinity, (_directory, names, itemOf) => {
    const found: Entry[] = []; const children: Item[] = [];
    for (const name of names) {
      if (entries.length + found.length >= request.maxEntries) { truncated = true; break; }
      const item = itemOf(name);
      if (!item) continue;
      found.push({ segments: item.segments, type: item.type, size: item.type === 'file' ? Number(item.stats.size) : null });
      if (item.type === 'directory' && !skip.has(name.toLowerCase())) children.push(item);
    }
    return { commit: () => { entries.push(...found); }, children, stop: truncated };
  });
  reply({ status: 'listed', entries, truncated, unlisted });
}

/** `*` matches any run of characters and `?` exactly one, case-insensitively; linear in the name for each `*`. */
function globMatcher(glob: string): (name: string) => boolean {
  const pattern = glob.toLowerCase();
  return candidate => {
    const name = candidate.toLowerCase();
    let p = 0, n = 0, star = -1, mark = 0;
    while (n < name.length) {
      if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) { p++; n++; }
      else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = n; }
      else if (star >= 0) { p = star + 1; n = ++mark; }
      else return false;
    }
    while (p < pattern.length && pattern[p] === '*') p++;
    return p === pattern.length;
  };
}

/** Directories a tree operation never enters: by name, or because the path from the root ends with a named sequence. */
function enterable(request: Walk): (item: Item) => boolean {
  const skip = new Set(['.git', 'node_modules', ...request.skip]);
  const base = lowered(request.segments);
  return item => {
    if (skip.has(item.name.toLowerCase())) return false;
    const full = [...base, ...lowered(item.segments)];
    return !request.skipSequences.some(sequence => sequence.length <= full.length &&
      sequence.every((part, index) => full[full.length - sequence.length + index] === part));
  };
}

/** Entries whose name matches a pattern, anywhere below a directory. Nothing is opened: names and sizes only. */
function find(root: string, request: Extract<Request, { op: 'find' }>): void {
  const rootStats = workspace(root);
  const checked = request.segments.length ? walk(root, request.segments, 'directory') : { path: root, chain: [] as Identity[] };
  const matches = globMatcher(request.glob); const enter = enterable(request);
  const entries: Entry[] = [];
  let truncated = false;
  const walked = traverse(root, rootStats, startOf(root, request.segments, checked), MAX_WALK_DEPTH, Date.now() + request.budgetMs, (_directory, names, itemOf) => {
    const found: Entry[] = []; const children: Item[] = [];
    for (const name of names) {
      const item = itemOf(name);
      if (!item) continue;
      if (matches(name)) {
        if (entries.length + found.length >= request.maxResults) { truncated = true; break; }
        found.push({ segments: item.segments, type: item.type, size: item.type === 'file' ? Number(item.stats.size) : null });
      }
      if (item.type === 'directory' && enter(item)) children.push(item);
    }
    return { commit: () => { entries.push(...found); }, children, stop: truncated };
  });
  reply({ status: 'found', entries, truncated: truncated || walked.expired });
}

type Match = { segments: string[]; line: number; text: string };

/** Finds the query in one line; returns where it starts, or -1. */
function lineMatcher(request: Extract<Request, { op: 'search' }>): (line: string) => number {
  if (request.regex) {
    let pattern: RegExp;
    try { pattern = new RegExp(request.query, request.ignoreCase ? 'i' : ''); } catch { throw new Refused('INVALID_QUERY'); }
    return line => { const found = pattern.exec(line); return found ? found.index : -1; };
  }
  if (!request.ignoreCase) return line => line.indexOf(request.query);
  const needle = request.query.toLowerCase();
  return line => line.toLowerCase().indexOf(needle);
}

/** The matching line as shown: whole when short, otherwise a window that contains the start of the match. */
function excerpt(line: string, at: number): string {
  const text = line.replace(/\r$/, '');
  if (text.length <= MAX_MATCH_CHARS) return text;
  const start = Math.max(0, Math.min(at - 60, text.length - MAX_MATCH_CHARS));
  return (start > 0 ? '…' : '') + text.slice(start, start + MAX_MATCH_CHARS - 2) + (start + MAX_MATCH_CHARS - 2 < text.length ? '…' : '');
}

function sensitiveName(policy: SensitivePolicy, name: string): boolean {
  const value = name.toLowerCase();
  if (policy.names.includes(value) || policy.suffixes.some(suffix => value.endsWith(suffix)) || policy.prefixes.some(prefix => value.startsWith(prefix))) return true;
  return (value === '.env' || value.startsWith('.env.') || value.endsWith('.env')) && !policy.envAllow.includes(value);
}

/** The text of a file whose handle is already verified, or null when it is not searchable (too large, binary, not UTF-8). */
function searchableText(fd: number, budget: number = MAX_SEARCH_SCAN_BYTES): { text: string | null; bytes: number } {
  const { data, truncated, bytes } = readBounded(fd, Math.min(MAX_SEARCH_FILE_BYTES, budget - 1));
  if (truncated || data.includes(0)) return { text: null, bytes };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), bytes }; } catch { return { text: null, bytes }; }
}

function matchesIn(text: string, segments: string[], matchAt: (line: string) => number, room: number): { matches: Match[]; more: boolean } {
  const matches: Match[] = [];
  let line = 0, from = 0;
  while (from <= text.length) {
    // A file that ends with a newline has no further, empty line after it.
    if (from === text.length && from > 0) break;
    const end = text.indexOf('\n', from);
    const content = text.slice(from, end === -1 ? text.length : end);
    line++;
    const at = matchAt(content);
    if (at >= 0) {
      if (matches.length >= room) return { matches, more: true };
      matches.push({ segments, line, text: excerpt(content, at) });
    }
    if (end === -1) break;
    from = end + 1;
  }
  return { matches, more: false };
}

/**
 * Text search below a directory (or in one file). A file is opened only if it is a plain, single-link file that is not
 * sensitive, matches the name pattern and is small enough; its handle must be the file lstat saw, otherwise it is
 * skipped rather than read. Binary and non-UTF-8 files are skipped. Everything is bounded: files, bytes, results, time.
 */
function search(root: string, request: Extract<Request, { op: 'search' }>): void {
  const rootStats = workspace(root);
  const matchAt = lineMatcher(request);
  const nameMatches = request.glob === null ? () => true : globMatcher(request.glob);
  const checked = request.segments.length ? walk(root, request.segments, 'any') : { path: root, chain: [] as Identity[], kind: 'directory' as const };
  const matches: Match[] = [];
  let truncated = false, filesScanned = 0, filesSkipped = 0, scannedBytes = 0, attemptedFiles = 0;

  if (checked.kind === 'file') {
    if (!nameMatches(request.segments[request.segments.length - 1]!)) {
      reply({ status: 'matched', matches, truncated, filesScanned, filesSkipped });
      return;
    }
    // One named file: the same checked open as `read`, then the same search.
    const fd = openChecked(checked.path, checked.chain[checked.chain.length - 1]!);
    try {
      verifyChain(root, rootStats, request.segments, checked.chain, 'file');
      const content = searchableText(fd);
      if (content.text === null) filesSkipped = 1;
      else { filesScanned = 1; const found = matchesIn(content.text, [], matchAt, request.maxResults); matches.push(...found.matches); truncated = found.more; }
    } finally { closeSync(fd); }
    reply({ status: 'matched', matches, truncated, filesScanned, filesSkipped });
    return;
  }

  const enter = enterable(request);
  const deadline = Date.now() + request.budgetMs;
  const walked = traverse(root, rootStats, startOf(root, request.segments, checked), MAX_WALK_DEPTH, deadline, (_directory, names, itemOf) => {
    const found: Match[] = []; const children: Item[] = [];
    let scanned = 0, skipped = 0, stop = false;
    for (const name of names) {
      const item = itemOf(name);
      if (!item) continue;
      if (item.type === 'directory') { if (enter(item)) children.push(item); continue; }
      if (item.type !== 'file' || !nameMatches(name) || sensitiveName(request.sensitive, name)) continue;
      if (matches.length + found.length >= request.maxResults || attemptedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_SCAN_BYTES || Date.now() > deadline) { stop = true; break; }
      if (item.stats.nlink !== 1n || item.stats.size > BigInt(MAX_SEARCH_FILE_BYTES)) { skipped++; continue; }
      let fd: number;
      try { fd = openSync(item.path, 'r'); } catch { skipped++; continue; }
      try {
        // The directory is pinned, so only the file itself could have been replaced since lstat; if it was, it is not read.
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !equal(identityOf(opened), identityOf(item.stats))) { skipped++; continue; }
        attemptedFiles++;
        const content = searchableText(fd, MAX_SEARCH_SCAN_BYTES - scannedBytes);
        scannedBytes += content.bytes;
        if (content.text === null) { skipped++; continue; }
        scanned++;
        const result = matchesIn(content.text, item.segments, matchAt, request.maxResults - matches.length - found.length);
        found.push(...result.matches);
        if (result.more) { stop = true; break; }
      } catch { skipped++; }
      finally { closeSync(fd); }
    }
    return { commit: () => { matches.push(...found); filesScanned += scanned; filesSkipped += skipped; truncated ||= stop; }, children, stop };
  });
  reply({ status: 'matched', matches, truncated: truncated || walked.expired, filesScanned, filesSkipped });
}

/** Opens a walked file and proves the handle is the file the walk saw. */
function openChecked(path: string, identity: Identity): number {
  let fd: number;
  try { fd = openSync(path, 'r'); }
  catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT') throw new Refused('CHANGED_DURING_READ');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'ERR_ACCESS_DENIED') throw new Refused('ACCESS_DENIED');
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !equal(identityOf(opened), identity)) throw new Refused('CHANGED_DURING_READ');
  } catch (error) { closeSync(fd); throw error; }
  return fd;
}

/**
 * Lines `start` to `start + count - 1` (a line ends at `\n`), at most `maxBytes` of them. The file is scanned from its
 * beginning in fixed chunks, never held whole: up to MAX_SCAN_BYTES, which also bounds the line count it can report.
 * A NUL byte anywhere in the scanned part makes the file binary, exactly as for a whole read.
 */
function readLines(fd: number, start: number, count: number, maxBytes: number): { data: Buffer; truncated: boolean; lines: number; totalLines: number | null } {
  const chunk = Buffer.alloc(65_536);
  const parts: Buffer[] = [];
  let line = 1, collected = 0, scanned = 0, truncated = false, ended = false, lastByte = -1;
  while (scanned < MAX_SCAN_BYTES) {
    const size = readSync(fd, chunk, 0, chunk.length, null);
    if (size === 0) { ended = true; break; }
    const view = chunk.subarray(0, size);
    if (view.includes(0)) throw new Refused('BINARY_FILE');
    scanned += size; lastByte = view[size - 1]!;
    let position = 0;
    while (position < size) {
      const newline = view.indexOf(10, position);
      const end = newline === -1 ? size : newline + 1;
      if (line >= start && line < start + count && !truncated) {
        const take = Math.min(end - position, maxBytes - collected);
        if (take > 0) { parts.push(Buffer.from(view.subarray(position, position + take))); collected += take; }
        if (take < end - position) truncated = true;
      }
      if (newline !== -1) line++;
      position = end;
    }
  }
  let data = Buffer.concat(parts, collected);
  if (truncated) {
    // Cut at maxBytes: do not leave part of a UTF-8 sequence at the end.
    let end = data.length;
    let lead = end;
    while (lead > 0 && lead > end - 4 && (data[lead - 1]! & 0xc0) === 0x80) lead--;
    if (lead > 0) {
      const first = data[lead - 1]!;
      const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
      if (width > 1 && lead - 1 + width > end) end = lead - 1;
    }
    data = data.subarray(0, end);
  }
  let lines = 0;
  for (const byte of data) if (byte === 10) lines++;
  if (data.length && data[data.length - 1] !== 10) lines++;
  // `line` is one more than the newlines seen; a file that ends with a newline has no further line after it.
  const totalLines = !ended ? null : scanned === 0 ? 0 : lastByte === 10 ? line - 1 : line;
  return { data, truncated: truncated || (!ended && line < start + count), lines, totalLines };
}

function read(root: string, request: Extract<Request, { op: 'read' }>): void {
  const rootStats = workspace(root);
  const checked = walk(root, request.segments);
  const fd = openChecked(checked.path, checked.chain[checked.chain.length - 1]!);
  try {
    // Re-walk: a directory swapped for a link, or the file replaced, after the first walk shows up here.
    verifyChain(root, rootStats, request.segments, checked.chain, 'file');
    const size = Number(fstatSync(fd, { bigint: true }).size);
    const decode = (data: Buffer): void => { try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new Refused('BINARY_FILE'); } };
    if (request.lines) {
      const { data, truncated, lines, totalLines } = readLines(fd, request.lines.start, request.lines.count, request.maxBytes);
      decode(data);
      reply({ status: 'ok', content: data.toString('base64'), size, truncated, startLine: request.lines.start, lines, totalLines });
      return;
    }
    const { data, truncated } = readBounded(fd, request.maxBytes);
    if (data.includes(0)) throw new Refused('BINARY_FILE');
    decode(data);
    reply({ status: 'ok', content: data.toString('base64'), size, truncated });
  } finally { closeSync(fd); }
}

function run(root: string, raw: string): void {
  const request = parse(raw);
  switch (request.op) {
    case 'list': list(root, request); return;
    case 'search': search(root, request); return;
    case 'find': find(root, request); return;
    default: read(root, request);
  }
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
