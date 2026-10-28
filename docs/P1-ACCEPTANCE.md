# P1 工程与控制面验收

2026-10-27 用户正式授权连续实施 P1.4–P1.7，2026-10-28 继续执行；依赖与退出门禁仍按冻结的 `P0-REVIEW.md` 第 5 节、ARCHITECTURE 和 ADR-WIN-001 执行。当前 P1.4 为 in-progress，后续阶段尚未开始，所有未验证能力继续 unverified、agentReady=false。PR #1/#2 与受保护分支不自动合并；重大架构、安全边界或原验收标准变更仍需人工决策。下面历史记录保留其当时范围。

2026-10-25 用户正式授权继续 P1.2/P1.3，2026-10-26 继续执行，停止于 P1.3。基线为 PR #1 的 `2b7da672d94c542f3e1a73272f22a915a6217058`；PR #1 仍 open/unmerged，原三平台 CI 成功，无审查记录。独立分支 `codex/p1-control-plane` 不合并 main。P0 原始验收文档及 ADR 继续保持冻结字节。`build/p0-status.json` 是历史状态，当前阶段读取 `build/p1-status.json`。状态文件是审计索引，不代替人类批准或实际测试。

## P1.0 阶段迁移（历史）

- 基线：`04d07bea89b70265a6b1fb1d79272b710623775b`，main 三平台 CI [40155608430](https://github.com/JaxLim/OperationAgent/actions/runs/40155608430) 成功；实施前本地 `check` 29/29、`check:p0-exit` 退出 0。
- `check:p0-exit` / `verify:p0` 从 Git 固定提交在工作区 `.cache` 生成临时快照，运行未修改的原 P0 检查器，再清理本次快照。缺历史对象/非祖先/冻结文件变化均失败；不是对当前 P1 目录伪报 P0。
- `.github/workflows/p0.yml` 在固定 P0 提交上重放原工具链；P1 workflow 在当前提交上检查工程与冻结文件。
- `verify:p1` 要求授权止于 P1.1、无生产 Worker 资格、完整 unverified 能力矩阵。仅根包复用原 P0 工具约束；运行时依赖在各自包内管理。
- 测试先行的实际失败：`node --test tests/p1/stage.test.ts` 退出 1，`ERR_MODULE_NOT_FOUND`（迁移检查器尚不存在）；实现后检查结果记于 EXECUTION。

## 命令语义

| 命令 | 验证内容 |
|---|---|
| `pnpm check:p1` / `pnpm check` | 类型、lint、单元测试、构建、P0 历史重放、P1 范围门禁及真实进程集成 |
| `pnpm check:engineering` | 上述工程检查，不运行进程集成，不能作为 P1.2/P1.3 完整验收 |
| `pnpm check:p0-exit` | 固定历史 P0 退出重放 + 当前冻结证据不变 |
| `pnpm verify:p1` | 当前阶段授权和能力声明、运行时版本、冻结证据 |
| `pnpm check:boundaries` | 实际 ESLint 源码检查、包清单/exports、TS references、环境类型与来源覆盖 |
| `pnpm test:integration` | 构建、Node staging、Electron 官方归档核验、真实 Node/Electron 进程测试；写入 `artifacts/p1/<platform-arch>/` |
| `pnpm package` / `pnpm test:smoke` | 仍退出 1 / NOT_IMPLEMENTED；安装器与安装后测试 NOT_RUN |

本轮真实进程目标仅 Windows x64。macOS/Linux 保留工程与数据库单元测试，进程集成为 NOT_RUN。P1.4～P1.7、公开原生创建、OWIP I/O、AppContainer、原生服务树和安装包均 NOT_RUN。不得把本轮 Main/Express 认证与数据库集成解释为完整 SEC-03（含 Worker）、SEC-17/18、SEC-W01 或 P1 总退出通过。

## P1.1 工程骨架与限制（历史）

七个 workspace 包：`apps/desktop`、`apps/server`、`apps/agent-worker`、`packages/contracts`、`packages/worker-transport`、`packages/platform-worker`、`packages/platform-supervision`。

- Desktop 的 Main/Preload/Renderer 是独立 TS projects；Main 只定义空工程宿主，不启动 Sidecar/Worker。Preload 只暴露当前构建元数据，Renderer 仅显示未启用状态；不建立业务 IPC。
- Express 导出不监听的应用工厂，没有 HTTP 路由、健康成功响应、身份认证或数据库。正式启动在 P1.2/P1.3 实施。
- contracts 是唯一跨边界 Schema 来源：严格 JSON-RPC 2.0、`protocolVersion`、实例 UUID、请求关联、角色与 hello/health/shutdown allowlist。所有就绪标记在本阶段限定为 false。
- worker-transport 仅实现纯报文解析和期望实例/角色校验；请求关联表、重复响应、时间预算、队列、OWIP framing 与 I/O 未实现。它不是完整 RPC client，也不是已认证的 OS 通道。
- Worker 入口与平台创建入口抛出 `WORKER_ISOLATION_UNAVAILABLE`；supervision 抛出 `NOT_IMPLEMENTED`。平台父/子端 exports 分开；未引入实验代码、native addon 或 AppContainer profile。
- 运行时依赖：contracts 的 Zod 4.6.7；Server 的 Express 5.3.0。Electron 45.0.0 是 Desktop 开发/类型依赖；Vite 8.3.5 是构建依赖；`@types/express` 5.0.6 是 Server 开发依赖。无 lifecycle scripts，无 Electron 二进制下载或真实启动。
- TypeScript `skipLibCheck:false` 保持。Electron 上游共享声明要求 Main 同时加载 DOM 类型；Renderer 无 Node 类型。Zod 声明引用 WHATWG URL，contracts 仅提供 URL 实例数据接口，不声明构造器/网络全局。真实编译负例验证 Worker 中 fetch/document/process/URL 构造器不可用。
- 构建通过 Vite 将 Preload 除 Electron 外的依赖捆入单个 CommonJS 文件；Renderer 关闭 module-preload fetch 注入，CSP 保持 `connect-src 'none'`，不加入 unsafe-eval。Zod 的 JIT 探测具有 CSP 禁止时的解释执行路径；本轮未把产物检查等同 Electron 安全验收。

检查覆盖 static import、re-export、跨进程相对路径、未审核别名、require、动态 import、import-equals、import type、包出口穿透、开发/可选依赖夹带和 tsconfig 弱化。该门禁约束受审查源码，不能抵抗已攻陷 Worker 的任意代码，完整 SEC-W01 仍独立。

以上为 P1.1 当时的验收事实；本轮推进内容如下，原 42 项测试没有被重写为应用验收。

## P1.2：Express / 独立 Node / SQLite

- `apps/server/src/entry.ts` 只能经继承 IPC bootstrap 启动；验证父 PID、协议、实例及实际 Node 版本/ABI，监听 `127.0.0.1:0`。失败不发 ready。
- `persistence/store.ts` 独占 `control-plane.sqlite`，使用 WAL、FULL synchronous、排他连接及事务。`001-control-plane.sql` 只含烟测记录和控制面运行记录；无 Task/模型/工具业务表。迁移有版本与 SHA-256 校验；失败回滚，未知版本/修改过的 SQL 拒绝启动。
- 正常关闭标记 CLEAN；异常退出保留 RUNNING，下次启动事务对账为 INTERRUPTED。只恢复控制面和已提交数据，不重放用户任务或未确认写入。
- `stage-sidecar.mjs` 从固定官方 Node 构建独立生产闭包，检查路径、链接及 native 文件；生成实际 Node/ABI/SQLite/lock hash/文件哈希 manifest。使用随包 `better-sqlite3 13.0.3` Node-API prebuild，只有独立 Node 加载它；没有 Electron ABI 重编译。
- 数据库单元测试覆盖幂等迁移、批量事务回滚、失败 SQL 回滚、迁移 checksum 改动拒绝、关闭重开与未清洁运行恢复。真实进程测试覆盖并发 DB 所有者拒绝、进程强杀后的数据持久化和身份轮换。

## P1.3：Main / Preload / 身份 / 生命周期

- Main 仅通过 `sidecar.ts` 创建独立 Node；固定 execPath/入口/cwd 和环境白名单，不传 PATH、NODE_OPTIONS、NODE_PATH 或 ELECTRON_RUN_AS_NODE。`staged-runtime.ts` 校验产物后才启动。无 Worker 创建。
- 32 字节随机令牌只经继承 IPC 给 Express。回环 HTTP 使用 HMAC，绑定协议、双方 runId、请求 ID、时间、方法、路径和正文；响应同样签名，避免向端口冒充者发送裸令牌。拒绝旧实例、重放、错误 Host、任何 Origin、代理头和重复头；正文、响应、连接数、请求窗口及 Main 并发有界。
- Preload 只暴露固定健康/烟测记录方法；双端 Schema 验证。Main 验证 WebContents、主 frame、精确本地 URL 与 origin。Renderer 保持 `contextIsolation:true`、`sandbox:true`、`nodeIntegration:false`、`connect-src 'none'`；无 Node/FS/DB/通用 HTTP/IPC 入口。
- 握手 10s；健康探测每 1s，连续 3 次失败触发清理；关闭宽限 5s，超时强制结束并确认退出；60s 内最多自动重启 3 次，耗尽后停止。旧实例响应不交付，新实例重新生成身份。父通道断开或租约失效时，响应正常的 Sidecar 自行退出。
- 实测包括真实 Electron/Renderer 写入和读回、CSP 拒绝直连、外部窗口 IPC 拒绝、导航拒绝、正常退出、Sidecar 强杀/恢复、Main 强杀、预算耗尽，以及实际生产 `main/index.ts` 的窗口关闭与 DB clean close。响应上限为 192 KiB，容纳 100 条最长合法记录的最坏 JSON 转义；真实桥接回归覆盖 UTF-8 与控制字符、关闭重开后的完整读回。

## 本轮未完成的安全与发布门禁

`agentReady=false`、所有平台能力保持 unverified。任务入口返回 WORKER_ISOLATION_UNAVAILABLE。没有模型、Agent Loop、Shell、文件工具或 MCP。

本轮 Sidecar 没有子 Worker/执行器，因此可单独验收其进程生命周期；这不证明卡死/恶意后代的 OS 级清理。Windows Job/native supervisor、公开 WorkerLauncher、OWIP/1、AppContainer/ACL/profile、安装器、签名和安装后的 SEC-18 仍 NOT_RUN，分别留在 P1.4/P1.5/P1.6/P1.7。不会从本轮结果推导生产隔离或三平台产品支持。

失败、修复、命令和 CI 证据索引见 `P1-validation.json` 的 continuation，以及 `EXECUTION.md` 末节。CI artifacts 保存原始命令输出和运行时元数据；文档描述不能代替对应提交的绿色 CI。
