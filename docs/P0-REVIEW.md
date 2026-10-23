# P0 工程架构评审与 P1 实施设计

评审日期：2026-10-23（Asia/Shanghai）。规范版本：`0.3.1-review`。

状态：**评审和最小元数据已形成；用户已选择保留 ADR，DEC-001 待后续原型验证，P0 尚未完整冻结；P1 未开始。** 本文不具有推翻 ARCHITECTURE/AGENTS 的效力。两份规范已逐行完整读取（685/96 行）。

## 1. 对目标架构的理解

进程树为 `Electron Main → 独立 Node Express Sidecar → 独立 Node Agent Worker`。Preload 运行于 Renderer 的隔离上下文，不是第五个常驻服务。Express 创建 Worker 并负责其握手、心跳和直接退出；Main 监管整棵服务进程树。短命 Read Adapter、Sandbox Launcher、Git Adapter、MCP 受控进程均由 Express 路由和监管，不增加常驻通用 Executor。

UI 的访问链固定为 Renderer → Preload 窄 API → Main 白名单代理 → Express。Express 是唯一身份/策略/审批/领域状态/数据库所有者，Tool Router 仅路由。Worker 内只运行规划、Agent Loop 和模型事件消费，模型与工具意图必须请求 Express；供应商适配和长期凭据都留在 Express。Main 仅提供 `safeStorage` 加解密能力。

跨进程类型来源只有 contracts 的运行时 Schema；类型由 Schema 推导。两端验证，不把 JSON-RPC id 当身份，不把模型、MCP 或 Renderer 输入当授权。旧实例退出、失联租约、背压、取消、结果 UNKNOWN 与任务 INTERRUPTED 都属于架构行为，不是日后可省略的优化。

P3a 需要至少一个 OS 上真实最小 `write_file/bash` 沙箱和 Read Gate。即使 P3a 已通过，高危能力仍等本 OS P3b；只读和 Git 只读分别等 SEC-08、SEC-22。所有能力目前均未实现或验证。

## 2. 完整性、一致性及风险

| 项目 | 核查结果 | 处理/门槛 |
|---|---|---|
| 文件名称 | 初始为 `ARCHITECTURE .md`、`AGENTS .md` | 经用户确认仅去掉空格；重命名前后 SHA-256 相同 |
| 规范优先级、15 项 ADR | 两文一致；架构是规范来源，AGENTS 是执行约束 | 未覆盖或改写任何正文 |
| 进程、RPC、DB、原生 ABI | 固定，无重新选型需求 | P1 SEC-03/17/18 验收 |
| Worker OS 隔离与 Windows fork | 无已证明的 stock fork 路径；详见 DEC-001 | **P0 完整冻结阻塞**；不能擅自修改 ADR |
| 阶段测试归属 | SEC-04 没有完整列入 P3b 退出集合；SEC-16 的 UI 包含 P2/P4 才实现的能力 | 建立补充追踪矩阵：P1 仅内部骨架资格；对外 UI 支持等 SEC-01/02/03/13/14，生产 Worker 隔离另过 SEC-W01；不提前宣称支持 |
| P0 要 CI/打包方案，P1 才有应用 | 不是必须在 P0 实现应用；两阶段证据容易混淆 | P0 编译检查工具及验证配置；P1 构建应用/实际安装烟测；占位命令必须非零退出 |
| contracts 在 P2，但 P1 有 RPC | P1 不可能没有最小 Schema | P1 仅版本、握手、health、shutdown、标准错误；业务契约留 P2 |
| fork 环境、能力绑定 | 默认 env/execArgv 会扩大权限，继承 IPC 不是内容授权 | 固定 execPath/cwd/env/execArgv、单 IPC、角色/方法 allowlist、runId 绑定和消息预算 |
| Sidecar 与 Electron ABI | 独立 Node 不能依赖 Electron 的 ASAR 解析或其 native ABI | 全部 Sidecar JS、依赖、SQL 与 Node 放 extraResources；Node/Electron 原生产物分别构建 |
| 平台生命周期 | 普通 kill(pid)/Node disconnect 回调不足以证明子孙全清理 | Windows Job/native supervisor；Linux pdeathsig + 进程组；macOS EOF + watchdog + 组监管，各自故障注入 |
| IPC 资源耗尽 | Schema 验证发生在 Node 消息反序列化后，不能只靠字段长度宣称防 OOM | 限发送端、消息频率/预算、超时、OS 资源边界；接收端前分配风险纳入 Worker 威胁模型 |
| 只读路径与 Git | realpath 字符串验证、git status 名称本身均不构成安全证明 | 安全打开/身份复验、竞态/硬链接/UNC 测试；禁 helper/filter/hooks 外部执行 |
| 密钥、Crypto Bridge | 首次录入必经 Renderer/Main；内存和 OS dump 无法完全消除 | P4 有限接口/实例/能力验证，默认不启应用 crash dump；系统风险明确 |
| 草稿状态与冻结选型 | “review” 与已确认 ADR 并不矛盾 | ADR 边界固定；实施版本/方案仍需 P0 收敛，平台安全性需要真实证据 |

