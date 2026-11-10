import { randomUUID } from 'node:crypto';
import { AGENT_RUN_LIMITS, AgentToolNameSchema, ListDirectoryArgsSchema, ReadFileArgsSchema } from '@operation-agent/contracts';
import type { AgentFinishOutcome, AgentFinishReason, AgentToolName, ClaudeModel, Project, RpcRequest, TaskSnapshot, TaskState,
  TurnOutcome } from '@operation-agent/contracts';
import type { CredentialService } from '../credentials/service.js';
import type { TaskLog } from '../persistence/tasks.js';
import type { TurnGateway } from '../models/turns.js';
import type { ToolRouter } from '../tools/router.js';
import { Conversation } from './conversation.js';
import type { LiveFeed } from './live.js';
import { formatListResult, formatReadResult, skippedResult } from './tool-results.js';
import type { FormattedToolResult } from './tool-results.js';

// Express Task Runner (ARCHITECTURE §4.1 TaskService, §6, §8). Express owns the task: its state machine, conversation,
// credentials, model turns, tool execution and audit. The isolated Worker drives the loop through four requests and is
// trusted with nothing: every request is checked against the task's own record, tools run from Express's copy of the
// model's call (never the Worker's), and a lost Worker interrupts its task instead of being reconnected.

/** Express's end of a session with an agent-capable Worker. */
export interface AgentWorkerLink {
  run(params: { taskId: string; tools: AgentToolName[]; maxTurns: number }): Promise<void>;
  cancel(taskId: string): Promise<boolean>;
}
export interface TaskRunnerStore extends TaskLog { getProject(id: string): Project | null }
export interface TaskRunnerOptions {
  store: TaskRunnerStore;
  credentials: CredentialService;
  gateway: TurnGateway;
  tools: ToolRouter;
  model: () => ClaudeModel;
  live: LiveFeed;
  stopGraceMs: () => number;
}
export type RunnerReply = { kind: string; [key: string]: unknown } | null;

const AGENT_TOOLS: AgentToolName[] = [...AgentToolNameSchema.options];
const READ_ONLY = 'Read-only task: no files were changed';
const REASONS: Readonly<Record<AgentFinishReason, string>> = Object.freeze({
  end_turn: 'Completed', max_tokens: 'The answer reached the output limit and may be incomplete',
  refusal: 'The model declined this request', context_exhausted: 'The conversation exceeded the model context window',
  turn_limit: `Stopped after ${AGENT_RUN_LIMITS.maxTurns} model turns`, model_failed: 'The model request failed',
  cancelled: 'Cancelled', protocol_error: 'The agent worker stopped responding correctly', other: 'The model stopped unexpectedly',
});

export function systemPrompt(project: Project): string {
  return [
    `You are OperationAgent, a careful assistant that answers questions about the user's software project "${project.name}".`,
    'You can only read the project: use list_directory to explore it and read_file to read text files. You cannot modify files, run commands or use the network.',
    'Paths are relative to the project root and use / separators; start with list_directory on "." when you do not know the layout.',
    'Some paths are deliberately unreadable (secrets, keys, .env files, .git internals, anything outside the project). When a tool refuses, accept it and do not look for another way in.',
    'Base your answer on what you actually read, name the files you relied on, and say plainly when the project does not contain the answer.',
  ].join('\n');
}

interface Run {
  taskId: string;
  project: Project;
  model: ClaudeModel;
  tools: AgentToolName[];
  conversation: Conversation;
  turn: number;
  abort: AbortController | undefined;
  /** At most one Worker request acts on a task at a time: a model turn, or that turn's tool calls (each at most once). */
  modelInFlight: boolean;
  activeTools: Set<string>;
  stopping: boolean;
  done: boolean;
  finished: Promise<void>;
  settle(): void;
}

export class TaskRunner {
  private readonly runs = new Map<string, Run>();
  private link: AgentWorkerLink | undefined;
  constructor(private readonly options: TaskRunnerOptions) {}

  get busy(): boolean { return this.runs.size > 0; }
  get available(): boolean { return this.link !== undefined; }
  activeTask(): string | null { return this.runs.keys().next().value ?? null; }

  attach(link: AgentWorkerLink): void { this.link = link; }
  /** The Worker is gone (exit, crash, failed session). Its tasks are interrupted; nothing reconnects to them (SEC-17). */
  detach(reason = 'The agent worker exited'): void {
    this.link = undefined;
    for (const run of [...this.runs.values()]) this.end(run, 'INTERRUPTED', reason);
  }

  private transition(taskId: string, to: TaskState, reason: string | null, extra: { cleanupConfirmed?: boolean } = {}): TaskSnapshot {
    return this.options.store.transitionTask(taskId, to, { requestId: randomUUID(), sideEffects: to === 'COMPLETED' || to === 'FAILED' ||
      to === 'STOPPED' || to === 'INTERRUPTED' ? 'VERIFIED' : null, reason, ...extra }).task;
  }
  private end(run: Run, to: TaskState, reason: string | null): void {
    if (run.done) return;
    run.done = true;
    run.abort?.abort();
    run.conversation.close();
    try { this.transition(run.taskId, to, reason ? `${reason}. ${READ_ONLY}` : READ_ONLY, to === 'STOPPED' ? { cleanupConfirmed: true } : {}); }
    finally {
      this.runs.delete(run.taskId);
      this.options.live.finish(run.taskId);
      run.settle();
    }
  }

