import { TASK_VIEW_LIMITS } from '@operation-agent/contracts';
import type { TaskMessage, TaskMessageView } from '@operation-agent/contracts';

// How a stored prompt or answer is shown to a viewer. The budget is measured on the JSON the route actually sends, not
// on the raw text: Main limits the response in serialized bytes, and escaping can make a string several times larger
// (a backslash or a quote doubles, a control character becomes six bytes), so text that is short enough as UTF-8 can
// still be too large on the wire.

const serializedBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text));

/** A message whole when its serialized text fits the view budget, otherwise clipped on a character boundary and flagged. */
export function clipMessage(message: TaskMessage): TaskMessageView {
  const budget = TASK_VIEW_LIMITS.maxMessageViewBytes;
  if (serializedBytes(message.text) <= budget) return { ...message, textTruncated: false };
  // The longest prefix that fits. `low` always fits, so the result does too even where a split surrogate pair makes the
  // serialized size briefly non-monotonic.
  let low = 0, high = Math.min(message.text.length, budget);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(message.text.slice(0, middle)) <= budget) low = middle; else high = middle - 1;
  }
  // Never leave a lone high surrogate at the cut.
  if (low > 0 && /[\uD800-\uDBFF]/.test(message.text[low - 1]!)) low--;
  return { ...message, text: message.text.slice(0, low), textTruncated: true };
}
