import type { ListDirectoryResult, ReadFailureCode, ReadFileResult, ReadRefusalCode, ToolCallStatus } from '@operation-agent/contracts';

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
});
const FAILURES: Readonly<Record<ReadFailureCode, string>> = Object.freeze({
  READ_ADAPTER_UNAVAILABLE: 'Reading files is not available on this platform.',
  TIMED_OUT: 'Reading took too long and was stopped.',
  ADAPTER_FAILED: 'The file reader failed.',
  BUSY: 'Too many reads are in progress; try again.',
  CLEANUP_UNCONFIRMED: 'The file reader could not be confirmed stopped, so reading is disabled for now.',
});

export interface FormattedToolResult { content: string; isError: boolean; status: ToolCallStatus; code: string | null; summary: string; size: number | null }

const kib = (bytes: number): string => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;

export function formatReadResult(result: ReadFileResult, requested: string): FormattedToolResult {
  if (result.status === 'ok') {
    const note = result.truncated ? `\n\n[Showing the first ${kib(result.bytes)} of ${kib(result.size)}. The rest of the file was not read.]` : '';
    return { content: result.content + note, isError: false, status: 'ok', code: null, size: result.bytes,
      summary: `Read ${result.path} (${kib(result.bytes)}${result.truncated ? ', truncated' : ''})` };
  }
  const message = result.status === 'refused' ? REFUSALS[result.code] : FAILURES[result.code];
  return { content: `${result.status === 'refused' ? 'Refused' : 'Failed'}: ${message}`, isError: true, status: result.status,
    code: result.code, size: null, summary: `${result.status === 'refused' ? 'Refused' : 'Failed'} to read ${requested.slice(0, 160)} (${result.code})` };
}

export function formatListResult(result: ListDirectoryResult, requested: string): FormattedToolResult {
  if (result.status === 'ok') {
    const lines = result.entries.map(entry => entry.type === 'directory' ? `${entry.path}/` : entry.type === 'link' ? `${entry.path} (link, not followed)`
      : entry.type === 'file' ? `${entry.path}  ${kib(entry.size ?? 0)}` : `${entry.path} (special)`);
    const header = `${result.path === '.' ? 'Project root' : result.path}: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}`;
    const unlisted = result.unlisted.length ? `\n[Not listed, because they contain only links or locked entries: ${result.unlisted.join(', ')}]` : '';
    const note = (result.truncated ? '\n[Listing truncated. List a subdirectory to see more.]' : '') + unlisted;
    return { content: `${header}\n${lines.join('\n')}${note}`, isError: false, status: 'ok', code: null, size: result.entries.length,
      summary: `Listed ${result.path} (${result.entries.length}${result.truncated ? '+' : ''} entries)` };
  }
  const message = result.status === 'refused' ? REFUSALS[result.code] : FAILURES[result.code];
  return { content: `${result.status === 'refused' ? 'Refused' : 'Failed'}: ${message}`, isError: true, status: result.status,
    code: result.code, size: null, summary: `${result.status === 'refused' ? 'Refused' : 'Failed'} to list ${requested.slice(0, 160)} (${result.code})` };
}

export function skippedResult(reason: string): FormattedToolResult {
  return { content: `Not executed: ${reason}`, isError: true, status: 'skipped', code: null, size: null, summary: `Skipped: ${reason}`.slice(0, 256) };
}
