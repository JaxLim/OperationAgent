# P0 实际执行与验证记录

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