新增 `SEC-W01` 是对 §2.2/§6.1 已有 MUST 的追踪编号，不替换原 SEC-01～23，也不改变 ADR。P3b 高危资格还必须包含已定义但摘要列表未完整列出的 SEC-04/07/11/17；P7 对全部适用要求复验。

## 3. P0 推荐固定的工程选型

版本来自 2026-10-23 官方发行页与 npm registry；精确配置见 runtime-lock/package.json。**锁定可复现版本不代表永久不升级**：安全补丁走独立依赖 PR、矩阵回归和锁文件更新，禁止安装时浮动 latest。

| 选型 | 精确版本/方案 | 所属进程及当前状态 |
|---|---|---|
| Node | **24.22.1 LTS**；Node ABI 137 | 开发工具、Express Sidecar、Worker；本轮工具用，应用 P1 待验证 |
| Electron | **45.0.0** | Main/Preload/Renderer；P0 只锁版本，未安装/运行 |
| pnpm | **10.34.7**；isolated linker；workspace:* | 构建工具，单锁文件，禁止幽灵依赖；10.x 的 2026-10-12 补丁版，避免 v12 原生 Rust 启动器迁移扩大 P0 范围 |
| Monorepo | pnpm workspaces + TypeScript project references（P1 配置项目引用） | 暂不引入 Nx/Turbo；三应用、纯 contracts 与窄平台包 |
| TypeScript | **5.9.3** 严格模式 | 编译工具；有意不选 TS7，因为 typescript-eslint 8.72.0 声明 TS <6.1 |
| ESLint | **10.13.0**、@eslint/js **10.0.1**、typescript-eslint **8.72.0** | P0 工程工具 lint；P1 增加真实进程依赖边界插件/规则并做负例测试 |
| Node types | **24.19.2** | 工程/Node 进程；基类 types:[]，Renderer 不引入 Node 类型 |
| 桌面打包 | electron-builder **26.15.3**、extraResources | 构建工具；严格使用 v26 文档，不混用 v27 nativeModules 配置 |
| DB | SQLite + better-sqlite3 **13.0.3** + SQL migrations | 仅 Express；P1 引入、目标 Node ABI 构建/加载；不替换成 node:sqlite |
| HTTP | Express **5.3.0**、127.0.0.1 动态端口 | 仅 Server；P1 最小控制面 |
| Schema | Zod **4.6.7** | contracts 的纯运行时依赖；各边界消费，P1 最小握手契约 |
| UI | React **19.3.1**；Vite **8.3.5** | Renderer/构建；本轮不安装、不制作 UI；React P6 使用前重新审查版本 |
| 测试 | Node 内置 test runner + tsc + ESLint | P0 无额外测试框架；P1 真实进程集成，Electron E2E 工具版本在 P1 引入时锁定 |
| RPC | Node IPC serialization:'json' + JSON-RPC 2.0 | Express↔Worker，无监听端口；协议 v1 初始仅精确匹配，升级显式协商 |

本轮实际新增第三方依赖只有根 devDependencies 五项，均不进入产品进程。Electron/Builder/Express/Zod/SQLite/React/Vite 是已核查的候选锁定版本，应用依赖图与安装闭包必须在各阶段真实验证后再声明已验证。

### 3.1 打包、ABI 与供应链

