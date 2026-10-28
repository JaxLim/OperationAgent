import { useEffect, useState, type ReactNode } from 'react';
import { engine } from '../sim/engine';
import { store, RETRYABLE_STATUSES } from '../sim/store';
import { diffStats } from '../sim/diff';
import type { Approval, Task, TimelineItem, ToolCall } from '../sim/types';
import {
  IconCheck, IconX, IconChevronRight, IconFile, IconSearch, IconTerminal, IconPencil, IconFolder, IconListTree,
  IconShield, IconLock, IconDiff, IconAlert, IconInfo, IconRetry, IconEye, IconBox, Spinner, IconSparkle,
} from './Icons';
import { Prose, clockTime, duration } from './format';

export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

const TOOL_ICON: Record<ToolCall['name'], (props: { size?: number }) => ReactNode> = {
  list_dir: IconFolder,
  read_file: IconFile,
  grep: IconSearch,
  bash: IconTerminal,
  write_file: IconPencil,
  apply_patch: IconBox,
};

function ToolState({ call }: { call: ToolCall }) {
  const now = useNow(200, call.state === 'running');
  if (call.state === 'running') {
    return <span className="tool-state tone-text-run"><Spinner size={12} />{duration(now - (call.startedAt ?? now))}</span>;
  }
  if (call.state === 'awaiting_approval') return <span className="tool-state tone-text-wait"><IconShield size={13} />awaiting approval</span>;
  const elapsed = call.startedAt && call.endedAt ? duration(call.endedAt - call.startedAt) : '';
  const icon = call.state === 'done' ? <IconCheck size={13} /> : call.state === 'failed' ? <IconX size={13} /> : call.state === 'denied' ? <IconLock size={13} /> : <IconX size={13} />;
  const tone = call.state === 'done' ? 'ok' : call.state === 'failed' ? 'danger' : 'muted';
  return <span className={`tool-state tone-text-${tone}`}>{icon}{call.state === 'done' ? elapsed : call.state}</span>;
}

export function ToolOutput({ call, showSeq }: { call: ToolCall; showSeq: boolean }) {
  if (!call.output.length && call.state !== 'running') return <div className="tool-output tool-output-empty">No output captured.</div>;
  return (
    <div className="tool-output" role="log" aria-live={call.state === 'running' ? 'polite' : 'off'}>
      <div className="out-meta"><IconLock size={11} />{call.isolation} <span className="out-sim">simulated</span></div>
      {call.argv && <div className="out-line out-cmd"><span className="prompt">$</span>{call.argv.join(' ')}</div>}
      {call.output.map(line => (
        <div key={line.seq} className={`out-line out-${line.stream}`}>
          {showSeq && <span className="out-seq">{line.seq}</span>}
          <span className="out-text">{line.text || ' '}</span>
        </div>
      ))}
      {call.state === 'running' && <div className="out-line out-cursor"><span className="caret" /></div>}
    </div>
  );
}

function ToolRow({ call, showSeq, nested }: { call: ToolCall; showSeq: boolean; nested?: boolean }) {
  const isExec = call.risk === 'exec' || call.name === 'apply_patch';
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (isExec && (call.state === 'running' || call.state === 'failed'));
  const Icon = TOOL_ICON[call.name];
  return (
    <div className={`tool-row risk-${call.risk} state-${call.state}${nested ? ' is-nested' : ''}`}>
      <button className="tool-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <IconChevronRight size={13} className={`chev${expanded ? ' is-open' : ''}`} />
        <span className="tool-icon"><Icon size={14} /></span>
        <span className="tool-title">{call.title}</span>
        <span className="tool-target">{call.target}</span>
        {call.summary && call.state !== 'running' && <span className="tool-summary">{call.summary}</span>}
        <span className="tool-spacer" />
        <ToolState call={call} />
      </button>
      {expanded && <ToolOutput call={call} showSeq={showSeq} />}
    </div>
  );
}

