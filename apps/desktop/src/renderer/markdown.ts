// Parsing for the Markdown view of model answers: pure functions with no React and no imports, so they can be tested
// directly. Model output is untrusted and may be adversarial or simply huge, and it is re-parsed on every streamed
// update, so both parsers are single passes whose work is linear in the input: every loop iteration consumes at least
// one line or one character, and every search for a closing delimiter is answered from a monotonic cache.

export type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }
  | { kind: 'paragraph'; text: string };

export const MAX_BLOCKS = 2_000;
/** Formatted inline spans per text; anything after the cap is shown as plain text. */
export const MAX_INLINE_SPANS = 5_000;
/** A link target longer than this is left as plain text. */
export const MAX_LINK_TARGET_CHARS = 2_048;

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;
// Up to three leading spaces, as in CommonMark; the paragraph rule below uses this same pattern to decide where to stop.
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const BULLET = /^\s*([-*+]|\d{1,9}[.)])\s+/;
const startsBlock = (line: string): boolean => FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || BULLET.test(line);

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length && blocks.length < MAX_BLOCKS) {
    const line = lines[index]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!; const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(marker)) body.push(lines[index++]!);
      index++;
      blocks.push({ kind: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { index++; continue; }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() }); index++; continue; }
    if (RULE.test(line)) { blocks.push({ kind: 'rule' }); index++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) body.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }
    if (BULLET.test(line)) {
      const ordered = /^\s*\d/.test(line); const items: string[] = [];
      while (index < lines.length && (BULLET.test(lines[index]!) || (/^\s{2,}\S/.test(lines[index]!) && items.length))) {
        const current = lines[index++]!;
        if (BULLET.test(current)) items.push(current.replace(BULLET, ''));
        else items[items.length - 1] += ' ' + current.trim();
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    // A paragraph always takes the current line, whatever it looks like, so the cursor advances on every iteration even
    // if a line is rejected by every rule above; it then continues until a blank line or the start of another block.
    const body: string[] = [lines[index++]!];
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)) body.push(lines[index++]!);
    blocks.push({ kind: 'paragraph', text: body.join('\n') });
  }
  return blocks;
}

export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'em'; text: string }
  | { kind: 'link'; text: string; url: string };

const BACKTICK = 0x60, STAR = 0x2a, UNDERSCORE = 0x5f, OPEN_BRACKET = 0x5b;
const isSpace = (code: number): boolean => code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x2028 || code === 0x2029 ||
  code === 0xfeff || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;

/**
 * "Where is the next match at or after `from`?", answered in amortized constant time for the non-decreasing positions
 * the tokenizer asks about: a previous answer `pos` for `asked` also answers every position in [asked, pos], and "none"
 * answers every later position. So each character is searched at most once per finder, however many openers there are.
 */
function finder(search: (from: number) => number): (from: number) => number {
  let asked = -1, found = -2;
  return from => {
    if (found !== -2 && from >= asked && (found === -1 || from <= found)) return found;
    asked = from; found = search(from);
    return found;
  };
}

/**
 * Splits text into literal runs and the inline spans answers about code use: `code`, **bold** / __bold__, *italic* and
 * [label](target). A span never contains its own delimiter, exactly as the previous pattern required; an opener without
 * a matching closer is literal text. The first opener wins and span contents are not parsed further.
 */
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const length = text.length;
  let spans = 0, literalFrom = 0, index = 0;
  const flush = (to: number): void => { if (to > literalFrom) tokens.push({ kind: 'text', text: text.slice(literalFrom, to) }); };
  const emit = (token: InlineToken, from: number, next: number): void => { flush(from); tokens.push(token); spans++; index = next; literalFrom = next; };

  // Backtick runs, each paired with the next run of the same length (found in one right-to-left pass).
  const runStart: number[] = [], runLength: number[] = [];
  for (let at = 0; at < length; at++) {
    if (text.charCodeAt(at) !== BACKTICK) continue;
    let end = at + 1;
    while (end < length && text.charCodeAt(end) === BACKTICK) end++;
    runStart.push(at); runLength.push(end - at); at = end - 1;
  }
  const closingRun = new Array<number>(runStart.length).fill(-1);
  const lastOfLength = new Map<number, number>();
  for (let run = runStart.length - 1; run >= 0; run--) {
    closingRun[run] = lastOfLength.get(runLength[run]!) ?? -1;
    lastOfLength.set(runLength[run]!, run);
  }
  let run = 0;

  const nextStar = finder(from => text.indexOf('*', from));
  const nextUnderscore = finder(from => text.indexOf('_', from));
  const nextCloseBracket = finder(from => text.indexOf(']', from));
  const nextCloseParen = finder(from => text.indexOf(')', from));
  const nextSpace = finder(from => { for (let at = from; at < length; at++) if (isSpace(text.charCodeAt(at))) return at; return -1; });

  while (index < length && spans < MAX_INLINE_SPANS) {
    const code = text.charCodeAt(index);
    if (code === BACKTICK) {
      while (run < runStart.length && runStart[run]! < index) run++;
      // Spans end just after a non-backtick delimiter, so a backtick reached here always starts a run.
      if (runStart[run] !== index) { index++; continue; }
      const open = run, close = closingRun[open] ?? -1;
      const afterOpen = index + runLength[open]!;
      if (close >= 0) { emit({ kind: 'code', text: text.slice(afterOpen, runStart[close]!) }, index, runStart[close]! + runLength[close]!); continue; }
      index = afterOpen; continue;
    }
    if (code === STAR || code === UNDERSCORE) {
      const next = code === STAR ? nextStar : nextUnderscore;
      if (text.charCodeAt(index + 1) === code) {
        const close = next(index + 2);
        if (close > index + 2 && text.charCodeAt(close + 1) === code) { emit({ kind: 'strong', text: text.slice(index + 2, close) }, index, close + 2); continue; }
      } else if (code === STAR && index + 1 < length && !isSpace(text.charCodeAt(index + 1))) {
        const close = next(index + 1);
        if (close > index + 1) { emit({ kind: 'em', text: text.slice(index + 1, close) }, index, close + 1); continue; }
      }
      index++; continue;
    }
    if (code === OPEN_BRACKET) {
      const labelEnd = nextCloseBracket(index + 1);
      if (labelEnd > index + 1 && text.charCodeAt(labelEnd + 1) === 0x28) {
        const targetStart = labelEnd + 2;
        const targetEnd = nextCloseParen(targetStart);
        if (targetEnd > targetStart && targetEnd - targetStart <= MAX_LINK_TARGET_CHARS) {
          const space = nextSpace(targetStart);
          if (space === -1 || space >= targetEnd) {
            emit({ kind: 'link', text: text.slice(index + 1, labelEnd), url: text.slice(targetStart, targetEnd) }, index, targetEnd + 1);
            continue;
          }
        }
      }
      index++; continue;
    }
    index++;
  }
  flush(length);
  return tokens;
}
