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
