# 后续路线图（P1 退出后）

日期：2026-10-30。**P2.0–P2.3 已于 2026-10-30 由用户正式授权**（原话 “Authorize P2.0–P2.3”，记录于 `build/p2-status.json`，`pnpm verify:p2` 校验）；P3 及以后仍未授权。规范来源仍为 `ARCHITECTURE.md` / `AGENTS.md` `0.4.0-p0` 与 ADR-WIN-001 r1；本文件只是排序与拆分建议，**不构成阶段授权，不改变任何能力声明**。每个阶段开工前仍需用户正式授权并更新阶段状态文件及对应检查器。

## 1. 现状

- P1.0–P1.7 已在 Windows x64 以真实 CI 证据退出（[P1 退出报告](P1-EXIT-REPORT.md)）；`agentReady=false`，生产 Worker 无资格，三平台全部能力 `unverified`。
- P2.0 契约（PR #3）已合并：工具流、任务状态机、TaskEvent、领域错误。
- P2.1 事件存储（PR #4）已合并：迁移 `004-task-events.sql`（`tasks` 和只追加的 `task_events`）及 Express 内 `persistence/tasks.ts`；数据库版本为 4。
- P2.2 只读任务视图（PR #5）已合并：任务列表、快照和按游标分页的事件接口，经 Main 固定通道和 Preload 暴露。
- P2.3 Workbench 任务视图（PR #6）已合并：侧栏列出当前项目的已提交任务；详情页按游标同步并显示事件时间线；中断任务显示“副作用未知”和“不会自动恢复”；控制面重启后从游标重新同步。P2 四个阶段均已实现，P2 总退出（`p2TotalExit`）需要已提交的 CI 证据，暂为 NOT_RUN。
- M1 SEC-W01（PR #7）已合并：Windows x64 在一次性 runner 上真实通过，证据见 `docs/evidence/m1/win32-x64/`。UDP 无响应由 WFP 审计丢包证明；IPv6 通过“路由到不存在下一跳 + WFP 审计拦截”证明，没有豁免任何要求。
- M2 第一切片（2026-10-31，PR #8）：CredentialService + Main safeStorage Crypto Bridge（迁移 `005`，数据库版本 5）、Express Model Gateway（Claude Messages API 连接测试）、模型设置的 5 个固定 IPC 操作，以及参考 Lusion 的设计系统和 Settings › Model 分区。M1 已合并，Windows 生产 Worker 已获资格；但 Agent Loop 尚未实现，真实执行仍关闭（`agentReady=false`）。Read Adapter（SEC-08）和 Worker Agent Loop 留待 M2 后续切片。详见 `EXECUTION.md` 末节。
- 本地开发需把 `.tools/node` 置于 PATH 前部，否则 `pnpm run` 内嵌脚本使用系统 Node 并因 `engines` 失败。

## 2. 优先级排序

| 优先级 | 工作项 | 阶段 | 依赖 | 退出证据 |
|---|---|---|---|---|
| 1 | **P2.0 契约基础**：`events/tool-output.ts`（§9.1.1）、任务状态机与合法迁移表（§8.1）、副作用核实状态、`TaskEvent` 信封、领域错误码 `AppError`（§9.1） | P2 | 无 | 纯 Schema 单元测试：未知字段/越界拒绝、非法迁移拒绝、`deltaPersistence` 固定为 transient |
| 2 | **P2.1 事件存储**：迁移 `004`（`tasks`、`task_events`，任务内唯一递增 `seq`）、状态 + 事件同事务提交、`requestId` 去重 | P2 | P2.0 | 事务回滚、序号单调、重复请求只应用一次（SEC-09 前置）、重启读回 |
| 3 | **P2.2 快照 + 游标补拉**：`GET 快照` + `events?afterSeq=` 有界分页；Renderer 先快照后补拉，提交成功后才广播 | P2 | P2.1 | 断线重连重建一致状态（SEC-13 前置）；安装后烟测扩展到新迁移 |
| 4 | **P2.3 任务状态 UI 接入**：Workbench 读取真实任务快照/事件（仍拒绝执行，任务停在 `CREATED` 或被拒绝） | P2 | P2.2 | 真实 Electron 链路测试；不显示虚假可执行能力 |
| 5 | **SEC-W01 Windows 生产 Worker Gate**（文件/凭据/网络/回环、危险句柄、启动竞态、原生边界、遗留 profile 对账） | P3 前置 | P1.4 | 一次性 runner 真实证据；任一 UNKNOWN 继续拒绝 |
| 6 | **P3a**：Windows Read Adapter + SEC-08 Read Gate；`write_file`/`bash` 最小 AppContainer/Job 沙箱 + SEC-23 | P3a | SEC-W01、P2 | SEC-08、SEC-23 真实证据；高危仍关闭 |
| 7 | **P3b**：审批/授权、Shell 规范化（SEC-21）、Git 白名单（SEC-07/22）、工具流背压（SEC-19）、停止语义（SEC-12） | P3b | P3a | 逐平台 SEC-05～08/12/16/19/21 |
| 8 | P4 单 Agent 闭环 → P5 MCP → P6 产品 UI → P7 故障注入/签名/发布 | P4–P7 | 依次 | 见 ARCHITECTURE §13 |

