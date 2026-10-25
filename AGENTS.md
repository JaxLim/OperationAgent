# AGENTS.md — Electron Agent Desktop 开发守则（P0 决策基线）

> 唯一规范性架构来源：`ARCHITECTURE.md`，版本 `0.4.0-p0`（含已批准 ADR-WIN-001 r1）。本文件是对开发人员和 AI 编程助手的**可执行工程约束**，不得推翻架构决策。现为目标仓库模板；任何“通过验证”需要实际 CI 结果支持。

## 1. 工作原则

- 从干净骨架起步，不迁移旧项目的耦合结构。每次只实现一个阶段，先跑门禁再开发后续能力。
- 在每次代码变更前，先明确所属进程、使用的 `packages/contracts` Schema、安全权限、持久化路径和失败语义。
- 不允许为了让 Demo 跑通，添加绕过 Express、跳过审批、无沙箱执行或直接操作业务数据库的临时通道。
- 遇到平台缺失、协议不兼容、鉴权失败，一律 **fail closed**，给出显式错误，不静默退化。
- 禁止在文档或提交描述中宣称“已安全隔离”，除非对应平台的真实安装包门禁测试已通过。

## 2. 各进程导入限制

| 代码位置 | 允许 | 禁止 |
|---|---|---|
| `apps/desktop/src/renderer` | UI、状态视图、`contracts`、设计令牌 | Node builtin、Express、Worker、DB、FS、直接 HTTP 访问 Express、原始 `ipcRenderer` |
| `apps/desktop/src/preload` | 窄范围 `contextBridge`、必要 Electron IPC、`contracts` | 通用 `request(url)`、`exec(cmd)`、`readFile(path)`、`getSecret()` |
| `apps/desktop/src/main` | Electron 生命周期、Express 服务树监管、白名单 API 代理、Crypto Bridge | Agent Loop、Tool Router 领域规则、业务 DB、直接创建 Worker |
| `apps/server` | Express 领域服务、数据库、平台 WorkerLauncher、Tool Registry、Model Gateway、MCP Host | Renderer UI、Worker Runtime 内部实现作为业务依赖 |
| `apps/agent-worker` | Agent Loop、类型化 RPC client、模型/工具意图、`contracts`；受信 bootstrap 仅窄继承通道适配 | `fs`、任意 Shell/网络、业务 DB、直接连接 MCP/模型提供商/Executor |
| `packages/contracts` | 纯 Schema、类型、错误码、事件、版本 | Electron/Express/DB/网络/系统 I/O |

导入禁令需要 lint/build 自动检验；Node Worker 的权限边界还必须通过 OS 级隔离测试证明。

## 3. 进程与 RPC（P0/P1）

- 进程关系固定：**Main → Express（打包的 Node sidecar）→ 直接子 Node Worker**。Windows 由 Express 进程内原生 WorkerLauncher 创建；其他 OS 暂保留 fork。禁止中间 launcher、父 PID 伪装、无隔离回退。
- **Windows 使用公开 Win32 单继承管道 + OWIP/1 framing + JSON-RPC 2.0；其他 OS 暂保留 Node IPC 适配器**。只维护一份 contracts。连接时验证 `expressRunId`、`workerRunId`、协议版本、能力和 Zod Schema；不要开放 Worker RPC 监听端口。
- Main 只监管 Express 服务进程树，不直接启动 Worker。Worker 退出由 Express 检测；Express 退出由 Main 触发整棵旧服务树和短命沙箱清理。
- 新 Express 必须创建新 Worker；不允许旧 Worker 跨实例存活、重连或继续执行。未完成清理时禁止新有副作用工具派发。
- 所有 WorkerLauncher 的 `execPath`、环境变量、cwd、启动参数必须显式限制，不继承不可信 PATH/`NODE_OPTIONS`/调试参数等。

**Worker Gate**：P1 只运行首指令前已 OS 限权的固定 fixture，不接生产任务/真实数据/凭据/模型。完整 SEC-W01 最迟对应平台进入 P3 执行链验证前通过；未知/失败均拒绝生产 Worker，返回 WORKER_ISOLATION_UNAVAILABLE。控制面可报告 controlPlaneReady，但 agentReady 必须为 false；不可把 Read/P3b 工具门禁当作 Worker 资格。公开创建/管道 fixture 失败则对应 P1 验收 BLOCKED，不用无隔离 fork 或实验未公开导出替代。

**窄原生边界**：仅受信 transport bootstrap 可加载固定随包 Node-API 通道组件；子端只收发/关闭父端授予的继承通道。Agent Runtime 禁止任意 native 加载；不能导出实验 probe 的创建进程/ACL/文件/任意句柄接口。父端创建组件仅 Express 可用。

