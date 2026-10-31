# 实际执行与验证记录

初始记录：2026-10-23（Asia/Shanghai）。以下初始阶段记录保留原貌；2026-10-24/25 的 ADR 批准与冻结验证见末节。生产功能和平台安全能力仍全部未验证。

## 已完成

- 完整读取两份规范：ARCHITECTURE 685 行，AGENTS 96 行。
- 经用户确认，将扩展名前有空格的两个文件重命名为标准名称。正文未编辑；SHA-256 重命名前后一致，值存于 `build/p0-status.json`。
- 用户已选择 DEC-001 方案 A：保留全部 ADR，记录 P0 技术阻塞，后续另行授权 Windows Worker 原型；本轮不进入 P1。
- 初始化 Git `main`，创建私有远端 `https://github.com/JaxLim/OperationAgent`。原始规范首个提交为 `c7d77de`。
- 工程基线提交 `af5fe9b`；CI 安装修复提交 `eac8e86`。已通过 GitHub API 核对远端 commit/tree SHA 与本地完全一致，没有强推或改写历史。
- Git 作者仅在本仓库设置为 JaxLim / `186766578+JaxLim@users.noreply.github.com`；未修改全局 Git 配置。
- Node 24.22.1 Windows x64 实际可执行文件下载于 `.tools/node/node.exe`，SHA-256 与官方清单匹配，运行时报告 ABI 137。pnpm 10.34.7 tarball 的 SHA-512 SRI 核验通过，解压于 `.tools/pnpm`。
- 五个直接开发依赖、98 个解析安装包；单个 `pnpm-lock.yaml`。安装使用 `--ignore-scripts`，所有 store/cache 均在工作区。未安装应用运行时依赖。

## 本地实际通过

| 验证 | 结果 |
|---|---|
| `pnpm typecheck` | strict TypeScript 检查通过 |
| `pnpm lint` | ESLint 零错误、零警告 |
| `pnpm test` | 10/10 通过，0 跳过 |
| `pnpm build` | P0 检查工具编译成功；不是 Electron 应用构建 |
| `pnpm verify:p0` | 原文 hash、运行时/ABI、精确版本、校验和、阶段与能力状态通过 |
| `pnpm check` | 上述检查组合通过，输出 `review-pending` 与 DEC-001 blocker |
| `pnpm install --frozen-lockfile --ignore-scripts --offline` | 锁文件离线重验通过 |
| `node dist/tooling/scripts/p0-check.js` | 编译后的检查工具运行通过 |
| `node scripts/bootstrap-windows.mjs --pnpm-only` | 锁定 Node 下 pnpm 归档 SRI 复核、解压及版本核对通过；CI 修复后的本地完整 `check` 再次通过 |
| `pnpm check:p0-exit` | 退出码1且包含 `P0_NOT_FROZEN`，符合预期；**P0冻结未通过** |
| `pnpm test:integration` / `package` / `test:smoke` | 各退出码1且包含 `NOT_IMPLEMENTED`；只验证拒绝占位成功，**未运行应用测试** |

检查经过三类验证：最初10项元数据测试；锁定工具链下完整检查及lint修复；冻结锁文件/编译产物/负向命令回归。没有为了“3轮”虚构应用或安全测试。

## 真实三平台 CI 结果

