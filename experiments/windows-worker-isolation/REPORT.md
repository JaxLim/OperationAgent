# DEC-001 Windows Worker 创建与权限隔离实验报告

日期：2026-10-24（UTC 原始时间见 evidence）；范围：P0 技术原型。**DEC-001 未关闭，P0 不冻结，不进入 P1，不宣布生产级沙箱支持。**

本轮完整复读 ARCHITECTURE.md、AGENTS.md、docs/P0-REVIEW.md、docs/adr/DEC-001-worker-isolation.md、docs/ACCEPTANCE.md。后续用户指令已明确授权此次实验；既有 DEC-001 中“本轮不启动”属于前一轮决定，本轮未修改其历史正文。

## 1. 结论

1. **原样 stock Node 24.22.1 fork()：FAILED。** 直接父进程和合法 IPC 成立，但合成工作区、数据库、凭据文件均可读写；回环连接及原生子进程创建也成功。
2. **原生候选路径：部分 PASS。** Express 进程内创建 AppContainer 主令牌，通过 CreateProcessAsUserW 创建直接子 Node Worker；令牌限制、Job、句柄白名单和子进程策略在恢复首条指令前检查。真实 Node `process.send`/`message` RPC、四类合成文件拒绝访问、指定公网 TCP 的显式权限拒绝、原生子进程拒绝以及父进程危险句柄拒绝可同时成立。
3. **仍不能满足既有 ADR。** 该路径没有调用 fork()，且依赖未公开 kernelbase 导出与 Node/libuv 私有 Windows IPC 格式。回环拒绝只有超时证据；Node spawnSync 发生超时；安装包、真实 Electron Main、启动竞态和跨平台等要求未验证。
4. 最小变更见 [ADR-WIN-001-PROPOSED.md](ADR-WIN-001-PROPOSED.md)：Windows 允许 Express 进程内原生创建直接子 Worker；IPC 载体另列两个可选方案，均未获批准。本轮只提交提案。

## 2. 环境与隔离范围

| 项目 | 实际值 / 边界 |
|---|---|
| OS | Windows NT 10.0.26300，x64；仅这一台主机 |
| 控制器 / Express 令牌 | 未提权，完整性 RID 8192；elevated=false |
| Node | 24.22.1；ABI 137；固定工作区内 `.tools/node/node.exe` |
| 编译器 | VS Build Tools 2022，MSVC 14.44.35207；SDK 10.0.26100.0 |
| C++ | C++20、/W4、/WX、/MT、Node-API；仅由随包 Node 实验进程加载，无 Electron ABI 重建 |
| 路径 | 每批使用 `runtime 空格`，覆盖中文及空格 |
| 测试隔离 | 独立实验目录、合成文件、候选 Worker OS 令牌限制；**不是可丢弃 VM，也不是安装包测试** |
| 允许读写 | 控制器只在本工作区创建 fixtures/runtime/evidence/构建与缓存；未读取真实凭据或业务数据库 |
| 外部状态 | 未调用 CreateAppContainerProfile；未改防火墙、loopback exemption、系统 PATH、全局 Git 或系统软件安装 |

`outside-workspace` 是“合成项目工作区之外、仍在 D:/Operation_Agent 实验根内”的标记文件，不是对用户真实工作区之外文件的探测。写入测试只请求打开现有标记文件的写权限，不修改其内容；最终四个 fixture 的 SHA-256 均未改变。非隔离对照组只运行这些固定、无实际副作用的探针，没有执行高危工具。

新增依赖只属于独立实验包：Express 5.3.0（真实实验父进程）、Zod 4.6.7（双方唯一实验 Schema）、@types/express 5.0.6（编译）。生产依赖及 packages/contracts 尚未创建。Windows SDK、MSVC 复用既有安装；Node headers/node.lib 下载到实验目录并核对官方 SHA-256，未完成下载签名链验证。

## 3. 技术分析与实施