并行可选（不阻塞主线，可在任意阶段插入）：安装包代码签名配置（需证书）、macOS/Linux 进程集成 runner、SBOM 生成。

## 3. 拆分原则

- P2 只引入数据形状、状态与持久化；不新增任何执行能力，不改变 `WORKER_ISOLATION_UNAVAILABLE` 拒绝路径。
- 改 `ControlHealth.databaseVersion` 等字面量会牵动集成与安装后烟测，P2.1 须同批更新并重跑 `pnpm check` 与 `pnpm test:smoke`。
- 每个切片单独提交、单独 CI；状态文件中的完成声明必须由检查器对照已提交证据校验。

## 4. 本轮（2026-10-30）执行范围

仅实施 P2.0 契约基础（纯 `packages/contracts` Schema + `tests/p2` 单元测试），不改数据库、HTTP 路由、Renderer、阶段状态文件或任何冻结文件；工程门禁本地运行，未产生 CI 证据。结果见 `EXECUTION.md` 末节。

## 5. P2 之后：通往可用 Agent 的最短合规路径（2026-10-31）

目标是尽快得到一个能真正执行任务的桌面 Agent，同时不绕过任何安全门禁。按 ARCHITECTURE §13，真实执行依赖三道门：生产 Worker 资格（SEC-W01）、工具门禁（只读走 SEC-08，高危走 P3a/P3b）和模型闭环（P4）。建议顺序如下，每个里程碑单独提 PR、单独 CI：

| 里程碑 | 交付 | 退出证据 | 依赖 |
|---|---|---|---|
| **M1 SEC-W01（Windows）** | 在 P1.4 受限 fixture 上补齐生产 Worker 攻击面测试：用户文件与凭据不可读、全网络与回环被拒、无危险句柄继承、启动竞态、原生边界只暴露通道。全部在一次性 CI runner 上运行 | runner 证据全部 PASS 后，Windows 才能 `workerIsolation=verified`；有任何 UNKNOWN 都不放行 | P1.4 |
| **M2 只读 Agent（P3a Read Gate + P4 最小闭环）**（**已完成，Windows x64**：七个切片全部合并，隔离运行时在一次性 runner 上端到端通过，证据见 `docs/evidence/m2/win32-x64/`；真实 Claude API 尚未验证） | Read Adapter 短命子进程（AppContainer，仅授权项目目录可读）+ SEC-08；Express Model Gateway + CredentialService/safeStorage + Claude 适配器；Worker Agent Loop 只能调用 `read_file` | SEC-08、SEC-20 真实测试；用模拟模型服务端做端到端 CI；第一次真正可用：能读代码并回答问题的 Agent | M1 |
| **M3 写入与 Shell（P3a 沙箱 + P3b）** | `write_file`/`bash` 的 AppContainer + Job 沙箱、审批流程、Shell 规范化、工具流背压与停止 | SEC-05～08/12/16/19/21/23 | M2 |
| **M4 产品化** | 审批/停止/恢复 UI 打磨，MCP（P5），签名与升级（P7） | 见 §13 | M3 |

需要用户决定的事项：
1. **模型供应商**：默认采用 Anthropic Claude（Messages API）。API Key 由用户在应用内输入，经 safeStorage 加密，Worker 不可见。
2. **执行顺序**：上表把 P4 的最小闭环和 P3a 的 Read Gate 合并为 M2，先交付只读 Agent，写入和 Shell 留到 M3。这样不改变任何门禁，只调整交付顺序；ARCHITECTURE §13 也允许只读能力先于高危能力开放。

## 6. 平台路线图（2026-11-10，ADR-PLAT-001）