function ToolGroup({ calls, showSeq }: { calls: ToolCall[]; showSeq: boolean }) {
  const running = calls.some(call => call.state === 'running');
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? running;
  const files = calls.filter(call => call.name === 'read_file').length;
  const searches = calls.filter(call => call.name === 'grep').length;
  const label = [files && `${files} file${files > 1 ? 's' : ''} read`, searches && `${searches} search${searches > 1 ? 'es' : ''}`,
    calls.length - files - searches > 0 && `${calls.length - files - searches} listing`].filter(Boolean).join(', ');
  const current = calls.find(call => call.state === 'running');
  const cancelled = calls.filter(call => call.state === 'cancelled').length;
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <IconChevronRight size={13} className={`chev${expanded ? ' is-open' : ''}`} />
        <span className="tool-icon"><IconEye size={14} /></span>
        <span className="tool-title">{running ? 'Exploring' : 'Explored'}</span>
        <span className="tool-group-label">{running && current ? current.target : label}</span>
        <span className="tool-spacer" />
        {running ? <span className="tool-state tone-text-run"><Spinner size={12} /></span>
          : cancelled ? <span className="tool-state tone-text-muted"><IconX size={13} />{cancelled} cancelled</span>
            : <span className="tool-state tone-text-ok"><IconCheck size={13} />{calls.length}</span>}
      </button>
      {expanded && <div className="tool-group-body">{calls.map(call => <ToolRow key={call.id} call={call} showSeq={showSeq} nested />)}</div>}
    </div>
  );
}

function StepIcon({ state }: { state: 'pending' | 'active' | 'done' | 'skipped' }) {
  if (state === 'active') return <span className="step-icon is-active"><Spinner size={13} /></span>;
  if (state === 'done') return <span className="step-icon is-done"><IconCheck size={12} /></span>;
  if (state === 'skipped') return <span className="step-icon is-skipped">–</span>;
  return <span className="step-icon is-pending" />;
}

function PlanCard({ task, planId }: { task: Task; planId: string }) {
  const plan = task.plan?.id === planId ? task.plan : undefined;
  if (!plan) return <div className="card card-superseded"><IconListTree size={14} /> Plan from an earlier attempt</div>;
  const pending = !plan.decision && task.status === 'awaiting_plan';
  const enabled = plan.steps.filter(step => step.enabled);
  const files = new Set(enabled.flatMap(step => step.files));
  return (
    <div className={`card plan-card${pending ? ' is-pending' : ''}`}>
      <div className="card-head">
        <span className="card-kicker"><IconListTree size={14} /> Plan</span>
        {plan.decision && <span className={`badge ${plan.decision === 'approved' ? 'tone-ok' : 'tone-muted'}`}>{plan.decision === 'approved' ? 'Approved' : 'Declined'}</span>}
        {pending && <span className="badge tone-wait">Review</span>}
      </div>
      <p className="plan-summary">{plan.summary}</p>
      <ol className="plan-steps">
        {plan.steps.map((step, index) => (
          <li key={step.id} className={`plan-step state-${step.state}${!step.enabled ? ' is-disabled' : ''}`}>
            <StepIcon state={step.enabled ? step.state : 'skipped'} />
            <div className="plan-step-body">
              <div className="plan-step-title">
                <span className="plan-step-index">{index + 1}</span>
                {step.title}
                {step.optional && <span className="badge badge-soft">optional</span>}
              </div>
              <div className="plan-step-detail">{step.detail}</div>
              {step.files.length > 0 && <div className="chips">{step.files.map(file => <span key={file} className="chip mono">{file}</span>)}</div>}
            </div>
            {step.optional && pending && (
              <label className="switch" title="Include this step">
                <input type="checkbox" checked={step.enabled} onChange={() => engine.togglePlanStep(task.id, step.id)} />
                <span className="switch-track" />
              </label>
            )}
          </li>
        ))}
      </ol>
      {pending && (
        <div className="card-foot">
          <span className="card-foot-meta">{enabled.length} steps · {files.size} files · writes held for review</span>
          <button className="btn btn-quiet" onClick={() => engine.decidePlan(task.id, false)}>Decline</button>
          <button className="btn btn-primary" onClick={() => engine.decidePlan(task.id, true)} autoFocus>
            <IconCheck size={14} /> Approve plan <kbd>Ctrl ↵</kbd>
          </button>
        </div>
      )}
    </div>
  );
}