1. Node 取官方发行归档；`build/runtime-lock.json` 固定六种 OS/arch 的文件名和 SHA-256。实际支持矩阵与“存在下载产物”分开。
2. Sidecar staging 路径：`build/stage/<builder-os>-<arch>/sidecar/`；builder 的 `win/mac/linux` 映射分别对应 manifest 的 `win32/darwin/linux`，禁止混用。内部布局：`node/`、`server/`（含生产 node_modules、migrations）、`agent-worker/`、`manifest.json`。
3. `resources/sidecar/node/node.exe`（Windows）或 `resources/sidecar/node/bin/node`（POSIX）是固定 execPath。启动绝不调用系统 PATH 中的 Node、不设置 ELECTRON_RUN_AS_NODE、不用 utilityProcess 替换 ADR。
4. `better-sqlite3` 仅装入 Server 的隔离生产闭包。按目标 Node/OS/arch 在原生 runner 构建，或核实精确 prebuild；无匹配产物则构建失败。输出 keyed by runtime+ABI+OS+arch+lock hash。原生构建 cache/header/download 全部限 workspace。
5. Electron builder 的 `npmRebuild:false`、`nodeGypRebuild:false` 防止覆盖 Node sidecar 原生产物。Sidecar 全部放 ASAR 外；只 unpack `.node` 而把 JS 留在 ASAR 不足以让独立 Node 工作。
6. Main 如需原生 Job 监管 addon，属于独立 `platform-supervision`；在 Electron ABI 目录单独构建并验证。不与 Server 的 Node ABI addon 混装。
7. manifest 记录运行时、实际 `process.versions.modules`、每个 native 文件 hash、协议版本、能力状态、源提交、lock hash。打包检查 symlink 最终目标不越 workspace；包内不得残留开发依赖、工作区外绝对路径、token、测试数据库。
8. Windows 签名应用和辅助 exe，macOS 逐项签名嵌套 Node/helper/native 库、hardened runtime 与 notarization，再装包验证；Linux 生成校验/SBOM和目标系统包。证书、entitlements、更新机制在 P1/P7 验证，不声称已签名。
9. SHA-256/SRI 验证是本轮实际供给链检查；Node 官方签名链离线验证与发行签名尚未执行，发布前补齐。无签名凭据时仅产内部测试包，发布门禁失败。

### 3.2 协议与 bootstrap

- Main 启动 Express 时用专用继承管道输送随机实例级 token，关闭无关句柄；secret 不在 argv/env/日志/磁盘。端口由 Express bind(127.0.0.1,0) 获取，ready 消息只携端口/版本/runId。ready 前必须 migration、Worker 握手、健康检查全部通过。
- Main HTTP 代理仅允许 contracts 列举的方法和路由；精确 Host+端口策略，拒绝不允许的 Origin，CORS 不充当认证。Renderer CSP 禁止直连本地 API。IPC 同时验证 senderFrame、frame URL、窗口和 Schema。
- Worker 继承一个 IPC channel；JSON-RPC request/response/notification 使用可区分 Schema，拒绝未知方法/字段、错误角色/旧 runId、重复响应、超限 payload。握手失败先清理进程，不开始任务。JSON-RPC request id 不用作授权。
- P1 建议固定参数：握手 10s、心跳 1s/连续 3 次失效、停机宽限 5s、重启预算 60s 内最多 3 次；均集中配置、可注入 fake clock 测边界。任务级最长终止 30s 属 P3，不因这些值改变原文。
- Main↔Express Crypto Bridge 预留独立能力、request correlation 和实例绑定。P1 不实现解密；P4 细化认证双向流/继承通道，不能给 Renderer 增加通用 decrypt API或 Main HTTP 监听旁路。
- 建议 P1 单消息 256 KiB、每方向最多 64 个在途调用/1 MiB 排队字节，错误与取消有保留预算。数值需集成压测调整；调整集中配置，不在业务端维护多套配额。

## 4. 最终推荐目录（本轮不创建应用目录）

