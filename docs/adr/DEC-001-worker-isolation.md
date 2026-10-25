# DEC-001：Windows Worker 创建与 OS 隔离的可验证实现路径

状态：**架构决策已解决**。用户于 2026-10-24 正式批准 [ADR-WIN-001 r1](ADR-WIN-001.md) D1～D5；规范已同步。P0 总退出仍须由 `check:p0-exit` 核验；生产 Worker 的 SEC-W01 尚未通过。

以下原始问题和方案 A/B 保留为 2026-10-23 的历史记录；当时选择 A，随后已授权并完成独立原型。本文件不替换规范，当前决策以已批准 ADR-WIN-001 r1 为准。

## 已冻结要求

- ARCHITECTURE §3.1、§14：Express 必须以 `child_process.fork()` 创建自己的直接子 Worker；继承 Node IPC 承载 JSON-RPC 2.0。
- ARCHITECTURE §2.2(4)、§6.1 和 AGENTS §2：面对受影响的 Worker，工作区、数据库、凭据、任意网络的拒绝访问必须有 OS 权限与测试证据。
- Express 自身需要数据库和模型网络权限，不能简单将整个控制面一起套用 Worker 的拒绝策略。

## 核查证据与边界

Node 24 官方 `fork()` 选项没有 Windows AppContainer / 受限令牌 / `STARTUPINFOEX` 属性入口。Node Permission Model 不承诺约束恶意代码。Windows Job Objects 的生命周期和资源约束也不能替代文件、网络及进程访问隔离。

由此得出的**工程判断**：仅使用 stock Node 的公开 `fork()` 配置，当前没有已证明满足 Windows Worker OS 隔离的方案。这里不声称数学上不可能；原生启动钩子、自限权 bootstrap、定制 Node 等候选均需要原型证明。尤其不能在 Worker 已加载不可信代码后才补限权，不能把线程 impersonation 当成不可逃逸的进程权限边界。

用外部原生 launcher 再创建 Worker 可能改变直接父子关系；直接用原生 `CreateProcess*` 替代 `fork()` 则改变固定 API。手工模拟 Node IPC 私有句柄/环境协议也带来版本耦合，未经测试不得采用。

## 选项

**A（推荐当前轮采用）**：保留全部 ADR。P0 标记 `review-pending`，本轮完成文档、元数据、检查工具与 Git。后续单独授权一个 Windows 原型任务，证明 Express 直接父进程 + 单继承 Node IPC + 启动前 OS 限权能同时成立；原型通过或完成正式 ADR 评审后才冻结。原型不是本轮 P1，更不能用无隔离生产 Worker 临时交付。

**B**：授权另起正式 ADR 评审，将固定的 `fork()` API 放宽为“Express 以受审查的平台原生创建路径启动直接子 Worker”，保持单 Agent、控制面、Schema、实例身份和 JSON-RPC 不变；同时评估是否需要受保护的继承管道代替 Node 内部 IPC。只有新 ADR 被明确批准并写回规范后才能实现。**本轮不改两份原文，不自动采用此方案。**

不接受的处理：只启用 `--permission` 即声称 OS 沙箱；只禁 import；只加 Job；把 Worker 移入 Main/Express；把工具禁用误当成 Worker 本身隔离；隐藏父子关系变化。

## 原型必须给出的证据

1. Windows 实际 PID/父 PID、进程令牌、完整性级别、AppContainer/等效策略及允许句柄清单；只允许继承一个 Worker RPC 通道。
2. Worker 启动早期及业务代码运行后，尝试读取工作区/DB/凭据标记文件、连接公网与回环、创建子进程或连接控制面，均按矩阵被拒绝；RPC 正常路径仍成功。
3. Express 被强杀、Main 被强杀、IPC 断开、Worker 卡住、启动竞态、重启预算耗尽时，旧进程退出并拒绝旧 runId。
4. 安装后、无管理员权限、路径含空格/中文、受控环境变量、目标 CPU 上复验。
5. Windows 之外逐平台建立相同的目标行为测试；一个平台通过不继承给其他平台。

来源（2026-10-23 核查）：[Node 24 child_process](https://nodejs.org/docs/latest-v24.x/api/child_process.html)、[Node 24 permissions](https://nodejs.org/docs/latest-v24.x/api/permissions.html)、[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)。

## 2026-10-24 批准后的处置

- 真实批准见 [r1 批准记录](approvals/ADR-WIN-001-r1.json)，绑定决策包 SHA-256 `01c286cb6a3060a9d09a007f4d151f64ec914b6d6dcc905f025f7d5ad9baef58`；用户原话为“批准 r1 全部修改（推荐）”。
- Windows 改为 Express 进程内原生直接创建 + 公开 Win32 继承管道 OWIP/1 / JSON-RPC 2.0。直接父进程、唯一控制面和首指令前 OS 限权不变；未公开令牌导出和 Node 私有 framing 不进入正式方案。
- 原型证据保持原样。公开 profile/创建路径与新管道受限 fixture 属 P1 必须通过的验收；完整 SEC-W01 最迟进入相应平台 P3 执行链验证前通过，UNKNOWN/FAILED 均拒绝生产 Worker。
- 本次只关闭架构选择冲突，不宣称生产沙箱完成，不授权开始 P1。P1 实施建议见 P0-REVIEW 的 P1.1～P1.7。