## 4. SQLite 与构建（P0/P1）

- V1 固定 **SQLite + `better-sqlite3` + 版本化 SQL Migration**；**只有 Express** 读写业务数据库。
- 在受控 Node sidecar 进程加载 `.node` 文件：构建/重编译目标为随包 **Node 的 ABI、OS 和 CPU 架构**。**不得**无条件将该 `.node` 产物按 Electron ABI 重建并替换 Node 所需产物。
- **只有 Native 模块实际由 Electron Runtime 加载时**才针对 Electron ABI 使用 `@electron/rebuild`。
- P0 的 CI/打包脚本应锁定 Node 运行时及原生模块产物；P1 必须在打包/安装后的应用中验证创建 DB → 迁移 → 写入 → 查询 → 关闭 → 重启读回。
- 关键任务状态、事件、审计意图提交需要事务；不得每条 stdout/stderr delta 都写进 SQLite。

## 5. 工具执行与批准

- 唯一调用路径：`Worker → Express 校验/审批 → Tool Router → 受控 Adapter/Launcher → Express → Worker`。
- 静态分流：只读走**低权限短生命周期 Read Adapter 子进程**；`bash` / `write_file` 走 OS 沙箱；Git 写走专用白名单通道；本地/远程 MCP 只通过 Express MCP Host。
- Read Adapter **禁止默认落在 Express 内直接执行文件读取**。如需例外，须独立威胁建模、测试与 ADR 审批。
- 普通 Shell 永远禁止修改 `.git`；`git add/commit` 需要专用授权；`git reset --hard` 和 `git push --force` 默认拒绝。
- 工作区外写入/默认网络/敏感文件访问必须受 OS 级能力限制；“用户批准”不取消沙箱。
- **P3a 必须在至少一个明确目标平台实际实现并测试 `write_file` + `bash` 的最小 OS 沙箱**（不是只交 Launcher 接口），验证工作区外写拒绝、普通 Shell `.git` 禁写、默认禁网和进程树回收，同时完成 Read Adapter 的 Read Gate。**P3a 通过也不得启用高危工具**：每个平台必须通过自己的完整 **P3b** 才能开放；未通过时统一返回 `SANDBOX_UNAVAILABLE`，**禁止回退普通 `spawn`**。
- **只读能力独立门禁**：`read_file` 允许在该平台 SEC-08 Read Gate（路径与敏感文件拒绝、符号链接/TOCTOU、防危险环境继承、短命进程回收）通过后启用，**不要求完整高危 OS 沙箱**；`git_status/diff` 须额外通过 SEC-22，验证不会执行不可信外部程序。Read Gate 不通过返回 `READ_ADAPTER_UNAVAILABLE`（或约定的 `CAPABILITY_UNAVAILABLE`），不能直接在 Express 里绕行读取；只读轻量隔离不等于恶意代码级 OS 沙箱。

## 6. Shell 规范化和审批（P3）

1. 一级匹配：解析 `argv[0]` 对应的真实执行程序（固定允许目录、规范路径、受信版本）；不是只匹配不可信 basename 或 PATH。
2. 二级匹配：规范化子命令和能力敏感选项；无须完整 argv 精确匹配。只映射明确支持的别名，例如 `npm i` → `npm install`。
3. `npm install` 属于**安装/构建模式，不是只读模式**：可能联网、运行 lifecycle scripts、改变锁文件。单独审核后可在限定工作区、写入范围和显式网络/脚本限制下给予任务级或会话级**构建**授权；不能与只读授权共用档位。若网络目标或脚本能力无法约束，就拒绝执行或改用限制更严的命令；不能借审批解除 OS 沙箱。
4. 原始 `sh -c`/`bash -c`、重定向、管道、命令替换、任意脚本/npx 不得因为 `argv[0]` 命中白名单而获得低危会话级授权。
5. 经审核的只读/常规构建模式可在限定工作区采用任务级或会话级授权；删除、危险 Git、敏感目录、远程发布等按次审批或拒绝。
6. 审批绑定**规范化后的完整能力集合与 argv 哈希**；审批后参数修改必须重新鉴权。

## 7. 实时输出和契约（P2/P3）

