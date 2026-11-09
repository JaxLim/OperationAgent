import { READ_FILE_LIMITS } from '@operation-agent/contracts';
import type { ReadRefusalCode } from '@operation-agent/contracts';

// SEC-08 path policy, applied by Express before any Read Adapter child exists. Pure string rules: this module performs
// no I/O. The child re-checks every component on disk (links, file identity), so these rules only need to be strict
// about what may be named, not about what the file system contains.

/** A sensitive-path refusal carries the normalized path for the audit record; other refusals have no valid path. */
export type PathDecision = { ok: true; segments: string[]; path: string } | { ok: false; code: ReadRefusalCode; path?: string };
export type RootDecision = { ok: true; root: string } | { ok: false; code: 'WORKSPACE_UNAVAILABLE' };

// Windows device names stay devices with any extension (`nul.txt`, `COM1.log`), and in any case.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;
// Characters Windows forbids in names, plus `:` (drive letters and NTFS alternate data streams).
const FORBIDDEN_CHAR = /[<>:"|?*]/;
// An 8.3 short name (`SECRET~1.ENV`) can alias a long name the denylist would refuse.
const SHORT_NAME = /~\d/;

/** Directories whose whole subtree is never readable through `read_file`. */
export const SENSITIVE_DIRECTORIES = Object.freeze(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.gcloud',
  '.config/gcloud', '.terraform.d', '.vault-token']);
/** Exact file names (case-insensitive). */
export const SENSITIVE_FILES = Object.freeze(['.npmrc', '.yarnrc.yml', '.pypirc', '.netrc', '_netrc', '.git-credentials', '.gitconfig',
  '.htpasswd', '.pgpass', '.my.cnf', '.boto', 'credentials', 'credentials.json', 'client_secret.json', 'service-account.json',
  'secrets.json', 'secrets.yaml', 'secrets.yml', 'terraform.tfstate', 'terraform.tfstate.backup', 'known_hosts', 'authorized_keys']);
/** Key material by extension. */
export const SENSITIVE_EXTENSIONS = Object.freeze(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.ppk', '.p8',
  '.gpg', '.tfvars']);
/** Private key files by prefix (`id_rsa`, `id_ed25519.pub` is public but shares the prefix and is refused too). */
const SENSITIVE_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];
/** `.env` files hold secrets; the conventional templates do not. */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template', '.env.defaults']);

function sensitive(segments: readonly string[]): boolean {
  const lower = segments.map(segment => segment.toLowerCase());
  for (const directory of SENSITIVE_DIRECTORIES) {
    const parts = directory.split('/');
    for (let index = 0; index + parts.length <= lower.length; index++) {
      if (parts.every((part, offset) => lower[index + offset] === part)) return true;
    }
  }
  const name = lower[lower.length - 1]!;
  if (SENSITIVE_FILES.includes(name)) return true;
  if (SENSITIVE_EXTENSIONS.some(extension => name.endsWith(extension))) return true;
  if (SENSITIVE_PREFIXES.some(prefix => name.startsWith(prefix))) return true;
  if ((name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) && !ENV_TEMPLATES.has(name)) return true;
  return false;
}

/** Normalizes a workspace-relative path requested by an agent. Never resolves against the file system. */
export function normalizeReadPath(input: string): PathDecision {
  if (typeof input !== 'string' || input.length === 0 || input.length > READ_FILE_LIMITS.maxPathChars) return { ok: false, code: 'INVALID_PATH' };
  // Control characters (including NUL), and any absolute, drive, UNC or device-namespace form.
  if (/\p{Cc}/u.test(input)) return { ok: false, code: 'INVALID_PATH' };
  if (/^[\\/]/.test(input) || /^[a-zA-Z]:/.test(input)) return { ok: false, code: 'OUTSIDE_WORKSPACE' };
  const segments: string[] = [];
  for (const segment of input.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { ok: false, code: 'OUTSIDE_WORKSPACE' };
    if (segment.length > READ_FILE_LIMITS.maxSegmentChars || FORBIDDEN_CHAR.test(segment) || DEVICE.test(segment) ||
      SHORT_NAME.test(segment) || /[. ]$/.test(segment) || /^ /.test(segment)) return { ok: false, code: 'INVALID_PATH' };
    segments.push(segment);
  }
  if (segments.length === 0 || segments.length > READ_FILE_LIMITS.maxSegments) return { ok: false, code: 'INVALID_PATH' };
  if (sensitive(segments)) return { ok: false, code: 'SENSITIVE_PATH', path: segments.join('/') };
  return { ok: true, segments, path: segments.join('/') };
}

/**
 * Validates a registered project path as a Read Adapter root on Windows: a drive-absolute directory below the drive
 * root, with no relative, stream, device-namespace (`\\?\`, `\\.\`) or UNC form. Returned with `\` separators and no
 * trailing separator, exactly as it is granted to the child's `--allow-fs-read`.
 */
export function normalizeWindowsRoot(input: string): RootDecision {
  if (typeof input !== 'string' || !/^[a-zA-Z]:[\\/]/.test(input) || /\p{Cc}/u.test(input)) return { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
  const parts = input.slice(3).split(/[\\/]/).filter(part => part !== '');
  if (parts.length === 0) return { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
  for (const part of parts) {
    if (part === '.' || part === '..' || FORBIDDEN_CHAR.test(part) || DEVICE.test(part) || /[. ]$/.test(part)) return { ok: false, code: 'WORKSPACE_UNAVAILABLE' };
  }
  return { ok: true, root: `${input[0]!.toUpperCase()}:\\${parts.join('\\')}` };
}

/** True when a path lies strictly inside a sensitive directory (the directory entry itself may be listed, not entered). */
export function insideSensitiveDirectory(segments: readonly string[]): boolean {
  const lower = segments.map(segment => segment.toLowerCase());
  return SENSITIVE_DIRECTORIES.some(directory => {
    const parts = directory.split('/');
    for (let index = 0; index + parts.length < lower.length; index++) {
      if (parts.every((part, offset) => lower[index + offset] === part)) return true;
    }
    return false;
  });
}

/** Single-segment sensitive directories the Read Adapter child must never descend into while listing. */
export const LIST_SKIP_DIRECTORIES: readonly string[] = Object.freeze(SENSITIVE_DIRECTORIES.filter(directory => !directory.includes('/')));

/** A directory to list: "", "." or "./" is the workspace root; anything else follows the read_file path rules. */
export function normalizeListPath(input: string): PathDecision {
  if (typeof input !== 'string') return { ok: false, code: 'INVALID_PATH' };
  if (/^[.]?[\\/]?$/.test(input)) return { ok: true, segments: [], path: '.' };
  return normalizeReadPath(input);
}
