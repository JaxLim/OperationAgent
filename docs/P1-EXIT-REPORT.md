# P1 退出报告（P1.4–P1.7）

日期：2026-10-29。授权：用户 2026-10-27 正式授权连续实施 P1.4–P1.7，2026-10-28 要求完成 P1、集成 Workbench UI 并交付可安装 Windows 应用。规范来源仍为 `ARCHITECTURE.md` / `AGENTS.md` `0.4.0-p0` 与 ADR-WIN-001 r1；本轮未修改任何冻结文件（`pnpm verify:p1` 逐字节核对）。

**结论：Windows x64 的 P1 总退出条件已有真实证据通过；`agentReady=false`、生产 Worker 未获资格，所有平台能力保持 unverified。** macOS/Linux 仅通过工程门禁，进程/Worker/安装包验收 NOT_RUN，不继承 Windows 结论。

## 1. 证据

| 项目 | 结果 | 证据 |
|---|---|---|
| 三平台工程门禁 + Windows 真实进程验收 | 全部通过 | CI run [40796366405](https://github.com/JaxLim/OperationAgent/actions/runs/40796366405)，源提交 `d503ee8` |
| P1.4 受限 fixture（一次性 GitHub Windows runner） | 10/10 通过 | `docs/evidence/p1/win32-x64/integration.json`（`workerFixture: PASS`）、`8.log` |
| P1.5 SEC-17 / 预算 / 两阶段清理 | 通过 | 同上（真实进程） + `tests/p1/fixture-runtime.test.ts`、`supervision.test.ts` |
| P1.6 安装包 + SEC-18 安装后烟测 | 10/10 通过（CI 干净 runner 与开发机各一次） | `docs/evidence/p1/win32-x64/installed-smoke.json`、`package.json`、`installed-window.png`、`installed-sidecar-suite.log` |

开发主机按 ADR-WIN-001 §3 不得创建 AppContainer profile 或修改 ACL，因此本机运行 `isolated-fixture.test.mjs` 时明确失败为 **BLOCKED**（不 skip、不 mock）；真实 fixture 证据只来自一次性 runner。

## 2. 各阶段交付

**P1.4 Express 平台 WorkerLauncher + OWIP/1**
- 原生父端（`packages/platform-worker/native/parent.cc`）：公开 `CreateAppContainerProfile` → 运行时目录最小 RX 授权（容器 SID + 用户 SID）→ `CreateNamedPipeW`（随机名、显式 DACL、拒绝远程、首实例）+ `CreateFileW` 预连接 → `CreateRestrictedToken(LUA_TOKEN|DISABLE_MAX_PRIVILEGE)` + `CreateProcessAsUserW`，属性为 `SECURITY_CAPABILITIES`（零能力）、`HANDLE_LIST`、`JOB_LIST`（kill-on-close、单进程）、`CHILD_PROCESS_POLICY`；挂起状态下核验 AppContainer、非提升、零能力、≤低完整性、SID、直接父进程、Job 归属、禁止子进程，任一失败即终止。
- 继承句柄仅三项：RPC 管道、NUL stdin、只写 stderr 诊断管道（Express 有界读取 4 KiB，不解析、不持久化）。RPC 通道只有预连接命名管道一条。环境变量为排序白名单（`LOCALAPPDATA/TEMP/TMP` 由系统改写到容器目录）。
- 传输：OWIP/1 8 字节头、≤256 KiB、严格 UTF-8 单对象；每方向 64 在途、1 MiB 数据 + 16 KiB 控制队列；握手 10 s、心跳 1 s × 3；挑战只经继承通道。
- fixture（`apps/agent-worker/src/fixture.ts`）只响应 hello/health/shutdown 与受控故障；受信 bootstrap 以 `process.dlopen` 加载固定 `channel.node`，运行时目录自带 `package.json` 边界，`--preserve-symlinks(-main)` 避免读取祖先目录。
- **发布构建不包含 fixture、bootstrap 或原生 launcher**；生产 Express 从不启动 Worker，任务入口返回 `WORKER_ISOLATION_UNAVAILABLE`。

**P1.5 监督与清理**：`packages/platform-supervision` 提供滑动窗口重启预算（3 次/60 s、指数退避、耗尽即停）、宽限期 5–30 s 注册校验（越界拒绝而非截断）和两阶段停止（仅在观察到退出后报告确认）。Express 的 `FixtureSupervisor` 在清理未确认时拒绝新启动；Main 的 sidecar 监督沿用同一预算并新增用户触发的重试。

**P1.6 打包**：`pnpm package` 将 Main 打包为无依赖单文件、加入经哈希核对的 Node sidecar，输出逐用户 NSIS 安装包。Electron fuses：禁用 RunAsNode / NODE_OPTIONS / inspect 参数，启用 asar 完整性校验与仅从 asar 加载、Cookie 加密。`better-sqlite3` 保持 Node ABI 137，不为 Electron 重编译。冻结的 `build/electron-builder.config.json` 未改动，Windows 设置位于 `build/electron-builder.windows.json` 叠加层。**未代码签名**（未配置证书；设置 `CSC_LINK`/`CSC_KEY_PASSWORD` 即签名）。

**P1.7 CI 与证据**：`.github/workflows/p1.yml` 在 Windows runner 上运行完整进程验收、真实受限 fixture、安装包构建与安装后烟测，并上传 `p1-evidence-*` 与安装包；macOS/Linux 运行工程门禁。状态文件 `build/p1-status.json` 的完成声明由 `scripts/p1-check.ts` 对照本目录证据校验，缺证据或证据失败时声明被拒绝。

## 3. Workbench UI 集成

原 `prototypes/workbench` 的设计（令牌、布局、组件）已迁入 `apps/desktop/src/renderer`（React 19），仿真引擎全部移除，所有数据来自真实链路 Renderer → Preload（固定 13 个 Schema 校验操作）→ Main → 认证 HTTP → Express → SQLite：

- 真实可用：项目（原生文件夹选择器，只存路径，不读内容）、设置（主题/密度/面板/停止宽限期，迁移 003 持久化，主题同步原生窗口）、实时控制面状态与能力矩阵、诊断（运行历史、数据库写入→提交→回读自检、控制面重启）、任务请求（由 Express 校验后以 `WORKER_ISOLATION_UNAVAILABLE` 拒绝，提示词不存储）。
- 明确锁定并标注原因：Agent 任务、Files（`READ_ADAPTER_UNAVAILABLE`）、Changes（`SANDBOX_UNAVAILABLE`）、Results（`WORKER_ISOLATION_UNAVAILABLE`）、审批策略。
- 控制面失败时窗口保持可用，显示错误横幅与重试；崩溃后的运行在下次启动标记为 INTERRUPTED。

## 4. 剩余限制与后续门禁

- **生产 Worker 仍无资格**：SEC-W01（文件/凭据/全网络/回环、危险句柄、启动竞态、原生边界等）未执行，最迟在 Windows 进入 P3 执行链前完成；任何 UNKNOWN/FAILED 继续拒绝生产 Worker。
- 只读工具（SEC-08）、Git 只读（SEC-22）、高危工具（P3a/P3b）未实现，相应 UI 保持锁定。
- 主机崩溃后遗留的 AppContainer profile / 运行时 ACL 只出现在测试 runner（发布构建从不创建 profile）；对账清理属于 SEC-W01 / P7 范围。
- 安装包未签名，Windows SmartScreen 可能提示；无自动更新。
- macOS/Linux：无原生 Worker launcher，进程与安装包验收 NOT_RUN。
- `ui` 能力仍为 unverified：SEC-13/14 等完整 UI 安全门禁尚未作为独立验收执行。
