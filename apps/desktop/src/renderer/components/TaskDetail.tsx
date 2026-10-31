import type { TaskEvent, TaskSnapshot } from '@operation-agent/contracts';
import { actions, useStore } from '../state';
import { TASK_STATE, bytes, dateTime, relativeTime, shortId } from './format';
import { IconAlert, IconChevronRight, IconClock, IconLock, IconRetry, IconTerminal } from './Icons';

// Read-only view of one task's committed log. State comes from Express; this view never infers success.

function StatePill({ state }: { state: string }) {
  const view = TASK_STATE[state] ?? { tone: 'muted' as const, label: state };
  return <span className={`pill tone-${view.tone}`}><span className={`dot${view.live ? ' dot-live' : ''}`} />{view.label}</span>;
}

function EventEntry({ event }: { event: TaskEvent }) {
  const at = <span className="card-foot-meta" title={event.occurredAt}>#{event.seq} · {dateTime(event.occurredAt)}</span>;
  if (event.type === 'task_created') {
    return <div className="notice tone-notice-neutral timeline-entry"><IconClock size={13} /><div><div className="notice-text">Task created</div></div>{at}</div>;
  }
  if (event.type === 'task_state_changed') {
    const { from, to, sideEffects, reason } = event.payload;
    const unknown = sideEffects === 'UNKNOWN';
    return (
      <div className={`notice timeline-entry ${unknown || to === 'INTERRUPTED' ? 'tone-notice-warn' : to === 'FAILED' ? 'tone-notice-danger' : 'tone-notice-neutral'}`}>
        {unknown ? <IconAlert size={13} /> : <IconChevronRight size={13} />}
        <div>
          <div className="notice-text">{TASK_STATE[from]?.label ?? from} → {TASK_STATE[to]?.label ?? to}</div>
          {(reason || sideEffects) && <div className="notice-detail">{reason}{reason && sideEffects ? ' · ' : ''}
            {sideEffects && <span className="mono">side effects {sideEffects}</span>}</div>}
        </div>
        {at}
      </div>
    );
  }
  const summary = event.payload;
  return (
    <article className={`card timeline-entry ${summary.exitCode === 0 ? 'tone-border-ok' : summary.exitCode === null ? 'tone-border-warn' : 'tone-border-danger'}`}>
      <div className="card-head">
        <span className="card-kicker"><IconTerminal size={13} /> Tool result</span>
        <span className={`badge mono ${summary.exitCode === 0 ? 'tone-ok' : summary.exitCode === null ? 'tone-warn' : 'tone-danger'}`}>
          {summary.exitCode === null ? 'no exit code' : `exit ${summary.exitCode}`}</span>
      </div>
      <p className="muted small">stdout {bytes(summary.stdoutBytes)} · stderr {bytes(summary.stderrBytes)}
        {summary.truncatedBytes > 0 ? ` · ${bytes(summary.truncatedBytes)} not kept` : ''} · call <span className="mono">{shortId(summary.toolCallId)}</span></p>
      {summary.diagnostics.map((item, index) => (
        <div key={index} className={`notice ${item.severity === 'error' ? 'tone-notice-danger' : 'tone-notice-warn'}`}><IconAlert size={13} /><div className="notice-detail">{item.summary}</div></div>
      ))}
      <div className="card-foot">{at}</div>
    </article>
  );
}

export function TaskDetail({ task }: { task: TaskSnapshot }) {
  const view = useStore(s => s.taskViews[task.id]);
  const events = view?.events ?? [];
  const last = [...events].reverse().find(event => event.type === 'task_state_changed');
  const unknown = last?.type === 'task_state_changed' && last.payload.sideEffects === 'UNKNOWN';
  return (
    <section className="center" data-task-id={task.id}>
      <header className="task-header">
        <div className="task-header-main">
          <h1 className="task-title">Task <span className="mono">{shortId(task.id)}</span></h1>
          <div className="task-meta">
            <StatePill state={task.state} />
            <span className="meta-item"><IconClock size={12} />created {relativeTime(Date.parse(task.createdAt))}</span>
            <span className="meta-item">updated {relativeTime(Date.parse(task.updatedAt))}</span>
            <span className="meta-item mono" data-sync={view?.sync ?? 'syncing'} data-synced-at={view?.syncedAt ?? 0}>
              {view?.sync === 'error' ? `out of sync · ${view.error}` : view?.sync === 'synced' ? `${view.appliedSeq}/${task.lastSeq} events` : 'syncing…'}</span>
          </div>
        </div>
        <div className="task-actions">
          {view?.sync === 'error' && <button className="btn btn-xs" onClick={() => void actions.resyncTask(task.id)}><IconRetry size={12} /> Resync</button>}
          <button className="btn btn-xs" onClick={() => actions.selectTask(null)}>Close</button>
        </div>
      </header>
      <div className="scroll"><div className="column">
        {task.state === 'INTERRUPTED' && (
          <div className="notice tone-notice-warn task-banner"><IconAlert size={14} /><div>
            <div className="notice-text">This task was interrupted{unknown ? ' and its side effects are unknown' : ''}.</div>
            <div className="notice-detail">Tasks are never resumed automatically. Resuming needs your confirmation and an isolated Worker,
              which this platform does not have yet (<span className="mono">WORKER_ISOLATION_UNAVAILABLE</span>).</div>
          </div><IconLock size={13} /></div>
        )}
        <div className="timeline" aria-label="Task events">{events.map(event => <EventEntry key={event.eventId} event={event} />)}</div>
        {view?.sync === 'syncing' && events.length === 0 && <p className="muted small">Loading committed events…</p>}
      </div></div>
    </section>
  );
}
