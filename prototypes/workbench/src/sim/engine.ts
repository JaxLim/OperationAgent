// Deterministic scenario engine. It replays a scripted agent run with timers and
// gates; it never spawns processes, reads disks, calls models or writes files.
// Applied changes only land in the in-memory "overlay" shown by the file viewer.

import { store, RETRYABLE_STATUSES, isActive } from './store';
import { LEDGER_FILES, DEMO_PROJECT_ID } from './data/projects';
import { diffStats, fingerprint, unifiedPatch } from './diff';
import type {
  Approval, Artifact, Capability, ChangeSet, FileChange, GrantScope, OutputStream, Plan, Task, TaskResult,
  TaskStatus, TestCase, TimelineItem, ToolCall, ToolName, ToolRisk,
} from './types';

class Aborted extends Error {}

type Line = [OutputStream, string];

interface ToolSpec {
  name: ToolName;
  risk: ToolRisk;
  title: string;
  target: string;
  argv?: string[];
  lines: Line[];
  durationMs: number;
  summary: string;
  exitCode?: number;
  fail?: boolean;
}

const ISOLATION: Record<ToolRisk, string> = {
  read: 'Read adapter · short-lived',
  exec: 'OS sandbox · network denied',
  write: 'OS sandbox · workspace-scoped',
};

const TEST_ARGV = ['pnpm', 'exec', 'vitest', 'run', 'tests/invoice'];

const BASE_CASES = [
  'returns zero totals for an empty invoice',
  'sums a single line',
  'applies the tax rate',
  'multiplies by quantity',
  'preserves the invoice currency',
  'handles a zero tax rate',
];
const NEW_CASES = ['rounds tax once per invoice (INC-4821)', 'keeps minor-unit precision for fractional prices'];

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

function numbered(content: string, limit = 40): Line[] {
  const lines = content.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, limit).map((text, index): Line => ['stdout', `${String(index + 1).padStart(3)}  ${text}`]);
  if (lines.length > limit) shown.push(['info', `… ${lines.length - limit} more lines`]);
  return shown;
}

class Run {
  readonly controller = new AbortController();
  private counter = 0;
  private seq = 0;
  gate?: { key: string; resolve: (value: unknown) => void; reject: (error: Error) => void };
  activeToolId?: string;
  streamingItemId?: string;

  constructor(readonly taskId: string, readonly attempt: number) {}

  get signal(): AbortSignal { return this.controller.signal; }
  get speed(): number { return store.getState().settings.speed; }
  task(): Task { return store.task(this.taskId)!; }
  id(prefix: string): string { return `${this.taskId}-a${this.attempt}-${prefix}${++this.counter}`; }
  patch(fn: (task: Task) => Task): void { store.updateTask(this.taskId, fn); }

  check(): void { if (this.signal.aborted) throw new Aborted(); }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.signal.aborted) { reject(new Aborted()); return; }
      const timer = window.setTimeout(() => { this.signal.removeEventListener('abort', onAbort); resolve(); }, ms / this.speed);
      const onAbort = (): void => { window.clearTimeout(timer); reject(new Aborted()); };
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  wait<T>(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.signal.aborted) { reject(new Aborted()); return; }
      this.gate = { key, resolve: value => { this.gate = undefined; resolve(value as T); }, reject };
      this.signal.addEventListener('abort', () => { this.gate = undefined; reject(new Aborted()); }, { once: true });
    });
  }

  status(status: TaskStatus): void { this.check(); this.patch(task => ({ ...task, status })); }

  push(item: TimelineItem): void { this.patch(task => ({ ...task, items: [...task.items, item] })); }

  notice(text: string, tone: 'neutral' | 'warn' | 'danger' | 'ok', detail?: string): void {
    this.push({ kind: 'notice', id: this.id('n'), at: Date.now(), text, tone, detail });
  }

  planStep(stepId: string, state: 'pending' | 'active' | 'done' | 'skipped'): void {
    this.patch(task => task.plan ? {
      ...task, plan: { ...task.plan, steps: task.plan.steps.map(step => step.id === stepId ? { ...step, state } : step) },
    } : task);
  }

  /** Streams agent prose word by word, like a model delta stream. */
  async say(text: string): Promise<void> {
    this.check();
    const id = this.id('m');
    this.streamingItemId = id;
    this.push({ kind: 'agent', id, at: Date.now(), text: '', streaming: true });
    const words = text.split(/(?<=\s)/);
    let shown = '';
    for (let index = 0; index < words.length; index += 3) {
      shown += words.slice(index, index + 3).join('');
      const value = shown;
      this.patch(task => ({ ...task, items: task.items.map(item => item.id === id && item.kind === 'agent' ? { ...item, text: value } : item) }));
      await this.sleep(38);
    }
    this.patch(task => ({ ...task, items: task.items.map(item => item.id === id && item.kind === 'agent' ? { ...item, streaming: false } : item) }));
    this.streamingItemId = undefined;
    await this.sleep(220);
  }

  createTool(spec: Pick<ToolSpec, 'name' | 'risk' | 'title' | 'target' | 'argv'>, state: ToolCall['state'], show = true): string {
    this.check();
    const id = this.id('t');
    const call: ToolCall = {
      id, name: spec.name, risk: spec.risk, title: spec.title, target: spec.target, argv: spec.argv,
      isolation: ISOLATION[spec.risk], state, output: [], startedAt: state === 'running' ? Date.now() : undefined,
    };
    this.patch(task => ({ ...task, tools: { ...task.tools, [id]: call } }));
    if (show) this.showTool(id);
    return id;
  }

  showTool(id: string): void {
    this.push({ kind: 'tool', id: `${id}-i`, at: Date.now(), toolCallId: id });
  }

  updateTool(id: string, fn: (call: ToolCall) => ToolCall): void {
    this.patch(task => ({ ...task, tools: { ...task.tools, [id]: fn(task.tools[id]!) } }));
  }

  /** Simulated tool execution: output deltas stream with sequence numbers, then the call settles. */
  async execute(id: string, spec: ToolSpec): Promise<void> {
    this.activeToolId = id;
    this.updateTool(id, call => ({ ...call, state: 'running', startedAt: Date.now() }));
    const delay = Math.max(30, spec.durationMs / Math.max(1, spec.lines.length));
    await this.sleep(Math.min(260, delay));
    for (const [stream, text] of spec.lines) {
      const seq = ++this.seq;
      this.updateTool(id, call => ({ ...call, output: [...call.output, { seq, stream, text }] }));
      await this.sleep(delay);
    }
    this.updateTool(id, call => ({
      ...call, state: spec.fail ? 'failed' : 'done', endedAt: Date.now(), summary: spec.summary, exitCode: spec.exitCode,
    }));
    this.activeToolId = undefined;
    await this.sleep(160);
  }

  async tool(spec: ToolSpec): Promise<string> {
    if (spec.name === 'read_file' && store.getState().settings.autoOpenContext) {
      store.update(s => s.activeTaskId === this.taskId && s.rightTab === 'files' ? { ...s, selectedFile: spec.target } : s);
    }
    const id = this.createTool(spec, 'running');
    await this.execute(id, spec);
    return id;
  }
}