function CapabilityList({ approval }: { approval: Approval }) {
  return (
    <dl className="caps">
      {approval.capabilities.map(cap => (
        <div key={cap.label} className={`cap tone-cap-${cap.tone}`}>
          <dt>{cap.label}</dt>
          <dd>{cap.tone === 'deny' && <IconLock size={12} />}{cap.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function decisionLabel(approval: Approval): string {
  if (approval.state === 'auto') return 'Auto-approved';
  if (approval.state === 'expired') return 'Expired';
  if (approval.state === 'denied') return approval.kind === 'changes' ? 'Rejected' : 'Denied';
  if (approval.kind === 'changes') return 'Applied';
  return approval.scope === 'task' ? 'Allowed for task' : 'Allowed once';
}

function CommandApproval({ task, approval }: { task: Task; approval: Approval }) {
  const call = approval.toolCallId ? task.tools[approval.toolCallId] : undefined;
  const pending = approval.state === 'pending';
  if (!pending) {
    return (
      <div className={`approval-compact tone-border-${approval.state === 'denied' ? 'danger' : 'muted'}`}>
        <IconShield size={14} />
        <span><strong>{approval.title}</strong> <span className="mono muted">{call?.argv?.join(' ')}</span></span>
        <span className="tool-spacer" />
        <span className={`badge ${approval.state === 'denied' ? 'tone-danger' : approval.state === 'expired' ? 'tone-muted' : 'tone-ok'}`}>{decisionLabel(approval)}</span>
        {approval.decidedAt && <span className="muted small">{clockTime(approval.decidedAt)}</span>}
      </div>
    );
  }
  return (
    <div className="card approval-card is-pending">
      <div className="card-head">
        <span className="card-kicker tone-text-wait"><IconShield size={14} /> Command approval</span>
        <span className="badge tone-wait">Waiting for you</span>
      </div>
      <div className="approval-title">{approval.title}</div>
      <p className="approval-reason">{approval.reason}</p>
      <div className="argv"><span className="prompt">$</span>{call?.argv?.join(' ')}</div>
      <CapabilityList approval={approval} />
      <div className="fingerprint" title="Grant binds to the normalised argv and capability set; changed arguments require a new approval">
        Grant fingerprint <span className="mono">{approval.argvHash}</span>
      </div>
      <div className="card-foot">
        <button className="btn btn-quiet btn-danger-text" onClick={() => engine.decideCommand(task.id, approval.id, false, 'once')}>Deny</button>
        <span className="tool-spacer" />
        <button className="btn" onClick={() => engine.decideCommand(task.id, approval.id, true, 'task')}>Allow for this task</button>
        <button className="btn btn-primary" onClick={() => engine.decideCommand(task.id, approval.id, true, 'once')} autoFocus>
          Allow once <kbd>Ctrl ↵</kbd>
        </button>
      </div>
    </div>
  );
}

function ChangesApproval({ task, approval }: { task: Task; approval: Approval }) {
  const changes = task.changes?.id === approval.changeSetId ? task.changes : undefined;
  const pending = approval.state === 'pending' && !!changes;
  const openDiff = (path?: string): void => store.update(state => ({ ...state, rightTab: 'changes', rightOpen: true, selectedFile: path ?? state.selectedFile }));
  if (!pending) {
    const applied = changes?.appliedPaths?.length ?? 0;
    return (
      <div className={`approval-compact tone-border-${approval.state === 'denied' ? 'danger' : 'muted'}`}>
        <IconDiff size={14} />
        <span><strong>{approval.title}</strong>{changes && approval.state === 'approved' && <span className="muted"> · {applied} applied</span>}</span>
        <span className="tool-spacer" />
        <span className={`badge ${approval.state === 'denied' ? 'tone-danger' : approval.state === 'expired' ? 'tone-muted' : 'tone-ok'}`}>{decisionLabel(approval)}</span>
        {changes && <button className="btn btn-quiet btn-xs" onClick={() => openDiff()}>View diff</button>}
      </div>
    );
  }
  const included = changes.files.filter(file => file.include);
  const totals = included.reduce((acc, file) => { const s = diffStats(file.before, file.after); return { a: acc.a + s.added, r: acc.r + s.removed }; }, { a: 0, r: 0 });
  return (
    <div className="card approval-card is-pending">
      <div className="card-head">
        <span className="card-kicker tone-text-wait"><IconDiff size={14} /> Review changes</span>
        <span className="badge tone-wait">Waiting for you</span>
      </div>
      <p className="approval-reason">{approval.reason}</p>
      <ul className="change-list">
        {changes.files.map(file => {
          const stats = diffStats(file.before, file.after);
          return (
            <li key={file.path} className={file.include ? '' : 'is-excluded'}>
              <label className="check">
                <input type="checkbox" checked={file.include} onChange={() => engine.toggleChangeFile(task.id, file.path)} />
                <span className="check-box"><IconCheck size={11} /></span>
              </label>
              <button className="change-path" onClick={() => openDiff(file.path)}>
                <span className={`file-kind kind-${file.kind}`}>{file.kind === 'added' ? 'A' : 'M'}</span>
                <span className="mono">{file.path}</span>
              </button>
              <span className="change-why">{file.rationale}</span>
              <span className="diffstat"><span className="add">+{stats.added}</span><span className="del">−{stats.removed}</span></span>
            </li>
          );
        })}
      </ul>
      <CapabilityList approval={{ ...approval, capabilities: approval.capabilities.map(cap => cap.label === 'Writes' ? { ...cap, value: `${included.length} of ${changes.files.length} files inside the workspace` } : cap) }} />
      <div className="card-foot">
        <button className="btn btn-quiet btn-danger-text" onClick={() => engine.decideChanges(task.id, false)}>Reject all</button>
        <button className="btn btn-quiet" onClick={() => openDiff()}><IconDiff size={14} /> Review diff</button>
        <span className="tool-spacer" />
        <span className="card-foot-meta"><span className="add">+{totals.a}</span> <span className="del">−{totals.r}</span></span>
        <button className="btn btn-primary" disabled={!included.length} onClick={() => engine.decideChanges(task.id, true)} autoFocus>
          <IconCheck size={14} /> Apply {included.length} of {changes.files.length} <kbd>Ctrl ↵</kbd>
        </button>
      </div>
    </div>
  );
}

function Notice({ item }: { item: Extract<TimelineItem, { kind: 'notice' }> }) {
  const Icon = item.tone === 'danger' || item.tone === 'warn' ? IconAlert : item.tone === 'ok' ? IconCheck : IconInfo;
  return (
    <div className={`notice tone-notice-${item.tone}`}>
      <Icon size={14} />
      <div>
        <div className="notice-text">{item.text}</div>
        {item.detail && <div className="notice-detail">{item.detail}</div>}
      </div>
      <span className="notice-time">{clockTime(item.at)}</span>
    </div>
  );
}

function StopProgress({ task }: { task: Task }) {
  if (!task.stop || task.stop.phase === 'done') return null;
  const phases = ['draining', 'terminating', 'verifying'] as const;
  const index = phases.indexOf(task.stop.phase);
  const labels = ['Draining — no new operations', 'Graceful terminate', 'Verifying side effects'];
  return (
    <div className="stop-progress" role="status">
      {phases.map((phase, i) => (
        <div key={phase} className={`stop-phase${i < index ? ' is-done' : i === index ? ' is-active' : ''}`}>
          {i < index ? <IconCheck size={12} /> : i === index ? <Spinner size={12} /> : <span className="dot" />}
          {labels[i]}
        </div>
      ))}
      <div className="stop-grace">Grace period {task.stop.graceMs / 1000}s · forced cleanup after</div>
    </div>
  );
}

function ResultCard({ task }: { task: Task }) {
  const result = task.result;
  if (!result) return null;
  const tone = result.outcome === 'success' ? 'ok' : result.outcome === 'failed' ? 'danger' : result.outcome === 'partial' ? 'warn' : 'muted';
  const added = result.filesChanged.reduce((sum, f) => sum + f.added, 0);
  const removed = result.filesChanged.reduce((sum, f) => sum + f.removed, 0);
  const retryable = RETRYABLE_STATUSES.includes(task.status) && !task.readOnlyHistory;
  return (
    <div className={`card result-card tone-border-${tone}`}>
      <div className="result-head">
        <span className={`result-icon tone-bg-${tone}`}>
          {tone === 'ok' ? <IconCheck size={15} /> : tone === 'danger' ? <IconX size={15} /> : tone === 'warn' ? <IconAlert size={14} /> : <IconInfo size={14} />}
        </span>
        <div>
          <div className="result-headline">{result.headline}</div>
          <div className="result-sub">{task.readOnlyHistory ? 'From history' : `Attempt ${task.attempt}`} · {duration(result.durationMs)} · {result.verified ? 'verified' : 'not verified'}</div>
        </div>
      </div>
      <ul className="result-bullets">{result.bullets.map(bullet => <li key={bullet}>{bullet}</li>)}</ul>
      <div className="stat-row">
        <div className="stat"><span className="stat-value">{result.filesChanged.length}</span><span className="stat-label">files</span></div>
        <div className="stat"><span className="stat-value"><span className="add">+{added}</span> <span className="del">−{removed}</span></span><span className="stat-label">lines</span></div>
        {result.tests && <div className="stat"><span className="stat-value">{result.tests.passed}<span className="muted">/{result.tests.passed + result.tests.failed}</span></span><span className="stat-label">tests passed</span></div>}
        <div className="stat"><span className="stat-value">{result.toolCalls}</span><span className="stat-label">tool calls</span></div>
        <div className="stat"><span className="stat-value">{result.approvals}</span><span className="stat-label">decisions</span></div>
      </div>
      <div className="card-foot">
        {!task.readOnlyHistory && <span className="card-foot-meta sim-note"><IconSparkle size={12} /> Simulated result — nothing was executed or written to disk</span>}
        <span className="tool-spacer" />
        {retryable && <button className="btn" onClick={() => engine.retry(task.id)}><IconRetry size={14} /> Retry</button>}
        <button className="btn btn-primary" onClick={() => store.update(s => ({ ...s, rightTab: 'results', rightOpen: true, selectedArtifact: null }))}>Inspect results</button>
      </div>
    </div>
  );
}

type Rendered = { key: string; node: ReactNode };

/** Groups consecutive read-only tool calls into a single "Explored" block. */
export function Timeline({ task, showSeq }: { task: Task; showSeq: boolean }) {
  const rendered: Rendered[] = [];
  let readRun: ToolCall[] = [];
  const flush = (): void => {
    if (!readRun.length) return;
    const calls = readRun;
    rendered.push({ key: `g-${calls[0]!.id}`, node: calls.length > 1 ? <ToolGroup calls={calls} showSeq={showSeq} /> : <ToolRow call={calls[0]!} showSeq={showSeq} /> });
    readRun = [];
  };
  const lastResultIndex = task.items.map(item => item.kind).lastIndexOf('result');
  task.items.forEach((item, index) => {
    if (item.kind === 'tool') {
      const call = task.tools[item.toolCallId];
      if (!call) return;
      if (call.risk === 'read') { readRun.push(call); return; }
      flush();
      if (call.state === 'awaiting_approval' && call.risk === 'exec') return; // represented by the approval card
      rendered.push({ key: item.id, node: <ToolRow call={call} showSeq={showSeq} /> });
      return;
    }
    flush();
    switch (item.kind) {
      case 'user':
        rendered.push({ key: item.id, node: <div className="msg msg-user"><div className="bubble">{item.text}</div></div> });
        break;
      case 'agent':
        rendered.push({ key: item.id, node: (
          <div className="msg msg-agent">
            <div className="prose">{item.text ? <Prose text={item.text} /> : <p className="muted">Thinking…</p>}{item.streaming && <span className="caret" />}</div>
          </div>
        ) });
        break;
      case 'plan':
        rendered.push({ key: item.id, node: <PlanCard task={task} planId={item.planId} /> });
        break;
      case 'approval': {
        const approval = task.approvals[item.approvalId];
        if (!approval) break;
        rendered.push({ key: item.id, node: approval.kind === 'command' ? <CommandApproval task={task} approval={approval} /> : <ChangesApproval task={task} approval={approval} /> });
        break;
      }
      case 'notice':
        rendered.push({ key: item.id, node: <Notice item={item} /> });
        break;
      case 'attempt':
        rendered.push({ key: item.id, node: <div className="attempt-divider"><span>Attempt {item.attempt}</span><span className="muted">{clockTime(item.at)}</span></div> });
        break;
      case 'result':
        if (index === lastResultIndex) rendered.push({ key: item.id, node: <ResultCard task={task} /> });
        else rendered.push({ key: item.id, node: <div className="card card-superseded"><IconInfo size={14} /> Result of an earlier attempt — see the run log in Results</div> });
        break;
    }
  });
  flush();
  return (
    <div className="timeline">
      {rendered.map(entry => <div key={entry.key} className="timeline-entry">{entry.node}</div>)}
      {task.status === 'stopping' && <StopProgress task={task} />}
    </div>
  );
}