```text
OperationAgent/
├── ARCHITECTURE.md / AGENTS.md          # 保持原文
├── package.json / pnpm-lock.yaml / pnpm-workspace.yaml
├── tsconfig.base.json / eslint.config.mjs
├── apps/
│   ├── desktop/
│   │   ├── src/main/{lifecycle,supervision,proxy,crypto}/
│   │   ├── src/preload/
│   │   ├── src/renderer/               # P6；P1 最多空测试窗口
│   │   └── tsconfig.{main,preload,renderer}.json
│   ├── server/src/
│   │   ├── transport/                 # HTTP、内部 RPC 入口
│   │   ├── supervision/               # fork、握手、实例和失联处理
│   │   ├── persistence/{migrations,repositories}/
│   │   ├── domain/                    # P2
│   │   ├── policies/                  # P3
│   │   ├── tools/{registry,router,read-adapter}/
│   │   ├── execution/{sandbox,git,streams}/
│   │   ├── event-stream/              # P2/P3 内部模块
│   │   ├── models/                    # P4 Model Gateway
│   │   ├── credentials/               # P4 CredentialService
│   │   └── mcp/                       # P5
│   └── agent-worker/src/{rpc,runtime,model-events}/
├── packages/
│   ├── contracts/src/{ipc,api,rpc,tools,events,errors,version}/
│   ├── platform-supervision/          # 生命周期原生辅助；P1；无工具业务
│   ├── platform-sandbox/src/{windows,macos,linux}/ # P3
│   ├── observability/                 # 脱敏日志；不导入领域模块
│   ├── test-utils/                    # 仅 dev dependency
│   └── ui/                            # P6
├── build/
│   ├── runtime-lock.json / p0-status.json / electron-builder.config.json
│   ├── native/                        # P1 Node/Electron 分离产物脚本
│   ├── signing/                       # P1/P7，无私钥
│   └── stage/                         # 生成物，Git 忽略
├── scripts/                           # P0 检查与 workspace-local bootstrap
├── tests/{p0,architecture,integration,failure-injection,sandbox,e2e}/
├── .github/workflows/
└── docs/{adr,P0-REVIEW.md,ACCEPTANCE.md,EXECUTION.md}
```

`models/` 与 `credentials/` 分别是 Server 的同级目录；不能由 Worker 导入。目录是最终目标图，不是已创建组件。

### 4.1 可审查依赖边界

| 消费模块 | 唯一允许的项目内依赖 | 禁止 |
|---|---|---|
| Renderer | contracts 的 UI 视图、ui | Node builtins、server、worker、平台包、Electron原始 IPC、fetch 本地控制面 |
| Preload | contracts、必要 Electron contextBridge/ipcRenderer | Server/Worker、通用文件/HTTP/shell/secret 代理 |
| Main | contracts、platform-supervision、窄日志 | Worker runtime、Server domain/db、Tool Router、platform-sandbox 工具业务 |
| Server | contracts、领域内部模块、平台接口、日志 | Renderer、Worker runtime 的代码（仅把构建路径当进程入口） |
| Worker | contracts、纯 runtime/model-events | fs/net/http/child_process/DB/MCP/Provider、native addon 动态加载 |
| contracts | Zod 等纯 Schema | 应用、Node/Electron/网络/IO、运行时单例 |
| platform-supervision | 系统 API/最小内部类型 | 领域权限、模型循环、数据库 |
| platform-sandbox | contracts 的执行 policy 类型、OS接口 | 自行审批、任意 Shell 旁路 |

P1 使用包 exports、独立 TS projects、运行/开发依赖分离及 ESLint 边界规则共同约束。禁止跨包相对路径、别名穿透、require/dynamic import 规避；加负例 fixture 验证规则真能拦截。仅禁 imports 无法阻止 compromised Worker，仍必须过 SEC-W01。打包 staging 不产生运行时依赖反向导入。

## 5. 分步实施计划

### P0（本轮边界）

1. 完整读规范、记录原始 hash/文档状态/15 项 ADR 与所有 SEC 编号，完成冲突表。
2. 查官方资料和 registry，锁定 Node/Electron/pnpm/TypeScript/Builder；登记依赖用途与进程归属。
3. 写入最小 metadata、严格 TS 配置、P0 检查工具、负例门禁测试、CI。无 apps/packages 运行时代码。
4. 明确 Sidecar 资源布局、ABI 构建隔离、六种目标归档 SHA-256 与签名/验收方案。
5. 将 DEC-001 提交用户决策；未解决时 `check:p0-exit` 必须失败，不能标记 P0 frozen。
6. 初始化 main 分支，纳入原文和工程基线，创建 JaxLim/OperationAgent 私有仓库并推送；验证本地/远端 SHA 一致，不修改全局 Git 身份。
7. 出具实际命令/结果、环境限制与 P1 的明确授权入口。本轮停止在 P0。

### P1（计划，需新授权且 P0 exit 通过）