用户于 2026-11-10 指令把目标从“可用的桌面 Agent”扩展为“可独立完成复杂任务的自主 Agent 平台”，优先级为：规划与编排、目标驱动的自主工作流、技能与插件、性能与 Token 效率、生产可靠性。范围授权与原话记录在 `build/agent-status.json` 的 `platform` 中，设计与边界分析见 [ADR-PLAT-001](adr/ADR-PLAT-001.md)。本节是排序；能力声明仍以检查器对照已提交证据为准。

### 6.1 评估结论（决定排序的事实）

1. **Agent 只对模型服务替身跑通过。** 隔离运行时的端到端测试已在一次性 runner 通过，证据已提交，M2 据此退出；但真实 `api.anthropic.com` 上从未有过运行记录。所有平台能力都建立在这条链路上，所以取得一次真实运行记录是最先要补的验证（需要密钥与同意）。
2. **会话只增不减。** 每轮都重发全部历史；任务读得稍多就会碰到上下文上限并失败，没有压缩、清理或用量可见性。这是当前最大的架构瓶颈，且修正方式受模型约束（历史只能追加，见 ADR §3）。
3. **没有任何性能数据。** 首字延迟、每轮耗时、Token 与缓存命中、每次读取的子进程开销都没有记录，后续优化无从比较。
4. **只读工具过粗。** 只能整文件读取和列目录，没有搜索和按行读取；定位一处定义要读入整个文件，Token 花在不需要的内容上。
5. **一个任务就是一问一答。** 没有计划、没有后续追问、没有检查点；Worker 丢失后任务只能标为中断，不能从中断处继续。
6. **写入与 Shell 尚未开始（M3）。** 这是最大的一块安全工作，也是技能脚本、运行测试做核验、本地 MCP Server 的共同前提。

### 6.2 排序

| 顺序 | 切片 | 交付（真实可用的功能） | 验证 | 状态 |
|---|---|---|---|---|
| 0 | **M2 退出** | PR #15、#16 合并；修正 main 上的烟测竞态（#17）；提交 runner 证据并记录 `agentReady`（#18） | `pnpm verify:agent` 对照 `docs/evidence/m2/win32-x64/` | 已完成（Windows x64）；真实 API 未验证 |
| 1 | **M5.1 上下文引擎与度量**（D1、D2） | 服务端工具结果清理与压缩；每轮首字延迟 / 耗时 / Token / 缓存命中；任务用量汇总；离线基准命令 | 前缀只追加检查；假模型服务端到端；基准结果入库 | 下一个 |
| 2 | **M5.2 选择性检索**（D3） | `read_file` 行范围；`search_text`；`find_files` | 每个新操作的 SEC-08 同类测试（穿越、敏感路径、链接竞态、上限）；基准对比读入字节数 | 未开始 |
| 3 | **M5.3 计划与进度**（D4） | `update_plan` 工具；计划事件与快照；界面进度；完成核对与停滞提醒 | 契约与状态测试；真实 Electron 链路 | 未开始 |
| 4 | **M6.1 会话与检查点**（D5） | 同一会话内追问；检查点落盘；中断后由用户选择从检查点继续 | 重启后继续的集成测试；检查点关闭时不落盘 | 未开始 |
| 5 | **M6.2 只读技能**（D6） | `SKILL.md` 发现、逐项目启用、`load_skill` | 哈希变化需重新启用；技能内容不能扩大能力 | 未开始 |
| 6 | **M3 写入与 Shell** | 沙箱、审批、Shell 规范化、工具流、停止语义 | SEC-05～08/12/16/19/21/23 | 未开始（既有授权） |
| 7 | **M7 编排与目标**（D7、D8） | 子 Agent；带预算的目标驱动运行；核验与反思阶段 | 并发循环隔离 / 取消 / 配额；预算与停止条件 | **待批准 D7、D8** |
| 8 | **M8 MCP 与插件**（D9、D10） | MCP Host；插件清单与生命周期 | SEC-15；插件越权测试 | **待批准 D9、D10**，依赖 M3 |

顺序 1～5 不新增任何操作系统能力，可在 M3 之前交付；M3 与它们相互独立，可交替推进。跨平台（macOS、Linux 的 SEC-W01 与 Read Gate）仍为 NOT_RUN，按 §2 的“并行可选”处理，不阻塞主线。

### 6.3 尚未验证、需要用户参与的事项

- 真实 Claude API 上的端到端任务、上下文管理 beta 的实际行为与费用：需要密钥与同意（ADR §8 第 5 项）。
- B 类决策 D7～D10 的批准（ADR §8）。