  /** Creates and starts a task. Throws NOT_FOUND, VALIDATION_ERROR, MODEL_NOT_CONFIGURED, AGENT_BUSY or WORKER_ISOLATION_UNAVAILABLE. */
  async start(projectId: string, prompt: string, requestId: string): Promise<TaskSnapshot> {
    if (!prompt.trim() || prompt.length > AGENT_RUN_LIMITS.maxPromptChars) throw new Error('VALIDATION_ERROR');
    // A retried request (same id) returns the task it already created, whatever the runner is doing now.
    const prior = this.options.store.taskForRequest(requestId);
    if (prior) {
      if (prior.projectId !== projectId) throw new Error('VALIDATION_ERROR');
      return prior;
    }
    const project = this.options.store.getProject(projectId);
    if (!project) throw new Error('NOT_FOUND');
    const link = this.link;
    if (!link) throw new Error('WORKER_ISOLATION_UNAVAILABLE');
    if (!this.options.credentials.status().configured) throw new Error('MODEL_NOT_CONFIGURED');
    if (this.busy) throw new Error('AGENT_BUSY');
    const created = this.options.store.createTask(projectId, requestId);
    // A repeated request id returns the committed task without starting it again.
    if (created.task.state !== 'CREATED' || this.runs.has(created.task.id)) return created.task;
    const taskId = created.task.id;
    let settle!: () => void;
    const run: Run = { taskId, project, model: this.options.model(), tools: AGENT_TOOLS, conversation: new Conversation(systemPrompt(project), prompt),
      turn: 0, abort: undefined, modelInFlight: false, activeTools: new Set(), stopping: false, done: false, finished: new Promise(resolve => { settle = resolve; }), settle: () => settle() };
    this.runs.set(taskId, run);
    this.transition(taskId, 'QUEUED', null);
    const message = this.options.store.addTaskMessage(taskId, 'user', 0, prompt);
    this.options.store.appendAgentEvent(taskId, 'user_message', { messageId: message.id, chars: prompt.length });
    this.transition(taskId, 'RUNNING', null);
    try { await link.run({ taskId, tools: run.tools, maxTurns: AGENT_RUN_LIMITS.maxTurns }); }
    catch { this.end(run, 'FAILED', 'The agent worker did not accept the task'); }
    return this.options.store.getTask(taskId)!;
  }

