import type { Task, TimelineItem, ToolCall, TaskResult } from '../types';

// Seeded, read-only history so the sidebar feels like a workspace that has been used.
// Timestamps are relative to "now" so the list always reads as recent.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Seed {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  ago: number;
  durationMs: number;
  status: Task['status'];
  reply: string;
  tools: Array<Pick<ToolCall, 'name' | 'risk' | 'title' | 'target' | 'summary'> & { state?: ToolCall['state'] }>;
  result: Omit<TaskResult, 'durationMs' | 'toolCalls' | 'approvals' | 'artifacts'> & { approvals?: number };
  notice?: { text: string; tone: 'neutral' | 'warn' | 'danger' | 'ok'; detail?: string };
}

const SEEDS: Seed[] = [
  {
    id: 'hist-ledger-1', projectId: 'ledger-api', ago: 3 * HOUR, durationMs: 4 * MIN + 12_000, status: 'completed',
    title: 'Return 422 for invoices without lines',
    prompt: 'POST /invoices/totals crashes with an empty lines array. Return a 422 with a stable error code instead.',
    reply: 'Added an explicit guard in the totals route that returns `422 NO_LINES`, plus a route test. The calculation itself already handled empty arrays; the crash came from the PDF preview hook.',
    tools: [
      { name: 'read_file', risk: 'read', title: 'Read file', target: 'src/routes/invoices.ts', summary: '11 lines' },
      { name: 'grep', risk: 'read', title: 'Search', target: 'lines.length', summary: '2 matches' },
      { name: 'write_file', risk: 'write', title: 'Edit file', target: 'src/routes/invoices.ts', summary: 'applied after review' },
      { name: 'bash', risk: 'exec', title: 'Run tests', target: 'pnpm vitest run tests/routes', summary: 'exit 0 · 12 passed' },
    ],
    result: {
      outcome: 'success', headline: 'Empty invoices now return 422 NO_LINES', verified: true,
      bullets: ['Guard added before computeTotals', 'Route test covers the empty-lines case'],
      filesChanged: [{ path: 'src/routes/invoices.ts', added: 1, removed: 0, kind: 'modified' }, { path: 'tests/routes/invoices.test.ts', added: 9, removed: 0, kind: 'modified' }],
      tests: { passed: 12, failed: 0, skipped: 0, cases: [] }, approvals: 2,
    },
  },
  {
    id: 'hist-ledger-2', projectId: 'ledger-api', ago: 1 * DAY + 2 * HOUR, durationMs: 1 * MIN + 40_000, status: 'stopped',
    title: 'Upgrade fastify to 5.6',
    prompt: 'Upgrade fastify to the latest 5.x and fix any type errors.',
    reply: 'Stopped before installing. The lockfile was not modified.',
    tools: [
      { name: 'read_file', risk: 'read', title: 'Read file', target: 'package.json', summary: '22 lines' },
      { name: 'bash', risk: 'exec', title: 'Install dependencies', target: 'pnpm install fastify@5.6.1', summary: 'cancelled by user', state: 'cancelled' },
    ],
    notice: { text: 'Stopped by user · process tree reclaimed after graceful terminate', tone: 'warn', detail: 'Side effects verified: no workspace writes.' },
    result: { outcome: 'stopped', headline: 'Stopped before install — no changes', verified: true, bullets: ['Build-mode install was never granted', 'Workspace unchanged'], filesChanged: [] },
  },
  {
    id: 'hist-ledger-3', projectId: 'ledger-api', ago: 3 * DAY, durationMs: 6 * MIN, status: 'changes_rejected',
    title: 'Refactor payment retries into a queue',
    prompt: 'Move payment retry logic out of the webhook handler into a background queue.',
    reply: 'The proposal was rejected during review, so nothing was written. Notes from the plan are kept below for reference.',
    tools: [
      { name: 'list_dir', risk: 'read', title: 'List directory', target: 'src/payments', summary: '6 entries' },
      { name: 'read_file', risk: 'read', title: 'Read file', target: 'src/payments/webhook.ts', summary: '148 lines' },
      { name: 'write_file', risk: 'write', title: 'Propose file', target: 'src/payments/retry-queue.ts', summary: 'rejected in review', state: 'denied' },
    ],
    result: { outcome: 'rejected', headline: 'Changes rejected in review — workspace untouched', verified: true, bullets: ['5 proposed files discarded'], filesChanged: [], approvals: 1 },
  },
  {
    id: 'hist-atlas-1', projectId: 'atlas-web', ago: 5 * HOUR, durationMs: 3 * MIN + 5_000, status: 'completed',
    title: 'Add 7-day range to usage chart',
    prompt: 'Let users switch the usage chart between 7 and 30 days.',
    reply: 'Added a segmented control and threaded the range through to `UsageChart`. Snapshot tests updated.',
    tools: [
      { name: 'read_file', risk: 'read', title: 'Read file', target: 'src/charts/UsageChart.tsx', summary: '3 lines' },
      { name: 'write_file', risk: 'write', title: 'Edit file', target: 'src/App.tsx', summary: 'applied after review' },
      { name: 'bash', risk: 'exec', title: 'Run tests', target: 'pnpm vitest run', summary: 'exit 0 · 31 passed' },
    ],
    result: {
      outcome: 'success', headline: 'Usage chart supports 7d and 30d', verified: true, bullets: ['Range control added'],
      filesChanged: [{ path: 'src/App.tsx', added: 6, removed: 1, kind: 'modified' }], tests: { passed: 31, failed: 0, skipped: 0, cases: [] }, approvals: 2,
    },
  },
  {
    id: 'hist-ops-1', projectId: 'ops-runbooks', ago: 2 * DAY, durationMs: 50_000, status: 'completed',
    title: 'Summarise last week’s latency pages',
    prompt: 'Summarise the ledger latency pages from last week into the runbook.',
    reply: 'Read-only task: drafted a summary in the conversation. No files were changed.',
    tools: [{ name: 'read_file', risk: 'read', title: 'Read file', target: 'runbooks/ledger-latency.md', summary: '4 lines' }],
    result: { outcome: 'success', headline: 'Summary drafted (read-only)', verified: true, bullets: ['No writes requested'], filesChanged: [] },
  },
];

