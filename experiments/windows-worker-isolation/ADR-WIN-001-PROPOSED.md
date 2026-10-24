# ADR-WIN-001 提案：Windows Worker 的原生创建例外

状态：**PROPOSED / 未批准 / 不生效**。不替代或修改 ARCHITECTURE.md、AGENTS.md、ADR-001/002/010/011，也不关闭 DEC-001。仅供用户审阅本轮实验后的最小架构变更。

## 问题及证据

Node 24.22.1 的公开 `child_process.fork()` 没有令牌或 STARTUPINFOEX 参数。其 Windows libuv 路径使用 CreateProcessW。实测 stock fork 和 fork 后添加 Job 均能读写合成工作区、数据库及凭据文件。Job 的生命周期管理不构成这几类访问的权限边界。

实验已证明另一条有限可行路径：Express 进程内的原生组件创建 AppContainer 主令牌，再通过 CreateProcessAsUserW、创建时 Job、句柄白名单和子进程限制启动直接子 Node Worker。启动前令牌检查、合法继承 Node IPC 和文件拒绝可同时成立。然而它不是 fork()；本轮所用 CreateAppContainerToken 是未公开的 kernelbase 导出，父端兼容的是 Node/libuv 私有 Windows IPC framing。这两点都不是已经接受的生产依赖。

## 建议批准的最小规范变化

仅将 Windows 的固定创建 API 改为：

> Express 通过经审查、加载于自身进程的 Windows 原生 Worker 创建组件启动直接子 Node Worker；权限令牌、受限继承句柄和必要进程策略必须在首条 Worker 指令执行前确定。Main 不创建 Worker，不增加中间常驻 launcher 进程。原生创建失败必须 fail closed，禁止回退普通 fork/spawn。

其他平台暂保留原规范，不据此宣布 fork 已实现对应平台隔离。此提案不改变控制面、单 Agent、业务数据库所有权、工具调用路径或阶段顺序。

## IPC 的两个可审阅选择

1. **最小文本变更**：保留 Node IPC。必须把版本绑定、私有 framing/CRT 句柄布局、双向边界校验、背压、断链和升级回归纳入发布门禁。实验兼容桥不能直接成为生产组件；需要独立审查。Node 升级前重跑全部平台测试，失败则拒绝启动。
2. **推荐的长期方向，需额外明确批准**：允许 Windows 使用一条受保护、创建时继承的双向管道承载版本化 JSON-RPC 2.0，双方拥有其公开 framing，不模拟 Node 内部 IPC；无 Worker 监听端口。保持 Express/Worker 两个 runId、能力协商、统一 contracts、请求限制和故障语义。它会改变原定载体，不能称为“实现细节”。本轮未实现此方案。

不建议为保持 fork() 字面 API 而维护定制 Node/libuv，或进行运行时函数补丁。外置 exe 再启动 Node 也不能满足直接父进程要求。线程 impersonation 不足以限制 CreateProcessW 创建的进程。

## 批准后仍需完成的工作

- 在可丢弃 Windows VM 中对比微软文档支持的 AppContainer profile/启动方案与无 profile 令牌方案，明确安装、卸载、用户 profile 和 ACL 管理；不把未公开导出直接写成默认生产选型。
- 解释并解决本轮 `spawnSync` 超时；取得回环网络拒绝的 OS/WFP 证据和可靠网络正向对照，扩展 IPv6、UDP/DNS、局域网与系统代理/COM 等出口。
- 测试继承句柄污染、进程/令牌句柄、启动窗口强杀、父 PID 复用、重启预算耗尽、不同用户 ACL、reparse point/TOCTOU 以及恶意 native code。
- 保持工作区/DB/凭据无授权读取；runtime 只读路径不能成为模块或 DLL 替换入口。评估 AppContainer 的 ALL APPLICATION PACKAGES 权限及 LPAC。
- 在安装包、非管理员用户、中文/空格路径、最低支持 Windows 和目标 CPU 上复验。真实 Electron Main 的进程树监管必须另测。
- 全部要求通过并完成正式 ADR 审批后，才讨论解除 P0 阻塞；不自动开始 P1。

## 决策范围

本提案可以授权后续验证方向，不能凭本次结果把 Windows 标记为“生产级沙箱已支持”。如果不批准创建 API 的例外，现有 fork() 要求保持不变，DEC-001 继续阻塞。
