# ADR-WIN-001 r1：Windows 原生 Worker 创建与公开管道协议

日期：2026-10-24。决策版本：**r1**。本文为正式决策文本，**生效须具备绑定本决策包 SHA-256 的用户批准记录、规范同步及 P0 退出检查**；缺任一项均待批准/待应用，不得自行视为已接受。实验草案不再作为审批对象。

## 1. 决策及明确批准范围

批准本 ADR 是批准以下 D1～D5 整组架构修改，不是批准生产沙箱上线，也不是启动 P1 的执行授权。

| 编号 | 请求批准的修改 | 保持不变的边界 |
|---|---|---|
| D1 | Windows 以 Express 进程内原生 WorkerLauncher 替代固定 child_process.fork()；使用公开 Windows 创建/令牌/属性 API | Main→Express→直接子 Node Worker；不增加中间 launcher 进程、不伪装父 PID；Agent Loop 不迁入控制面 |
| D2 | Windows 从 Node IPC 改为一条创建时继承的受保护 Win32 双向管道，采用自主版本 framing + JSON-RPC 2.0 | 无 Worker 网络监听端口；唯一 contracts、双方 Schema、身份/实例/能力绑定；其他 OS 暂保留 fork + Node IPC 适配器 |
| D3 | 引入独立 Worker Gate，区分 P0 架构批准、P1 隔离测试资格和 SEC-W01 生产运行资格 | Worker 的 OS 隔离始终必需；工具 Read/Git/P3b 门禁独立且不能替代 Worker Gate |
| D4 | P1 可独立验证控制面/DB；报告 controlPlaneReady 与 agentReady 两种状态，未具资格时 agentReady=false | 不把健康检查成功表述为 Agent 可执行；真实任务入口返回 WORKER_ISOLATION_UNAVAILABLE，禁止降级无隔离 Worker |
| D5 | 按配套补丁更新 ARCHITECTURE/AGENTS，明确窄原生 transport bootstrap 例外及阶段验收 | 原生业务权限仅归 Express；Worker Runtime 禁 FS/DB/网络/任意 native 加载；不新增通用系统调用入口 |

涉及 ADR-001、010、011、015 的创建方式、传输及阶段解释；ADR-002 的唯一控制面、ADR-008 的数据库所有权和工具安全边界不变。

## 2. 决策依据及可行性结论

