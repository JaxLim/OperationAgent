# DEC-001 Windows Worker 隔离实验（非生产）

本目录只用于 2026-10-23 用户授权的 P0 技术验证，不属于正式应用，不进入 P1。
不得从 apps/packages 导入，不发布 native addon，不将实验结果自动映射为平台能力。
ARCHITECTURE.md、AGENTS.md、既有 ADR 及 P0 blocker 保持不变。

原型比较 stock Node fork、fork 后 Job 约束、受限令牌候选与启动前 AppContainer 创建路径。
Express 仅作为实验父进程，不实现业务路由、Agent、数据库或凭据服务。
所有文件探针使用本目录生成的假工作区/数据库/凭据；禁止读取真实秘密。
网络探针仅做 TCP 建连，不发送应用数据；所有写入及 ACL 修改限本工作区。
不创建 AppContainer profile，不设置全局防火墙/loopback exemption，不改系统 PATH。

新增依赖仅属于独立实验：Express 5.3.0（实验父进程）；Zod 4.6.7（双方实验协议校验）；
@types/express 5.0.6（实验编译）。复用根目录 TypeScript/Node types/ESLint，不改生产依赖。
Native Node-API addon 属实验父进程与攻击探针，使用 Windows SDK，绝不是生产通用执行入口。

结果见 [REPORT.md](REPORT.md)、[未批准 ADR 提案](ADR-WIN-001-PROPOSED.md) 与 evidence/。
DEC-001 仍阻塞：原生候选部分测试通过，stock fork 不满足权限隔离，生产能力未验证。
未运行的性质为 UNKNOWN；已观察到违反的性质为 FAILED；PASS 只限具体实验条件。

固定 Node、依赖、VS Build Tools 与 SDK 准备好后，在仓库根运行：

```bash
.tools/node/node.exe experiments/windows-worker-isolation/check.mjs
.tools/node/node.exe experiments/windows-worker-isolation/_build/js/run.js --require-dec001
```

check 是工程质量检查；run 是实际 Windows 实验，写独立 evidence 批次。
`--require-dec001` 返回 2 表示完整安全验收尚未满足，禁止把采集成功当作安全通过。
单独运行某种创建方式可用 `--mode=lowbox --lifecycle`；完整复现命令和限制见报告。
所有 _build、_runs、下载与 node_modules 均忽略，源码、锁文件及原始 JSON 证据纳入版本控制。
