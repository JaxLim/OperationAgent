import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { TASK_VIEW_LIMITS, TaskMessageViewSchema } from '../../packages/contracts/dist/index.js';
import type { LiveDelta, TaskEvent, TaskMessage, TaskMessageView } from '../../packages/contracts/dist/index.js';
import { clipMessage } from '../../apps/server/dist/agent/message-view.js';
import { MAX_BLOCKS, MAX_INLINE_SPANS, MAX_LINK_TARGET_CHARS, parseBlocks, tokenizeInline } from '../../apps/desktop/src/renderer/markdown.ts';
import { EMPTY_CONVERSATION, withLivePage, withMessages } from '../../apps/desktop/src/renderer/conversation.ts';
import type { ConversationView } from '../../apps/desktop/src/renderer/conversation.ts';

// The conversation view (PR #16 review): what a viewer is sent, how answers are parsed, and how the two concurrent pulls
// (committed messages, live deltas) are merged. All pure functions, tested directly.

const taskId = randomUUID();
const message = (role: 'user' | 'assistant', turn: number, text: string): TaskMessage =>
  ({ id: randomUUID(), taskId, role, turn, text, createdAt: new Date(0).toISOString() });
const shown = (role: 'user' | 'assistant', turn: number, text: string): TaskMessageView => ({ ...message(role, turn, text), textTruncated: false });
const kinds = (text: string): string[] => tokenizeInline(text).map(token => `${token.kind}:${token.text}`);
const elapsed = (run: () => void): number => { const start = performance.now(); run(); return performance.now() - start; };

test('a message view is clipped by its serialized size, so escaping can never push a page past the response limit', () => {
  const plain = clipMessage(message('assistant', 1, 'short answer'));
  assert.deepEqual([plain.text, plain.textTruncated], ['short answer', false]);
  // Each of these is under the budget as raw UTF-8 but far over it once JSON-escaped.
  for (const [name, text] of [['backslashes', '\\'.repeat(139_000)], ['quotes', '"'.repeat(139_000)], ['controls', '\u0001'.repeat(100_000)],
    ['mixed', 'path C:\\dir\\"file"\n'.repeat(7_000)]] as const) {
    assert.ok(Buffer.byteLength(text) <= TASK_VIEW_LIMITS.maxMessageViewBytes, `${name}: raw text alone is within the budget`);
    const view = clipMessage(message('assistant', 1, text));
    assert.equal(view.textTruncated, true, name);
    assert.ok(text.startsWith(view.text) && view.text.length > 0, `${name}: a non-empty prefix`);
    assert.ok(Buffer.byteLength(JSON.stringify(view.text)) <= TASK_VIEW_LIMITS.maxMessageViewBytes, `${name}: serialized text fits`);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) <= TASK_VIEW_LIMITS.maxMessagePageBytes, `${name}: the whole view fits one page`);
    // The clip is tight: one more character would not fit.
    assert.ok(Buffer.byteLength(JSON.stringify(text.slice(0, view.text.length + 1))) > TASK_VIEW_LIMITS.maxMessageViewBytes, `${name}: longest prefix`);
    assert.ok(TaskMessageViewSchema.safeParse(view).success, name);
  }
  // Text that fits when serialized is not clipped, however close to the limit.
  const exact = 'a'.repeat(TASK_VIEW_LIMITS.maxMessageViewBytes - 2);
  assert.equal(clipMessage(message('assistant', 1, exact)).textTruncated, false);
  assert.equal(clipMessage(message('assistant', 1, exact + 'a')).textTruncated, true);
  // A cut never leaves half of a surrogate pair, whichever half the budget lands on.
  for (const lead of ['', 'x', 'xx', 'xxx']) {
    const view = clipMessage(message('assistant', 1, lead + '😀'.repeat(60_000)));
    assert.equal(view.textTruncated, true);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    assert.ok(!loneSurrogate.test(view.text) && view.text.endsWith('😀'), `no lone surrogate (lead ${lead.length})`);
  }
});

