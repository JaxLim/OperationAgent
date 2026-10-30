# 后续路线图（P1 退出后）

日期：2026-10-30。**P2.0–P2.3 已于 2026-10-30 由用户正式授权**（原话 “Authorize P2.0–P2.3”，记录于 `build/p2-status.json`，`pnpm verify:p2` 校验）；P3 及以后仍未授权。规范来源仍为 `ARCHITECTURE.md` / `AGENTS.md` `0.4.0-p0` 与 ADR-WIN-001 r1；本文件只是排序与拆分建议，**不构成阶段授权，不改变任何能力声明**。每个阶段开工前仍需用户正式授权并更新阶段状态文件及对应检查器。

## 1. 现状

- P1.0–P1.7 已在 Windows x64 以真实 CI 证据退出（[P1 退出报告](P1-EXIT-REPORT.md)）；`agentReady=false`，生产 Worker 无资格，三平台全部能力 `unverified`。
- contracts 仅含版本、握手、health/shutdown、控制面 HTTP 与 Workbench 外壳；无 Task、TaskEvent、工具流或领域错误契约。
- SQLite 迁移止于 `003-workbench.sql`；没有任务表、事件表或补拉游标。
- 本地开发需把 `.tools/node` 置于 PATH 前部，否则 `pnpm run` 内嵌脚本使用系统 Node 并因 `engines` 失败。

## 2. 优先级排序

| 优先级 | 工作项 | 阶段 | 依赖 | 退出证据 |
|---|---|---|---|---|
| 1 | **P2.0 契约基础**：`events/tool-output.ts`（§9.1.1）、任务状态机与合法迁移表（§8.1）、副作用核实状态、`TaskEvent` 信封、领域错误码 `AppError`（§9.1） | P2 | 无 | 纯 Schema 单元测试：未知字段/越界拒绝、非法迁移拒绝、`deltaPersistence` 固定为 transient |
| 2 | **P2.1 事件存储**：迁移 `004`（`tasks`、`task_events`，任务内唯一递增 `seq`）、状态 + 事件同事务提交、`requestId` 去重 | P2 | P2.0 | 事务回滚、序号单调、重复请求只应用一次（SEC-09 前置）、重启读回 |
| 3 | **P2.2 快照 + 游标补拉**：`GET 快照` + `events?afterSeq=` 有界分页；Renderer 先快照后补拉，提交成功后才广播 | P2 | P2.1 | 断线重连重建一致状态（SEC-13 前置）；安装后烟测扩展到新迁移 |
| 4 | **P2.3 任务状态 UI 接入**：Workbench 读取真实任务快照/事件（仍拒绝执行，任务停在 `CREATED` 或被拒绝） | P2 | P2.2 | 真实 Electron 链路测试；不显示虚假可执行能力 |
| 5 | **SEC-W01 Windows 生产 Worker Gate**（文件/凭据/网络/回环、危险句柄、启动竞态、原生边界、遗留 profile 对账） | P3 前置 | P1.4 | 一次性 runner 真实证据；任一 UNKNOWN 继续拒绝 |
| 6 | **P3a**：Windows Read Adapter + SEC-08 Read Gate；`write_file`/`bash` 最小 AppContainer/Job 沙箱 + SEC-23 | P3a | SEC-W01、P2 | SEC-08、SEC-23 真实证据；高危仍关闭 |
| 7 | **P3b**：审批/授权、Shell 规范化（SEC-21）、Git 白名单（SEC-07/22）、工具流背压（SEC-19）、停止语义（SEC-12） | P3b | P3a | 逐平台 SEC-05～08/12/16/19/21 |
| 8 | P4 单 Agent 闭环 → P5 MCP → P6 产品 UI → P7 故障注入/签名/发布 | P4–P7 | 依次 | 见 ARCHITECTURE §13 |

并行可选（不阻塞主线，可在任意阶段插入）：安装包代码签名配置（需证书）、macOS/Linux 进程集成 runner、SBOM 生成。

## 3. 拆分原则

- P2 只引入数据形状、状态与持久化；不新增任何执行能力，不改变 `WORKER_ISOLATION_UNAVAILABLE` 拒绝路径。
- 改 `ControlHealth.databaseVersion` 等字面量会牵动集成与安装后烟测，P2.1 须同批更新并重跑 `pnpm check` 与 `pnpm test:smoke`。
- 每个切片单独提交、单独 CI；状态文件中的完成声明必须由检查器对照已提交证据校验。

## 4. 本轮（2026-10-30）执行范围

仅实施 P2.0 契约基础（纯 `packages/contracts` Schema + `tests/p2` 单元测试），不改数据库、HTTP 路由、Renderer、阶段状态文件或任何冻结文件；工程门禁本地运行，未产生 CI 证据。结果见 `EXECUTION.md` 末节。