const runs = new Map<string, Run>();
let taskCounter = 0;

/** Tool calls and approvals of the current attempt only; ids carry the attempt number. */
function attemptCounts(task: Task): { toolCalls: number; approvals: number } {
  const mine = (id: string): boolean => id.startsWith(`${task.id}-a${task.attempt}-`);
  return {
    toolCalls: Object.keys(task.tools).filter(mine).length,
    approvals: Object.values(task.approvals).filter(a => mine(a.id) && (a.state === 'approved' || a.state === 'denied')).length,
  };
}

function capabilitiesFor(): Capability[] {
  return [
    { label: 'Executable', value: 'pnpm 10.34.7 → vitest 4.0.8 (pinned, resolved path)', tone: 'ok' },
    { label: 'Mode', value: 'Test run · lifecycle scripts disabled', tone: 'ok' },
    { label: 'Filesystem', value: 'Read workspace · write node_modules/.vite only', tone: 'ok' },
    { label: 'Network', value: 'Denied', tone: 'deny' },
    { label: '.git', value: 'No access', tone: 'deny' },
    { label: 'Limits', value: '120 s timeout · 5 s stop grace', tone: 'ok' },
  ];
}

/**
 * Command gate. A grant binds to the fingerprint of the normalised argv plus the
 * capability set, so a later call with different arguments would ask again.
 */
async function commandGate(run: Run, spec: ToolSpec, reason: string): Promise<{ id: string; allowed: boolean }> {
  const id = run.createTool(spec, 'awaiting_approval', false);
  const capabilities = capabilitiesFor();
  const argvHash = fingerprint([...(spec.argv ?? []), '~/sample-projects/ledger-api', ...capabilities.map(cap => cap.value)]);
  const task = run.task();
  const settings = store.getState().settings;
  const approvalId = run.id('ap');
  const base: Approval = {
    id: approvalId, kind: 'command', toolCallId: id, title: spec.title, reason, capabilities, argvHash, state: 'pending',
  };
  if (task.grants.includes(argvHash) || settings.approvalPolicy === 'ask-writes') {
    const why = task.grants.includes(argvHash)
      ? `Covered by task grant ${argvHash.slice(0, 8)} — identical argv and capability set.`
      : 'Auto-approved by policy: sandboxed test-mode command.';
    run.patch(t => ({ ...t, approvals: { ...t.approvals, [approvalId]: { ...base, state: 'auto', scope: 'task', decidedAt: Date.now(), reason: why } } }));
    run.notice(why, 'neutral');
    run.showTool(id);
    return { id, allowed: true };
  }
  const previous = run.task().status;
  run.patch(t => ({ ...t, approvals: { ...t.approvals, [approvalId]: base } }));
  run.push({ kind: 'approval', id: `${approvalId}-i`, at: Date.now(), approvalId });
  run.status('awaiting_approval');
  if (settings.autoOpenContext) store.update(s => s.activeTaskId === run.taskId ? { ...s, rightTab: 'approvals', rightOpen: true } : s);
  const decision = await run.wait<{ allow: boolean; scope: GrantScope }>(approvalId);
  run.patch(t => ({
    ...t,
    approvals: { ...t.approvals, [approvalId]: { ...t.approvals[approvalId]!, state: decision.allow ? 'approved' : 'denied', scope: decision.scope, decidedAt: Date.now() } },
    grants: decision.allow && decision.scope === 'task' ? [...t.grants, argvHash] : t.grants,
  }));
  run.status(previous);
  if (!decision.allow) {
    run.updateTool(id, call => ({ ...call, state: 'denied', endedAt: Date.now(), summary: 'denied by you · not executed' }));
  } else {
    run.showTool(id);
  }
  return { id, allowed: decision.allow };
}

