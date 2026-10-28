# P1.0 / P1.1 工程验收

本轮授权仅包含阶段迁移和工程骨架，停止于 P1.1。P0 原始验收文档及 ADR 继续保持冻结字节；后续 P1 说明集中于本文件。`build/p0-status.json` 是历史状态，当前阶段读取 `build/p1-status.json`。状态文件是审计索引，不代替人类批准或实际测试。

## P1.0 阶段迁移

- 基线：`04d07bea89b70265a6b1fb1d79272b710623775b`，main 三平台 CI [40155608430](https://github.com/JaxLim/OperationAgent/actions/runs/40155608430) 成功；实施前本地 `check` 29/29、`check:p0-exit` 退出 0。
- `check:p0-exit` / `verify:p0` 从 Git 固定提交在工作区 `.cache` 生成临时快照，运行未修改的原 P0 检查器，再清理本次快照。缺历史对象/非祖先/冻结文件变化均失败；不是对当前 P1 目录伪报 P0。
- `.github/workflows/p0.yml` 在固定 P0 提交上重放原工具链；P1 workflow 在当前提交上检查工程与冻结文件。
- `verify:p1` 要求授权止于 P1.1、无生产 Worker 资格、完整 unverified 能力矩阵。仅根包复用原 P0 工具约束；运行时依赖在各自包内管理。
- 测试先行的实际失败：`node --test tests/p1/stage.test.ts` 退出 1，`ERR_MODULE_NOT_FOUND`（迁移检查器尚不存在）；实现后检查结果记于 EXECUTION。

## 命令语义

| 命令 | 验证内容 |
|---|---|
| `pnpm check:p1` / `pnpm check` | 当前阶段类型、lint、单元测试、构建、P0 历史重放、P1 门禁 |
| `pnpm check:p0-exit` | 固定历史 P0 退出重放 + 当前冻结证据不变 |
| `pnpm verify:p1` | 当前阶段授权和能力声明、运行时版本、冻结证据 |
| `pnpm check:boundaries` | 实际 ESLint 源码检查、包清单/exports、TS references、环境类型与来源覆盖 |
| `pnpm test:integration` / `package` / `test:smoke` | 仍退出 1 / NOT_IMPLEMENTED；未执行产品集成或安装器验收 |

P1.2～P1.7、公开原生创建、OWIP I/O、OS 隔离、数据库、实际服务树、安装包全部 NOT RUN。不得把静态导入边界或 Schema 单元测试解释为 SEC-W01、SEC-03/17/18、RPC-02 或 P1 总退出通过。

## P1.1 工程骨架与限制

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

后续阶段需要显式授权，完成身份认证与受控启动，再实现数据库、真实 Worker 传输、原生隔离、进程树及安装烟测；不得用本次 42 项工程/Schema 测试代替这些门禁。
