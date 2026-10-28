# OperationAgent Workbench — UI prototype

A standalone, offline desktop UI prototype for the OperationAgent agent workspace. It shows the full intended task flow with a **deterministic simulation**:

open project → submit task → review plan → watch tool activity → approve or reject changes → inspect results.

> **Everything the agent does here is simulated.** No model is called, no process is spawned, no real folder is opened, read or written, and the page has no network access. Applied changes go only to an in-memory "overlay" shown in the file viewer.

## Relationship to the product code

- The prototype lives outside `apps/*` and `packages/*` and has its own `pnpm-workspace.yaml`. It is **not** part of the product workspace, dependency graph, lint scope or stage gates.
- It imports nothing from `apps/` or `packages/`. It is not wired to Express, the Worker, the preload bridge or SQLite, and it changes no security boundary in `ARCHITECTURE.md` or `AGENTS.md`.
- The optional desktop window (`electron/main.cjs`) only *reuses the Electron binary* already verified in `apps/desktop`. It has no preload, no Node integration and a sandboxed renderer, and it cancels every request outside `dist/`.
- The built bundle ships a strict CSP: `connect-src 'none'`, no inline scripts or styles.

## Launch

Run these from `prototypes/workbench`, using the repository's pinned Node (`.tools/node`, see the root README).

First time only, install the prototype's own dependencies (React 19.3.1, Vite 8.3.5, TypeScript 5.9.3):

```bash
../../.tools/node/node.exe ../../.tools/pnpm/bin/pnpm.cjs install --frozen-lockfile
```

**Browser (dev server, hot reload)**, then open http://127.0.0.1:5317:

```bash
../../.tools/node/node.exe ../../.tools/pnpm/bin/pnpm.cjs dev
```

**Desktop window (Electron)**: build first, then launch. This needs `pnpm prepare:electron` to have been run once at the repo root.

```bash
../../.tools/node/node.exe ../../.tools/pnpm/bin/pnpm.cjs build
```

```bash
../../.tools/node/node.exe ../../.tools/pnpm/bin/pnpm.cjs desktop
```

**Checks:**

```bash
../../.tools/node/node.exe ../../.tools/pnpm/bin/pnpm.cjs typecheck
```

```bash
../../.tools/node/node.exe ../../.tools/pnpm/bin/pnpm.cjs test
```

`test` verifies that the sample data is internally consistent. It evaluates the sample TypeScript to confirm the scripted bug is real ($37.41 instead of $37.40) and that the scripted fix produces the claimed results. It also checks the diff utilities.

## Three-minute demo walkthrough

| Time | Do | Notice |
|---|---|---|
| 0:00 | Look at the window before clicking anything | Three panels: projects/tasks · conversation · context. The violet **Prototype · simulated execution** badge and the status bar state that nothing real runs. |
| 0:10 | Press `Ctrl O` (or click the project name), browse projects, keep **ledger-api** | Sample projects only; **Choose folder…** is disabled on purpose. Click a history task such as *Upgrade fastify to 5.6* to see a read-only past run, then press `Ctrl N`. |
| 0:25 | Click **Fix the one-cent invoice tax bug**, then press `Enter` | The task starts as **Exploring**. Read-only calls group under **Explored** (Read adapter). The right panel follows each file the agent reads, and the task renames itself. |
| 0:45 | Read the diagnosis and the **Plan** card | The arithmetic is concrete (1.02 × 3 = $3.06, should be $3.05). Toggle the optional CHANGELOG step, then **Approve plan** (`Ctrl ↵`). |
| 1:00 | **Command approval** for `pnpm exec vitest run tests/invoice` | You see the capability set (network denied, `.git` no access, limits) and the grant fingerprint. Choose **Allow for this task**. |
| 1:10 | Watch the test output stream | stdout/stderr separation and the isolation label inside the output. Turn on sequence numbers in Settings to see delta ordering. |
| 1:25 | **Review changes**: the right panel opens on **Changes** | Switch between Unified and Split views and step through the 4 files. Untick `src/money/minor.ts` to see the count change, then tick it again. |
| 1:45 | **Apply 4 of 4** | **Applying**, then **Verifying**. The second test run shows *Covered by task grant …* because the argv and capability set match. |
| 2:00 | **Results** tab | Outcome, files changed, the 8 test cases, and artifacts. Open `changes.patch` and `run-log.jsonl`. In **Files**, `total.ts` is now marked *modified · simulated*. |
| 2:20 | Click **Retry** on the result card, approve the plan, then click **Stop** (or `Ctrl .`) while it runs | **Stopping** progresses through *Draining → Graceful terminate → Verifying side effects* to **Stopped** with a side-effect report. |
| 2:40 | Click **Retry**, approve everything, then **Reject all** at review | **Changes rejected — workspace untouched**. |
| 2:50 | Settings → Simulation → **Simulate sandbox unavailable**, then retry | The test run fails with `SANDBOX_UNAVAILABLE` and the run **fails closed**, with no unsandboxed fallback. Click **Reset demo** to start clean. |

Other things to try: exclude `minor.ts` but keep `total.ts` (the suite fails to compile; *completed · issues*). Exclude `total.ts` but keep the tests (the regression test fails). Reload the window mid-run (the run becomes **Interrupted** and is never resumed automatically). Switch to dark theme, compact density or 4× speed.

Keyboard: `Ctrl N` new task · `Ctrl O` open project · `Ctrl ↵` approve the pending gate · `Ctrl .` stop · `Ctrl ,` settings · `Ctrl \` toggle context panel.

## What is functional, simulated, or unfinished

**Functional (real UI behaviour):**
- Three-panel workbench, project switching, task history with search, grouped by in progress / today / earlier.
- Composer, keyboard shortcuts, settings (theme, density, auto-open context, sequence numbers, approval policy, stop grace, speed).
- Plan review with an optional step; command approval with once / task scope; per-file change selection; unified and split diff viewer; syntax-highlighted file viewer.
- Results with test table, artifacts viewer and copy; Stop, Retry (new attempt) and Reset demo.
- Interrupted-on-reload handling; light and dark themes; a single active run at a time.
- Per-viewer persistence in `localStorage` (the app still works if storage is unavailable).

**Simulated (scripted, deterministic):**
- Agent prose, plan, tool calls and their output, test results, timings.
- The approval capability sets and grant fingerprint. The fingerprint is FNV-1a for display only; it is not a security primitive.
- Stop phases (graceful terminate, process-tree exit) and side-effect verification.
- "Applied" files, which exist only in the in-memory overlay.
- `SANDBOX_UNAVAILABLE` (an injected failure).
- Any prompt in ledger-api replays the same INC-4821 scenario; the UI says so under the composer.

**Not implemented:**
- Real model, Worker, Express API, tool execution, sandbox, MCP, Git operations or credentials. No connection to the product runtime exists or is implied.
- Follow-up messages within a task (the composer always starts a new task), editing a plan, inline diff comments, multiple concurrent runs, task deletion/archiving, and more than one scripted scenario.
- The other sample projects (atlas-web, ops-runbooks) contain history only.
- No installer or packaging. Accessibility has been considered (roles, focus, reduced motion) but not audited.