  /** User stop (ARCHITECTURE §8.2): STOPPING, abort the model stream, cancel the loop, and confirm within the grace period. */
  async stop(taskId: string): Promise<TaskSnapshot> {
    const run = this.runs.get(taskId);
    if (!run) {
      if (!this.options.store.getTask(taskId)) throw new Error('NOT_FOUND');
      throw new Error('INVALID_TRANSITION');
    }
    if (!run.stopping) {
      run.stopping = true;
      this.transition(taskId, 'STOPPING', 'Stop requested');
      run.abort?.abort();
      void this.link?.cancel(taskId).catch(() => false);
    }
    const grace = this.options.stopGraceMs();
    let timer: NodeJS.Timeout | undefined;
    const confirmed = await Promise.race([run.finished.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), grace); })]);
    clearTimeout(timer);
    // No confirmation from the Worker: the loop may still be alive, so the task is interrupted, never shown as stopped.
    if (!confirmed) this.end(run, 'INTERRUPTED', 'The agent worker did not confirm the stop in time');
    return this.options.store.getTask(taskId)!;
  }

  /** Handles one Worker → Express request; null means refuse it (the session answers VALIDATION_ERROR). */
  async handle(request: RpcRequest): Promise<RunnerReply> {
    switch (request.method) {
      case 'model.turn': return this.modelTurn(request.params.taskId, request.params.turn);
      case 'tool.call': return this.toolCall(request.params.taskId, request.params.turn, request.params.toolCallId);
      case 'agent.finish': return this.finish(request.params.taskId, request.params.outcome, request.params.reason);
      default: return null;
    }
  }

  private async modelTurn(taskId: string, turn: number): Promise<RunnerReply> {
    const run = this.runs.get(taskId);
    // Turns are strictly sequential: never while another turn or any of the previous turn's tool calls is running.
    if (!run || run.done || turn !== run.turn + 1 || run.modelInFlight || run.activeTools.size) return null;
    run.turn = turn;
    run.modelInFlight = true;
    try { return await this.runModelTurn(run, taskId, turn); }
    finally { run.modelInFlight = false; }
  }

  private async runModelTurn(run: Run, taskId: string, turn: number): Promise<RunnerReply> {
    const failed = (code: Extract<TurnOutcome, { status: 'failed' }>['code'], retryable = false): RunnerReply =>
      ({ kind: 'model.turn', outcome: { status: 'failed', code, retryable, httpStatus: null } });
    if (run.stopping) return failed('cancelled');
    if (run.conversation.status === 'awaiting_tools') run.conversation.closeRound();
    const abort = new AbortController(); run.abort = abort;
    const used = await this.options.credentials.withKey(apiKey => this.options.gateway.runTurn({ apiKey, model: run.model, turn,
      system: run.conversation.system, messages: run.conversation.history(), tools: run.tools, signal: abort.signal,
      onDelta: delta => this.options.live.push(taskId, turn, delta) }));
    // This turn owned the controller until it settled; Stop and detach always reach the request that is actually running.
    if (run.abort === abort) run.abort = undefined;
    if (run.done) return failed('cancelled');
    if (!used.ok) return failed(used.reason);
    const result = used.value;
    if (result.status === 'failed') return { kind: 'model.turn', outcome: { status: 'failed', code: result.code, retryable: result.retryable, httpStatus: result.httpStatus } };
    try {
      run.conversation.acceptTurn(result.replay, result.view.stopReason);
      const text = result.replay.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
      const message = text ? this.options.store.addTaskMessage(taskId, 'assistant', turn, clip(text)) : null;
      this.options.store.appendAgentEvent(taskId, 'assistant_turn', { turn, model: result.view.model, messageId: message?.id ?? null,
        stopReason: result.view.stopReason, toolCalls: result.view.toolCalls.length, fallback: result.view.fallback, usage: result.view.usage });
    } catch { return failed('response_invalid'); }
    return { kind: 'model.turn', outcome: { status: 'ok', view: result.view } };
  }

  private async toolCall(taskId: string, turn: number, toolCallId: string): Promise<RunnerReply> {
    const run = this.runs.get(taskId);
    if (!run || run.done || turn !== run.turn || run.modelInFlight || run.activeTools.has(toolCallId)) return null;
    const call = run.conversation.pendingCall(toolCallId);
    if (!call) return { kind: 'tool.call', status: 'skipped', summary: 'Unknown tool call' };
    run.activeTools.add(toolCallId);
    try { return await this.runToolCall(run, taskId, turn, call); }
    finally { run.activeTools.delete(toolCallId); }
  }

  private async runToolCall(run: Run, taskId: string, turn: number, call: NonNullable<ReturnType<Conversation['pendingCall']>>): Promise<RunnerReply> {
    const name = AgentToolNameSchema.safeParse(call.name);
    let formatted: FormattedToolResult;
    let target = '';
    if (run.stopping) formatted = skippedResult('the task is stopping');
    else if (!call.executable) formatted = skippedResult('the model output was cut off before this call was complete');
    else if (!name.success || !run.tools.includes(name.data)) formatted = skippedResult(`no tool named ${call.name.slice(0, 64)} is available`);
    else if (name.data === 'read_file') {
      const args = ReadFileArgsSchema.safeParse(call.input);
      target = args.success ? args.data.path : '';
      formatted = formatReadResult(await this.options.tools.readFile({ projectId: run.project.id, taskId, toolCallId: randomUUID(), args: call.input }), target);
    } else {
      const args = ListDirectoryArgsSchema.safeParse(call.input);
      target = args.success ? args.data.path || '.' : '';
      formatted = formatListResult(await this.options.tools.listDirectory({ projectId: run.project.id, taskId, toolCallId: randomUUID(), args: call.input }), target);
    }
    if (run.done) return { kind: 'tool.call', status: 'skipped', summary: 'The task has ended' };
    if (call.executable && run.conversation.pendingCall(call.id)) run.conversation.recordResult(call.id, formatted.content, formatted.isError);
    this.options.store.appendAgentEvent(taskId, 'tool_call', { turn, callId: call.id, tool: call.name.slice(0, 128) || 'tool',
      target: target.slice(0, 512), status: formatted.status, code: formatted.code, size: formatted.size });
    return { kind: 'tool.call', status: formatted.status, summary: clipSummary(formatted.summary) };
  }

  private finish(taskId: string, outcome: AgentFinishOutcome, reason: AgentFinishReason): RunnerReply {
    const run = this.runs.get(taskId);
    if (!run || run.done) return { kind: 'agent.finish', accepted: false };
    if (run.stopping) this.end(run, 'STOPPED', 'Stopped by the user');
    else if (outcome === 'completed') this.end(run, 'COMPLETED', reason === 'max_tokens' ? REASONS.max_tokens : null);
    else this.end(run, 'FAILED', REASONS[reason]);
    return { kind: 'agent.finish', accepted: true };
  }
}

/** The tool.call reply contract allows 256 characters; a long path must never fail the reply (and with it the session). */
export function clipSummary(summary: string): string {
  return summary.length <= 256 ? summary : summary.slice(0, 255) + '…';
}

/** Stored answer text is bounded; the live view and the model already had the full text. */
function clip(text: string): string {
  const limit = 500_000;
  if (Buffer.byteLength(text) <= limit) return text;
  let end = Math.min(text.length, limit);
  while (end > 0 && Buffer.byteLength(text.slice(0, end)) > limit - 64) end = Math.floor(end * 0.9);
  return text.slice(0, end) + '\n\n[Answer truncated for storage]';
}