function testRun(cases: TestCase[], compileError?: string): { lines: Line[]; summary: string; exitCode: number; fail: boolean } {
  const lines: Line[] = [['stdout', ` RUN  v4.0.8 ~/sample-projects/ledger-api`], ['stdout', '']];
  if (compileError) {
    lines.push(
      ['stderr', ` FAIL  tests/invoice/total.test.ts [ tests/invoice/total.test.ts ]`],
      ['stderr', `Error: ${compileError}`],
      ['stderr', `  ❯ src/invoice/total.ts:2:46`],
      ['stdout', ''],
      ['stdout', ` Test Files  1 failed (1)`],
      ['stdout', `      Tests  no tests`],
      ['stdout', `   Start at  ${clock()}`],
      ['stdout', `   Duration  402ms`],
    );
    return { lines, summary: 'exit 1 · suite failed to load', exitCode: 1, fail: true };
  }
  const failed = cases.filter(test => test.state === 'fail');
  lines.push(['stdout', ` ${failed.length ? '❯' : '✓'} tests/invoice/total.test.ts (${cases.length} tests${failed.length ? ` | ${failed.length} failed` : ''}) ${cases.reduce((sum, test) => sum + test.ms, 0)}ms`]);
  for (const test of cases) {
    lines.push([test.state === 'fail' ? 'stderr' : 'stdout', `   ${test.state === 'fail' ? '×' : '✓'} computeTotals > ${test.name} ${test.ms}ms`]);
    if (test.note) lines.push(['stderr', `     → ${test.note}`]);
  }
  lines.push(['stdout', '']);
  for (const test of failed) {
    lines.push(['stderr', ` FAIL  tests/invoice/total.test.ts > computeTotals > ${test.name}`], ['stderr', `AssertionError: ${test.note}`], ['stderr', ' ❯ tests/invoice/total.test.ts:44:26'], ['stdout', '']);
  }
  lines.push(
    ['stdout', ` Test Files  ${failed.length ? '1 failed' : '1 passed'} (1)`],
    ['stdout', `      Tests  ${failed.length ? `${failed.length} failed | ` : ''}${cases.length - failed.length} passed (${cases.length})`],
    ['stdout', `   Start at  ${clock()}`],
    ['stdout', `   Duration  ${560 + cases.length * 9}ms (transform 88ms, collect 97ms, tests ${cases.reduce((sum, test) => sum + test.ms, 0)}ms)`],
  );
  return {
    lines,
    summary: failed.length ? `exit 1 · ${failed.length} failed, ${cases.length - failed.length} passed` : `exit 0 · ${cases.length} passed`,
    exitCode: failed.length ? 1 : 0,
    fail: failed.length > 0,
  };
}

function cases(names: string[], failing: Record<string, string> = {}): TestCase[] {
  return names.map((name, index) => ({ name, state: failing[name] ? 'fail' : 'pass', ms: [1, 1, 2, 1, 0, 1, 4, 1][index] ?? 1, note: failing[name] }));
}

function buildPlan(run: Run): Plan {
  return {
    id: run.id('plan'),
    summary: 'Fix per-line tax rounding in computeTotals and lock it in with a regression test.',
    steps: [
      { id: 'baseline', title: 'Run the invoice suite as a baseline', detail: 'Sandboxed test run, network denied. Needs your approval.', files: [], enabled: true, state: 'pending' },
      { id: 'minor', title: 'Move arithmetic to integer minor units', detail: 'New helper with toMinor / fromMinor and half-even rounding.', files: ['src/money/minor.ts'], enabled: true, state: 'pending' },
      { id: 'round', title: 'Round tax once per invoice', detail: 'Replace per-line toFixed rounding, as FIN-212 in the README requires.', files: ['src/invoice/total.ts'], enabled: true, state: 'pending' },
      { id: 'tests', title: 'Add regression tests', detail: 'Reproduce INC-4821 (3 × $11.45 at 8.875 %) and a fractional-price case.', files: ['tests/invoice/total.test.ts'], enabled: true, state: 'pending' },
      { id: 'changelog', title: 'Add a CHANGELOG entry', detail: 'One line under Unreleased.', files: ['CHANGELOG.md'], optional: true, enabled: true, state: 'pending' },
      { id: 'verify', title: 'Verify the fix in the sandbox', detail: 'Re-run the suite against the applied changes.', files: [], enabled: true, state: 'pending' },
    ],
  };
}

function finish(run: Run, status: TaskStatus, result: Omit<TaskResult, 'durationMs' | 'toolCalls' | 'approvals'>): void {
  run.patch(t => ({
    ...t, status,
    result: { ...result, durationMs: Date.now() - (t.startedAt ?? t.createdAt), ...attemptCounts(t) },
  }));
  run.push({ kind: 'result', id: run.id('r'), at: Date.now() });
  if (store.getState().settings.autoOpenContext) store.update(s => s.activeTaskId === run.taskId ? { ...s, rightTab: 'results', rightOpen: true } : s);
}

