import { TASK_LIVE_LIMITS, TaskLivePageSchema } from '@operation-agent/contracts';
import type { LiveDelta, TaskLivePage, TurnDelta } from '@operation-agent/contracts';

// Live stream deltas for a viewer (ARCHITECTURE §5.2.2 / §7.3 rule 7): realtime only and never persisted. Each task's
// buffer is bounded by bytes; when it overflows the oldest deltas are dropped and a reader behind them is told there is
// a gap, so it can fall back to the committed messages. A finished task's buffer is kept briefly, then released.

interface Feed { deltas: (LiveDelta & { bytes: number })[]; bytes: number; nextSeq: number; evictedThrough: number; done: boolean; doneAt: number }

export class LiveFeed {
  private readonly feeds = new Map<string, Feed>();
  constructor(private readonly now: () => number = Date.now, private readonly maxBytes: number = TASK_LIVE_LIMITS.maxBufferedBytes) {}

  private feed(taskId: string): Feed {
    let feed = this.feeds.get(taskId);
    if (!feed) { feed = { deltas: [], bytes: 0, nextSeq: 1, evictedThrough: 0, done: false, doneAt: 0 }; this.feeds.set(taskId, feed); }
    return feed;
  }

  push(taskId: string, turn: number, delta: TurnDelta): void {
    this.sweep();
    const feed = this.feed(taskId);
    if (feed.done) return;
    const entry = { seq: feed.nextSeq++, turn, delta, bytes: Buffer.byteLength(JSON.stringify(delta)) };
    feed.deltas.push(entry); feed.bytes += entry.bytes;
    while (feed.bytes > this.maxBytes && feed.deltas.length) {
      const dropped = feed.deltas.shift()!;
      feed.bytes -= dropped.bytes; feed.evictedThrough = dropped.seq;
    }
  }

  finish(taskId: string): void {
    const feed = this.feed(taskId);
    feed.done = true; feed.doneAt = this.now();
  }

  /** At most `maxBytes` of serialized deltas per page (always at least one when any is pending). */
  read(taskId: string, afterSeq: number, maxBytes: number = Number.MAX_SAFE_INTEGER): TaskLivePage {
    this.sweep();
    const feed = this.feeds.get(taskId);
    if (!feed) return TaskLivePageSchema.parse({ taskId, afterSeq, nextSeq: afterSeq, deltas: [], gap: false, done: true });
    const deltas: LiveDelta[] = []; let bytes = 0;
    for (const entry of feed.deltas) {
      if (entry.seq <= afterSeq) continue;
      if (deltas.length >= TASK_LIVE_LIMITS.maxDeltasPerPage || (deltas.length && bytes + entry.bytes > maxBytes)) break;
      deltas.push({ seq: entry.seq, turn: entry.turn, delta: entry.delta }); bytes += entry.bytes;
    }
    const nextSeq = deltas.length ? deltas[deltas.length - 1]!.seq : Math.max(afterSeq, feed.nextSeq - 1);
    return TaskLivePageSchema.parse({ taskId, afterSeq, nextSeq, deltas, gap: afterSeq < feed.evictedThrough,
      done: feed.done && nextSeq >= feed.nextSeq - 1 });
  }

  /** Whether a feed exists (a task that started in this Express instance). */
  has(taskId: string): boolean {
    this.sweep();
    return this.feeds.has(taskId);
  }

  /** Releases buffers of tasks that finished more than the retention window ago. */
  private sweep(): void {
    const cutoff = this.now() - TASK_LIVE_LIMITS.retainFinishedMs;
    for (const [taskId, feed] of this.feeds) if (feed.done && feed.doneAt < cutoff) this.feeds.delete(taskId);
  }
}
