# OperationAgent

当前阶段：**P0 架构决策已批准并通过本地退出检查；未开始 P1**。

规范来源：[ARCHITECTURE.md](ARCHITECTURE.md)、[AGENTS.md](AGENTS.md)，现为 `0.4.0-p0`。已按用户正式批准的 [ADR-WIN-001 r1](docs/adr/ADR-WIN-001.md) 更新，批准记录绑定决策包与规范补丁哈希。

本仓库目前没有 Electron 应用、Express 服务、Agent Runtime、产品 UI 或可使用的工具。构建命令只编译 P0 检查工具，不能视为桌面应用构建成功。

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

`check` 校验 P0 元数据与工程工具；`check:p0-exit` 核验真实批准关联、规范与原始证据，不能只靠 frozen 状态通过。`test:integration`、`package`、`test:smoke` 当前显式失败，不能当作已实现测试。

建议下一阶段按 [P1.1～P1.7](docs/P0-REVIEW.md#5-分步实施计划) 开发契约、控制面/数据库、平台 Worker 创建与监管、安装包烟测；本轮批准不含 P1 实施授权。P1 只能运行已经 OS 限权的固定测试 Worker；Windows 公开创建路径和 OWIP/1 管道仍须实际验收，完整 SEC-W01 最迟相应平台进入 P3 执行链验证前通过。任何失败或未知均不得授予生产 Worker 权限。

Windows x64 可用现有 Node 运行 `node scripts/bootstrap-windows.mjs`，将校验过哈希的 Node/pnpm 下载到本仓库 `.tools/`。已有下载仅在哈希一致时复用，哈希不符拒绝覆盖。之后用 `.tools/node/node.exe .tools/pnpm/bin/pnpm.cjs ...` 调用。所有包缓存均配置在工作区内，不需要全局安装。

CI 在各平台先选定锁定的 Node，再运行 `node scripts/bootstrap-windows.mjs --pnpm-only`。该模式支持 Windows/macOS/Linux，只安装并校验 pnpm；版本与 SRI 统一读取 `build/runtime-lock.json`，不使用另一个包管理器自安装当前包管理器。

生产支持状态：所有平台 `ui/read/gitRead/highRisk/workerIsolation` 均为 **unverified**；依赖和工具链检查通过不改变这些状态。
