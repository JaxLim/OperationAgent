# OperationAgent

当前阶段：**P0 架构评审与工程基线；尚未冻结，未开始 P1**。

规范来源：[ARCHITECTURE.md](ARCHITECTURE.md)、[AGENTS.md](AGENTS.md)。两份原文仅按用户确认修正文件名，内容未改。

本仓库目前没有 Electron 应用、Express 服务、Agent Runtime、产品 UI 或可使用的工具。构建命令只编译 P0 检查工具，不能视为桌面应用构建成功。

- [P0 评审、选型、目录与 P1 计划](docs/P0-REVIEW.md)
- [验收命令和阶段门禁](docs/ACCEPTANCE.md)
- [实际执行记录](docs/EXECUTION.md)
- [待决 Worker 隔离问题](docs/adr/DEC-001-worker-isolation.md)

## 开发工具

锁定 Node.js `24.22.1`、pnpm `10.34.7`；全部开发依赖精确锁定，依赖树由 `pnpm-lock.yaml` 固定。

已有锁定工具链时：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm check:p0-exit
```

`check` 校验 P0 元数据与工程工具；`check:p0-exit` 在架构阻塞未关闭时必须失败。`test:integration`、`package`、`test:smoke` 当前显式失败，不能当作已实现测试。

Windows x64 可用现有 Node 运行 `node scripts/bootstrap-windows.mjs`，将校验过哈希的 Node/pnpm 下载到本仓库 `.tools/`。已有下载仅在哈希一致时复用，哈希不符拒绝覆盖。之后用 `.tools/node/node.exe .tools/pnpm/bin/pnpm.cjs ...` 调用。所有包缓存均配置在工作区内，不需要全局安装。

CI 在各平台先选定锁定的 Node，再运行 `node scripts/bootstrap-windows.mjs --pnpm-only`。该模式支持 Windows/macOS/Linux，只安装并校验 pnpm；版本与 SRI 统一读取 `build/runtime-lock.json`，不使用另一个包管理器自安装当前包管理器。

生产支持状态：所有平台 `ui/read/gitRead/highRisk/workerIsolation` 均为 **unverified**；依赖和工具链检查通过不改变这些状态。
