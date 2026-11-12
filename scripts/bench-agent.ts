import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAUDE_MODELS, CONTEXT_POLICIES, summarizeTaskUsage } from '../packages/contracts/dist/index.js';
import type { ClaudeModel, ContextPolicy } from '../packages/contracts/dist/index.js';
import { createTurnGateway } from '../apps/server/dist/models/turns.js';
import { createToolRouter } from '../apps/server/dist/tools/router.js';
import { AGENT_HARNESS_KEY, withAgentHarness } from '../tests/m2/support/agent-harness.ts';
import { messageStart, messageStop, sse, textBlock, toolBlock } from '../tests/m2/support/fake-provider.ts';

// Offline agent benchmark (ADR-PLAT-001 D2): `pnpm bench:agent`. It measures what this repository can measure without
// a provider account, on this machine, against a local fake of the Messages API:
//   gateway   the control plane's own cost per model turn (SDK, guarded fetch, stream parsing, loopback HTTP)
//   tools     what one read-only tool call costs end to end (the short-lived Read Adapter child)
//   task      a scripted exploration run through the real Worker runtime, Task Runner and Read Adapter: time, request
//             growth, and whether every request extended the previous one (append-only)
//   costModel NOT a measurement: an arithmetic model of the provider's documented caching and context-editing rules,
//             used to compare the context policies. It says what the policy should do, not what the provider did.
// Timings depend on the machine; the request sizes, counts and the cost model are deterministic.

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]! : 0;
};
const stats = (values: number[]) => ({ count: values.length, p50: +percentile(values, 0.5).toFixed(2), p95: +percentile(values, 0.95).toFixed(2),
  max: +Math.max(0, ...values).toFixed(2) });

interface Provider { endpoint: string; bodies: { bytes: number; body: { messages: unknown[]; [key: string]: unknown } }[]; connections: () => number; close(): void }
async function provider(reply: (res: ServerResponse, request: number) => void): Promise<Provider> {
  const bodies: Provider['bodies'] = []; const sockets = new Set<unknown>();
  const server: Server = createServer((req: IncomingMessage, res) => {
    sockets.add(req.socket);
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw.toString('utf8')) as { messages: unknown[]; [key: string]: unknown };
      bodies.push({ bytes: raw.length, body });
      reply(res, bodies.length);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { endpoint: `http://127.0.0.1:${address.port}`, bodies, connections: () => sockets.size, close: () => { server.closeAllConnections(); server.close(); } };
}

/** The control plane's own cost per turn: an immediate, tiny reply, so everything measured is ours or loopback. */
async function benchGateway(turns: number) {
  const fake = await provider(res => sse(res, [messageStart(), ...textBlock(0, 'ok'), ...messageStop('end_turn')]));
  try {
    const gateway = createTurnGateway({ endpoint: fake.endpoint, maxRetries: 0 });
    const input = { apiKey: AGENT_HARNESS_KEY, model: 'claude-sonnet-5-5' as const, turn: 1, system: 'You read code.',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }], tools: ['read_file' as const, 'list_directory' as const],
      context: CONTEXT_POLICIES['claude-sonnet-5-5'] };
    for (let warm = 0; warm < 5; warm++) await gateway.runTurn(input);
    const before = fake.connections();
    const durations: number[] = [], ttfts: number[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const started = performance.now();
      const result = await gateway.runTurn(input);
      durations.push(performance.now() - started);
      if (result.status !== 'ok') throw new Error(`gateway turn failed: ${result.code}`);
      if (result.timing.ttftMs !== null) ttfts.push(result.timing.ttftMs);
    }
    return { turns, turnMs: stats(durations), ttftMs: stats(ttfts), newConnections: fake.connections() - before };
  } finally { fake.close(); }
}

/** One read-only tool call end to end through the Tool Router: policy, child process, reply validation and audit row. */
async function benchTools(calls: number) {
  const fake = await provider(res => sse(res, [messageStart(), ...messageStop('end_turn')]));
  try {
    let result: Record<string, unknown> = {};
    const files = Object.fromEntries([['small.ts', 'x'.repeat(4_096)], ['large.ts', 'y'.repeat(262_144)],
      ...Array.from({ length: 60 }, (_, index) => [`src/module${index}/index.ts`, `export const value${index} = ${index};\n`])]) as Record<string, string>;
    await withAgentHarness(fake.endpoint, async harness => {
      const router = createToolRouter({ store: harness.store });
      const time = async (run: () => Promise<{ status: string }>): Promise<number> => {
        const started = performance.now(); const outcome = await run();
        if (outcome.status !== 'ok') throw new Error(`tool call ${outcome.status}`);
        return performance.now() - started;
      };
      const probe = await router.readFile({ projectId: harness.projectId, args: { path: 'small.ts' } });
      if (probe.status !== 'ok') { result = { available: false, reason: probe.code }; return; }
      const read4k: number[] = [], read256k: number[] = [], list: number[] = [];
      for (let call = 0; call < calls; call++) {
        read4k.push(await time(() => router.readFile({ projectId: harness.projectId, args: { path: 'small.ts' } })));
        read256k.push(await time(() => router.readFile({ projectId: harness.projectId, args: { path: 'large.ts', maxBytes: 262_144 } })));
        list.push(await time(() => router.listDirectory({ projectId: harness.projectId, args: { path: 'src', depth: 2 } })));
      }
      const started = performance.now();
      await Promise.all(Array.from({ length: 16 }, () => time(() => router.readFile({ projectId: harness.projectId, args: { path: 'small.ts' } }))));
      result = { available: true, readFile4KiBMs: stats(read4k), readFile256KiBMs: stats(read256k), listDirectory120EntriesMs: stats(list),
        sixteenParallelReadsMs: +(performance.now() - started).toFixed(2) };
    }, { files });
    return result;
  } finally { fake.close(); }
}