test('Markdown blocks: every line is consumed, including headings the old parser stalled on', () => {
  // The reported input: an indented heading used to stop the cursor and fill the output with 2,000 empty paragraphs.
  assert.deepEqual(parseBlocks('Before\n\n  ## Heading\n\nImportant answer'), [
    { kind: 'paragraph', text: 'Before' }, { kind: 'heading', level: 2, text: 'Heading' }, { kind: 'paragraph', text: 'Important answer' }]);
  assert.deepEqual(parseBlocks('intro\n   # Up to three spaces\n    # Four is text'), [
    { kind: 'paragraph', text: 'intro' }, { kind: 'heading', level: 1, text: 'Up to three spaces' }, { kind: 'paragraph', text: '    # Four is text' }]);
  assert.deepEqual(parseBlocks('# Title\n\ntext one\ntext two\n- a\n- b\n  more\n1. x\n\n> quoted\n> again\n\n---\n```ts\nconst a = 1;\n# not a heading\n```\ntail'), [
    { kind: 'heading', level: 1, text: 'Title' }, { kind: 'paragraph', text: 'text one\ntext two' },
    { kind: 'list', ordered: false, items: ['a', 'b more', 'x'] }, { kind: 'quote', text: 'quoted\nagain' }, { kind: 'rule' },
    { kind: 'code', lang: 'ts', text: 'const a = 1;\n# not a heading' }, { kind: 'paragraph', text: 'tail' }]);
  assert.deepEqual(parseBlocks('```\nunterminated'), [{ kind: 'code', lang: '', text: 'unterminated' }]);
  assert.deepEqual(parseBlocks(''), []);
  // Progress is structural: whatever the lines look like, a block consumes at least one of them.
  const pieces = ['', ' ', '#', '  ## h', '    ## not', '####### seven', '>', ' > q', '-', '- item', '1) one', '***', '_ _ _', '```', '~~~x', 'text', '\t# tab',
    ' \u00a0## nbsp', '#\u3000wide', '   ', '\u2028', '# ', '  #', '- ', '1.'];
  let seed = 20261110;
  const random = (): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  for (let round = 0; round < 400; round++) {
    const lines = Array.from({ length: 1 + Math.floor(random() * 40) }, () => pieces[Math.floor(random() * pieces.length)]!);
    const blocks = parseBlocks(lines.join(round % 2 ? '\n' : '\r\n'));
    assert.ok(blocks.length <= lines.filter(line => line.trim()).length, `more blocks than non-blank lines: ${JSON.stringify(lines)}`);
  }
  assert.equal(parseBlocks('para\n\n'.repeat(MAX_BLOCKS + 50)).length, MAX_BLOCKS);
});

test('Markdown inline spans: same spans as before, opener without closer is literal, first opener wins', () => {
  assert.deepEqual(kinds('use `npm test` then **bold**, __also__, *soft* and [docs](https://example.test/a)'), ['text:use ', 'code:npm test',
    'text: then ', 'strong:bold', 'text:, ', 'strong:also', 'text:, ', 'em:soft', 'text: and ', 'link:docs']);
  assert.deepEqual(tokenizeInline('[docs](https://example.test/a)'), [{ kind: 'link', text: 'docs', url: 'https://example.test/a' }]);
  assert.deepEqual(kinds('``a ` b`` and ```` x ````'), ['code:a ` b', 'text: and ', 'code: x ']);
  assert.deepEqual(kinds('**a `b` c** `d ** e`'), ['strong:a `b` c', 'text: ', 'code:d ** e']);
  // Unclosed or malformed openers stay text.
  for (const literal of ['a ` b', '```a`', 'a ** b', '**', '****', '* spaced *', 'a * b', '__x_', '_single_', '[label]', '[label] (gap)', '[](x)', '[a]()',
    '[a](b c)', '[a](b\td)', '[[[[', ']]]]', '((((', '`', '*', '_', '[', '']) {
    assert.deepEqual(tokenizeInline(literal), literal ? [{ kind: 'text', text: literal }] : [], JSON.stringify(literal));
  }
  assert.deepEqual(kinds('[a](' + 'u'.repeat(MAX_LINK_TARGET_CHARS) + ')'), ['link:a']);
  assert.deepEqual(kinds('[a](' + 'u'.repeat(MAX_LINK_TARGET_CHARS + 1) + ')').length, 1, 'an overlong target is plain text');
  // Text is never lost or duplicated: the tokens always spell the input once its delimiters are put back.
  const rebuild = (text: string): string => tokenizeInline(text).map(token => token.kind === 'text' ? token.text : token.kind === 'em' ? `*${token.text}*` :
    token.kind === 'link' ? `[${token.text}](${token.url})` : token.kind === 'strong' ? `S${token.text}S` : `C${token.text}C`).join('');
  const normalize = (text: string): string => text.replaceAll(/`+/g, 'C').replaceAll(/\*\*|__/g, 'S');
  for (const sample of ['plain', 'a *b* c [d](e) f', 'x **y** z __w__', '`a` `b` `c', 'mix *a **b** `c` [d](e)']) {
    assert.equal(normalize(rebuild(sample)), normalize(sample), sample);
  }
  const capped = tokenizeInline('*a* '.repeat(MAX_INLINE_SPANS + 100));
  assert.equal(capped.filter(token => token.kind === 'em').length, MAX_INLINE_SPANS);
  assert.ok(capped.at(-1)!.kind === 'text' && capped.at(-1)!.text.includes('*a* *a*'), 'the rest is plain text');
});

