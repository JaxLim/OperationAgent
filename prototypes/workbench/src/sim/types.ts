// Domain model for the simulated workbench. Every object here is produced by the
// deterministic scenario engine; nothing reflects a real process, file or model.

export type TaskStatus =
  | 'draft'
  | 'planning'
  | 'awaiting_plan'
  | 'running'
  | 'awaiting_approval'
  | 'applying'
  | 'verifying'
  | 'completed'
  | 'completed_with_issues'
  | 'changes_rejected'
  | 'plan_declined'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
  | 'failed';

export type ToolName = 'list_dir' | 'read_file' | 'grep' | 'bash' | 'write_file' | 'apply_patch';
export type ToolRisk = 'read' | 'exec' | 'write';
export type ToolState = 'queued' | 'awaiting_approval' | 'running' | 'done' | 'failed' | 'cancelled' | 'denied' | 'skipped';
export type OutputStream = 'stdout' | 'stderr' | 'info';

export interface OutputLine {
  seq: number;
  stream: OutputStream;
  text: string;
}

export interface ToolCall {
  id: string;
  name: ToolName;
  risk: ToolRisk;
  title: string;
  target: string;
  /** Normalised argv for exec tools; shown in approvals and bound to the grant hash. */
  argv?: string[];
  isolation: string;
  state: ToolState;
  startedAt?: number;
  endedAt?: number;
  output: OutputLine[];
  summary?: string;
  exitCode?: number;
}

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  files: string[];
  optional?: boolean;
  enabled: boolean;
  state: 'pending' | 'active' | 'done' | 'skipped';
}

export interface Plan {
  id: string;
  summary: string;
  steps: PlanStep[];
  decision?: 'approved' | 'declined';
}

export interface FileChange {
  path: string;
  kind: 'modified' | 'added';
  before: string;
  after: string;
  rationale: string;
  include: boolean;
}

export interface ChangeSet {
  id: string;
  files: FileChange[];
  decision?: 'applied' | 'rejected';
  appliedPaths?: string[];
}

export interface Capability {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'deny';
}

export type ApprovalKind = 'command' | 'changes';
export type GrantScope = 'once' | 'task';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  toolCallId?: string;
  changeSetId?: string;
  title: string;
  reason: string;
  capabilities: Capability[];
  argvHash?: string;
  state: 'pending' | 'approved' | 'denied' | 'auto' | 'expired';
  scope?: GrantScope;
  decidedAt?: number;
}

export interface TestCase {
  name: string;
  state: 'pass' | 'fail' | 'skip';
  ms: number;
  note?: string;
}

export interface Artifact {
  id: string;
  name: string;
  kind: 'patch' | 'report' | 'log';
  content: string;
}

export interface TaskResult {
  outcome: 'success' | 'partial' | 'rejected' | 'stopped' | 'failed' | 'declined';
  headline: string;
  bullets: string[];
  filesChanged: { path: string; added: number; removed: number; kind: 'modified' | 'added' }[];
  tests?: { passed: number; failed: number; skipped: number; cases: TestCase[] };
  verified: boolean;
  durationMs: number;
  toolCalls: number;
  approvals: number;
  artifacts: Artifact[];
}

export type TimelineItem =
  | { kind: 'user'; id: string; at: number; text: string }
  | { kind: 'agent'; id: string; at: number; text: string; streaming?: boolean }
  | { kind: 'plan'; id: string; at: number; planId: string }
  | { kind: 'tool'; id: string; at: number; toolCallId: string }
  | { kind: 'approval'; id: string; at: number; approvalId: string }
  | { kind: 'notice'; id: string; at: number; text: string; tone: 'neutral' | 'warn' | 'danger' | 'ok'; detail?: string }
  | { kind: 'attempt'; id: string; at: number; attempt: number }
  | { kind: 'result'; id: string; at: number };

export interface StopInfo {
  requestedAt: number;
  graceMs: number;
  phase: 'draining' | 'terminating' | 'verifying' | 'done';
  cancelledTool?: string;
  sideEffects: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  scenario: 'invoice-rounding' | 'history';
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  attempt: number;
  items: TimelineItem[];
  tools: Record<string, ToolCall>;
  approvals: Record<string, Approval>;
  plan?: Plan;
  changes?: ChangeSet;
  result?: TaskResult;
  stop?: StopInfo;
  /** Script cursor of the current attempt; lets the engine resume after a gate. */
  cursor: number;
  /** Grants the user gave for this task, keyed by argv hash. */
  grants: string[];
  startedAt?: number;
  readOnlyHistory?: boolean;
}

export interface ProjectFile {
  path: string;
  content: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string;
  description: string;
  language: string;
  files: ProjectFile[];
  accent: string;
}

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  density: 'comfortable' | 'compact';
  speed: 0.5 | 1 | 2 | 4;
  autoOpenContext: boolean;
  approvalPolicy: 'ask-writes-and-commands' | 'ask-writes';
  injectSandboxFailure: boolean;
  graceMs: number;
  showSequence: boolean;
}

export type RightTab = 'files' | 'changes' | 'approvals' | 'results';

export interface AppState {
  version: number;
  projects: Project[];
  activeProjectId: string;
  tasks: Task[];
  activeTaskId: string | null;
  /** Simulated overlay of applied changes per project. Real files are never written. */
  overlay: Record<string, Record<string, string>>;
  settings: Settings;
  rightTab: RightTab;
  rightOpen: boolean;
  selectedFile: string | null;
  selectedArtifact: string | null;
}
