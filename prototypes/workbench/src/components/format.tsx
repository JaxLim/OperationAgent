import { Fragment, type ReactNode } from 'react';
import type { TaskStatus } from '../sim/types';

export type Tone = 'neutral' | 'run' | 'wait' | 'ok' | 'warn' | 'danger' | 'muted';

export const STATUS_META: Record<TaskStatus, { label: string; tone: Tone; live?: boolean }> = {
  draft: { label: 'Draft', tone: 'muted' },
  planning: { label: 'Exploring', tone: 'run', live: true },
  awaiting_plan: { label: 'Plan review', tone: 'wait' },
  running: { label: 'Running', tone: 'run', live: true },
  awaiting_approval: { label: 'Needs approval', tone: 'wait' },
  applying: { label: 'Applying', tone: 'run', live: true },
  verifying: { label: 'Verifying', tone: 'run', live: true },
  completed: { label: 'Completed', tone: 'ok' },
  completed_with_issues: { label: 'Completed · issues', tone: 'warn' },
  changes_rejected: { label: 'Changes rejected', tone: 'muted' },
  plan_declined: { label: 'Plan declined', tone: 'muted' },
  stopping: { label: 'Stopping', tone: 'warn', live: true },
  stopped: { label: 'Stopped', tone: 'muted' },
  interrupted: { label: 'Interrupted', tone: 'warn' },
  failed: { label: 'Failed', tone: 'danger' },
};

export function StatusPill({ status, compact }: { status: TaskStatus; compact?: boolean }) {
  const meta = STATUS_META[status];
  return (
    <span className={`pill tone-${meta.tone}${compact ? ' pill-compact' : ''}`}>
      <span className={`dot${meta.live ? ' dot-live' : ''}`} />
      {meta.label}
    </span>
  );
}

export function relativeTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 45_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Inline markdown subset used by agent prose: **bold** and `code`. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, index) => {
        const lines = block.split('\n');
        if (lines.every(line => line.startsWith('- '))) {
          return <ul key={index}>{lines.map((line, i) => <li key={i}>{inline(line.slice(2))}</li>)}</ul>;
        }
        return <p key={index}>{inline(block)}</p>;
      })}
    </>
  );
}

const KEYWORDS = new Set(['import', 'from', 'export', 'function', 'return', 'const', 'let', 'for', 'of', 'if', 'else', 'type', 'interface',
  'async', 'await', 'new', 'true', 'false', 'null', 'undefined', 'extends', 'as', 'describe', 'it', 'expect']);

/** Tiny tokenizer for TS/JSON/Markdown sample files; good enough for display. */
export function highlight(line: string, language: 'ts' | 'md' | 'json' | 'text'): ReactNode {
  if (language === 'text') return line;
  if (language === 'md') {
    if (/^#{1,6}\s/.test(line)) return <span className="tk-heading">{line}</span>;
    if (/^\s*[-*]\s/.test(line)) return <><span className="tk-punct">{line.match(/^\s*[-*]/)![0]}</span>{inline(line.replace(/^\s*[-*]/, ''))}</>;
    return inline(line);
  }
  const tokens: ReactNode[] = [];
  const pattern = /(\/\/.*$|\/\*.*?\*\/|^\s*\*.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(line))) {
    if (match.index > last) tokens.push(line.slice(last, match.index));
    const token = match[0];
    let cls = '';
    if (token.startsWith('//') || token.startsWith('/*') || token.trimStart().startsWith('*')) cls = 'tk-comment';
    else if (/^["'`]/.test(token)) cls = language === 'json' && line.slice(match.index + token.length).trimStart().startsWith(':') ? 'tk-key' : 'tk-string';
    else if (/^\d/.test(token)) cls = 'tk-number';
    else if (KEYWORDS.has(token)) cls = 'tk-keyword';
    else if (/^[A-Z]/.test(token)) cls = 'tk-type';
    else if (line[match.index + token.length] === '(') cls = 'tk-fn';
    tokens.push(cls ? <span key={key++} className={cls}>{token}</span> : token);
    last = match.index + token.length;
  }
  if (last < line.length) tokens.push(line.slice(last));
  return tokens;
}

export function languageOf(path: string): 'ts' | 'md' | 'json' | 'text' {
  if (/\.(ts|tsx|js|mjs)$/.test(path)) return 'ts';
  if (path.endsWith('.md')) return 'md';
  if (path.endsWith('.json')) return 'json';
  return 'text';
}
