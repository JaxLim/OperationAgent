import type { TaskEvent, TaskLivePage, TaskMessageView } from '@operation-agent/contracts';

// One task's conversation as a window shows it, and the two ways it changes: committed messages pulled from Express, and
// pages of transient live deltas. Both are pure functions of the view as it is at the moment they are applied. The two
// pulls run concurrently, so neither may write back anything it read before its request: the store applies these
// functions to the current view when a reply arrives.

/** What the model is producing right now for one turn: transient stream deltas, replaced by the committed answer. */
export interface LiveTurn { readonly turn: number; readonly text: string; readonly thinking: string; readonly tools: readonly { id: string; name: string }[] }
/**
 * The committed prompt and answers (from Express), and the stream of the turn in progress. `gap` means some live deltas
 * were missed; the committed answer is still complete.
 */
export interface ConversationView {
  readonly messages: readonly TaskMessageView[];
  readonly liveSeq: number;
  readonly live: LiveTurn | null;
  readonly gap: boolean;
  readonly stopping: boolean;
}
export const EMPTY_CONVERSATION: ConversationView = Object.freeze({ messages: [], liveSeq: 0, live: null, gap: false, stopping: false });
export const MAX_LIVE_CHARS = 200_000;
export const MAX_LIVE_TOOLS = 64;

/** The highest turn Express has committed, as far as the answers and events applied in this window show. */
export function committedTurn(messages: readonly TaskMessageView[], events: readonly TaskEvent[]): number {
  let turn = 0;
  for (const message of messages) if (message.role === 'assistant' && message.turn > turn) turn = message.turn;
  for (const event of events) if (event.type === 'assistant_turn' && event.payload.turn > turn) turn = event.payload.turn;
  return turn;
}

/**
 * Appends messages pulled after the first `shown` ones; a live turn that is now committed gives way to its committed
 * answer. Everything else in the view, in particular live text and the live cursor, is kept exactly as it is now.
 */
export function withMessages(view: ConversationView, shown: number, pulled: readonly TaskMessageView[], events: readonly TaskEvent[]): ConversationView {
  if (view.messages.length !== shown) return view;
  const messages = [...view.messages, ...pulled];
  return { ...view, messages, live: view.live && view.live.turn <= committedTurn(messages, events) ? null : view.live };
}

/**
 * Applies one page of live deltas read after the view's cursor. `refresh` asks the caller to pull the committed views
 * again (a new turn began, a tool call was announced, or the stream ended).
 */
export function withLivePage(view: ConversationView, page: Pick<TaskLivePage, 'afterSeq' | 'nextSeq' | 'deltas' | 'gap' | 'done'>,
  events: readonly TaskEvent[]): { view: ConversationView; refresh: boolean } {
  if (page.afterSeq !== view.liveSeq) return { view, refresh: false };
  const committed = committedTurn(view.messages, events);
  let live = view.live; let refresh = page.done && page.deltas.length === 0;
  for (const { turn, delta } of page.deltas) {
    // The tail of a turn that is already committed adds nothing: its answer is shown from the committed text.
    if (turn <= committed) { if (delta.kind === 'tool_call') refresh = true; continue; }
    if (!live || turn > live.turn) { live = { turn, text: '', thinking: '', tools: [] }; refresh = true; }
    if (turn < live.turn) continue;
    if (delta.kind === 'text') live = { ...live, text: (live.text + delta.text).slice(-MAX_LIVE_CHARS) };
    else if (delta.kind === 'thinking') live = { ...live, thinking: (live.thinking + delta.text).slice(-MAX_LIVE_CHARS) };
    else { live = { ...live, tools: [...live.tools, { id: delta.id, name: delta.name }].slice(-MAX_LIVE_TOOLS) }; refresh = true; }
  }
  return { view: { ...view, live, liveSeq: page.nextSeq, gap: view.gap || page.gap }, refresh };
}