/** A scripted exploration: every round the model reads two 16 KiB files, then answers. Real loop, real tools. */
async function benchTask(rounds: number) {
  const fake = await provider((res, request) => (request <= rounds
    ? sse(res, [messageStart(), ...textBlock(0, `Reading round ${request}.`), ...toolBlock(1, `toolu_${request}_a`, 'read_file', { path: `src/a${request}.ts` }),
      ...toolBlock(2, `toolu_${request}_b`, 'read_file', { path: `src/b${request}.ts` }), ...messageStop('tool_use')])
    : sse(res, [messageStart(), ...textBlock(0, 'Finished.'), ...messageStop('end_turn')])));
  try {
    const files = Object.fromEntries(Array.from({ length: rounds }, (_, index) => [[`src/a${index + 1}.ts`, `// a${index + 1}\n${'a'.repeat(16_000)}`],
      [`src/b${index + 1}.ts`, `// b${index + 1}\n${'b'.repeat(16_000)}`]]).flat()) as Record<string, string>;
    let report: Record<string, unknown> = {};
    await withAgentHarness(fake.endpoint, async harness => {
      const started = performance.now();
      const task = await harness.runTask('Read the sources.', 300_000);
      const wallMs = performance.now() - started;
      const usage = summarizeTaskUsage(task.events);
      const sizes = fake.bodies.map(entry => entry.bytes);
      // Append-only: every request repeats the previous one's system, tools and messages byte for byte, then adds to it.
      let rewritten = 0;
      for (let index = 1; index < fake.bodies.length; index++) {
        const previous = fake.bodies[index - 1]!.body, current = fake.bodies[index]!.body;
        if (JSON.stringify(previous.system) !== JSON.stringify(current.system) || JSON.stringify(previous.tools) !== JSON.stringify(current.tools)) rewritten++;
        previous.messages.forEach((message, position) => { if (JSON.stringify(message) !== JSON.stringify(current.messages[position])) rewritten++; });
      }
      const toolOk = task.events.filter(event => event.type === 'tool_call' && event.payload.status === 'ok').length;
      report = { state: task.state, rounds, requests: fake.bodies.length, toolCalls: usage.toolCalls, toolCallsOk: toolOk, wallMs: +wallMs.toFixed(1),
        modelMs: usage.modelMs, toolMs: usage.toolMs, medianTtftMs: usage.medianTtftMs,
        requestBytes: { first: sizes[0], last: sizes.at(-1), total: sizes.reduce((sum, size) => sum + size, 0) }, rewrittenPrefixBlocks: rewritten,
        connections: fake.connections() };
    }, { files });
    return report;
  } finally { fake.close(); }
}

/**
 * Selective retrieval (M5.2): one definition in a project of `files` files of about 16 KiB each. "Read everything" is
 * what a model with only list_directory and read_file has to do in the worst case; "search, then read the lines" is the
 * path the new tools give it. Both run through the real router and Read Adapter children. What is measured is the cost
 * of each path, not which path a model would choose.
 */
