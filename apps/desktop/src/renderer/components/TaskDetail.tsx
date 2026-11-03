import type { TaskEvent, TaskSnapshot } from '@operation-agent/contracts';
import { useLocale, useT } from '../locale';
import { actions, useStore } from '../state';
import { TASK_STATE, bytes, dateTime, relativeTime, shortId, stateLabel } from './format';
import { IconAlert, IconChevronRight, IconClock, IconLock, IconRetry, IconTerminal } from './Icons';

// Read-only view of one task's committed log. State comes from Express; this view never infers success.

function StatePill({ state }: { state: string }) {
  const t = useT();
  const view = TASK_STATE[state] ?? { tone: 'muted' as const, live: undefined };
  return <span className={`pill tone-${view.tone}`}><span className={`dot${view.live ? ' dot-live' : ''}`} />{stateLabel(state, t)}</span>;
}

function EventEntry({ event }: { event: TaskEvent }) {
  const t = useT(); const locale = useLocale();
  const at = <span className="card-foot-meta" title={event.occurredAt}>#{event.seq} · {dateTime(event.occurredAt, locale)}</span>;
  if (event.type === 'task_created') {
    return <div className="notice tone-notice-neutral timeline-entry"><IconClock size={13} /><div><div className="notice-text">{t('task.created')}</div></div>{at}</div>;
  }
  if (event.type === 'task_state_changed') {
    const { from, to, sideEffects, reason } = event.payload;
    const unknown = sideEffects === 'UNKNOWN';
    return (
      <div className={`notice timeline-entry ${unknown || to === 'INTERRUPTED' ? 'tone-notice-warn' : to === 'FAILED' ? 'tone-notice-danger' : 'tone-notice-neutral'}`}>
        {unknown ? <IconAlert size={13} /> : <IconChevronRight size={13} />}
        <div>
          <div className="notice-text">{stateLabel(from, t)} → {stateLabel(to, t)}</div>
          {(reason || sideEffects) && <div className="notice-detail">{reason}{reason && sideEffects ? ' · ' : ''}
            {sideEffects && <span className="mono">{t('task.sideEffects', { value: sideEffects })}</span>}</div>}
        </div>
        {at}
      </div>
    );
  }
  const summary = event.payload;
  const parts = [t('task.output', { out: bytes(summary.stdoutBytes), err: bytes(summary.stderrBytes) }),
    ...(summary.truncatedBytes > 0 ? [t('task.notKept', { bytes: bytes(summary.truncatedBytes) })] : [])];
  return (
    <article className={`card timeline-entry ${summary.exitCode === 0 ? 'tone-border-ok' : summary.exitCode === null ? 'tone-border-warn' : 'tone-border-danger'}`}>
      <div className="card-head">
        <span className="card-kicker"><IconTerminal size={13} /> {t('task.toolResult')}</span>
        <span className={`badge mono ${summary.exitCode === 0 ? 'tone-ok' : summary.exitCode === null ? 'tone-warn' : 'tone-danger'}`}>
          {summary.exitCode === null ? t('task.noExit') : t('task.exit', { code: summary.exitCode })}</span>
      </div>
      <p className="muted small">{parts.join(' · ')} · <span className="mono">{t('task.call', { id: shortId(summary.toolCallId) })}</span></p>
      {summary.diagnostics.map((item, index) => (
        <div key={index} className={`notice ${item.severity === 'error' ? 'tone-notice-danger' : 'tone-notice-warn'}`}><IconAlert size={13} /><div className="notice-detail">{item.summary}</div></div>
      ))}
      <div className="card-foot">{at}</div>
    </article>
  );
}

export function TaskDetail({ task }: { task: TaskSnapshot }) {
  const t = useT(); const locale = useLocale();
  const view = useStore(s => s.taskViews[task.id]);
  const events = view?.events ?? [];
  const last = [...events].reverse().find(event => event.type === 'task_state_changed');
  const unknown = last?.type === 'task_state_changed' && last.payload.sideEffects === 'UNKNOWN';
  return (
    <section className="center" data-task-id={task.id}>
      <header className="task-header">
        <div className="task-header-main">
          <h1 className="task-title">{t('task.label')} <span className="mono">{shortId(task.id)}</span></h1>
          <div className="task-meta">
            <StatePill state={task.state} />
            <span className="meta-item"><IconClock size={12} />{t('task.createdAgo', { time: relativeTime(Date.parse(task.createdAt), locale) })}</span>
            <span className="meta-item">{t('task.updatedAgo', { time: relativeTime(Date.parse(task.updatedAt), locale) })}</span>
            <span className="meta-item mono" data-sync={view?.sync ?? 'syncing'} data-synced-at={view?.syncedAt ?? 0}>
              {view?.sync === 'error' ? t('task.outOfSync', { code: view.error ?? '' }) : view?.sync === 'synced'
                ? t('task.events', { applied: view.appliedSeq, total: task.lastSeq }) : t('task.syncing')}</span>
          </div>
        </div>
        <div className="task-actions">
          {view?.sync === 'error' && <button className="btn btn-xs" onClick={() => void actions.resyncTask(task.id)}><IconRetry size={12} /> {t('task.resync')}</button>}
          <button className="btn btn-xs" onClick={() => actions.selectTask(null)}>{t('common.close')}</button>
        </div>
      </header>
      <div className="scroll"><div className="column">
        {task.state === 'INTERRUPTED' && (
          <div className="notice tone-notice-warn task-banner"><IconAlert size={14} /><div>
            <div className="notice-text">{t(unknown ? 'task.interruptedUnknown' : 'task.interrupted')}</div>
            <div className="notice-detail">{t('task.interruptedText')} <span className="mono">WORKER_ISOLATION_UNAVAILABLE</span></div>
          </div><IconLock size={13} /></div>
        )}
        <div className="timeline" aria-label={t('task.eventsLabel')}>{events.map(event => <EventEntry key={event.eventId} event={event} />)}</div>
        {view?.sync === 'syncing' && events.length === 0 && <p className="muted small">{t('task.loading')}</p>}
      </div></div>
    </section>
  );
}