const ISOLATION: Record<ToolCall['risk'], string> = {
  read: 'Read adapter',
  exec: 'OS sandbox',
  write: 'OS sandbox',
};

export function seedHistory(): Task[] {
  const now = Date.now();
  return SEEDS.map(seed => {
    const start = now - seed.ago - seed.durationMs;
    const tools: Record<string, ToolCall> = {};
    const items: TimelineItem[] = [{ kind: 'user', id: `${seed.id}-u`, at: start, text: seed.prompt }];
    const step = seed.durationMs / (seed.tools.length + 2);
    seed.tools.forEach((tool, index) => {
      const id = `${seed.id}-t${index}`;
      const at = start + step * (index + 1);
      tools[id] = {
        id, name: tool.name, risk: tool.risk, title: tool.title, target: tool.target, summary: tool.summary,
        isolation: ISOLATION[tool.risk], state: tool.state ?? 'done', startedAt: at, endedAt: at + step * 0.6, output: [],
      };
      items.push({ kind: 'tool', id: `${id}-i`, at, toolCallId: id });
    });
    if (seed.notice) items.push({ kind: 'notice', id: `${seed.id}-n`, at: now - seed.ago - 1000, ...seed.notice });
    items.push({ kind: 'agent', id: `${seed.id}-a`, at: now - seed.ago, text: seed.reply });
    items.push({ kind: 'result', id: `${seed.id}-r`, at: now - seed.ago });
    const { approvals, ...result } = seed.result;
    return {
      id: seed.id, projectId: seed.projectId, title: seed.title, prompt: seed.prompt, scenario: 'history',
      createdAt: start, updatedAt: now - seed.ago, status: seed.status, attempt: 1, items, tools, approvals: {},
      cursor: 0, grants: [], startedAt: start, readOnlyHistory: true,
      result: { ...result, durationMs: seed.durationMs, toolCalls: seed.tools.length, approvals: approvals ?? 0, artifacts: [] },
    } satisfies Task;
  });
}
