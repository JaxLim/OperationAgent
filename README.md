# OperationAgent

当前阶段：**P1（P1.0–P1.7）已在 Windows x64 完成真实验收，见 [P1 退出报告](docs/P1-EXIT-REPORT.md)；`agentReady=false`，不授予生产 Worker 资格**。

规范来源：[ARCHITECTURE.md](ARCHITECTURE.md)、[AGENTS.md](AGENTS.md)，现为 `0.4.0-p0`。已按用户正式批准的 [ADR-WIN-001 r1](docs/adr/ADR-WIN-001.md) 更新，批准记录绑定决策包与规范补丁哈希。

当前阶段记录和命令语义见 [P1 验收](docs/P1-ACCEPTANCE.md) 与 `build/p1-status.json`。P0 文件保持为冻结历史，不用改写旧批准记录推进阶段。

已建立七个 workspace 包和 Main/Preload/Renderer 独立 TypeScript 项目。Express 使用版本化 SQL migration 和独占 SQLite 连接；Main 通过继承通道建立服务身份，以认证的回环 HTTP 代理固定 API。Windows 平台 WorkerLauncher（公开 API + AppContainer + Job + OWIP/1）只在一次性 runner 上启动受限测试 fixture；发布构建不包含 fixture，任务入口返回 `WORKER_ISOLATION_UNAVAILABLE`。证据见 `docs/evidence/p1/win32-x64/`。

## 安装与使用（Windows x64）

1. 运行 `OperationAgent-0.1.0-win-x64.exe`（`pnpm package` 生成于 `dist/installers/`，或下载 CI artifact `operationagent-installer-win-x64`）。安装包为逐用户安装，无需管理员；目前**未代码签名**，SmartScreen 可能提示“未知发布者”。
2. 从开始菜单或桌面快捷方式启动 OperationAgent。界面右上角显示控制面状态；**Status** 面板显示服务、数据库、Worker 门禁与能力矩阵。
3. 可用功能：添加/切换/移除项目文件夹（只保存路径，不读取内容）、设置（主题、密度、上下文面板、停止宽限期）、诊断（运行历史、数据库自检、重启控制面）。提交任务会被控制面明确拒绝（`WORKER_ISOLATION_UNAVAILABLE`），不会无隔离执行。
4. 数据位于 `%APPDATA%\OperationAgent\control-plane\control-plane.sqlite`，卸载时保留。卸载：Windows“设置 → 应用”或安装目录中的 `Uninstall OperationAgent.exe`。

- [P0 评审、选型、目录与 P1 计划](docs/P0-REVIEW.md)
- [验收命令和阶段门禁](docs/ACCEPTANCE.md)
- [实际执行记录](docs/EXECUTION.md)
- [Worker 架构阻塞的处理结论](docs/adr/DEC-001-worker-isolation.md)
- [P0 决策批准记录](docs/adr/approvals/ADR-WIN-001-r1.json) / [门禁实际运行日志](docs/adr/ADR-WIN-001-validation.json)

## 开发工具

锁定 Node.js `24.22.1`、pnpm `10.34.7`；全部开发依赖精确锁定，依赖树由 `pnpm-lock.yaml` 固定。

已有锁定工具链时：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm check:p0-exit
```

`check` / `check:p1` 包括当前工程检查和真实进程集成（含 Worker fixture 步骤；非一次性 runner 上明确记录为 BLOCKED）；`check:engineering` 只运行工程检查，明确不代表进程验收。`check:p0-exit` 在固定历史提交上重放原 P0 检查并核对当前冻结证据。

构建安装包并执行安装后烟测（Windows x64；`check:p1` 中的原生 fixture 构建另需 VS 2022 C++ 生成工具）：

```sh
pnpm package     # build、官方 Node staging、Electron 校验、NSIS 安装包 → dist/installers/
pnpm test:smoke  # 静默安装到 .cache、启动/关闭/重启/强杀恢复、已安装 sidecar 套件、静默卸载
```

P1.4～P1.7 的退出证据见 [P1 退出报告](docs/P1-EXIT-REPORT.md)。完整 SEC-W01 最迟相应平台进入 P3 执行链验证前通过；任何失败或未知均不得授予生产 Worker 权限。

Windows x64 真实链路验收及开发启动：

```sh
pnpm test:integration  # build、官方 Node staging、Electron 校验与真实进程测试
pnpm desktop          # 使用已有 staging 启动开发版 Workbench
```

测试数据仅写工作区 `.cache`，日志写 `artifacts/p1/win32-x64/`；正常应用数据由 Express 写入 Electron `userData/control-plane/control-plane.sqlite`。不接受 Renderer 提供数据库路径。`stage:sidecar` 的 `manifest.json` 绑定实际 Node/ABI、生产闭包和 native 文件哈希。CI 保留三平台工程门禁；本轮真实 Electron/Sidecar 验收目标为 Windows x64，macOS/Linux 的进程验收明确为 NOT_RUN。

Windows x64 可用现有 Node 运行 `node scripts/bootstrap-windows.mjs`，将校验过哈希的 Node/pnpm 下载到本仓库 `.tools/`。已有下载仅在哈希一致时复用，哈希不符拒绝覆盖。之后用 `.tools/node/node.exe .tools/pnpm/bin/pnpm.cjs ...` 调用。所有包缓存均配置在工作区内，不需要全局安装。

CI 在各平台先选定锁定的 Node；Windows 运行完整 `bootstrap-windows.mjs`，为真实进程验收准备独立 Node，macOS/Linux 使用 `--pnpm-only` 安装并校验 pnpm。版本与 SRI 统一读取 `build/runtime-lock.json`，不使用另一个包管理器自安装当前包管理器。

生产支持状态：所有平台 `ui/read/gitRead/highRisk/workerIsolation` 均为 **unverified**；依赖和工具链检查通过不改变这些状态。
