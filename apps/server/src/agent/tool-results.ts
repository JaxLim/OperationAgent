import type { FindFilesResult, ListDirectoryResult, ReadFailureCode, ReadFileResult, ReadRefusalCode, SearchTextResult, ToolCallStatus } from '@operation-agent/contracts';

// How a tool outcome is shown to the model (tool_result content) and summarized for the Worker and the timeline. The
// model gets the content it asked for, or a plain explanation of a refusal so it neither retries blindly nor tries to
// work around a policy. The Worker and the persisted timeline only ever get the short summary.

const REFUSALS: Readonly<Record<ReadRefusalCode, string>> = Object.freeze({
  INVALID_PATH: 'The path is not a valid project-relative path.',
  OUTSIDE_WORKSPACE: 'The path is outside the project. Only files inside the project root can be read.',
  SENSITIVE_PATH: 'The path is protected (secrets, keys, credentials or .git internals) and is never readable. Do not try to read it another way.',
  NOT_FOUND: 'No such file or directory in the project.',
  NOT_A_FILE: 'The path exists but is not the expected kind (a file for read_file, a directory for list_directory).',
  LINK_REJECTED: 'The path goes through a symbolic link or junction, which is never followed.',
  MULTIPLE_LINKS: 'The file has more than one hard link, so it could alias a file outside the project; it is not readable.',
  BINARY_FILE: 'The file is not UTF-8 text.',
  CHANGED_DURING_READ: 'The path changed while it was being read; try again.',
  ACCESS_DENIED: 'The operating system denied access to this path.',
  WORKSPACE_UNAVAILABLE: 'The project folder is not available.',
  INVALID_QUERY: 'The query or file-name pattern is not valid: a regular expression must compile, a query must be on one line, and a ' +
    'file-name pattern names files only (put the directory in path).',
});
const FAILURES: Readonly<Record<ReadFailureCode, string>> = Object.freeze({
  READ_ADAPTER_UNAVAILABLE: 'Reading files is not available on this platform.',
  TIMED_OUT: 'Reading took too long and was stopped.',
  ADAPTER_FAILED: 'The file reader failed.',
  BUSY: 'Too many reads are in progress; try again.',
  CLEANUP_UNCONFIRMED: 'The file reader could not be confirmed stopped, so reading is disabled for now.',
});

const SUMMARY_LIMIT = 256;
const bound = (summary: string): string => summary.length <= SUMMARY_LIMIT ? summary : summary.slice(0, SUMMARY_LIMIT - 1) + '…';
/** Shortens a path for a one-line summary, keeping its end (the file name), which is the useful part. */
const short = (path: string): string => path.length <= 160 ? path : '…' + path.slice(-159);

export interface FormattedToolResult { content: string; isError: boolean; status: ToolCallStatus; code: string | null; summary: string; size: number | null }

const kib = (bytes: number): string => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;

export function formatReadResult(result: ReadFileResult, requested: string): FormattedToolResult {
  if (result.status === 'ok' && result.range) {
    const { startLine, lines, totalLines } = result.range;
    const last = startLine + Math.max(lines, 1) - 1;
    const total = totalLines === null ? 'more lines than can be counted in one call' : `${totalLines} lines`;
    const header = lines ? `[Lines ${startLine}-${last} of ${result.path}; the file has ${total}]\n`
      : totalLines === null ? `[Could not reach line ${startLine} of ${result.path} within the scan limit.]`
        : `[${result.path} has no line ${startLine}; it has ${total}]`;
    const cut = result.truncated ? `\n[Returned ${kib(result.bytes)}: the requested range is incomplete at the byte or scan limit.]` : '';
    return { content: header + result.content + cut, isError: false, status: 'ok', code: null, size: result.bytes,
      summary: bound(`Read ${short(result.path)} lines ${startLine}-${last}`) };
  }
  if (result.status === 'ok') {
    const note = result.truncated
      ? `\n\n[Showing the first ${kib(result.bytes)} of ${kib(result.size)}. The rest of the file was not read; use startLine and lineCount to read further.]` : '';
    return { content: result.content + note, isError: false, status: 'ok', code: null, size: result.bytes,
      summary: bound(`Read ${short(result.path)} (${kib(result.bytes)}${result.truncated ? ', truncated' : ''})`) };
  }
  const message = result.status === 'refused' ? REFUSALS[result.code] : FAILURES[result.code];
  return { content: `${result.status === 'refused' ? 'Refused' : 'Failed'}: ${message}`, isError: true, status: result.status,
    code: result.code, size: null, summary: bound(`${result.status === 'refused' ? 'Refused' : 'Failed'} to read ${short(requested)} (${result.code})`) };
}

