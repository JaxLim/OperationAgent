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
| `pnpm test:integration` / `package` / `test:smoke` | 仍退出 1 / NOT_IMPLEMENTED；未执行产品集成或安装器验收 |

P1.2～P1.7、公开原生创建、OWIP I/O、OS 隔离、数据库、实际服务树、安装包全部 NOT RUN。不得把静态导入边界或 Schema 单元测试解释为 SEC-W01、SEC-03/17/18、RPC-02 或 P1 总退出通过。
