import type { TaskEvent, TaskSnapshot } from '@operation-agent/contracts';
import { useT } from '../locale';
import { useStore } from '../state';
import { IconAlert, IconCheck, IconEye, IconListTree, IconSparkle, IconStop, IconX } from './Icons';
import { Markdown } from './Markdown';

// The conversation of one task: what the person asked, what the model answered each turn, which files it looked at,
// and, while it runs, the turn being streamed right now. Committed text and events come from Express; the stream is
// transient and gives way to the committed answer as soon as that turn is recorded.

type ToolCallEvent = Extract<TaskEvent, { type: 'tool_call' }>;
type TurnEvent = Extract<TaskEvent, { type: 'assistant_turn' }>;

function ToolCall({ event }: { event: ToolCallEvent }) {
  const t = useT();
  const { tool, target, status, code } = event.payload;
  const tone = status === 'ok' ? 'tone-ok' : status === 'skipped' ? 'tone-muted' : status === 'refused' ? 'tone-warn' : 'tone-danger';
  return (
    <li className={`conv-tool ${tone}`} title={code ?? undefined}>
      {tool === 'list_directory' ? <IconListTree size={12} /> : <IconEye size={12} />}
      <span className="conv-tool-name">{tool === 'list_directory' ? t('conv.listed') : tool === 'read_file' ? t('conv.read') : tool}</span>
      <span className="conv-tool-target mono">{target || '—'}</span>
      {status !== 'ok' && <span className={`badge ${tone}`}>{t(`task.tool.${status}` as 'task.tool.ok')}{code ? ` · ${code}` : ''}</span>}
    </li>
  );
}

const ACTIVE = new Set(['CREATED', 'QUEUED', 'RUNNING', 'STOPPING']);

export function Conversation({ task }: { task: TaskSnapshot }) {
  const t = useT();
  const view = useStore(s => s.taskViews[task.id]);
  const conversation = useStore(s => s.conversations[task.id]);
  const events = view?.events ?? [];
  const messages = conversation?.messages ?? [];
  const prompt = messages.find(message => message.role === 'user');
  const answers = new Map(messages.filter(message => message.role === 'assistant').map(message => [message.turn, message]));
  const turns = events.filter((event): event is TurnEvent => event.type === 'assistant_turn');
  const calls = events.filter((event): event is ToolCallEvent => event.type === 'tool_call');
  const committed = Math.max(0, ...turns.map(event => event.payload.turn));
  const live = conversation?.live && conversation.live.turn > committed ? conversation.live : null;
  const active = ACTIVE.has(task.state);
  const final = [...events].reverse().find((event): event is Extract<TaskEvent, { type: 'task_state_changed' }> => event.type === 'task_state_changed');

  return (
    <section className="conversation" aria-label={t('conv.label')}>
      {prompt && (
        <div className="msg-user"><div className="bubble conv-prompt">{prompt.text}</div></div>
      )}
      {turns.map(event => {
        const answer = answers.get(event.payload.turn);
        const turnCalls = calls.filter(call => call.payload.turn === event.payload.turn);
        return (
          <article key={event.eventId} className="conv-turn">
            {answer && <div className="conv-answer"><Markdown text={answer.text} />
              {answer.textTruncated && <p className="muted small">{t('conv.clipped')}</p>}</div>}
            {turnCalls.length > 0 && <ul className="conv-tools">{turnCalls.map(call => <ToolCall key={call.eventId} event={call} />)}</ul>}
            {event.payload.fallback && <p className="muted small">{t('task.fallback')}</p>}
          </article>
        );
      })}
      {live && (
        <article className="conv-turn conv-live" aria-live="polite">
          {live.thinking && (
            <details className="conv-thinking"><summary><IconSparkle size={12} /> {t('conv.thinking')}</summary>
              <p className="conv-thinking-text">{live.thinking.slice(-4_000)}</p></details>
          )}
          {live.text ? <div className="conv-answer"><Markdown text={live.text} /></div> : null}
          {live.tools.length > 0 && <ul className="conv-tools">{live.tools.map(item => (
            <li key={item.id} className="conv-tool tone-muted">{item.name === 'list_directory' ? <IconListTree size={12} /> : <IconEye size={12} />}
              <span className="conv-tool-name">{item.name}</span><span className="dot dot-live" /></li>))}</ul>}
          <p className="conv-working"><span className="dot dot-live" />{task.state === 'STOPPING' ? t('conv.stopping') : t('conv.working')}</p>
        </article>
      )}
      {active && !live && task.state !== 'CREATED' && (
        <p className="conv-working"><span className="dot dot-live" />{task.state === 'STOPPING' ? t('conv.stopping') : t('conv.starting')}</p>
      )}
      {conversation?.gap && active && <p className="muted small">{t('conv.gap')}</p>}
      {!active && final && (
        <div className={`notice conv-end ${task.state === 'COMPLETED' ? 'tone-notice-ok' : task.state === 'STOPPED' ? 'tone-notice-neutral' : 'tone-notice-warn'}`}>
          {task.state === 'COMPLETED' ? <IconCheck size={13} /> : task.state === 'STOPPED' ? <IconStop size={13} /> : task.state === 'FAILED' ? <IconX size={13} /> : <IconAlert size={13} />}
          <div><div className="notice-text">{t(`conv.end.${task.state}` as 'conv.end.COMPLETED')}</div>
            {final.payload.reason && <div className="notice-detail">{final.payload.reason}</div>}</div>
        </div>
      )}
    </section>
  );
}