test('Markdown inline parsing is linear: adversarial model output cannot freeze the Renderer', () => {
  // The reported input was 64,000 opening brackets (about 3.2 s per pass with the old pattern). These are over six times
  // longer; a quadratic scan would take minutes, a linear one a few milliseconds. The bound is deliberately loose.
  const size = 400_000;
  const cases: Record<string, string> = {
    'unclosed brackets': '['.repeat(size),
    'brackets closed once at the end': '['.repeat(size) + ']',
    'labels without targets': '[a]'.repeat(size / 4) + '(',
    'targets never closed': '[a]('.repeat(size / 4),
    'targets with spaces, closed at the end': '[a](b c'.repeat(size / 8) + ')',
    'stars with spaces': '* '.repeat(size / 2),
    'lone bold openers': '**a '.repeat(size / 4) + '_',
    'underscore pairs': '__a_'.repeat(size / 4),
    'backtick runs of growing length': Array.from({ length: 800 }, (_, index) => '`'.repeat(index + 1) + 'a').join(''),
    'mixed backtick lengths': '`` ` '.repeat(size / 5),
    'every delimiter': '[*_`('.repeat(size / 5),
  };
  for (const [name, text] of Object.entries(cases)) {
    let tokens = 0;
    const ms = elapsed(() => { tokens = tokenizeInline(text).length; });
    assert.ok(ms < 2_000, `${name}: ${Math.round(ms)} ms for ${text.length} characters`);
    assert.ok(tokens > 0 && tokens <= MAX_INLINE_SPANS * 2 + 1, `${name}: ${tokens} tokens`);
  }
  const ms = elapsed(() => { parseBlocks(('  ## h\n' + '['.repeat(200) + '\n').repeat(2_000)); });
  assert.ok(ms < 2_000, `blocks: ${Math.round(ms)} ms`);
});

test('conversation view: a message pull and a live poll that overlap never undo each other', () => {
  const turnEvent = (turn: number): TaskEvent => ({ type: 'assistant_turn', payload: { turn } } as unknown as TaskEvent);
  const text = (seq: number, turn: number, value: string): LiveDelta => ({ seq, turn, delta: { kind: 'text', text: value } });
  const page = (afterSeq: number, deltas: LiveDelta[], extra: { gap?: boolean; done?: boolean } = {}) =>
    ({ afterSeq, nextSeq: deltas.at(-1)?.seq ?? afterSeq, deltas, gap: extra.gap ?? false, done: extra.done ?? false });

  // The reported race: live text A is shown (cursor 1); a message pull starts; B arrives (cursor 2); the pull returns.
  let view: ConversationView = withLivePage(EMPTY_CONVERSATION, page(0, [text(1, 1, 'A')]), []).view;
  const pullStartedWith = view.messages.length;
  view = withLivePage(view, page(1, [text(2, 1, 'B')]), []).view;
  view = withMessages(view, pullStartedWith, [shown('user', 0, 'question')], []);
  assert.deepEqual([view.live?.text, view.liveSeq, view.messages.length], ['AB', 2, 1], 'B is kept and the cursor still matches the text');

  // A new turn and a tool call ask for the committed views; plain text of the same turn does not.
  assert.equal(withLivePage(EMPTY_CONVERSATION, page(0, [text(1, 1, 'A')]), []).refresh, true);
  assert.equal(withLivePage(view, page(2, [text(3, 1, 'C')]), []).refresh, false);
  const tool = withLivePage(view, page(2, [{ seq: 3, turn: 1, delta: { kind: 'tool_call', id: 'toolu_1', name: 'read_file' } }]), []);
  assert.deepEqual([tool.refresh, tool.view.live?.tools], [true, [{ id: 'toolu_1', name: 'read_file' }]]);

  // Once the turn is committed its live text gives way to the answer, and a late tail of that turn is not shown again.
  view = withMessages(view, 1, [shown('assistant', 1, 'AB, in full')], [turnEvent(1)]);
  assert.deepEqual([view.live, view.messages.length], [null, 2]);
  const tail = withLivePage(view, page(2, [text(3, 1, ' tail')]), [turnEvent(1)]);
  assert.deepEqual([tail.view.live, tail.view.liveSeq, tail.refresh], [null, 3, false]);
  // The next turn starts a fresh live turn; older deltas mixed into the page are ignored.
  const next = withLivePage(tail.view, page(3, [text(4, 1, 'old'), text(5, 2, 'Next')]), [turnEvent(1)]);
  assert.deepEqual([next.view.live?.turn, next.view.live?.text, next.refresh], [2, 'Next', true]);

  // A reply for a cursor or message count the view has moved past is not applied.
  assert.equal(withLivePage(next.view, page(1, [text(2, 2, 'stale')]), []).view, next.view);
  assert.equal(withMessages(next.view, 0, [shown('user', 0, 'again')], []), next.view);
  // Gaps accumulate, and the end of the stream asks for a final refresh.
  const gap = withLivePage(next.view, page(5, [], { gap: true, done: true }), []);
  assert.deepEqual([gap.view.gap, gap.refresh, gap.view.live?.text], [true, true, 'Next']);
});