Node v24.22.1 的 `lib/child_process.js` 将 fork 转为 spawn；Windows libuv 使用 STARTUPINFOW/CreateProcessW，公开 fork 选项没有 Windows token、AppContainer 或 STARTUPINFOEX 入口。Windows uid/gid 支持也不能替代这些 API。依据：[Node fork 文档](https://nodejs.org/docs/v24.22.1/api/child_process.html#child_processforkmodulepath-args-options)、[固定版本 JS](https://github.com/nodejs/node/blob/v24.22.1/lib/child_process.js)、[固定版本 libuv 创建实现](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/win/process.c)。

这不是“任何可能的定制 fork 都不可能”的数学证明。Express 全进程限权会破坏其数据库与网络职责；线程 impersonation 也不自动改变 CreateProcessW 使用的进程主令牌。外置 execPath launcher 再创建 Node 会增加一级父进程；本轮不使用父 PID 属性伪装创建者。见 [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)。

原生组件加载在 Express 进程内，按以下顺序创建 Worker：

1. 随机、首实例、拒绝远程连接的双向命名管道；父进程提前建立子端句柄。Worker 不监听网络端口。
2. 明确继承三类句柄：NUL 输入、只写诊断管道、一个 Worker RPC 通道。Job、进程句柄、父进程特意打开的凭据 canary 句柄不在 HANDLE_LIST 内。
3. 创建 kill-on-close、活动进程数 1 的 Job；通过 JOB_LIST 在创建时分配，而非启动后补挂。Job 只用于生命周期和进程数限制。
4. 设置 CHILD_PROCESS_RESTRICTED；以挂起方式创建后，从父端读取令牌、父 PID、完整性级别、能力数和 Job 成员关系，检查完成再 ResumeThread。没有使用 PARENT_PROCESS 属性。
5. `lowbox` 候选借鉴 Chromium 调用 kernelbase `CreateAppContainerToken`，取得 AppContainer 主令牌后传给 CreateProcessAsUserW。它是**未公开导出**，不是已批准生产 API。仅给实验 runtime 目录增加对应 SID 的 RX ACL；没有给 fixture 或盘符根增加权限。
6. 清理时关闭父进程唯一拥有的 Job 句柄；退出/断链超时由 Express 执行。构造失败通过 RAII 关闭资源，残留有精确实验 PID 的兜底回收；兜底不算通过。

属性依据：[STARTUPINFOEX 属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[受限令牌](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Chromium 令牌实现](https://github.com/chromium/chromium/blob/main/base/win/access_token.cc)。Chromium 链接为主分支调研来源，不是本实验二进制依赖。

Worker 端使用真正的 Node IPC bootstrap、process.send 和 message。父端实现锁定 Node 版本的 16 字节 libuv frame 和 CRT fd table 兼容桥；这**不是父端 ChildProcess 对象，也不是公共稳定传输 API**。输入均经过实验统一 Zod Schema；帧/消息/批次有上限，拒绝句柄转移与非法 UTF-8。实验 JSON-RPC 使用数值 error.code，验证 runId 和协议版本。完整生产 expressRunId/workerRunId/能力协商、审计持久化、背压和敌对流量测试仍未实现。依据：[libuv Windows pipe](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/win/pipe.c)、[CRT 句柄启动表](https://github.com/nodejs/node/blob/v24.22.1/deps/uv/src/win/process-stdio.c)。

## 4. 实际矩阵

**PASS 只表示指定主机、指定探针成立；不等于产品安全支持。**

| 创建方式 | 直接父进程 + RPC | 启动前 AppContainer | 文件权限隔离 | 结果 |
|---|---|---|---|---|
| stock fork | PASS | FAILED | FAILED | 不满足 DEC-001 |
| fork 后添加 Job | PASS | FAILED | FAILED | Job 不能补齐权限边界；还有启动后分配窗口 |
| 原生创建 + Job + 子进程策略，无降权 | PASS | FAILED | FAILED | 证明 IPC 桥和子进程策略本身可工作 |
| CreateRestrictedToken(DISABLE_MAX_PRIVILEGE) | PASS | FAILED | FAILED | 此配置没有 restricting SID，不能代表所有受限令牌方案都无效 |
| SECURITY_CAPABILITIES AppContainer | FAILED | UNKNOWN | UNKNOWN | CreateProcess 返回 Win32 2；未创建 Worker |
| SECURITY_CAPABILITIES LPAC | FAILED | UNKNOWN | UNKNOWN | 同上；具体根因未证明 |
| AppContainer 主令牌 lowbox 候选 | PASS | PASS | PASS（四类 fixtures） | 固定 fork API 不符；部分行为 UNKNOWN |

lowbox 在首条指令前和两次 Worker 探针中：AppContainer=true、IL=4096、capabilityCount=0、child policy=true；无 Node Permission Model。`IsTokenRestricted=false` 不能被误读为没有 AppContainer，二者是不同检查。

| DEC-001 属性 | 结论 | 原始观察及限制 |
|---|---|---|
| 真实 Express 直接父进程 | PASS | Native creatorPid、Windows parent PID 和 Worker 观察一致；未伪装父 PID |
| 首条指令前限权 | PASS（候选） | 挂起状态检查主令牌和创建时 Job，再 ResumeThread |
| 一条继承 Node RPC / 正常请求 | PASS（实验协议） | hello challenge/pid、后续 probe、旧 runId 拒绝、非法字段拒绝均成功 |
| 工作区 / 数据库 / 凭据 / 合成工作区外标记 | PASS（路径样本） | 启动早期和 RPC 后，Win32 读写均 error 5，Node 均 EPERM；父进程读写正向对照成功 |
| 指定公网 TCP | PASS（显式 API 拒绝） | Worker 对 1.1.1.1:443 返回 10013；父进程是 10060 超时，因此“可达公网端到端对照”仍 UNKNOWN |
| 回环 / Express 端口 | UNKNOWN | Worker 10060 超时；普通 fork 同一类端口可连接。未取得 WFP 拒绝事件，不把超时解释为确定权限拒绝 |
| 原生子进程与 breakaway | PASS（固定 Node --version 探针） | CreateProcessW 返回 367；breakaway 返回 5；没有运行普通 Shell |
| Node spawnSync | UNKNOWN | 即使设置自身 2s timeout 仍未及时返回；父进程 5s 探针截止后强制回收，不能记为授权拒绝 |
| 父进程危险权限 | PASS（组合权限探针） | PROCESS_CREATE_PROCESS / VM_WRITE / DUP_HANDLE 组合 OpenProcess 返回 5；未枚举所有攻击路径 |
| 凭据句柄不继承 | PASS（canary） | 显式 HANDLE_LIST 不含 canary，Worker 查询为无效句柄；完整句柄审计 UNKNOWN |
| Express 强杀 | PASS（本次实验） | Worker 挂死状态下强杀 Express，无协作退出仍回收；约 48.0ms 后确认不存活 |
| Main 强杀 | PASS（Node 模拟 Main）；真实 Electron UNKNOWN | 模拟 Main→Express→Worker 均为 Node；约 39.4ms；没有 Electron 安装包 |
| IPC 断开 / Worker 无限循环 | PASS（本次实验） | 分别等待 5000ms 后关闭 Job，强制回收耗时约 15.2 / 7.9ms，无残留 |
| 启动竞态 / PID 复用 / 重启预算 | UNKNOWN | 未做竞态压力与重启预算；轮询 PID 不能证明 PID 复用防护 |
| 安装后 / 多 Windows 版本 / ARM64 / macOS / Linux | UNKNOWN | 本轮未执行，不能继承本机结果 |

## 5. 可复核证据与已运行命令

最终完整批次：[2026-10-24T04-52-17-103Z-5370b70e/summary.json](evidence/2026-10-24T04-52-17-103Z-5370b70e/summary.json)。内含 7 个权限对照 + 5 个生命周期/Node spawn 场景，共 **12** 个。每个场景都有独立 JSON，记录 PID、启动前令牌、双方消息、原始帧 base64、诊断、错误码和清理结果。

- [权限原始记录](evidence/2026-10-24T04-52-17-103Z-5370b70e/lowbox-permissions.json)
- [环境、源码/二进制/规范/fixture 哈希和正向对照](evidence/2026-10-24T04-52-17-103Z-5370b70e/environment.json)
- [原生编译命令、输出及原始输出 base64](evidence/2026-10-24T04-52-17-103Z-5370b70e/native-build.json)
- [实际验收重放：12 条记录有效，要求未全部证明](evidence/2026-10-24T04-52-17-103Z-5370b70e/acceptance-replay.json)
- [质量检查命令、stdout、stderr、退出码](evidence/checks-2026-10-24T04-52-02-466Z/summary.json)

所有系统命令在 `D:/Operation_Agent`，通过 Git Bash 运行；PowerShell 包装入口先设 UTF-8。以下为已执行命令族；prepare/install 只需首次执行，测试没有依赖系统 PATH 中的 Node。

```bash
export PATH="$PWD/.tools/node:$PATH"
export npm_config_cache="$PWD/.cache/npm"
export XDG_CACHE_HOME="$PWD/.cache"
export XDG_DATA_HOME="$PWD/.cache/data"
export XDG_STATE_HOME="$PWD/.cache/state"
export PNPM_HOME="$PWD/.tools/pnpm-home"
node .tools/pnpm/bin/pnpm.cjs --dir experiments/windows-worker-isolation --ignore-workspace install --ignore-scripts --store-dir D:/Operation_Agent/.pnpm-store --cache-dir D:/Operation_Agent/.cache/pnpm
node experiments/windows-worker-isolation/prepare.mjs
node experiments/windows-worker-isolation/build.mjs
node node_modules/typescript/bin/tsc -p experiments/windows-worker-isolation/tsconfig.json
node --test experiments/windows-worker-isolation/_build/js/wire.test.js
node experiments/windows-worker-isolation/_build/js/run.js --quick
node experiments/windows-worker-isolation/_build/js/run.js --mode=plain-native
node experiments/windows-worker-isolation/_build/js/run.js --mode=restricted
node experiments/windows-worker-isolation/_build/js/run.js --mode=appcontainer
node experiments/windows-worker-isolation/_build/js/run.js --mode=lowbox
node experiments/windows-worker-isolation/_build/js/run.js --mode=lowbox --lifecycle
node experiments/windows-worker-isolation/check.mjs
node experiments/windows-worker-isolation/_build/js/run.js --require-dec001
node experiments/windows-worker-isolation/_build/js/replay.js experiments/windows-worker-isolation/evidence/2026-10-24T04-52-17-103Z-5370b70e --require-dec001
```

单元测试先得到 3 PASS / 2 FAILED（跨帧 UTF-8 和无效字节），修复后 5 PASS；加入证据判定回归后 **7/7 PASS**。原生 /W4 /WX、严格 TypeScript、实验 lint 均 PASS；根 `pnpm check` 的 **10/10 P0 测试及其他检查 PASS**。根 `--require-frozen` 返回 1，符合保持阻塞的预期；实验验收重放实际返回 **2**，不能用于声称 DEC-001 通过。

`run.js` 不带 require 标志时的 0 仅表示证据收集完成。历史批次有早期 `failure:null` 却未 ready 的记录，不能拿该字段单独判成功；最终批次使用明确矩阵和独立重放。所有早期失败证据仍保留，不覆盖或删除。

开发过程中实际遇到并保留的失败：CREATE_NO_WINDOW/CREATE_NEW_CONSOLE 下 0xC0000142；无 profile 属性路径 Win32 2；Node realpath 对 D:\\ 的 EPERM；spawnSync 超时；无效句柄探针 0xC0000008；初版 UTF-8 解码失败；根检查未经固定 pnpm 入口失败。对应处理没有给 Worker 扩大文件或网络权限：固定 DETACHED_PROCESS、固定 module 启动参数、拆分阻塞探针、仅捕获 canary 的预期 INVALID_HANDLE 异常、严格流式 UTF-8、修正检查入口。初版 canary 的共享模式曾造成 error 32，已修正，最终写权限对照不会借共享冲突伪造拒绝。

## 6. 已实现 / 已验证 / 计划实现

**已实现**：独立 TypeScript 实验 harness、真实 Express 父进程、故意使用 FS/网络/原生 API 的 hostile Worker 探针、原生创建/令牌/Job/句柄探针、严格实验契约、受限 IPC 解码、故障场景、证据判定、重放与构建检查脚本。

**已验证**：仅上述本机实验与质量检查。两份规范 SHA-256 与实验前一致，既有 ADR、P0 review-pending、P1 未开始及平台能力状态保持原值。没有修改正式应用代码或 CI 支持声明。

**计划实现、尚未验证**：ADR 审批后的原生创建/IPC 最终路线、可丢弃 VM、公开支持 API/profile 生命周期、完整网络/句柄/启动竞态/重启预算攻击矩阵、生产双 runId/能力协商与审计、DLL/模块替换和 TOCTOU、恶意 native code、完整安装包和跨平台验证。

实验残余风险：同步原生管道写入可能阻塞 Express；RX ACL helper 只适用于受信 harness 路径而非任意客户端路径；生产父端 native 组件内存安全未独立审计；AppContainer 不是 LPAC；未枚举系统 broker/COM、所有 token/进程句柄或所有网络协议；签名/安装/runtime 完整性未达生产标准。**禁止将实验直接接入正式 WorkerLauncher。**

下一步推荐先审阅 ADR-WIN-001 的 Windows 创建 API 例外及 IPC 选项，再在可丢弃 Windows VM 中解决公开 API、回环与 spawnSync 证据缺口；安装包与多平台门禁通过前继续保持 P0 阻塞。

## 7. 文件与版本控制范围

本轮新增文件全部在 `experiments/windows-worker-isolation/`，共 118 个：23 个源码/配置/说明文件，95 份 JSON 证据。

| 文件组 | 实际文件 |
|---|---|
| 原生组件 | `native/probe.cc` |
| 实验进程和协议 | `src/contracts.ts`、`native.ts`、`worker.ts`、`host.ts`、`supervisor.ts`、`wire.ts` |
| 实验和证据判定 | `src/run.ts`、`evaluate.ts`、`replay.ts`、`wire.test.ts`、`evaluate.test.ts` |
| 构建与依赖 | `prepare.mjs`、`build.mjs`、`check.mjs`、`eslint.config.mjs`、`tsconfig.json`、`package.json`、`pnpm-lock.yaml`、`.gitignore` |
| 说明 | `README.md`、`REPORT.md`、`ADR-WIN-001-PROPOSED.md` |
| 原始证据 | `evidence/` 中最终批次、历史失败批次和工程检查 JSON；不包含真实秘密 |

执行 `git add experiments/windows-worker-isolation` 和 `git diff --cached --check`；差异检查通过。编译产物、下载、复制的 Node 运行时、fixtures、依赖和缓存没有纳入 Git。Git 提交/远端同步结果以本轮交付消息的实际 SHA 为准。