function runLog(task: Task): Artifact {
  const events = task.items.map((item, index) => {
    const base = { seq: index + 1, at: new Date(item.at).toISOString(), kind: item.kind, simulated: true };
    if (item.kind === 'tool') {
      const call = task.tools[item.toolCallId];
      return { ...base, tool: call?.name, target: call?.target, state: call?.state, summary: call?.summary };
    }
    if (item.kind === 'approval') {
      const approval = task.approvals[item.approvalId];
      return { ...base, approval: approval?.kind, state: approval?.state, scope: approval?.scope, argvHash: approval?.argvHash };
    }
    if (item.kind === 'notice') return { ...base, text: item.text };
    return base;
  });
  return { id: 'run-log', name: 'run-log.jsonl', kind: 'log', content: events.map(event => JSON.stringify(event)).join('\n') + '\n' };
}

async function invoiceScenario(run: Run): Promise<void> {
  const settings = () => store.getState().settings;
  run.status('planning');
  await run.say('I\'ll start by locating the invoice total calculation, the money rules in the README, and the tests that cover them.');

  await run.tool({ name: 'list_dir', risk: 'read', title: 'List directory', target: 'src/invoice', durationMs: 420,
    lines: [['stdout', 'total.ts      27 lines'], ['stdout', 'types.ts      19 lines']], summary: '2 entries' });
  await run.tool({ name: 'read_file', risk: 'read', title: 'Read file', target: 'src/invoice/total.ts', durationMs: 900,
    lines: numbered(LEDGER_FILES['src/invoice/total.ts'].before), summary: '27 lines' });
  await run.tool({ name: 'grep', risk: 'read', title: 'Search', target: 'toFixed|Math.round  src/', durationMs: 620,
    lines: [
      ['stdout', 'src/invoice/total.ts:16:    tax += Number((lineAmount * invoice.taxRate).toFixed(2));'],
      ['stdout', 'src/invoice/total.ts:21:    subtotal: Number(subtotal.toFixed(2)),'],
      ['stdout', 'src/invoice/total.ts:22:    tax: Number(tax.toFixed(2)),'],
      ['stdout', 'src/invoice/total.ts:23:    total: Number(total.toFixed(2)),'],
    ], summary: '4 matches in 1 file' });
  await run.tool({ name: 'read_file', risk: 'read', title: 'Read file', target: 'README.md', durationMs: 520,
    lines: numbered(store.getState().projects[0]!.files[0]!.content, 12), summary: '17 lines · money rules' });
  await run.tool({ name: 'read_file', risk: 'read', title: 'Read file', target: 'tests/invoice/total.test.ts', durationMs: 700,
    lines: numbered(LEDGER_FILES['tests/invoice/total.test.ts'].before, 14), summary: '36 lines · 6 tests' });

  await run.say('Found the cause. `computeTotals` rounds tax **per line** with `toFixed(2)` while summing floats. For INC-4821 (3 × $11.45 at 8.875 %), each line\'s tax of 1.0161875 rounds up to 1.02, so the invoice is charged **$3.06** tax instead of **$3.05** on a $34.35 subtotal. The README\'s money rules (FIN-212) require rounding once per invoice with banker\'s rounding.\n\nHere is my plan. Nothing will be written until you have reviewed the diff.');

  run.patch(task => ({ ...task, title: 'Fix per-line tax rounding (INC-4821)' }));
  const plan = buildPlan(run);
  run.patch(task => ({ ...task, plan }));
  run.push({ kind: 'plan', id: `${plan.id}-i`, at: Date.now(), planId: plan.id });
  run.status('awaiting_plan');
  const approved = await run.wait<boolean>('plan');
  run.patch(task => ({ ...task, plan: task.plan && { ...task.plan, decision: approved ? 'approved' : 'declined' } }));
  if (!approved) {
    run.notice('Plan declined — the run ended before any command or write.', 'warn');
    await run.say('Understood. I\'ve stopped here without running commands or proposing changes. Edit the request and send it again, or retry to get a fresh plan.');
    finish(run, 'plan_declined', {
      outcome: 'declined', headline: 'Plan declined — no actions taken', verified: true,
      bullets: ['5 read-only tool calls ran in the read adapter', 'No commands executed, no files proposed'], filesChanged: [], artifacts: [runLog(run.task())],
    });
    return;
  }
  const changelogEnabled = run.task().plan?.steps.find(step => step.id === 'changelog')?.enabled ?? false;
  if (!changelogEnabled) run.planStep('changelog', 'skipped');
  run.status('running');

  // Baseline run
  run.planStep('baseline', 'active');
  await run.say('Starting with a baseline run of the invoice suite.');
  const baselineSpec: ToolSpec = { name: 'bash', risk: 'exec', title: 'Run tests', target: TEST_ARGV.join(' '), argv: TEST_ARGV, durationMs: 1500, lines: [], summary: '' };
  const baseline = await commandGate(run, baselineSpec, 'Baseline run of the invoice suite before any change.');
  if (baseline.allowed && settings().injectSandboxFailure) {
    await run.execute(baseline.id, {
      ...baselineSpec, durationMs: 700, fail: true, exitCode: undefined, summary: 'SANDBOX_UNAVAILABLE · not executed',
      lines: [
        ['info', 'requesting OS sandbox profile exec/test-mode …'],
        ['stderr', 'SANDBOX_UNAVAILABLE: high-risk tool sandbox is not verified on this platform (P3b gate not passed).'],
        ['info', 'fail-closed: no fallback to an unsandboxed spawn'],
      ],
    });
    run.planStep('baseline', 'skipped');
    run.notice('Sandbox unavailable — the run failed closed.', 'danger', 'Injected by Settings → Simulation → "Simulate sandbox unavailable". The engine never falls back to an unsandboxed process.');
    await run.say('I can\'t run the test suite: the sandbox reported `SANDBOX_UNAVAILABLE`, and I won\'t fall back to running it outside the sandbox. Turn off the failure injection in Settings → Simulation, then retry.');
    finish(run, 'failed', {
      outcome: 'failed', headline: 'Failed closed: sandbox unavailable', verified: true,
      bullets: ['Test command was never started', 'No changes proposed or written'], filesChanged: [], artifacts: [runLog(run.task())],
    });
    return;
  }
  if (baseline.allowed) {
    const base = testRun(cases(BASE_CASES));
    await run.execute(baseline.id, { ...baselineSpec, ...base });
    run.planStep('baseline', 'done');
    await run.say('Baseline is green (6 / 6), so the defect isn\'t covered by any test. Drafting the fix and the regression tests now.');
  } else {
    run.planStep('baseline', 'skipped');
    run.notice('Baseline skipped — command denied.', 'warn');
    await run.say('Skipping the baseline run. I\'ll draft the fix from the code alone.');
  }

  // Proposals — staged in a review buffer, nothing applied yet.
  const proposals: Array<{ step: string; path: keyof typeof LEDGER_FILES; rationale: string }> = [
    { step: 'minor', path: 'src/money/minor.ts', rationale: 'Keeps arithmetic in integer cents and adds half-even rounding.' },
    { step: 'round', path: 'src/invoice/total.ts', rationale: 'Rounds tax once on the invoice subtotal instead of per line.' },
    { step: 'tests', path: 'tests/invoice/total.test.ts', rationale: 'Reproduces INC-4821 and guards fractional-price precision.' },
  ];
  if (changelogEnabled) proposals.push({ step: 'changelog', path: 'CHANGELOG.md', rationale: 'Documents the customer-visible fix.' });

  const files: FileChange[] = [];
  for (const proposal of proposals) {
    run.planStep(proposal.step, 'active');
    const { before, after } = LEDGER_FILES[proposal.path];
    const stats = diffStats(before, after);
    await run.tool({
      name: 'write_file', risk: 'write', title: before ? 'Propose edit' : 'Propose new file', target: proposal.path, durationMs: 650,
      lines: [['info', `staged +${stats.added} −${stats.removed} in review buffer · not written`]],
      summary: `+${stats.added} −${stats.removed} · held for review`,
    });
    files.push({ path: proposal.path, kind: before ? 'modified' : 'added', before, after, rationale: proposal.rationale, include: true });
    run.planStep(proposal.step, 'pending');
  }

  const changes: ChangeSet = { id: run.id('cs'), files };
  const approvalId = run.id('ap');
  const approval: Approval = {
    id: approvalId, kind: 'changes', changeSetId: changes.id, title: `Apply ${files.length} file changes`,
    reason: 'Writes are staged in a review buffer. Choose which files to apply.', state: 'pending',
    capabilities: [
      { label: 'Writes', value: `${files.length} files inside the workspace`, tone: 'ok' },
      { label: 'Deletes', value: 'None', tone: 'ok' },
      { label: '.git', value: 'Untouched', tone: 'deny' },
      { label: 'Target', value: 'Simulated overlay — real files are never written', tone: 'warn' },
    ],
  };
  run.patch(task => ({ ...task, changes }));
  await run.say(`I've drafted ${files.length} changes. Review the diff — you can exclude individual files before applying.`);
  run.patch(task => ({ ...task, approvals: { ...task.approvals, [approvalId]: approval } }));
  run.push({ kind: 'approval', id: `${approvalId}-i`, at: Date.now(), approvalId });
  run.status('awaiting_approval');
  if (settings().autoOpenContext) store.update(s => s.activeTaskId === run.taskId ? { ...s, rightTab: 'changes', rightOpen: true } : s);

  const apply = await run.wait<boolean>(changes.id);
  const included = run.task().changes!.files.filter(file => file.include);
  if (!apply || included.length === 0) {
    run.patch(task => ({
      ...task,
      changes: task.changes && { ...task.changes, decision: 'rejected', appliedPaths: [] },
      approvals: { ...task.approvals, [approvalId]: { ...task.approvals[approvalId]!, state: 'denied', decidedAt: Date.now() } },
      plan: task.plan && { ...task.plan, steps: task.plan.steps.map(step => step.id === 'baseline' ? step : { ...step, state: 'skipped' }) },
    }));
    run.notice('Changes rejected — the review buffer was discarded.', 'warn', 'No file in the workspace was modified.');
    await run.say('Got it — I discarded the proposed changes. The workspace is exactly as it was. Retry if you\'d like a different approach.');
    finish(run, 'changes_rejected', {
      outcome: 'rejected', headline: 'Changes rejected — workspace untouched', verified: true,
      bullets: [`${files.length} proposed files discarded`, 'Baseline test results kept for reference'], filesChanged: [], artifacts: [runLog(run.task())],
    });
    return;
  }

  for (const proposal of proposals) run.planStep(proposal.step, included.some(file => file.path === proposal.path) ? 'done' : 'skipped');
  run.patch(task => ({
    ...task,
    approvals: { ...task.approvals, [approvalId]: { ...task.approvals[approvalId]!, state: 'approved', scope: 'once', decidedAt: Date.now() } },
  }));
  run.status('applying');
  const patchLines: Line[] = included.map(file => {
    const stats = diffStats(file.before, file.after);
    return ['stdout', `${file.kind === 'added' ? 'A' : 'M'}  ${file.path}  +${stats.added} −${stats.removed}`];
  });
  patchLines.push(['info', 'written to simulated workspace overlay · real files untouched']);
  await run.tool({ name: 'apply_patch', risk: 'write', title: 'Apply changes', target: `${included.length} files`, durationMs: 700, lines: patchLines, summary: `${included.length} files applied (simulated)` });
  const appliedPaths = included.map(file => file.path);
  run.patch(task => ({ ...task, changes: task.changes && { ...task.changes, decision: 'applied', appliedPaths } }));
  store.update(state => ({
    ...state,
    overlay: { ...state.overlay, [DEMO_PROJECT_ID]: { ...state.overlay[DEMO_PROJECT_ID], ...Object.fromEntries(included.map(file => [file.path, file.after])) } },
  }));

  // Verification
  run.planStep('verify', 'active');
  run.status('verifying');
  await run.say('Changes applied. Re-running the suite to verify.');
  const has = (path: string): boolean => appliedPaths.includes(path);
  const verifySpec: ToolSpec = { ...baselineSpec, title: 'Verify tests' };
  const verify = await commandGate(run, verifySpec, 'Verification run against the applied changes.');
  let testCases: TestCase[] = [];
  let outcome: TaskResult['outcome'] = 'success';
  let headline = 'INC-4821 fixed — tax rounds once per invoice';
  let message = 'Done. Tax is now computed once on the invoice subtotal in integer cents with half-even rounding, and two regression tests lock the behaviour in. All 8 invoice tests pass.';
  const bullets: string[] = [];
  let verified = false;
  if (!verify.allowed) {
    run.planStep('verify', 'skipped');
    outcome = 'partial';
    headline = 'Changes applied — not verified';
    message = 'Changes are applied, but I didn\'t run the verification because the command was denied. Run the suite before merging.';
    bullets.push('Verification command denied');
  } else {
    let compileError: string | undefined;
    if (has('src/invoice/total.ts') && !has('src/money/minor.ts')) compileError = 'Failed to resolve import "../money/minor" from "src/invoice/total.ts". Does the file exist?';
    const names = has('tests/invoice/total.test.ts') ? [...BASE_CASES, ...NEW_CASES] : BASE_CASES;
    const failing = !has('src/invoice/total.ts') && has('tests/invoice/total.test.ts') ? { [NEW_CASES[0]!]: 'expected 3.06 to be 3.05 // Object.is equality' } : {};
    testCases = compileError ? [] : cases(names, failing);
    const result = testRun(testCases, compileError);
    await run.execute(verify.id, { ...verifySpec, ...result });
    verified = !result.fail;
    run.planStep('verify', result.fail ? 'skipped' : 'done');
    if (compileError) {
      outcome = 'partial'; headline = 'Applied partially — suite fails to compile';
      message = '`total.ts` now imports `src/money/minor.ts`, which was excluded, so the suite no longer compiles. Retry and include the helper, or revert `total.ts`.';
      bullets.push('src/money/minor.ts was excluded but is required');
    } else if (result.fail) {
      outcome = 'partial'; headline = 'Regression test fails — fix not applied';
      message = 'The new regression test fails because the fix in `total.ts` was excluded. The test now documents the bug; include `total.ts` to fix it.';
      bullets.push('src/invoice/total.ts was excluded');
    } else if (!has('src/invoice/total.ts')) {
      outcome = 'partial'; headline = 'Supporting files applied — defect not fixed';
      message = 'Only supporting files were applied, so INC-4821 is still present. The existing suite passes.';
      bullets.push('src/invoice/total.ts was excluded');
    } else if (!has('tests/invoice/total.test.ts')) {
      outcome = 'partial'; headline = 'Fix applied — regression test excluded';
      message = 'The fix is applied and the existing 6 tests pass, but without the regression test INC-4821 could silently return.';
      bullets.push('Regression tests were excluded');
    }
  }
  if (outcome === 'success') bullets.push('Tax rounded once per invoice (FIN-212)', 'Arithmetic in integer minor units', '2 regression tests added');
  bullets.push(`${appliedPaths.length} of ${files.length} proposed files applied to the simulated workspace`);

  await run.say(message);
  const filesChanged = included.map(file => ({ path: file.path, kind: file.kind, ...diffStats(file.before, file.after) }));
  const artifacts: Artifact[] = [{ id: 'patch', name: 'changes.patch', kind: 'patch', content: unifiedPatch(included) }];
  if (testCases.length) {
    artifacts.push({ id: 'report', name: 'test-report.txt', kind: 'report', content: run.task().tools[verify.id]!.output.map(line => line.text).join('\n') + '\n' });
  }
  artifacts.push(runLog(run.task()));
  finish(run, outcome === 'success' ? 'completed' : 'completed_with_issues', {
    outcome, headline, bullets, filesChanged, verified, artifacts,
    tests: testCases.length ? {
      passed: testCases.filter(test => test.state === 'pass').length,
      failed: testCases.filter(test => test.state === 'fail').length,
      skipped: 0, cases: testCases,
    } : undefined,
  });
}