async function benchRetrieval(files: number) {
  const fake = await provider(res => sse(res, [messageStart(), ...messageStop('end_turn')]));
  try {
    const target = Math.floor(files / 2);
    const body = (index: number) => Array.from({ length: 400 }, (_, line) => line === 200 && index === target
      ? 'export function targetDefinition() { return 42; }' : `export const value_${index}_${line} = ${line}; // filler`).join('\n') + '\n';
    const workspace = Object.fromEntries(Array.from({ length: files }, (_, index) => [`src/module${index}.ts`, body(index)])) as Record<string, string>;
    let report: Record<string, unknown> = {};
    await withAgentHarness(fake.endpoint, async harness => {
      const router = createToolRouter({ store: harness.store });
      const timed = async <T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> => { const started = performance.now(); const value = await run(); return { value, ms: performance.now() - started }; };
      // Read everything: list, then every file (four at a time, as the agent loop does).
      const everything = await timed(async () => {
        let bytes = 0, calls = 1;
        await router.listDirectory({ projectId: harness.projectId, args: { path: 'src' } });
        for (let index = 0; index < files; index += 4) {
          const reads = await Promise.all(Array.from({ length: Math.min(4, files - index) }, (_, offset) =>
            router.readFile({ projectId: harness.projectId, args: { path: `src/module${index + offset}.ts` } })));
          for (const read of reads) { calls++; if (read.status === 'ok') bytes += read.bytes; }
        }
        return { bytes, calls };
      });
      // Search, then read twenty lines around the match.
      const selective = await timed(async () => {
        const search = await router.searchText({ projectId: harness.projectId, args: { query: 'function targetDefinition' } });
        if (search.status !== 'ok' || search.matches.length !== 1) throw new Error('search did not find the definition');
        const match = search.matches[0]!;
        const read = await router.readFile({ projectId: harness.projectId, args: { path: match.path, startLine: Math.max(1, match.line - 10), lineCount: 20 } });
        if (read.status !== 'ok') throw new Error('range read failed');
        return { bytes: Buffer.byteLength(match.text) + match.path.length + read.bytes, calls: 2, filesScanned: search.filesScanned };
      });
      // A whole-project search alone, repeated, for its latency distribution.
      const searches: number[] = [];
      for (let round = 0; round < 10; round++) searches.push((await timed(() => router.searchText({ projectId: harness.projectId, args: { query: 'targetDefinition' } }))).ms);
      const finds: number[] = [];
      for (let round = 0; round < 10; round++) finds.push((await timed(() => router.findFiles({ projectId: harness.projectId, args: { pattern: '*.ts' } }))).ms);
      report = { files, projectBytes: Object.values(workspace).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
        readEverything: { calls: everything.value.calls, toolResultBytes: everything.value.bytes, ms: +everything.ms.toFixed(1) },
        searchThenRange: { calls: selective.value.calls, toolResultBytes: selective.value.bytes, filesScanned: selective.value.filesScanned, ms: +selective.ms.toFixed(1) },
        bytesRatio: +(selective.value.bytes / everything.value.bytes).toFixed(4),
        searchProjectMs: stats(searches), findProjectMs: stats(finds) };
    }, { files: workspace });
    return report;
  } finally { fake.close(); }
}

