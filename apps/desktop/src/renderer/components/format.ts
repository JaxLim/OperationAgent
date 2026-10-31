export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
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

export function dateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A stable, decorative accent per project derived from its id; not a security property. */
export function accent(id: string): string {
  const palette = ['#3a55d9', '#217a4c', '#a86300', '#8a3ec2', '#bf3a2c', '#2a7f8f', '#5b6472'];
  let hash = 0; for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

/** Display tone and label for a committed task state; purely presentational. */
export const TASK_STATE: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'muted' | 'run' | 'wait'; label: string; live?: true }> = {
  CREATED: { tone: 'muted', label: 'Created' }, QUEUED: { tone: 'wait', label: 'Queued', live: true },
  RUNNING: { tone: 'run', label: 'Running', live: true }, WAITING_APPROVAL: { tone: 'warn', label: 'Waiting for approval' },
  COMPLETED: { tone: 'ok', label: 'Completed' }, FAILED: { tone: 'danger', label: 'Failed' },
  STOPPING: { tone: 'wait', label: 'Stopping', live: true }, STOPPED: { tone: 'muted', label: 'Stopped' },
  INTERRUPTED: { tone: 'warn', label: 'Interrupted' },
};
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