GitHub Actions [39948546861](https://github.com/JaxLim/OperationAgent/actions/runs/39948546861) 已完成，结论为 `success`。测试对应提交 `eac8e860ed72a1e1469ae9899770dedc658b1a1f`；之后仅补充执行记录，未改变已测试的代码或配置。

| Runner / 实际运行架构 | 工程测试 | Job 证据 |
|---|---|---|
| Windows 2025 / win32-x64 | 10/10，0 fail，0 skipped | [120397081382](https://github.com/JaxLim/OperationAgent/actions/runs/39948546861/job/120397081382) |
| macOS 15 / darwin-arm64 | 10/10，0 fail，0 skipped | [120397081309](https://github.com/JaxLim/OperationAgent/actions/runs/39948546861/job/120397081309) |
| Ubuntu 24.04 / linux-x64 | 10/10，0 fail，0 skipped | [120397081113](https://github.com/JaxLim/OperationAgent/actions/runs/39948546861/job/120397081113) |

三个实际日志均报告 Node `v24.22.1`、ABI `137`；均完成 pnpm 归档 SHA-512 校验、锁文件安装、strict typecheck、零警告 lint、P0 工具 build、源码与编译版元数据检查。检查输出明确保持 `review-pending`、DEC-001 blocker、`applicationTestsRun:false`。

这些 CI 没有安装 Electron、执行 better-sqlite3 native addon 或启动应用进程树；不改变任何产品平台能力状态。

## 执行过的主要命令与工具动作

每个 PowerShell 命令入口先执行：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
```

系统命令通过 `C:/Program Files/Git/bin/bash.exe -c ...` 调用。以下为实际动作清单（长 JSON 查询与工具调用按用途归并）：

```text
git --version / node --version / npm --version / pnpm --version / gh --version
git status --short --branch
gh auth status
git config --get user.name / user.email
uname -m / python --version / cmake --version
vswhere.exe -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
rg --files / rg -n（工作区、指定skill定位和轻量记忆检索）
PowerShell .NET ReadAllLines/ReadAllText（文件工具拒绝当前路径后的读取备用方式）
PowerShell .NET File.Move + SHA256（获批重命名与内容验证）
node --input-type=module -e ...（官方npm版本/peer/engines/SRI及Node校验和查询）
node scripts/bootstrap-windows.mjs
node scripts/bootstrap-windows.mjs --pnpm-only
curl --fail --location --silent --show-error --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 240 --output .tools/node/node.exe.part https://nodejs.org/dist/v24.22.1/win-x64/node.exe
PowerShell .NET SHA256 + File.Move（校验后将node.exe.part纳入本地工具链）
node .tools/pnpm/bin/pnpm.cjs install --ignore-scripts --store-dir .pnpm-store --cache-dir .cache/pnpm
node .tools/pnpm/bin/pnpm.cjs check
node .tools/pnpm/bin/pnpm.cjs install --frozen-lockfile --ignore-scripts --offline --store-dir .pnpm-store --cache-dir .cache/pnpm
node dist/tooling/scripts/p0-check.js
Node spawnSync 执行四个负向门禁，断言退出码1及指定错误标记
git init -b main
git config --local user.name JaxLim
git config --local user.email 186766578+JaxLim@users.noreply.github.com
git add -- ARCHITECTURE.md AGENTS.md .gitattributes
git diff --cached --stat
git commit -m "docs: preserve initial OperationAgent architecture and development rules"
gh repo create JaxLim/OperationAgent --private --source . --remote origin --description ... --push
git diff --check / git ls-remote origin refs/heads/main
git add -- <本轮已审查的工程文件>
git diff --cached --check
git commit -m "chore: establish P0 engineering baseline and explicit architecture gates"
git commit -m "fix(ci): bootstrap pinned pnpm without engine conflicts"
git push -u origin main（后续三次 HTTPS 网络连接失败；未重复创建仓库）
GitHub create_tree（以远端父 tree 为基础，逐文件原始内容构造 tree，核对本地 tree SHA）
gh api --method POST repos/JaxLim/OperationAgent/git/commits --input .cache/commit-<sha>.json --jq .sha
GitHub update_ref（expected_sha 为父提交，force:false，核对提交SHA后快进 main）
git update-ref refs/remotes/origin/main <已远端验证的SHA> <原tracking SHA>
GitHub fetch_workflow_run_jobs / fetch_workflow_job_logs（实际 CI 状态及失败日志）
```

运行 pnpm 时临时 PATH 首位为本仓库 `.tools/node`；`npm_config_cache`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`PNPM_HOME` 均指向本仓库子目录。未执行全局安装、未更改系统 PATH、未更改执行策略。

GitHub 插件用于确认账户和新仓库权限/可见性；插件没有创建仓库接口，故创建与本地推送采用已有认证的 gh。官方 Node/Electron/pnpm/Builder/Microsoft 文档通过联网核实；没有采用旧项目代码或架构。

首提交 push 成功；后续 Git HTTPS 连接连续失败，而 GitHub Git data API 可用，因此用插件创建精确 tree、gh 提交原始 author/committer/时间/message 元数据，再用插件按父 SHA 快进 ref。两端 tree/commit SHA 均核对一致后才更新本地 tracking ref；并非仅上传了相似文件。

## 真实遇到的问题及处理

- 文件工具允许路径错误地配置为另一工作区；改为当前工作区的本机只读调用，未修改工具权限设置。
- 两份文档最初名字含空格；获用户确认后仅改名。
- 命令工具直接选Bash误入WSL且 `/bin/bash` 不存在；改为显式启动真实Git Bash，之后成功。未将WSL当生产环境。
- 指定 `ps-utf8-io` skill 不在可用目录；已检查指定路径并检索 `.codex`/`.claude`/工作区，未找到可加载文件，**未声称已使用该skill**。所有PowerShell入口实际设置UTF-8。
- Node二进制第一次fetch超时，第二次连接被重置；从同一官方URL以curl重试成功，校验通过才执行。已给bootstrap加入相同源fallback。
- pnpm 12.15.0 实际包已切为原生Rust启动器，与既定JS调用方式不符；正式工程选用官方 `latest-10` 的 10.34.7（2026-10-12发布）。试验产物仅保留在忽略的 `.tools/pnpm12-probe*`，未进入依赖树或版本控制。
- 完整lint首轮发现bootstrap的 `fetch` 全局声明缺失与错误因果链未保留；修复后完整check通过。
- 首次 GitHub Actions 运行 [39923351142](https://github.com/JaxLim/OperationAgent/actions/runs/39923351142) 三个平台均在 pnpm 自安装阶段失败；根目录严格 engines 拒绝 Action 内部的 pnpm 8.14.3 / Node 24.21.0，工程测试尚未执行。修复保留全部版本约束，改由锁定 Node 执行现有 bootstrap 的跨平台 `--pnpm-only` 模式，按 SRI 校验后直接调用工作区 pnpm。
- cmake未在PATH；P0无需它。VS C++组件可发现不代表SDK/原生构建验证已完成。

## 未完成或不适用的验证

- DEC-001 的 Windows Worker 隔离原型与所有 OS 安全属性：未实现/未验证。
- Electron/Express/Worker 应用、生产 contracts、SQLite原生addon构建和加载、SEC-03/17/18真实进程测试：P1计划，未运行。
- 安装器、打包后迁移/读写/重启、无系统Node场景、macOS签名公证、Linux内核门禁、Windows AppContainer/Job安全验证：未运行。
- Node发布签名链验证、产品代码签名、SBOM、更新回滚：尚未完成，当前哈希/SRI不等同这些验证。
- 当前 CI 已在上述三个目标通过 P0 工程检查；应用集成、安装烟测和 OS 安全门禁尚未实现，因此三平台产品支持状态仍为 `unverified`。

## 本轮文件范围

规范：`ARCHITECTURE.md`、`AGENTS.md` 仅改名，正文保持。

新增工程元数据：`.gitignore`、`.gitattributes`、`.editorconfig`、`.node-version`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、`tsconfig.tools.json`、`eslint.config.mjs`。

新增方案/门禁配置：`build/runtime-lock.json`、`build/electron-builder.config.json`、`build/p0-status.json`、`.github/workflows/p0.yml`。

新增P0工具/测试：`scripts/bootstrap-windows.mjs`、`scripts/p0-check.ts`、`scripts/run-checks.mjs`、`scripts/phase-required.mjs`、`tests/p0/baseline.test.ts`。

新增文档：`README.md`、`docs/P0-REVIEW.md`、`docs/ACCEPTANCE.md`、`docs/EXECUTION.md`、`docs/adr/DEC-001-worker-isolation.md`。

本地忽略产物：`.git/`、`.tools/`、`.cache/`、`.pnpm-store/`、`node_modules/`、`dist/tooling/`。未创建 `apps/` 或 `packages/`；未修改工作区之外的文件。

## ADR-WIN-001 r1 批准与 P0 退出（2026-10-24/25）

已完整复读规范、P0 评审、DEC-001 和验收文档，并审查提交 `c44d8c9` 的既有原型原始证据。本轮没有扩展沙箱原型，没有新增依赖或启动 P1。

2026-10-24，用户明确回复“批准 r1 全部修改（推荐）”。[批准记录](adr/approvals/ADR-WIN-001-r1.json) 绑定 `build/p0-decision.json` 的 SHA-256 `01c286cb6a3060a9d09a007f4d151f64ec914b6d6dcc905f025f7d5ad9baef58`。随后才应用已审阅补丁，同步 ARCHITECTURE/AGENTS 至 0.4.0-p0，并在核验批准、规范目标 hash 和证据后更新 P0 状态摘要。DEC-001 的架构冲突已关闭，完整生产 Worker SEC-W01 仍未通过。

### 真正执行的验证

| 检查 | 实际结果 |
|---|---|
| 修改前的两项门禁负例 | 12 项中 2 项失败，重现“只改 frozen”和“删除能力矩阵”可绕过旧检查 |
| 扩展证据完整性测试 | 初次发现源码清单可被清空，修复后强制完整源码集合与文件正向对照 |
| `pnpm check`（批准前、规范同步后） | 两次完整通过：strict typecheck、零警告 lint、29/29 tests、build、verify:p0 |
| `pnpm check:p0-exit` | 批准前退出 1；正式批准及规范同步后退出 0 |
| `node dist/tooling/scripts/p0-check.js --require-frozen` | 退出 0；approved / updated / evidenceVerified=true |
| `git apply --check docs/adr/ADR-WIN-001-normative.patch` | 应用前通过；正式批准后才执行 `git apply` |
| `git diff --check` / staged 检查 | 通过；保存的 unified diff 与 ARCHITECTURE 中合法 Markdown 双空格换行采用明确文件级 whitespace 属性 |

原始命令、退出码和输出保存在 [ADR 验证记录](adr/ADR-WIN-001-validation.json)。正向审批单元测试仅使用内存合成数据；唯一落盘 approved 记录来自上述真实用户答复。CI 的 docs 忽略规则已移除，决策与批准文档变更也会触发门禁。后续 GitHub CI 结果以实际运行链接为准，不能套用旧提交的结果。

### 本次文件变更

- 规范与入口：`ARCHITECTURE.md`、`AGENTS.md`、`README.md`、`.gitattributes`。
- 决策和追踪：`docs/adr/ADR-WIN-001.md`、规范 patch、validation JSON、approvals/r1 JSON、`DEC-001-worker-isolation.md`、`docs/P0-REVIEW.md`、`docs/ACCEPTANCE.md`、本文件。
- 门禁与配置：`build/p0-decision.json`、`build/p0-status.json`、`scripts/p0-check.ts`、`scripts/p0-decision.ts`、`tests/p0/baseline.test.ts`、`tests/p0/decision.test.ts`、`.github/workflows/p0.yml`。
- 忽略的辅助产物：`.cache/adr-r1/` 中补丁目标副本/hash、决策包生成脚本及验证/上传辅助数据，`dist/tooling/` 编译产物；都仅位于工作区。

### P1 建议与仍未完成的验证

建议在下一次取得实施授权后，按 P1.1～P1.7 开始：最小 contracts 与导入边界 → Express/SQLite/Node ABI → Main bootstrap → 公开 Windows 创建/OWIP/1 受限 fixture → 服务树故障回收 → 真实安装包 DB 烟测。控制面可独立测试，未经隔离门禁的 Worker 不能执行生产任务。

公开 profile/创建路径和新协议尚未实现或验证；旧原型使用未公开导出和私有 framing，不作为生产回退。网络全矩阵/回环、Node spawnSync、危险句柄、竞态、实际 Electron/安装包及其他 OS 隔离仍未完成，按 P1 与 SEC-W01 分阶段验收。所有平台能力保持 unverified，P0 冻结不改变该状态。

## P1.0 阶段迁移（2026-10-25）

基于已核对的 main `04d07bea89b70265a6b1fb1d79272b710623775b` 创建 `codex/p1-foundation`。对应 P0 CI [40155608430](https://github.com/JaxLim/OperationAgent/actions/runs/40155608430) 三个平台均 success。Git HTTPS fetch 超时，使用已连接 GitHub API 核实远端 SHA；没有改写 main。

变更：保留原 P0 检查器/批准/规范/实验字节，新增 `p0-history.ts`、`p1-check.ts`、P1 状态与三平台 workflow、迁移正负例、P1 验收文档；根 scripts 切换至阶段感知入口。无应用进程或持久化业务数据；只在工作区 `.cache` 写入并清理历史重放快照。

实际命令与结果：

- 修改前 `pnpm check`：退出 0，29/29 tests；`check:p0-exit`：退出 0。
- Red：`node --test tests/p1/stage.test.ts` 退出 1，`ERR_MODULE_NOT_FOUND`，新检查器尚未实现。
- Green：`pnpm check:p1` 退出 0；strict TypeScript、ESLint 零警告、32/32 tests（0 skipped）、build、P0 历史退出重放、P1 范围/冻结校验全部通过。
- `git diff --check` 退出 0。

P1.0 工程迁移已实现；P1.1 在此批尚未实施。后续可以新增有归属的应用包，但不能改写 P0 证据或提升能力。产品集成、Worker 隔离、数据库和安装包：NOT RUN，未创建 AppContainer profile。

## P1.1 工程骨架（2026-10-25）

实际新增文件分组：三个 `apps/*` 包及其分进程源文件/tsconfig；contracts 的 version/errors/rpc/ipc/URL 实例类型；worker-transport 和两个平台接口包；根 tsconfig 引用图；构建、产物、依赖边界检查脚本；ESLint 边界规则；contracts/boundaries/workspace/disabled-worker 测试。更新 root scripts、workspace 配置、锁文件和 P1 状态。完整机器可读命令/退出码/stdout/stderr 保存在 [P1-validation.json](P1-validation.json)。

| 验证批次 | 实际结果 |
|---|---|
| 测试先行 | 退出 1：契约文件不存在、Renderer 的 node:fs 未被拦截；实现规则与 Schema 后修复 |
| 首次全工程 typecheck | 退出 2：Zod 缺 URL 实例类型、Electron 共享声明缺 Web 类型；修复独立类型配置，未关闭 strict/skipLibCheck |
| 补充配置负例 | 包/tsconfig 拒绝测试通过；类型负例测试首次因 Windows 路径分隔符匹配错误失败，规范化诊断路径后 3/3 通过 |
| 根级与各包 typecheck | 全部通过，包含 Desktop 三个独立进程配置 |
| `pnpm check:p1` | 退出 0：42/42 tests，0 skipped；ESLint 零警告、依赖方向、build、P0 重放、P1 状态检查通过 |
| 构建产物复核 | 发现 Vite 默认 module-preload 注入 fetch；关闭后 `pnpm build` 退出 0，Preload 仅 require electron、Renderer 无 fetch/require、所有关键编译入口存在 |
| `pnpm install --frozen-lockfile --ignore-scripts --offline` | 退出 0，锁文件可重验，无 lifecycle scripts |
| `test:integration` / `package` / `test:smoke` | 均实际退出 1 / NOT_IMPLEMENTED，产品测试本身 NOT RUN |

已完成：P1.0/P1.1 工程与静态约束。未完成：P1.2～P1.7、真实 Electron 启动、受控 HTTP/IPC、数据库、原生 Worker/OWIP、隔离和安装验收；所有平台能力仍 unverified。冻结架构、ADR 批准记录、P0 原始检查器和原始实验均保持字节不变，未将实验代码引入生产包。

本轮用户确认缺失 ps-utf8-io 时按 UTF-8 规范继续；每个 PowerShell 入口均设置 UTF-8。所有代码、依赖缓存和测试快照位于仓库内。未合并 main，未创建 AppContainer profile。

## P1.2 / P1.3 控制面与真实进程链路（2026-10-26；27 日续作上传）

用户正式授权实施 P1.2/P1.3，并要求继续未完成部分。已复核 ARCHITECTURE、AGENTS、P0-REVIEW、P1-ACCEPTANCE、ADR-WIN-001 及现有源码。PR [#1](https://github.com/JaxLim/OperationAgent/pull/1) 仍 open、merged=false、无 review；已验证 head `2b7da672d94c542f3e1a73272f22a915a6217058`，原三平台 P1 CI [40180920348](https://github.com/JaxLim/OperationAgent/actions/runs/40180920348) 与 P0 重放 [40180920354](https://github.com/JaxLim/OperationAgent/actions/runs/40180920354) 成功。新工作在独立分支 `codex/p1-control-plane`，以该 P1.1 提交为父，不合并 PR #1/main，不进入 P1.4。

### P1.2 实际修改与验证

Express 独占 SQLite，运行于实际独立的 Node 24.22.1 / ABI 137 进程。新增版本化 SQL 迁移、迁移 SHA-256 校验、批量事务、排他所有权、CLEAN/INTERRUPTED 运行对账；数据只写控制面烟测表与服务运行表，无任务自动恢复或外部副作用。

- 实现文件：`apps/server/src/index.ts`、`src/entry.ts`、`src/persistence/store.ts`、`migrations/001-control-plane.sql`、`apps/server/package.json`；`packages/contracts/src/api/index.ts`、`src/ipc/identity.ts` 和 contracts 导出。
- 工程文件：`scripts/stage-sidecar.mjs`、`scripts/check-workspace.ts`、`pnpm-lock.yaml`。`better-sqlite3 13.0.3` 使用其 Node-API prebuild；实际 SQLite 版本 3.53.4，未使用 Electron ABI 重编译。
- 测试文件：`tests/p1/persistence.test.ts`、`tests/integration/sidecar-helper.mjs`、`tests/integration/sidecar.test.mjs`。覆盖初始化/幂等迁移、失败 SQL 回滚、迁移修改拒绝、批量写入回滚、并发 DB 所有者拒绝、强杀持久化/恢复、旧实例拒绝、父通道断开、租约到期与请求窗口上限。

### P1.3 实际修改与验证

Main 启动并监管已校验的独立 Node Sidecar。令牌仅走继承 IPC，回环 HTTP 请求和响应以 HMAC 绑定服务身份；Preload 只有固定方法，Main 验证调用 frame/URL/Schema。Renderer 没有 Node/FS/DB/直接 HTTP 能力。重启仅恢复控制面，最多 60s 内 3 次，旧进程确认退出后才启动新实例。

- 实现文件：`apps/desktop/src/main/index.ts`、`host.ts`、`sidecar.ts`、`staged-runtime.ts`；`src/preload/index.ts`、`src/renderer/index.ts`；`packages/contracts/src/ipc/index.ts`。
- 测试文件：`tests/integration/electron.test.mjs`、`electron-harness.mjs`、`electron-entry.mjs`。真实 Electron/Preload/Renderer 调用，验证认证、CSP、外部窗口 IPC 拒绝、导航拒绝、中文/转义内容持久化、Sidecar 崩溃恢复、Main 崩溃后响应正常的 Sidecar 退出、重启预算、实际生产入口窗口关闭及 SQLite clean close。测试没有关闭 Electron sandbox。
- 构建及门禁文件：`scripts/prepare-electron.mjs`、`test-integration.mjs`、`run-checks.mjs`、`import-boundaries.mjs`、`p1-check.ts`；`eslint.config.mjs`、`package.json`、`pnpm-workspace.yaml`、`tests/p1/boundaries.test.ts`、`tests/p1/stage.test.ts`；`.github/workflows/p1.yml`、`build/p1-status.json`。记录更新于 README、本文件、P1-ACCEPTANCE 和 P1-validation；P0 冻结文件及 Worker/平台原生包未修改。

### 实际命令与结果

所有系统命令经真实 Git Bash 运行，PowerShell 入口先设置 UTF-8，临时 PATH 首位为 `.tools/node`。下面的 `pnpm` 实际调用方式为 `node .tools/pnpm/bin/pnpm.cjs`。

```sh
git switch -c codex/p1-control-plane
pnpm install --ignore-scripts
node --test tests/p1/persistence.test.ts
pnpm build
pnpm stage:sidecar
pnpm prepare:electron
pnpm test:integration
pnpm check:p1
pnpm install --frozen-lockfile --ignore-scripts --offline
pnpm lint
git diff --check
```

初次完整检查通过 44/44 工程与真实 SQLite 单元测试、9/9 真实进程测试，0 skipped。最终审查补充最长 JSON 转义回归：`node --test --test-name-pattern="maximally escaped" tests/integration/electron.test.mjs` 在修复前实际失败，返回 `CONTROL_PLANE_REQUEST_FAILED`。修复后再次完整 `check:p1` 退出 0：44/44 工程与数据库测试、10/10 真实进程测试，0 fail、0 skipped。最终运行结果和时间见 `P1-validation.json` 的 `continuation.localEvidence`；该记录包含命令退出码、运行时信息及进程测试原始输出。本地记录的 source 指向 P1.1 父提交且 sourceDirty=true，明确表示尚未提交的本轮工作树，不将其冒充父提交 CI。

### 失败与修复记录

| 实际失败 | 修复与验证 |
|---|---|
| 新数据库测试报 `ERR_MODULE_NOT_FOUND` | 实现 Express 所有的 store 与 SQL migration 后真实 SQLite 测试通过 |
| pnpm deployment 自引用越界，`STAGED_SYMLINK_ESCAPE` | 精确移除已验证的源码 self-link；生产依赖先做路径检查再物化 |
| isolated pnpm 布局物化后丢失 `zod` 解析 | 改用 hoisted 的独立生产部署闭包；真实 staged Node 加载 DB 与 Express 成功 |
| Electron 官方安装 fetch 失败、未完整归档 hash 错误 | 从同一官方 URL 使用 curl 临时下载，按 npm 包固定的 checksum 验证后才使用 |
| 测试清理先删除目录而 DB 进程尚未退出 | 追踪并先关闭各临时目录的 Sidecar，再删除仓库内测试目录 |
| strict 平台索引类型及 lint 未使用表达式 | 明确 Partial 平台映射和条件分支，未放松 strict/lint |
| Electron harness 顶层 `await app.whenReady()` 死锁 | 改用 ready 回调；真实 harness 和生产 Main 入口都能启动、退出 |
| 100 条最长合法转义记录超过 64 KiB 响应上限 | 有界上限调整为 192 KiB，覆盖 Schema 允许值的 JSON 最坏膨胀；新增真实 Preload/SQLite 关闭重开回归 |

### GitHub CI 与剩余范围

2026-10-27 已提交并通过常规 Git push 上传代码提交 `a1d3ef2833ea913dd2c1b2ab9fbfe7cc5b541214`。该提交的 [P1 CI 40463899742](https://github.com/JaxLim/OperationAgent/actions/runs/40463899742) 与 [P0 重放 40463899772](https://github.com/JaxLim/OperationAgent/actions/runs/40463899772) 均为 success；逐个读取 P1 job 原始日志，结果如下。本节及 JSON 的 CI 索引是后续纯证据提交，不将被引用提交伪装为自指 SHA。

| Job | 实际结果 | 证据 |
|---|---|---|
| Windows 2025 / x64 | 44/44 工程/DB + 10/10 真实进程，0 fail、0 skipped；Electron 45.0.0 官方归档 SHA-256 校验、Node 24.22.1 / ABI 137 / NAPI 10、SQLite 3.53.4 | [122054626694](https://github.com/JaxLim/OperationAgent/actions/runs/40463899742/job/122054626694) |
| macOS 15 / arm64 | 44/44 工程/DB，0 fail、0 skipped；进程集成 NOT_RUN | [122054626341](https://github.com/JaxLim/OperationAgent/actions/runs/40463899742/job/122054626341) |
| Ubuntu 24.04 / x64 | 44/44 工程/DB，0 fail、0 skipped；进程集成 NOT_RUN | [122054626637](https://github.com/JaxLim/OperationAgent/actions/runs/40463899742/job/122054626637) |

三个 P0 job 均成功，重放固定历史提交 `04d07be`。本轮 Windows x64 job 运行完整 `check:p1` 和真实 Electron/独立 Node/SQLite；macOS/Linux 只运行 `check:engineering`。三份 `p1-evidence-*` artifact 均上传成功，保存完整命令日志与 runtime/checks/integration JSON，保留 14 天；artifact ID/digest/到期日见 `P1-validation.json`。本轮没有 CI 失败；upload-artifact v4 的上游 Node 20 runtime 收到弃用提示，runner 实际以 Node 24 执行且上传成功。

上传命令：`git commit -m "feat(p1): run authenticated Electron sidecar with durable SQLite"`、`git -c http.version=HTTP/1.1 push -u origin codex/p1-control-plane`，退出码均为 0。分支未合并；审查 PR 仅在本轮验收和 CI 通过后创建。

仍为 NOT_RUN：macOS/Linux 进程链路、原生 WorkerLauncher、OWIP/1、AppContainer、原生服务树监管、安装器与安装后 SEC-18、完整 SEC-03/17/SEC-W01、P1 总退出。当前无后代执行器；父通道/租约清理不等同卡死或恶意后代的 OS 强制清理。产物 hash 不等同代码签名，也不抵抗同用户本地恶意修改整个应用；回环监听器可能被本地进程造成拒绝服务，所有异常保持 fail closed。`agentReady=false`，不启用 Worker/Agent Loop/Shell/文件写工具/真实模型。

## PR #2 审查修复（2026-10-27 实测；28 日继续提交）

修复共享 HTTP 计数器导致合法 Main 心跳被拒绝的问题：未认证、普通认证请求和 Main 专用 `/v1/heartbeat` 分别限流；Renderer 健康查询保持普通预算。心跳有独立有界重放记录和 Main 并发保留位，仍验证完整 HMAC、身份、时间与跨通道 requestId 重放。

SQLite 新增 `002-string-length.sql`，使用确定性 `oa_utf16_length` 与 Zod 的 UTF-16 长度语义一致。`001-control-plane.sql` 原始字节及已部署 checksum 保持不变；历史连续版本及全部已应用 checksum 先校验，再在同一事务升级。健康契约报告 databaseVersion=2。实测原数据、时间和运行记录保留；002 中途失败可完整回滚并重试。

回归先在旧代码实际失败：前导 NUL 触发 `SQLITE_CONSTRAINT_CHECK`；共享预算耗尽后合法请求返回 `429`。修复后 `pnpm check:p1` 全部门禁通过：**47/47 工程/数据库测试、13/13 Windows 真实 Node/Electron 进程测试，0 fail、0 skipped**。覆盖前导/全 NUL、中文/代理对长度边界、真实 Preload 最坏转义关闭重开、未认证及重放洪泛、普通认证突发、独立心跳限额；跨越租约期限后原 Sidecar PID/实例保持、重启计数为 0。P0 冻结重放、类型、lint、导入边界、构建均通过。

本地证据位于 `artifacts/p1/win32-x64/`，完成时间 `2026-10-27T12:04:20.258Z`，基线 `5fa460c` 且 `sourceDirty=true`；不将工作树结果冒充该基线 CI。新提交的 GitHub CI/审查状态另以 PR #2 的真实记录为准。用户本次已授权 P1.4–P1.7 连续开发；本修复提交仍只包含 P1.2/P1.3 修复，不提前宣称后续阶段通过。

## P2.0 契约基础（2026-10-30，本地，未提交）

用户要求评审现状、排出路线图（见 [ROADMAP.md](ROADMAP.md)），并执行约一小时可完成的工作。本节只记录这部分工作。`build/p1-status.json` 和检查器均未改动，P2 的阶段授权还需另行正式记录；本轮不声称 P2 已开始或已通过。

- 新增 `packages/contracts/src/events/tool-output.ts`（§9.1.1）。`deltaPersistence` 只能取 `transient`，chunk 按 UTF-8 字节限长，摘要计数做一致性校验；`TOOL_OUTPUT_PERSISTENCE` 规定只有摘要会持久化。
- 新增 `packages/contracts/src/events/task.ts`：九个任务状态和冻结的迁移表。在 §8.1 示意图的基础上，补了 §8.2–8.4 要求的停止边和中断边。`STOPPED` 要求 `cleanupConfirmed`，`INTERRUPTED` 恢复要求 `userConfirmed`，终态不再迁移。另有 `SideEffectStatus`、`TaskEvent`（任务内从 1 开始、无间隙的 `seq`）和纯函数 `replayTaskEvents`：它拒绝序号间隙、重复事件、跨任务事件和状态不连续，发现问题只报告、不修复。
- `errors/` 新增领域错误 `AppErrorSchema` / `DomainErrorCodeSchema`。原 RPC `ErrorCodeSchema` 不变，有测试锁定。
- 没有改数据库、HTTP 路由、Preload、Renderer 或 Worker，执行能力不变，任务入口仍返回 `WORKER_ISOLATION_UNAVAILABLE`。

验证：在 PATH 前部放 `.tools/node`（v24.22.1）后运行 `pnpm check:engineering`，七项全部退出 0（typecheck、lint、check:boundaries、test、build、verify:p0、verify:p1）。测试从 76/76 增加到 **84/84**，0 fail。另做一次变异检查：给 `STOPPING` 临时加上 `FAILED` 边后，对应测试失败；还原后通过。没有运行 `test:integration`、安装包或 CI，这部分仍待提交后由 CI 产生证据。

### P2 授权记录（2026-10-30）

用户在 PR #3 合并前正式授权 P2 范围。原话：“Authorize P2.0–P2.3”，回答的问题是 “Which P2 scope do you formally authorize, so I can record it and finish the merge?”。记录方式沿用 P1：

- `build/p2-status.json`：授权阶段 P2.0–P2.3，止于 P2.3；P2.0 标为 implemented，P2.1–P2.3 标为 not-started；`p2TotalExit=NOT_RUN`；`agentReady=false`；三平台能力全部 unverified。`build/p1-status.json` 保持不变。
- `scripts/p2-check.ts`（`pnpm verify:p2`，已加入 `run-checks`，CI 中随 `check:p1` / `check:engineering` 运行）：
  - 逐字校验授权原话和日期；
  - 要求 P1 已有证据支撑的退出（`PASS_WIN32_X64`）；
  - P2.0 的完成声明要求契约文件存在；
  - 在各自证据检查建立前，拒绝把 P2.1–P2.3 或 P2 总退出标为完成；
  - 拒绝越出授权范围和任何虚假资格。
- `tests/p2/stage.test.ts` 覆盖上述各项的正例和负例。

## P2.1 任务与事件存储（2026-10-30）

授权：用户 2026-10-30 授权 P2.0–P2.3（记录于 `build/p2-status.json`），随后指示“Start P2.1”。

- `apps/server/migrations/004-task-events.sql`：
  - `tasks` 每个任务一行，保存当前状态和 `last_seq`；`project_id` 不设外键，项目被移除后任务的审计记录仍然保留。
  - `task_events` 以 `(task_id, seq)` 为主键，`event_id` 唯一，`request_id` 在非空时唯一，payload 必须是不超过 32 KiB 的合法 JSON。
  - 数据库触发器保证 seq 从 1 起连续无间隙，并拒绝任何 UPDATE/DELETE（`TASK_EVENTS_APPEND_ONLY`），作为 Express 代码之外的第二道防线。
  - 不保存提示词、tool_output_delta 或任何密钥。
- `apps/server/src/persistence/tasks.ts`（仅 Express 内部使用）：
  - `createTask`、`transitionTask`、`recordToolSummary` 都在 immediate 事务内把状态和事件一起提交；迁移合法性由 contracts 的 `checkTaskTransition` 判定，被拒绝的请求不写入任何数据。
  - 同一个 `requestId` 只应用一次：重复的相同操作返回已提交的结果，用于不同操作则返回 `REQUEST_CONFLICT`。
  - `listTaskEvents(taskId, afterSeq, limit≤200)` 按 seq 顺序分页；读取时用 contracts 重新校验存储的 JSON，不合法即失败（fail closed）。
- 启动对账：`openStore` 在原有的运行记录恢复事务内，把所有未结束的任务迁移到 `INTERRUPTED` 并写入事件。RUNNING、WAITING_APPROVAL、STOPPING 的副作用记为 `UNKNOWN`，CREATED、QUEUED 记为 null。恢复需要用户确认，不会自动重放任何任务（ADR-005/010）。
- 数据库版本从 3 升到 4，同批更新了 contracts（`ControlHealth`/`ControlOverview`）、P1 持久化测试、Electron 集成测试和安装后烟测的期望值。`verify:p2` 扩展为：P2.1 的完成声明要求迁移、`tasks.ts` 和测试文件存在，且 P2.0 已标记完成；P2.2、P2.3 仍不得声称完成。

验证：`pnpm check:engineering` 八项全部退出 0，测试从 88 增加到 **94/94**；新增 `tests/p2/task-store.test.ts`（6 项）覆盖原子提交、拒绝不写入、seq 连续与游标分页、请求去重与冲突、摘要上限与终态拒绝、重启对账与读回，以及数据库层的只追加和无间隙约束。另做一次变异检查：去掉 `transitionTask` 的事务后，注入的提交失败会留下孤立事件，对应测试失败；还原后通过。真实进程集成结果见下文；安装后烟测（`pnpm package && pnpm test:smoke`）未在本地运行，由 CI 执行。

本地真实进程集成（`pnpm test:integration`，Windows x64，工作树基于 `f5740ee` 且有未提交改动）退出 0：真实 Node/Electron 进程测试 14/14，原生接口测试 2/2，0 fail、0 skipped；Electron 测试确认 `overview.database.version` 为 4。Worker fixture 在本开发机上按 ADR-WIN-001 §3 记为 `BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST`，真实 fixture 证据仍只能来自一次性 CI runner。本地结果不能代替 CI 证据。

## P2.2 快照与游标补拉（2026-10-31）

授权：P2.0–P2.3（`build/p2-status.json`），用户指示 “Start P2.2”。全部为只读接口：没有任何路由会创建、启动或修改任务，任务启动入口仍返回 `WORKER_ISOLATION_UNAVAILABLE`。

- 契约 `packages/contracts/src/api/tasks.ts`：
  - `TaskRef`、`TaskEventsQuery`（`afterSeq` 为非负安全整数，`limit` 为 1–200）、`TaskList`（最多 50 个）、`TaskEventPage`。
  - 页面结构本身就能证明三件事：属于同一任务；从 `afterSeq+1` 起连续无间隙；且 `hasMore` 为真时必然前进（每页至少一个事件），因此客户端循环一定会结束。
  - `catchUpTaskEvents` 是先取快照、再按游标补拉的纯函数（受 `maxCatchUpPages` 限制）。出现无效页、页面游标或任务不符、序号或状态不连续时，它返回错误、不做修补，调用方应重新获取快照。
  - 新增控制面错误 `CURSOR_AHEAD`：客户端游标超出已提交的日志，例如数据库已被替换。
- Express 新增三个路由：`GET /v1/tasks`、`POST /v1/tasks/snapshot`、`POST /v1/tasks/events`。
  - 快照和页面在单写入者的同一同步调用中读取，彼此一致。
  - 页面按序列化后的字节数截断（`maxPageBytes` 60 KiB，单个事件总能放下），远低于 Main 的 192 KiB 响应上限。
  - 游标超前返回 409，未知任务返回 404，输入不合法返回 400。
- Main 新增 3 个固定 IPC 通道（`oa:tasks-list`、`oa:tasks-snapshot`、`oa:tasks-events`），Preload 新增 `listTasks`、`getTask`、`listTaskEvents`，两侧都做 Schema 校验。没有通用请求通道。
- 导入边界：`scripts/import-boundaries.mjs` 的 IPC 操作白名单新增上述 3 个只读操作，做法与 P1 Workbench 新增操作时相同。规则本身不变：每个 `invoke` 仍只能使用白名单内的 `IPC_CHANNELS` 成员。
- `verify:p2`：P2.2 的完成声明要求 `api/tasks.ts` 和 `tests/p2/task-api.test.ts` 存在，且 P2.1 已标记完成；P2.3 仍不得声称完成。

验证：
- `pnpm check:engineering`：八项全部退出 0，测试从 94 增加到 **97/97**。新增 `tests/p2/task-api.test.ts`，覆盖页面连续性和必然前进、查询边界、多页补拉、从游标恢复，以及各类不一致页面被拒绝。
- 本地 `pnpm test:integration`（Windows x64）退出 0：真实进程测试 **15/15**，原生接口测试 2/2。
  - 新增的真实进程测试先用 Express 存储写入一个已完成任务（12 个事件，其中 8 个约 15.6 KiB 的摘要），再从独立启动的 staged sidecar 经认证 HTTP 读取：多页字节受限分页、完整重建、从游标恢复，以及不一致状态、游标超前、未知任务和非法输入均按预期失败。
  - Electron 测试确认真实桥接暴露了新增的 3 个 API：被拒绝的任务启动不留下任何任务，未知查询返回 NOT_FOUND，非法游标被拒绝。
  - Worker fixture 在本机仍为 `BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST`。

安装后烟测由 CI 运行。

## P2.3 Workbench 任务视图（2026-10-31）

授权：P2.0–P2.3（`build/p2-status.json`）。用户 2026-10-31 指示完成 P2.3 后继续推进后续里程碑。执行能力不变：任务启动仍被拒绝，提示词不存储。

- Renderer 状态（`state.ts`）：Express 的快照是唯一事实来源。
  - 每个任务记录本窗口已应用的游标（`appliedSeq` 和回放得到的状态），通过契约中的 `catchUpTaskEvents` 补拉。
  - 控制面换了新实例后，先重新读取快照，再从原游标继续补拉。
  - 游标超前或页面不一致时，从零重来一次；第二次仍失败就显示“out of sync”并提供 Resync。
  - 回放结果与快照不一致时显示 `STATE_MISMATCH`，不在本地自行判断。
- 界面：
  - 侧栏列出当前项目的已提交任务，显示状态色点和更新时间；没有任务时保留原有的门禁说明。
  - 详情页（`TaskDetail.tsx`）显示状态、已同步事件数和事件时间线：创建事件、状态迁移（含原因和副作用）、工具结果摘要（退出码、字节数、诊断）。
  - `INTERRUPTED` 任务提示副作用可能未知，并说明不会自动恢复，恢复需要隔离 Worker。
  - 全部使用现有设计令牌和样式类。
- `verify:p2`：P2.3 的完成声明要求 `TaskDetail.tsx` 和 Electron 集成测试存在，且 P2.2 已标记完成。P2 总退出仍为 NOT_RUN，需要已提交的 CI 证据。

验证：`pnpm check:engineering` 八项全部退出 0（97/97）。本地 `pnpm test:integration`（Windows x64）退出 0：真实进程测试 **16/16**，原生接口测试 2/2。新增的 Electron 测试先用 Express 存储写入一个已完成任务和一个停在 RUNNING 的任务，再启动真实 Electron 窗口：
- 点击侧栏任务行，等待游标同步完成，核对时间线内容（含工具结果、`exit 0` 和诊断信息）；
- 停在 RUNNING 的任务被 sidecar 启动对账标为 `INTERRUPTED`，界面显示 `side effects UNKNOWN` 和不会自动恢复的提示；
- 强杀 sidecar 后，界面在新的 Express 实例上重新同步（要求同步时间晚于重启），事件数不变。

测试还保存了真实窗口截图（`artifacts/p1/win32-x64/workbench-task.png`），供目视检查。隐藏窗口不会重绘，所以截图前会短暂以不抢焦点的方式显示窗口。

## M1：SEC-W01 Windows 生产 Worker 门禁（2026-10-31，进行中）

授权：用户 2026-10-31 的原话已记录在 `build/agent-status.json`，内容包括后续里程碑可自主推进、模型供应商选定 Claude、授权 M1–M4。`verify:agent`（`scripts/agent-check.ts`）校验以下几点：
- 授权原话和供应商与记录完全一致；
- 只有已提交的一次性 runner 证据显示 `secW01: PASS`（`docs/evidence/m1/<平台>/`）时，平台的 SEC-W01 才能标 PASS；
- `productionWorkerQualified` 需要 Windows 的 SEC-W01 PASS，且 M1 已完成；
- `agentReady` 还需要 M2 完成；
- 一个平台的证据不能用于其他平台。

方法：在 `tests/` 下单独构建一个仅供测试的 probe runtime（`tests/worker-fixture/probe-bootstrap.mjs`），绝不进入任何发布包。它经生产 launcher 路径在真实的 AppContainer 和 Job 中启动，扮演已被攻陷的 Worker：
- 先尝试所有被禁止的操作，再加载受信通道；
- 结果写成一行 `OA-PROBE`，通过有界 stderr 诊断管道上报；
- 然后照常完成 OWIP/1 握手和两阶段停止。

测试宿主准备的目标：
- 工作区、用户目录和 TEMP 中的 canary 文件，以及仓库 `.git/config`；
- 会计数的 127.0.0.1 TCP、::1 TCP 和 127.0.0.1 UDP 监听器；
- 一个用于“杀进程”尝试的旁路进程；
- 宿主侧对公网、IPv6 和 DNS 的对照连接。

| SEC-W01 项目 | 覆盖 |
|---|---|
| 用户文件与凭据 | 读取工作区、用户目录、TEMP canary 和 `.git/config`；列出用户目录、仓库和 Users；写入工作区、用户目录、TEMP 和 runtime 自身，全部必须为 DENIED |
| 环境与凭据泄漏 | Worker 环境变量名必须恰好是 6 项白名单，不含任何 token 或 PATH |
| 全目标网络和回环 | 公网 TCP4/TCP6、公网 UDP DNS、本机 DNS 解析、回环 TCP4/TCP6/UDP4；监听器命中数必须为 0；超时一律视为 UNKNOWN，即失败 |
| 子进程和危险操作 | spawn 和终止旁路进程都必须为 DENIED，旁路进程必须仍然存活；基线要求 `noChildProcessCreation`、恰好 3 个继承句柄、低完整性、零能力 |
| 原生边界 | 通道组件只导出 `close,read,write`；加载父端 launcher 组件必须被拒（Access is denied） |
| 启动竞态、实例复用、预算、故障回收 | 由现有 P1.4/P1.5 runner 套件覆盖：挂起状态下核验基线、SEC-17、重启预算、hang/exit 回收 |
| 安装包 | 发布包不含 fixture 或 probe；由 P1.6 安装后烟测验证 |

本地验证：
- 未加沙箱的 dry run 中，所有探针都报 ALLOWED（回环 UDP 报 SENT，三个监听器各被命中一次，旁路进程被杀死），说明每个探针都能真实检测到“成功”。
- 本机运行 `sec-w01.test.mjs` 时按规定报 BLOCKED。
- `check:engineering` 九项全部退出 0（100/100）。

真实结论只能来自一次性 Windows runner。在证据提交之前，`secW01` 保持 NOT_RUN，`productionWorkerQualified` 保持 false。

### M1 结果：Windows x64 SEC-W01 通过（2026-10-31）

一次性 runner 运行 [41195176816](https://github.com/JaxLim/OperationAgent/actions/runs/41195176816)，源提交 `7dce7c4`，`integration.json` 中 `secW01: PASS`。证据已提交到 `docs/evidence/m1/win32-x64/`，包括 `integration.json`、原始 `sec-w01.json` 和测试日志。

- 文件、凭据、进程和原生边界：全部 DENIED。
- 环境：启动时恰好是 6 项白名单，通道加载后只剩 5 项。
- 正向对照：原生通道只导出 `close,read,write`，旁路进程存活，三个回环监听器命中数均为 0。
- 公网 TCP4：EACCES，WFP 审计有出站拦截记录（5152/5157）。
- 回环 TCP4/TCP6：系统报 ETIMEDOUT（AppContainer 回环隔离），宿主对照可达，监听器零命中。
- 公网 UDP DNS：Worker 收不到响应，而宿主对照收到了；WFP 审计记录了 `1.1.1.1:53/UDP` 的出站丢包和拦截（5152、5157）。
- 公网 IPv6：runner 本身没有 IPv6 出口，因此添加 ULA 地址和指向不存在下一跳的主机路由。宿主对照为“已路由但无应答”（TIMEOUT），不再是 ENETUNREACH；Worker 的连接为 DENIED，WFP 审计记录了 `[2606:4700:4700::1111]:443/TCP` 的出站连接拦截（5157）。
- 两条 Codex 审查意见均已处理：原始报告必须逐项通过共享规则并与集成记录同源；无路由一律视为“无法判定”，不算拒绝。

据此，`build/agent-status.json` 记录：Windows x64 SEC-W01 PASS，M1 完成，`productionWorkerQualified: true`，`verify:agent` 用已提交的原始证据复核。`agentReady` 仍为 false，要等 M2 的 Agent Loop 实现后才能设置；macOS 和 Linux 的 SEC-W01 仍为 NOT_RUN，不继承 Windows 的结论。

## M2 第一切片：Claude 接入、模型设置与设计系统（2026-10-31）

授权：用户授权里程碑 M1–M4，模型供应商为 Anthropic Claude，要求优先交付可用且精致的 Agent，并从 M2 起采用参考 Lusion 的高级界面风格。本切片只交付凭据、模型网关、模型设置和设计系统；**真实 Worker/Agent 执行仍关闭**：本切片开发时 SEC-W01（M1，PR #7）尚未合并。PR #7 合并后（`27d3014`），Windows 生产 Worker 已获资格（`productionWorkerQualified=true`），但 Agent Loop 还不存在，所以任务启动继续返回 `WORKER_ISOLATION_UNAVAILABLE`，`agentReady=false`。本切片未改动 `tests/worker-fixture/**`、`scripts/sec-w01-rules.ts` 和 `scripts/agent-check.ts`；合并 main 后，`build/agent-status.json` 中只把 `M2` 改为 `in-progress`，其余字段保持 M1 的取值。

- 契约 `packages/contracts/src/api/model.ts`：
  - 模型固定为 `claude-sonnet-5-5`（默认）、`claude-opus-5-5`、`claude-haiku-5-5`。
  - `ApiKeySchema`：20–256 个可见 ASCII 字符，不允许空白；Zod 校验失败的信息不含输入值。
  - Renderer 视图 `ModelSettingsView` 只包含供应商、模型、`configured` 状态、4 位识别提示（`hint`，密钥末 4 位）和 `secureStorage`（available/unavailable）。严格 Schema 保证回复不会携带任何密钥材料。
  - 连接测试结果 `ModelTestResult` 归一化为 `ok / auth_failed / rate_limited / model_unavailable / provider_error / unreachable / not_configured / credential_unavailable`，只附 HTTP 状态码和耗时，不转发供应商的正文、头或错误文本。
  - Crypto Bridge 消息（`crypto-request` / `crypto-response`）绑定 `mainRunId/expressRunId` 和 `requestId`，只有 encrypt、decrypt 两个操作，大小有界。
  - 端点：生产固定为 `https://api.anthropic.com`。Bootstrap 新增可选 `modelEndpoint`，只接受 `http://127.0.0.1:<port>`，供测试接入本地假供应商；生产入口从不设置它。
  - 新增控制面错误码 `SECURE_STORAGE_UNAVAILABLE`；`ControlHealth`/`ControlOverview` 的数据库版本由 4 升到 5。
- 持久化：迁移 `005-model-credentials.sql` 新建 `model_credentials`（provider、scheme=`electron-safestorage-v1`、base64 密文、hint、更新时间）和 `model_settings`（模型选择）。SQLite 只保存密文和非敏感元数据；读取到未知模型时回退默认值，不信任存储内容。数据库版本 4→5，同批更新了 P1 持久化测试、Electron 集成测试和安装后烟测的期望值。
- Express（`apps/server/src`）：
  - `credentials/service.ts`（CredentialService）：保存前必须先经 Main Crypto Bridge 加密；桥不可用时拒绝（SEC-14），不做任何弱化回退。若桥返回的“密文”包含明文，同样拒绝。失败只抛固定错误码且不带 cause。使用密钥时每次解密一次，只交给一个回调，不缓存。
  - `credentials/bridge.ts`：Express 端经继承的 Node IPC 通道向 Main 请求加/解密。回复必须匹配未完成的 `requestId` 和本服务树身份；同时最多 4 个请求，每个 5 秒超时。没有 Main 时默认 fail closed。
  - `models/gateway.ts`（Model Gateway）：唯一操作是“测试连接”，用 `fetch` 发送一次最小的 Messages API 请求（`max_tokens: 1`，`anthropic-version: 2023-06-01`），15 秒超时，并设置 `redirect: 'error'`，防止 `x-api-key` 随重定向发往其他源。响应正文直接丢弃。
  - 新增 4 个路由：`GET/PUT /v1/model/settings`、`PUT /v1/model/credential`、`POST /v1/model/credential/clear`、`POST /v1/model/test`。连接测试同一时间只跑一个，并发请求共用同一结果。没有通用代理。
- Main（`apps/desktop/src/main`）：
  - `crypto-bridge.ts`：Main 中唯一接触明文的模块，使用 Electron `safeStorage` 的异步 API（`isAsyncEncryptionAvailable`、`encryptStringAsync`、`decryptStringAsync`）。只响应当前活动服务树经自身继承通道发来、身份一致的请求，限制并发数，不缓存、不记日志，错误里不带明文。Linux 的 `basic_text` 后端视为不可用。
  - Supervisor 只对当前活动实例的继承通道提供 Crypto Bridge。新增 5 个固定 IPC 通道：`oa:model-settings-get`、`oa:model-choice-save`、`oa:model-key-set`、`oa:model-key-clear`、`oa:model-test`。
  - 设置密钥使用单独的注册函数：先在 Main 检查安全存储是否可用，失败只返回固定错误码、不附 cause。连接测试的 Main 侧超时为 20 秒，其余请求仍为 2 秒。
  - Preload 对应新增 5 个方法，两侧都做 Schema 校验；本地校验失败只抛 `VALIDATION_ERROR`。IPC 操作白名单（`scripts/import-boundaries.mjs`）同步新增这 5 项。
- 已知残余风险（ARCHITECTURE §6.3，未改变）：首次录入时明文依次经过 Renderer、Preload、Main 代理，再经回环 HTTP 到 Express，并在 Crypto Bridge 加/解密时短暂出现在 Main；连接测试时 Express 短暂持有明文。JS 字符串无法保证清零。已保存的密钥不回读到 Renderer：输入框在保存成功后立即清空，不进入长期状态。`decryptStringAsync` 返回的 `shouldReEncrypt` 暂不处理（不影响正确性，后续切片可补上重新加密）。
- 设计系统（`styles/app.css`，在原有令牌上扩展，没有重写应用）：
  - 参考 lusion.co 的克制风格：单一电光蓝强调色（浅色 `#1f3bf0` / 深色 `#7d8cff`），展示字号配紧字距，微标签采用大写加宽字距，按钮为胶囊形，层次靠细线加柔和多层阴影和毛玻璃浮层，过渡采用 expo-out 曲线（`cubic-bezier(0.16, 1, 0.3, 1)`，与 Lusion 站点 CSS 一致）。
  - 动效令牌：时长 `--dur-fast/base/slow`；三条按 SwiftUI `spring(response, dampingFraction)` 采样成 CSS `linear()` 的弹簧曲线（`--spring-snappy` 0.32/0.86、`--spring-smooth` 0.45/1.0、`--spring-bouncy` 0.5/0.72），各配一个停稳时长。没有引入新依赖。
  - 对话框带弹簧进场和短退场动画（`Modal` 等退场动画播完再卸载）。分段控件和设置导航的滑块用弹簧移动，设置分区切换时内容平滑落位，提示条改为毛玻璃样式。`prefers-reduced-motion` 下所有动画和过渡缩短到 1ms，状态变化保留。
  - Settings 重排为带编号的分区导航（01–05），新增 **Model** 分区，包含：供应商卡片（显示是否已配置密钥）、三张模型卡片、API Key 字段（已保存时只显示 `sk-ant-••••末4位`，可替换或移除；安全存储不可用时说明原因并禁止保存）、Test connection 按钮及各结果状态的说明。状态栏显示当前模型和密钥状态，点击可直接打开 Model 设置。

验证（本地 Windows x64，工作树基于 `ee8eeed`，改动未提交）：
- `pnpm check:engineering` 八项全部退出 0，测试从 97 增加到 **106/106**。新增 `tests/m2/model.test.ts`（9 项），覆盖：
  - 契约：拒绝的密钥不出现在错误中；端点只能是固定地址或回环；视图不能携带密钥材料。
  - CredentialService：SQLite、WAL 文件的全部字节中都找不到明文。
  - SEC-14：安全存储不可用、桥原样回显明文、桥报错这三种情况都不写入任何数据，错误信息也不透传。
  - Express 端桥客户端：按 requestId 和身份匹配回复，并发上限与超时生效。
  - Main Crypto Bridge（使用假存储）：拒绝外部服务树，安全存储不可用或 Linux `basic_text` 时拒绝，错误中没有明文。
  - Gateway（对接本地假供应商）：请求头与请求体正确，各状态码映射正确，端口关闭时报 unreachable，重定向目标收不到任何请求，超时按 unreachable 处理。
- 本地 `pnpm test:integration` 退出 0：真实进程测试 **17/17**，原生接口测试 2/2。新增的 Electron 测试使用回环假供应商，全程走真实桥：
  - 在真实 DOM 中打开 Settings › Model，输入并保存密钥，然后运行 Test connection；保存后 DOM 中不再残留明文。
  - 经 API 验证两侧的 Schema 校验和模型切换，所有回复都不含密钥。
  - 把 `safeStorage` 修改为不可用后，保存被拒绝（`SECURE_STORAGE_UNAVAILABLE`），已存的密钥不变。
  - 重启后密文仍能经新实例的桥解密并测试成功；清除后返回 `not_configured`。
  - 扫描整个数据目录（SQLite、WAL、Chromium 配置目录）以及全部进程输出，均未发现明文。
  - Worker fixture 在本机仍为 `BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST`。
- 截图：测试从真实窗口截取的浅色和深色截图，复制到 `docs/evidence/m2/win32-x64/settings-model-{light,dark}.png` 供评审。
- 未验证：安装后烟测（`pnpm package && pnpm test:smoke`，期望值已改为迁移 1–5）由 CI 运行；未对真实 api.anthropic.com 发起请求；macOS/Linux 的 `safeStorage` 行为未测试。本地结果不能代替 CI 证据。

PR #8 评审修正（同日）：
- 保存时立即清空输入框：不论成功还是失败，密钥都不会留在 Renderer 状态或 DOM 中。
- 保存和移除密钥时，Main 侧超时改为 12 秒，长于 Crypto Bridge 的 5 秒超时。保存若未得到确认，界面会重新读取实际状态，不再断言“未写入”。
- Express 收到超时后才到达、但身份合法的加密回复时，直接丢弃，不再误判为关闭消息而停止控制面。
- CredentialService 的保存与移除按请求顺序串行执行，先发出的保存不会撤销已确认的移除。
- 连接测试按配置版本区分：Express 只让配置相同的测试共享进行中的请求；Renderer 丢弃在模型或密钥变更前发起的测试结果。

以上修正新增 2 项单元测试；本地 `check:engineering` 与 `test:integration`（17/17、2/2）均再次退出 0。

合并 main（M1，`27d3014`）后：`pnpm check:engineering` 九项（含 `verify:agent`）全部退出 0，单元测试 **113/113**；本地 `pnpm test:integration` 退出 0，真实进程测试 17/17，原生接口测试 2/2。本机的 Worker fixture、SEC-17 和 SEC-W01 仍为 `BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST`，Windows SEC-W01 的 PASS 来自 M1 已提交的 CI 证据。

### PR #8 收尾审查（2026-10-31）

主会话接手 PR #8 后，复核了凭据、Crypto Bridge、模型网关和 IPC 链路。Codex 的 5 条意见已在 `ae79ddd` 中处理，包括 Renderer 不保留明文 key、凭据请求时限长于 bridge、过期的 bridge 回复不触发关停、保存与删除串行化、过时的连接测试结果被丢弃，线程均已解决。本轮另外做了两处修正：

- 纵深防御：打包后的应用如果收到 `modelEndpoint` 覆盖（测试用的本机假服务端），直接拒绝启动（`MODEL_ENDPOINT_OVERRIDE_REJECTED`），避免真实 key 以明文 HTTP 发往本机监听者。生产入口本来就不传这个参数，此项只是防止将来误用。
- 状态文案更正：M1 合并后，“Windows Worker 门禁未通过”已不成立。概览契约中 `worker.reason` 改为 `AGENT_LOOP_NOT_IMPLEMENTED`，这在所有平台都成立；Status 面板标签改为 “Blocked by”；Settings、About、侧栏和任务拒绝提示统一说明执行能力随 Agent Loop 推出，且只在 Worker 已通过隔离门禁的平台开放。控制面不在运行时声称任何平台的门禁结论，该结论只以构建记录 `build/agent-status.json` 为准。

收尾验证（Windows x64 本地）：
- `pnpm check:engineering` 九项全部退出 0（**113/113**），`verify:agent` 显示 M1 已完成、M2 进行中、Windows SEC-W01 PASS、`agentReady=false`。
- `pnpm test:integration` 退出 0：真实进程测试 **17/17**（含模型设置经真实桥接的完整流程），原生接口测试 2/2。
- Worker fixture 和 SEC-W01 在开发机上按规定为 BLOCKED，由 CI 一次性 runner 执行。
