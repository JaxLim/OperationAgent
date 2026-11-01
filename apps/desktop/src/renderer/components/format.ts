import type { Locale, MessageKey } from '../i18n';

export function relativeTime(at: number, locale: Locale, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return format.format(0, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, 'hour');
  return format.format(-Math.round(hours / 24), 'day');
}

export function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export const shortId = (id: string | null | undefined): string => id ? id.slice(0, 8) : '—';

export function dateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A stable, decorative accent per project derived from its id; not a security property. */
export function accent(id: string): string {
  const palette = ['#3a55d9', '#217a4c', '#a86300', '#8a3ec2', '#bf3a2c', '#2a7f8f', '#5b6472'];
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

/** Display tone and label for a committed task state; purely presentational. */
export const TASK_STATE: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'muted' | 'run' | 'wait'; label: MessageKey; live?: true }> = {
  CREATED: { tone: 'muted', label: 'task.state.CREATED' }, QUEUED: { tone: 'wait', label: 'task.state.QUEUED', live: true },
  RUNNING: { tone: 'run', label: 'task.state.RUNNING', live: true }, WAITING_APPROVAL: { tone: 'warn', label: 'task.state.WAITING_APPROVAL' },
  COMPLETED: { tone: 'ok', label: 'task.state.COMPLETED' }, FAILED: { tone: 'danger', label: 'task.state.FAILED' },
  STOPPING: { tone: 'wait', label: 'task.state.STOPPING', live: true }, STOPPED: { tone: 'muted', label: 'task.state.STOPPED' },
  INTERRUPTED: { tone: 'warn', label: 'task.state.INTERRUPTED' },
};
/** A committed state's display label; an unknown state shows its code rather than a guess. */
export function stateLabel(state: string, t: (key: MessageKey) => string): string {
  const view = TASK_STATE[state];
  return view ? t(view.label) : state;
}
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