| 顺序 | 交付 | 退出条件/证据 |
|---|---|---|
| P1.1 | contracts 最小 v1、三个应用包、进程独立 TS 配置和包 exports | build/typecheck/lint；越界 import 负例；未知字段/版本/角色拒绝 |
| P1.2 | 官方 Node staging、最小 Express health、SQLite 基础 migration 与测试记录表 | Node ABI manifest、事务回滚/幂等迁移/数据库关闭重开；无任务业务表扩展 |
| P1.3 | Main 安全启动、bootstrap 令牌、只回环 HTTP、有限 IPC | 外部无 token/错误 Host Origin 拒绝；合法 Main 成功；日志无 token |
| P1.4 | Express fork 心跳 Worker、单继承 IPC、握手/健康/停机，暂不实现 Agent Loop | 父子 PID 树正确；未知 runId/重复响应/断链/超时/背压都可测试 |
| P1.5 | 原生服务树监督、两阶段清理、预算和 orphan 检测 | SEC-17；强杀 Express/Main、卡死 Worker、重复启动，不残留旧 Worker |
| P1.6 | 签名准备、原生产物/Sidecar 引入安装包、内部空窗口/测试 harness | 清洁安装后的 SEC-18；实际资源 execPath，不能误用开发机 Node |
| P1.7 | 三 OS 已选 CPU 的 CI + 故障证据归档；未具备环境的目标明确失败/待验 | 所有声称已通过的目标有安装/重启证据；未过不发布能力；P1退出报告 |

P1 不实现：任务规划/模型供应商/密钥服务/工具执行/授权产品流/MCP/业务 UI。数据库仅建立迁移机制与烟测记录，P2 定义完整领域模型；不得把计划中的功能 mock 成“已支持”。

## 6. Windows 环境与跨平台策略

已观察：Windows `10.0.26300.0` x64，系统 Node `24.14.0`/ABI137，Git `2.53.0.windows.1`，npm `11.9.0`，gh `2.92.0`，Python `3.12.12`；VS 2022 Build Tools 的 C++ 组件可发现；cmake 不在 Git Bash PATH。VS 安装存在不等于 native 编译已成功，SDK/编译器/安装包需 P1 实测。

用户配置中的 `D:/git/Git/bin` 不存在；实际 Git Bash 为 `C:/Program Files/Git/bin/bash.exe`。命令工具直接选择 Bash 误入 WSL，因此使用 UTF-8 PowerShell 入口显式执行该 Git Bash。未将 WSL 用作 Windows 沙箱或构建证明。

系统 Node 不修改；项目工具下载到 `.tools`，缓存/store 放 `.cache`/`.pnpm-store`；所有写入限当前工作区。GitHub CLI 使用已有凭据，不读出 token。现有全局 Git 作者属于另一项目，本仓库单独设置 JaxLim 与其 GitHub noreply 邮箱。

建议第一组原生验证目标为 Windows x64、macOS arm64、Linux x64；OS 下界候选 Windows 11、macOS 14+、Ubuntu 24.04，但**都不是已经支持的最低版本声明**。Windows ARM64、macOS x64、Linux ARM64 的 Node 产物只锁来源，需独立 runner 才可宣传支持。macOS 签名/公证在 macOS 执行，Linux 权限在真实目标内核执行；交叉编译成功不能替代目标安装/安全测试。

Linux Landlock/seccomp、macOS Seatbelt、Windows AppContainer/ACL 是待证明的候选；`sandbox-exec` 弃用风险原文已经承认。P3a 首个平台推荐 Linux x64（权限机制清楚、CI可测），这是后续排期建议，不能替代 Windows Worker 的 DEC-001，也不授权本轮实现。

## 7. 官方依据

- [Node 24.22.1 发布与安全修复](https://nodejs.org/en/blog/release/v24.22.1)、[Node 发布周期](https://github.com/nodejs/Release)、[校验和](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)。
- [Electron 稳定版本](https://releases.electronjs.org/?channel=stable)、[支持周期](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)、[Native ABI](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)、[安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。Electron 自带 Node 与独立 Sidecar Node 分别管理安全更新，二者版本相近不等于 ABI 相同。
- [electron-builder v26 contents](https://www.electron.build/v26/docs/contents/)、[v26 配置](https://www.electron.build/v26/docs/api/app-builder-lib.interface.configuration/)、[尚未发布的 v27 变更](https://www.electron.build/docs/migration/v27-breaking-changes/)。
- [pnpm workspace](https://pnpm.io/workspaces)、[pnpm settings](https://pnpm.io/settings)、[typescript-eslint 元数据](https://registry.npmjs.org/typescript-eslint/8.72.0)。依赖版本还逐项核查了 npm registry 的 version/engines/peerDependencies。

验证证据以 [EXECUTION.md](EXECUTION.md) 为准；本报告中的设计表格不能当成测试通过报告。