- `packages/contracts/src/events/tool-output.ts` 定义 `tool_output_delta` / `tool_output_truncated` / `tool_output_summary` 及 `OutputPolicy`；服务端负责验证与持久化决策。
- stderr/stdout 分离，并包含 `taskId`、`toolCallId`、`attemptId`、输出来源和序号；模型流和工具流使用同一任务级背压/取消框架。
- `tool_output_delta` 只实时流转；**不逐块持久化**。持久化经脱敏后的警告/错误摘要、最终结果、退出码和丢弃/采样计数。**`ToolStreamService` / `EventMultiplexer` 均属于 Express 的内部逻辑模块**，不允许创建旁路权限入口或新常驻执行器。
- 缓冲有界；慢消费者必须截断/限流并推送缺口标记。断线补拉保证关键事件，不承诺恢复未采集的所有 stdout 字节。
- 不信任 MCP/Worker 的输出保存等级声明；Tool Registry 定义强制落盘策略。不能把 API Key、令牌或敏感数据当日志保存。

## 8. 取消和故障

- 用户停止：`STOPPING` → 禁止新操作 → 取消 Worker/模型 → 对沙箱子进程树优先温和退出（POSIX 进程组 `SIGTERM`）→ 超时强制清理（POSIX `SIGKILL`；Windows 平台等价）→ 核实副作用 → `STOPPED`。
- 终止宽限期 **默认 5,000ms，允许范围 5,000～30,000ms**；Tool Registry 注册时拒绝不在范围内的配置。不得宣称宽限期能保证所有文件操作原子性。
- Worker 崩溃 → `INTERRUPTED`；Express 崩溃 → Fail-Closed 和旧进程树清理；关键副作用未知时记为 `UNKNOWN`，不可盲重试。
- 恢复旧任务须由用户明确选择继续；不存在无条件 exactly-once 外部副作用保证。

## 9. 密钥安全（P4）

- 凭据由 Express CredentialService 管生命周期及密文；Main 受限 Crypto Bridge 使用 `safeStorage`；Worker 不见密钥。
- 首次输入明文确实经过 Renderer、Preload、Main 和 Express；Main 加/解密时短时看到明文。这是已知残余风险，不得假装“主进程永不接触明文”。
- 明文流转逻辑集中在窄范围可审计模块中；禁止写入日志、遥测、异常对象、业务持久化数据库字段、Renderer 长期状态。
- JS/OS 内存和 crash minidump 不能保证“逐缓冲区彻底排除/清零”。涉密进程默认不启用应用级 crash dump 收集及远程上传；若启用先进行单独安全评审，系统级转储风险单独说明。

## 10. CI / PR 检查清单

- [ ] P0 冻结核验绑定 ADR-WIN-001 r1 的真实批准记录、规范更新和原始证据；改 frozen/blockers 不构成批准。
- [ ] P1 fixture 无生产执行资格；完整 Worker SEC-W01 在 P3 前完成，失败平台 agentReady=false；新 Windows framing/异步 I/O/配额必须真实测试。

- [ ] 代码导入边界 lint、契约运行时 Schema 和协议版本测试通过。
- [ ] Express 失败后旧 Worker 必须退出，新实例只能通过平台 WorkerLauncher 创建新 Worker（SEC-17）。
- [ ] 安装包 Node sidecar 加载 `better-sqlite3`，迁移、读写、重启烟测成功（SEC-18）。
- [ ] P3a 至少一个平台真实 `write_file/bash` 最小 OS 沙箱与 Read Gate 通过（SEC-23 + SEC-08）；**包括 P3a 平台在内**，未通过 P3b 的平台所有高危工具仍拒绝；只读按独立 Read Gate 控制。
- [ ] 每个宣称支持高危工具的 OS 通过沙箱、`.git`、网络、进程树完整安全验证（SEC-05～08/12/16/19/21；Git 只读另需 SEC-22）；仅支持基础 UI 的 OS 至少通过 SEC-01/02/13/14（共同 SEC-03 不豁免）；声称 `read_file` 另通过 SEC-08，声称 Git 只读另通过 SEC-22。
- [ ] 命令别名、危险选项、原始 Shell 包装不可提升授权（SEC-21）。
- [ ] 工具流可持续输出、内存有界、UI 断线显示缺口、DB 不按 delta 膨胀（SEC-19）。
- [ ] 停止默认 5s、最高 30s，超限配置在注册时拒绝；清理完成后才标 `STOPPED`（SEC-12）。
- [ ] 外部无效身份应拒绝；**合法 Worker 通过继承 IPC 身份可通信且留下审计**（SEC-03）。
- [ ] 密钥只在必要路径短暂出现，日志、崩溃收集、错误报告符合第 9 节（SEC-20）。

> 任何 AI 代理改动上述边界，必须先提出 ADR 和对应安全测试；不得直接变更并声称为“实现细节”。