// --- cost model (arithmetic, not a measurement) -------------------------------------------------------------------
// Prices per input token relative to a model's base input price, from the provider's published rules: a cache read
// costs `read`, a 5-minute cache write 1.25, and Haiku 5.5 bills a request five times higher once its prompt exceeds
// 100K tokens. A turn's prompt is the whole conversation so far; with a stable prefix everything sent on the previous
// turn is a cache read and only the new tail is written. A summarization reads the prompt once more, writes a summary
// and restarts the conversation from it. Clearing old tool results (not used in production, modelled for comparison)
// changes the prefix at the first cleared result, so everything after that point is written again on that turn.
const PRICE: Readonly<Record<ClaudeModel, { read: number; longPromptAt: number | null; longPromptFactor: number }>> = {
  'claude-opus-5-5': { read: 0.05, longPromptAt: null, longPromptFactor: 1 },
  'claude-sonnet-5-5': { read: 0.1, longPromptAt: null, longPromptFactor: 1 },
  'claude-haiku-5-5': { read: 0.1, longPromptAt: 100_000, longPromptFactor: 5 },
};
const CLEARED_RESULT_TOKENS = 30, SUMMARY_TOKENS = 2_000, OUTPUT_PRICE = 5, WINDOW_TOKENS = 1_000_000;
/** A policy the model can evaluate: summarization as in production, optionally with tool-result clearing. */
export interface ModelledPolicy extends ContextPolicy { clear?: { atInputTokens: number; keepToolUses: number; atLeastTokens: number } }
export interface CostModelInput { turns: number; resultsPerTurn: number; tokensPerResult: number; tokensPerAssistantTurn: number; baseTokens: number }
export function modelCost(model: ClaudeModel, policy: ModelledPolicy | null, input: CostModelInput) {
  const price = PRICE[model];
  // The conversation as a list of blocks in order; `result` blocks can be cleared.
  const blocks: { tokens: number; result: boolean }[] = [{ tokens: input.baseTokens, result: false }];
  let cachedThrough = 0, cost = 0, peak = 0, clears = 0, compactions = 0, overWindow = 0;
  for (let turn = 1; turn <= input.turns; turn++) {
    let prompt = blocks.reduce((sum, block) => sum + block.tokens, 0);
    let firstChanged = blocks.length;
    if (policy?.clear && prompt >= policy.clear.atInputTokens) {
      const results = blocks.map((block, index) => ({ block, index })).filter(entry => entry.block.result && entry.block.tokens > CLEARED_RESULT_TOKENS);
      const clearable = results.slice(0, Math.max(0, results.length - policy.clear.keepToolUses));
      const freed = clearable.reduce((sum, entry) => sum + entry.block.tokens - CLEARED_RESULT_TOKENS, 0);
      if (clearable.length && freed >= policy.clear.atLeastTokens) {
        for (const entry of clearable) entry.block.tokens = CLEARED_RESULT_TOKENS;
        firstChanged = clearable[0]!.index; clears++; prompt -= freed;
      }
    }
    if (policy && prompt >= policy.compactAtInputTokens) {
      cost += prompt * price.read + SUMMARY_TOKENS * OUTPUT_PRICE; compactions++;
      blocks.splice(0, blocks.length, { tokens: input.baseTokens + SUMMARY_TOKENS, result: false });
      prompt = blocks[0]!.tokens; firstChanged = 0;
    }
    const stable = blocks.slice(0, Math.min(firstChanged, cachedThrough)).reduce((sum, block) => sum + block.tokens, 0);
    const factor = price.longPromptAt !== null && prompt > price.longPromptAt ? price.longPromptFactor : 1;
    cost += (stable * price.read + (prompt - stable) * 1.25) * factor;
    peak = Math.max(peak, prompt);
    if (prompt > WINDOW_TOKENS) overWindow++;
    cachedThrough = blocks.length;
    blocks.push({ tokens: input.tokensPerAssistantTurn, result: false });
    for (let result = 0; result < input.resultsPerTurn; result++) blocks.push({ tokens: input.tokensPerResult, result: true });
  }
  // A turn whose prompt exceeds the window does not run: the task fails there, so its cost is not comparable.
  return { peakPromptTokens: peak, inputCostInBaseTokens: Math.round(cost), clears, compactions, turnsOverWindow: overWindow };
}
/** The clearing alternative that was considered: a full round of tool calls (16) is always kept, summarization stays as a backstop. */
export const CLEARING_ALTERNATIVE: Readonly<Record<ClaudeModel, ModelledPolicy>> = {
  'claude-opus-5-5': { compactAtInputTokens: 700_000, clear: { atInputTokens: 350_000, keepToolUses: 16, atLeastTokens: 50_000 } },
  'claude-sonnet-5-5': { compactAtInputTokens: 700_000, clear: { atInputTokens: 350_000, keepToolUses: 16, atLeastTokens: 50_000 } },
  'claude-haiku-5-5': { compactAtInputTokens: 90_000, clear: { atInputTokens: 60_000, keepToolUses: 16, atLeastTokens: 15_000 } },
};
export const COST_SCENARIOS: Readonly<Record<string, CostModelInput>> = {
  'short: 8 turns x 2 reads of 4K tokens': { turns: 8, resultsPerTurn: 2, tokensPerResult: 4_000, tokensPerAssistantTurn: 300, baseTokens: 1_500 },
  'medium: 40 turns x 2 reads of 8K tokens': { turns: 40, resultsPerTurn: 2, tokensPerResult: 8_000, tokensPerAssistantTurn: 400, baseTokens: 1_500 },
  'long: 40 turns x 4 reads of 8K tokens': { turns: 40, resultsPerTurn: 4, tokensPerResult: 8_000, tokensPerAssistantTurn: 400, baseTokens: 1_500 },
  'heavy: 40 turns x 4 reads of 16K tokens': { turns: 40, resultsPerTurn: 4, tokensPerResult: 16_000, tokensPerAssistantTurn: 400, baseTokens: 1_500 },
  'wide: 40 turns x 12 reads of 4K tokens': { turns: 40, resultsPerTurn: 12, tokensPerResult: 4_000, tokensPerAssistantTurn: 400, baseTokens: 1_500 },
};
export function costModel() {
  return Object.fromEntries(Object.entries(COST_SCENARIOS).map(([name, scenario]) => [name, Object.fromEntries(CLAUDE_MODELS.map(model =>
    [model, { unmanaged: modelCost(model, null, scenario), production: modelCost(model, CONTEXT_POLICIES[model], scenario),
      clearingAlternative: modelCost(model, CLEARING_ALTERNATIVE[model]!, scenario) }]))]));
}

async function main(): Promise<void> {
  const target = `${process.platform}-${process.arch}`;
  const report = { check: 'AGENT_BENCH', target, node: process.version, measuredAt: new Date().toISOString(),
    gateway: await benchGateway(200), tools: await benchTools(30), task: await benchTask(24), retrieval: await benchRetrieval(40),
    costModel: { note: 'Arithmetic model of documented provider pricing and context editing; not measured against the provider.', scenarios: costModel() } };
  const output = resolve('artifacts/bench', target); mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'agent.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