async function start(taskId: string): Promise<void> {
  const task = store.task(taskId)!;
  const run = new Run(taskId, task.attempt);
  runs.set(taskId, run);
  try {
    await invoiceScenario(run);
  } catch (error) {
    if (!(error instanceof Aborted)) {
      console.error(error);
      store.updateTask(taskId, t => ({
        ...t, status: 'failed',
        items: [...t.items, { kind: 'notice', id: `${taskId}-err-${Date.now()}`, at: Date.now(), tone: 'danger', text: 'Simulation error', detail: String(error) }],
      }));
    }
  } finally {
    if (runs.get(taskId) === run && !run.signal.aborted) runs.delete(taskId);
  }
}

function plainSleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms / store.getState().settings.speed));
}

function deriveTitle(prompt: string): string {
  const firstSentence = prompt.split(/(?<=[.!?])\s/)[0] ?? prompt;
  const clean = firstSentence.replace(/\s+/g, ' ').trim();
  return clean.length > 64 ? clean.slice(0, 61).trimEnd() + '…' : clean;
}

export const engine = {
  /** Starts the scripted run. Only one simulated run may be active; returns null otherwise. */
  createTask(prompt: string): string | null {
    if (store.getState().tasks.some(task => isActive(task))) return null;
    const now = Date.now();
    const id = `task-${now.toString(36)}-${(++taskCounter).toString(36)}`;
    const items: TimelineItem[] = [{ kind: 'user', id: `${id}-u1`, at: now, text: prompt }];
    const leftover = Object.keys(store.getState().overlay[DEMO_PROJECT_ID] ?? {});
    if (leftover.length) {
      items.push({
        kind: 'notice', id: `${id}-baseline`, at: now, tone: 'neutral',
        text: `Simulated workspace restored to the sample baseline (${leftover.length} earlier simulated edit${leftover.length > 1 ? 's' : ''} cleared).`,
        detail: 'The scripted scenario always starts from the original sample files. Only the in-memory overlay is affected.',
      });
    }
    const task: Task = {
      id, projectId: DEMO_PROJECT_ID, title: deriveTitle(prompt), prompt, scenario: 'invoice-rounding',
      createdAt: now, updatedAt: now, startedAt: now, status: 'planning', attempt: 1, cursor: 0, grants: [],
      items, tools: {}, approvals: {},
    };
    store.update(state => ({
      ...state, tasks: [task, ...state.tasks], activeTaskId: id, activeProjectId: DEMO_PROJECT_ID, rightTab: 'files',
      selectedFile: 'src/invoice/total.ts', selectedArtifact: null, overlay: { ...state.overlay, [DEMO_PROJECT_ID]: {} },
    }));
    void start(id);
    return id;
  },

  isRunning(taskId: string): boolean {
    return runs.has(taskId);
  },

  decidePlan(taskId: string, approve: boolean): void {
    const run = runs.get(taskId);
    if (run?.gate?.key === 'plan') run.gate.resolve(approve);
  },

  togglePlanStep(taskId: string, stepId: string): void {
    store.updateTask(taskId, task => task.plan && !task.plan.decision ? {
      ...task, plan: { ...task.plan, steps: task.plan.steps.map(step => step.id === stepId && step.optional ? { ...step, enabled: !step.enabled } : step) },
    } : task);
  },

  decideCommand(taskId: string, approvalId: string, allow: boolean, scope: GrantScope): void {
    const run = runs.get(taskId);
    if (run?.gate?.key === approvalId) run.gate.resolve({ allow, scope });
  },

  toggleChangeFile(taskId: string, path: string): void {
    store.updateTask(taskId, task => task.changes && !task.changes.decision ? {
      ...task, changes: { ...task.changes, files: task.changes.files.map(file => file.path === path ? { ...file, include: !file.include } : file) },
    } : task);
  },

  decideChanges(taskId: string, apply: boolean): void {
    const run = runs.get(taskId);
    const changeSetId = store.task(taskId)?.changes?.id;
    if (changeSetId && run?.gate?.key === changeSetId) run.gate.resolve(apply);
  },

  /**
   * STOPPING → no new operations → cancel in-flight tool (graceful terminate, then
   * forced after the grace period) → verify side effects → STOPPED.
   */
  async stop(taskId: string): Promise<void> {
    const run = runs.get(taskId);
    const task = store.task(taskId);
    if (!run || !task || task.status === 'stopping' || !isActive(task)) return;
    const graceMs = store.getState().settings.graceMs;
    const stoppedAt: Partial<Record<TaskStatus, string>> = {
      planning: 'Stopped while exploring the codebase', awaiting_plan: 'Stopped during plan review',
      awaiting_approval: 'Stopped while waiting for your approval', running: 'Stopped between steps',
      applying: 'Stopped while applying changes', verifying: 'Stopped during verification',
    };
    const idleReason = stoppedAt[task.status] ?? 'No tool was running';
    const activeToolId = run.activeToolId;
    const streamingId = run.streamingItemId;
    store.updateTask(taskId, t => ({
      ...t, status: 'stopping',
      stop: { requestedAt: Date.now(), graceMs, phase: 'draining', cancelledTool: activeToolId && t.tools[activeToolId]?.target, sideEffects: '' },
      items: [...t.items, { kind: 'notice', id: `${taskId}-stop-${Date.now()}`, at: Date.now(), tone: 'warn', text: 'Stop requested — no new operations will be dispatched.' }],
    }));
    run.controller.abort();

    await plainSleep(450);
    if (!store.task(taskId)) return;
    store.updateTask(taskId, t => ({
      ...t,
      stop: t.stop && { ...t.stop, phase: 'terminating' },
      items: t.items.map(item => item.id === streamingId && item.kind === 'agent' ? { ...item, streaming: false, text: item.text + ' …' } : item),
      approvals: Object.fromEntries(Object.entries(t.approvals).map(([id, approval]) => [id, approval.state === 'pending' ? { ...approval, state: 'expired' as const } : approval])),
      tools: Object.fromEntries(Object.entries(t.tools).map(([id, call]) => {
        if (call.state === 'awaiting_approval') return [id, { ...call, state: 'skipped' as const, summary: 'not started · stop requested' }];
        if (call.state !== 'running') return [id, call];
        const seq = (call.output.at(-1)?.seq ?? 0) + 1;
        return [id, { ...call, output: [...call.output, { seq, stream: 'info' as const, text: `graceful terminate sent to process tree (grace ${graceMs / 1000}s)` }] }];
      })),
    }));
    await plainSleep(650);
    if (!store.task(taskId)) return;
    store.updateTask(taskId, t => ({
      ...t,
      stop: t.stop && { ...t.stop, phase: 'verifying' },
      tools: Object.fromEntries(Object.entries(t.tools).map(([id, call]) => {
        if (call.state !== 'running') return [id, call];
        const seq = (call.output.at(-1)?.seq ?? 0) + 1;
        return [id, { ...call, state: 'cancelled' as const, endedAt: Date.now(), summary: 'cancelled · exited within grace',
          output: [...call.output, { seq, stream: 'info' as const, text: 'process tree exited after 0.6s · no forced kill needed' }] }];
      })),
    }));
    await plainSleep(600);
    const latest = store.task(taskId);
    if (!latest) return;
    const applied = latest.changes?.appliedPaths ?? [];
    const sideEffects = applied.length
      ? `${applied.length} file(s) had already been applied to the simulated workspace and were kept: ${applied.join(', ')}.`
      : 'No workspace writes. Proposed changes (if any) were discarded.';
    store.updateTask(taskId, t => ({
      ...t, status: 'stopped',
      stop: t.stop && { ...t.stop, phase: 'done', sideEffects },
      plan: t.plan && { ...t.plan, steps: t.plan.steps.map(step => step.state === 'active' || step.state === 'pending' ? { ...step, state: 'skipped' } : step) },
      items: [...t.items, { kind: 'notice', id: `${taskId}-stopped-${Date.now()}`, at: Date.now(), tone: 'ok', text: 'Stopped · side effects verified', detail: sideEffects }],
      result: {
        outcome: 'stopped', headline: applied.length ? 'Stopped after applying changes' : 'Stopped — workspace untouched', verified: true,
        bullets: [activeToolId ? `Cancelled ${t.tools[activeToolId]?.title.toLowerCase()} on ${t.tools[activeToolId]?.target}` : idleReason, sideEffects],
        filesChanged: (t.changes?.files ?? []).filter(file => applied.includes(file.path)).map(file => ({ path: file.path, kind: file.kind, ...diffStats(file.before, file.after) })),
        durationMs: Date.now() - (t.startedAt ?? t.createdAt), ...attemptCounts(t),
        artifacts: [runLog(t)],
      },
    }));
    store.updateTask(taskId, t => ({ ...t, items: [...t.items, { kind: 'result', id: `${taskId}-stop-r-${Date.now()}`, at: Date.now() }] }));
    runs.delete(taskId);
  },

  /** Used by "Reset demo": abandons every simulated run without writing further events. */
  abortAll(): void {
    for (const run of runs.values()) run.controller.abort();
    runs.clear();
  },

  retry(taskId: string): void {
    const task = store.task(taskId);
    if (!task || runs.has(taskId) || !RETRYABLE_STATUSES.includes(task.status) || task.readOnlyHistory) return;
    const now = Date.now();
    const reverted = task.changes?.appliedPaths ?? [];
    if (reverted.length) {
      store.update(state => {
        const overlay = { ...state.overlay[task.projectId] };
        for (const path of reverted) delete overlay[path];
        return { ...state, overlay: { ...state.overlay, [task.projectId]: overlay } };
      });
    }
    const attempt = task.attempt + 1;
    const items: TimelineItem[] = [...task.items, { kind: 'attempt', id: `${taskId}-att-${attempt}`, at: now, attempt }];
    if (reverted.length) {
      items.push({ kind: 'notice', id: `${taskId}-rev-${attempt}`, at: now, tone: 'neutral', text: `Reverted ${reverted.length} simulated file(s) from attempt ${task.attempt} before retrying.`, detail: 'Only the in-memory overlay is affected.' });
    }
    store.updateTask(taskId, t => ({
      ...t, attempt, items, status: 'planning', plan: undefined, changes: undefined, result: undefined, stop: undefined,
      cursor: 0, grants: [], startedAt: now,
    }));
    store.update(state => ({ ...state, rightTab: 'files' }));
    void start(taskId);
  },
};