证据提交：[c44d8c9](https://github.com/JaxLim/OperationAgent/commit/c44d8c9d5c068c84e94053f3b624c0144694c3cb)，完整原始批次位于 `experiments/windows-worker-isolation/evidence/2026-10-24T04-52-17-103Z-5370b70e/`。

- stock fork 与 fork+Job 保持父子关系和 IPC，但未隔离合成工作区/数据库/凭据。固定 API 已成为实现障碍；继续把 fork 字面 API 当不变量没有安全收益。
- 原生候选已同时观察到直接父进程、首条指令前 AppContainer/零能力/低完整性、继承管道上的合法 RPC、文件和指定公网 TCP 显式权限拒绝，以及若干故障回收。
- 候选使用未公开 CreateAppContainerToken 与 Node 私有 framing；**不能据此声称本 ADR 的公开 API 实现已通过**。公开 SECURITY_CAPABILITIES 无 profile 路径曾返回 Win32 2；根因及受支持 profile 方案尚待 P1 验证。
- 回环只有超时、Node spawnSync 超时、真实 Electron/安装包/启动竞态/完整攻击矩阵未验证，保留 UNKNOWN。P0 接受的是有依据、可失败关闭的实现路线，而非这些安全性质已成立。

**结论：这条路线可以在架构层面替代 Windows 固定 fork API。** 已证明原生直接创建与启动前隔离能共存；公开 Win32 管道 API 具备所需创建、读写、继承能力。自主 framing 是 P1 必须完成的有界工程验证，不要求在 P0 再造一套完整沙箱。若 P1 的公开创建路径或隔离 transport fixture 失败，阻塞对应 P1 验收，禁止用旧实验组件或普通 fork 凑通过。

## 3. Windows 创建约束

正式方向固定为公开 CreateProcessW/CreateProcessAsUserW、STARTUPINFOEX、SECURITY_CAPABILITIES、HANDLE_LIST、JOB_LIST 和 CHILD_PROCESS_POLICY；AppContainer profile 采用公开 CreateAppContainerProfile/派生/删除接口管理。选择哪一条公开 CreateProcess 变体须由目标令牌权限与实际测试决定，不允许改用未公开导出作为静默替代。

profile 会影响用户目录/注册表。本 ADR 只批准架构路线，**不授权在当前开发主机工作区外创建 profile 或修改 ACL/防火墙**；P1 的该项验证在单独批准的可丢弃 VM/runner 中进行，安装与卸载负责明确的 profile 生命周期。不能把本轮未创建 profile 的失败反推成公开 API 本身不可行。

首条 Worker 指令之前必须满足：固定随包 Node、受信只读代码路径、白名单 env/cwd/argv、最小主令牌和能力、无业务 DB/凭据/工作区直接权限、网络拒绝策略、受限句柄继承、创建时 Job 归属和子进程约束。父进程持有真实进程句柄并在恢复前检查令牌及身份；失败即终止，不运行用户/模型内容。禁止以父 PID 属性伪造创建关系。

Job 负责回收/资源限制，不能替代文件和网络隔离。子进程策略必须配合危险进程/令牌句柄拒绝、无高权句柄继承验证。Express/Worker 失联、预算耗尽和清理未知时拒绝新执行；默认 5s 宽限、全局 30s 上限不变。

## 4. 公开 IPC 路线与最小协议

Windows 选 **CreateNamedPipeW + CreateFileW 预连接 + HANDLE_LIST 继承**。Express 在受信创建阶段建立单实例、随机名称、显式最小 DACL、拒绝远程连接的 duplex byte pipe；仅将连接好的子端传给 Worker，关闭父进程残留子端。名称不是认证秘密，禁止运行期间按名称重新接入。不要采用默认 DACL，也不要把预连接客户端 PID 查询误当成 Worker 身份证明。

读写使用公开 ReadFile/WriteFile 的 overlapped I/O 和取消/截止时间，不在 Express 主线程执行无界同步等待。Node 通过窄 Node-API 适配器持有受信句柄；不再依赖 NODE_CHANNEL_FD、CRT fd table、libuv 私有 frame 或 process.send。Windows 变更不要求 macOS/Linux 同时更换载体；公共逻辑报文和授权 Schema 只有一份。

P1 最小 OWIP/1 协议冻结如下；以后调整按协议版本回归，不分叉权限定义：

- 8 字节头：ASCII `OAW1` + uint32 little-endian payload 字节长度；长度 1～262144，分配正文前拒绝越界。完整 payload 严格 UTF-8，单个 JSON-RPC 2.0 对象，不接受 batch 或附带句柄传输。
- 同一逻辑 envelope 绑定 protocolVersion、expressRunId、workerRunId、requestId；双向严格 Zod Schema、角色/方法白名单、未知字段和重复响应拒绝。JSON-RPC id 只是关联值，不是授权。
- 初始挑战只走已继承的通道，不放 argv/env/日志；身份绑定父端创建的进程句柄和实例，而非信任 Worker 自报 PID。能力由 Express 与构建门禁取交集，不采信 Worker 扩权。
- 握手 10s；心跳 1s、连续 3 次失效；每方向最多 64 个在途请求、1MiB 数据队列，额外最多 16KiB 保留给关闭/取消控制帧。失败清理、背压和超限必须集成测试，不能以 OS pipe buffer 大小代替应用队列限制。
- 只在 P1 fixture 中开放 hello/health/shutdown/受控故障注入；任务、模型、工具 RPC 不在此阶段开放。处理写入完成和业务确认时使用不同语义。

模块归属：`packages/contracts` 保持纯 Schema；`packages/worker-transport` 包含窄协议适配，`packages/platform-worker` 为 Node ABI 原生边界。父端创建组件仅 Express 使用；子端只导出受信继承通道的收发/关闭能力，**不能把实验 probe 的 launch/ACL/fs/spawn 接口带入 Worker**。Agent Runtime 只依赖类型化 RPC client；其禁止 fs/net/DB/任意 addon 的约束不变。

## 5. 分阶段退出条件

| 阶段 / Gate | 必须解决 | 尚不得宣称或开放 |
|---|---|---|
| P0 / ARCH-DECISION | D1～D5 明确批准；规范与批准版本一致；原型原始证据/hash有效；Windows transport/所有权/失败语义/阶段责任已决定；Node/ABI/DB/打包基线检查通过 | 平台能力全部 unverified；不把原型 PASS 升格为生产 SEC-W01 |
| P1 / WORKER-FIXTURE | 公开创建路径+公开管道的受限固定 fixture；首指令前 OS 基线检查；合法/非法 RPC、身份、配额、断链、服务树及重启预算测试；安装包 Node/SQLite 烟测 | 无用户工作区、真实 DB/凭据、模型或 Agent Loop；fixture 无生产执行资格，发布构建移除注入入口 |
| P2 结束 / 进入 P3 前 / SEC-W01 | 准备进入生产执行链验证的平台，完成受影响 Worker 的文件、凭据、全目标网络/回环、危险句柄、子进程、启动竞态/实例复用/预算、原生边界、安装包和故障回收证据；Windows x64 是首个目标 | UNKNOWN/FAILED 均阻止该平台 Worker 生产资格；不因为要推进 P3 而改到 P4 再测 |
| P3a | 原定义：至少一平台真实 write_file/bash 最小沙箱+SEC-23、Read Gate | 高危工具仍关闭 |
| P3b / 上线 | 每个平台完整工具门禁；生产 Worker 还需 SEC-W01；发布时 P7 复验 | Read/Git/HighRisk 通过都不能绕开 Worker Gate |

**P1 可开发 ≠ P1 已验收 ≠ Worker 可生产执行。** 控制面、契约、迁移、监管可以先完成独立测试；没有隔离能力时只能报告 controlPlaneReady/agentReady=false，生产任务入口返回 WORKER_ISOLATION_UNAVAILABLE。禁止启动无隔离“临时 Worker”。无法启动真实受限 fixture 的平台，其 Worker 集成验收为 BLOCKED，不使用 skip/mock 宣布通过。

P1 总退出至少要求 Windows x64 的真实受限 fixture + 新管道和安装包 DB 测试通过；其他平台可以继续独立构建，但各自结果与能力不得继承 Windows 结论。P1 不实现业务 Agent；全生产 Worker 安全 Gate 最迟在相应平台进入 P3 执行链验证前完成。

## 6. 剩余风险、负责人及停止规则

| 风险 | 归属 / 最迟阶段 | 失败处理 |
|---|---|---|
| 公开 profile/创建路径兼容性、Node 模块加载 | Windows Launcher / P1 fixture | 受限 fixture 不 ready，P1 对应验收 BLOCKED；控制面可继续独立开发 |
| 新 framing、native 异步 I/O、取消及资源耗尽 | Transport / P1 | 拒绝握手或断链清理，不能复用私有 framing 作为生产回退 |
| 回环、IPv4/IPv6、TCP/UDP/DNS/代理出口；spawnSync 不返回 | Worker 安全审查 / SEC-W01，P3前 | 保持 UNKNOWN；禁止生产 Worker，不扩大权限使测试通过 |
| 句柄/令牌、ACL/重解析点、启动竞态、原生代码边界 | 平台安全审查 / SEC-W01，P3前 | 未过即关闭相应平台资格 |
| ABI、安装/签名、版本升级、其他平台 | 构建与发布 / P1、对应 Gate、P7 | 目标独立失败，不宣传未测平台 |

本轮不再扩展新的沙箱技术研究。后续只按这些有归属的验收项实现；若公开 Windows 创建路线在受控环境仍不可行，提交带证据的 ADR 修订，不回退普通 fork，也不重新打开无界方案探索。

## 7. P0 冻结与审批记录

`build/p0-decision.json` 绑定本 ADR、验收文档、规范修改补丁、原始证据及目标规范 SHA-256。批准记录必须指向其精确内容哈希，列明 D1～D5 并保留用户原话/来源。缺批准、旧批准、规范未同步、证据缺失/损坏或能力冒充 verified 时，check:p0-exit 必须失败。

JSON 记录是可审计索引，不能自行证明人类身份；批准的信任来自实际用户消息/人工代码审查。检查器防止遗漏、过期和仅改状态文件，不声称能阻止有仓库写权限者同时篡改检查器与审批记录。未获明确批准不得生成 approved 记录。P0 frozen 仅是已经完成检查后的状态摘要。

批准并完成规范同步/P0退出后，只提交 P1 开发建议；实施 P1 仍需用户明确授权。当前路线倾向不是正式批准。

## 8. 一手资料

- [公开 Win32 管道 API](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)：duplex、显式 DACL、overlapped I/O、首实例和远程连接限制；这些 API 能力不等同于完整实现已验证。
- [创建时属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)：句柄白名单、AppContainer、Job、子进程策略；危险进程句柄可能破坏子进程限制。
- [CreateAppContainerProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)：公开 profile 生命周期会创建用户目录和注册表存储，必须纳入安装/测试范围。
- [固定实验报告](../../experiments/windows-worker-isolation/REPORT.md)：区分已实现、实测结果与 UNKNOWN。该实验保持原样，不将失败历史改成成功。