export function formatListResult(result: ListDirectoryResult, requested: string): FormattedToolResult {
  if (result.status === 'ok') {
    const lines = result.entries.map(entry => entry.type === 'directory' ? `${entry.path}/` : entry.type === 'link' ? `${entry.path} (link, not followed)`
      : entry.type === 'file' ? `${entry.path}  ${kib(entry.size ?? 0)}` : `${entry.path} (special)`);
    const header = `${result.path === '.' ? 'Project root' : result.path}: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}`;
    const unlisted = result.unlisted.length ? `\n[Not listed, because they contain only links or locked entries: ${result.unlisted.join(', ')}]` : '';
    const note = (result.truncated ? '\n[Listing truncated. List a subdirectory to see more.]' : '') + unlisted;
    return { content: `${header}\n${lines.join('\n')}${note}`, isError: false, status: 'ok', code: null, size: result.entries.length,
      summary: bound(`Listed ${short(result.path)} (${result.entries.length}${result.truncated ? '+' : ''} entries)`) };
  }
  const message = result.status === 'refused' ? REFUSALS[result.code] : FAILURES[result.code];
  return { content: `${result.status === 'refused' ? 'Refused' : 'Failed'}: ${message}`, isError: true, status: result.status,
    code: result.code, size: null, summary: bound(`${result.status === 'refused' ? 'Refused' : 'Failed'} to list ${short(requested)} (${result.code})`) };
}

function rejected(result: { status: 'refused'; code: ReadRefusalCode } | { status: 'failed'; code: ReadFailureCode }, verb: string, requested: string): FormattedToolResult {
  const message = result.status === 'refused' ? REFUSALS[result.code] : FAILURES[result.code];
  const outcome = result.status === 'refused' ? 'Refused' : 'Failed';
  return { content: `${outcome}: ${message}`, isError: true, status: result.status, code: result.code, size: null,
    summary: bound(`${outcome} to ${verb} ${short(requested)} (${result.code})`) };
}

/** Matches as `path:line: text`, one per line, in the order the child found them (directories in name order, lines in order). */
export function formatSearchResult(result: SearchTextResult, query: string): FormattedToolResult {
  if (result.status !== 'ok') return rejected(result, 'search for', query);
  const where = result.path === '.' ? 'the project' : result.path;
  const lines = result.matches.map(match => `${match.path}:${match.line}: ${match.text}`);
  const skipped = result.filesSkipped ? `, ${result.filesSkipped} skipped as binary, too large, linked or locked` : '';
  const header = `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} in ${where} ` +
    `(${result.filesScanned} file${result.filesScanned === 1 ? '' : 's'} searched${skipped})`;
  const note = result.truncated ? '\n[Stopped early at a result, file, size or time limit. Narrow the search with path or fileNames to see more.]' : '';
  return { content: header + (lines.length ? '\n' + lines.join('\n') : '') + note, isError: false, status: 'ok', code: null, size: result.matches.length,
    summary: bound(`Searched ${short(where)} for "${query.slice(0, 60)}" (${result.matches.length}${result.truncated ? '+' : ''} matches)`) };
}

export function formatFindResult(result: FindFilesResult, pattern: string): FormattedToolResult {
  if (result.status !== 'ok') return rejected(result, 'find', pattern);
  const where = result.path === '.' ? 'the project' : result.path;
  const lines = result.entries.map(entry => entry.type === 'directory' ? `${entry.path}/` : entry.type === 'link' ? `${entry.path} (link, not followed)`
    : entry.type === 'file' ? `${entry.path}  ${kib(entry.size ?? 0)}` : `${entry.path} (special)`);
  const header = `${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} named ${pattern} in ${where}`;
  const note = result.truncated ? '\n[Stopped early at a result or time limit. Narrow the search with path to see more.]' : '';
  return { content: header + (lines.length ? '\n' + lines.join('\n') : '') + note, isError: false, status: 'ok', code: null, size: result.entries.length,
    summary: bound(`Found ${result.entries.length}${result.truncated ? '+' : ''} named ${pattern.slice(0, 60)} in ${short(where)}`) };
}

export function skippedResult(reason: string): FormattedToolResult {
  return { content: `Not executed: ${reason}`, isError: true, status: 'skipped', code: null, size: null, summary: bound(`Skipped: ${reason}`) };
}
