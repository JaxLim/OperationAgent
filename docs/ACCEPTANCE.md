# P0 / P1 验收方案

状态：P0 检查工具可执行；P1 以下用例为**计划实现**，不伪造通过。实际结果见 EXECUTION.md。

## P0 当前可执行命令

在锁定 Node 24.22.1/pnpm 10.34.7 环境执行；Windows 本机可使用 `.tools/node/node.exe .tools/pnpm/bin/pnpm.cjs <命令>` 替代 `pnpm <命令>`。

| 命令 | 验证范围 | 当前期望 |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | 锁文件、引擎/peer、只装审核的开发依赖 | 安装成功，无应用 native lifecycle |
| `pnpm typecheck` | P0 脚本/测试 strict TS，Node类型不扩散到基础配置 | 零错误 |
| `pnpm lint` | 工程工具静态检查 | 零错误/警告 |
| `pnpm test` | P0 正常/拒绝路径及未实现命令非零退出 | 全部通过；不是 IPC/沙箱/DB 测试 |
| `pnpm build` | 编译 P0 工程工具至 dist/tooling | 不产 Electron 应用 |
| `pnpm verify:p0` | 原文 hash、版本/ABI/平台校验和、禁虚假能力、无应用目录 | 元数据通过，并输出未冻结状态 |
| `pnpm check` | 上述 typecheck/lint/test/build/verify:p0 的顺序组合 | 同样不代表 P0 已冻结 |
| `node dist/tooling/scripts/p0-check.js` | 编译产物运行校验 | 与源码检查等价 |
| `pnpm check:p0-exit` | 必须 frozen 且无 blocker | **当前必须非零退出，DEC-001 未解决** |
| `pnpm test:integration` / `pnpm package` / `pnpm test:smoke` | 防止把未实现流程当成功 | 当前非零 `NOT_IMPLEMENTED` |

CI 文件 `.github/workflows/p0.yml` 在 Windows/macOS/Linux 运行 P0 工程检查。CI 绿色只表示这些检查通过，不代表平台 UI、Worker 隔离、原生 DB 或安装包支持。正式进入 P1 的入口必须先运行 `check:p0-exit`；当前未创建 P1 job。

P0 负例覆盖：浮动依赖、Node/Electron版本错配、TS strict被关、Node types污染、native Electron误重建、未经测试能力改为 verified、带 blocker 冒充冻结、丢失目标校验和、非对象配置、P1命令假成功。

## P1 测试接口（以下命令尚未实现）

P1 将以相同根命令接入真实程序：`pnpm build` 编译全部包；`pnpm lint` 同时检查进程边界；`pnpm test:integration` 真实 fork/HTTP/DB；`pnpm package -- --target <os-arch>` 在目标 runner 打包；`pnpm test:smoke -- --artifact <installer> --report <path>` 安装后执行。不得使用 `--passWithNoTests`，预期文件缺失/测试空集/无产物一律失败。

| ID / 阶段 | 自动动作 | 必须断言/证据 |
|---|---|---|
| BUILD-01 / P1 | contracts → Server/Worker → Main/Preload 的 TS references 构建 | strict、循环依赖为零、Node/DOM类型隔离、大小写正确；Renderer仅空测试宿主 |
| SEC-01 / P1 | 生成 fixture：Renderer import fs/Server/Worker；Main import DB；contracts import Node；Worker import net | lint/build非零，fixture清理；正向 contracts import 通过；覆盖别名/相对路径/require/dynamic import |
| SEC-02 / P1 | 恶意frame IPC、通用URL/方法请求、Renderer fetch loopback | IPC sender/Schema/路由和CSP拒绝；无业务副作用 |
| SEC-03 / P1 | 正确 token health；缺失/错误 token、Host、Origin；本地伪造Worker | 正向成功；负向401/403或无监听IPC；身份与runId绑定；token不入日志 |
| RPC-01 / P1 | 错版本/角色/runId/方法/未知字段/超限/重复ID，合法握手/health/shutdown | 两端Zod验证；错误只回安全字段；不发成功ready；队列/调用超时有界 |
| RPC-02 / P1 | 慢消费者、进程发送大量消息、disconnect、超时取消 | 内存/队列/在途请求有上限；断链后不自续；无未处理Promise拒绝 |
| PROC-01 / P1 | 记录Main、Express、Worker pid/ppid和execPath | Main只直启Express，Worker直接父为Express；只有一个继承IPC，无Worker网络监听 |
| SEC-17 / P1 | 强杀Express、Main；Worker卡死/连续崩溃；重启时注入旧runId | 有界终止旧树、退出确认后新实例；PID重用与启动竞态不误认；耗尽预算保持失败 |
| SEC-18 / P1 | 从真实安装包启动→DB migration→事务写/读→关闭→重启读回 | 实际随包Node与ABI记录；sqlite addon实际加载；migration幂等；故障rollback；Main/Worker不能读写DB |
| PKG-01 / P1 | 干净profile安装、PATH无Node、工作目录为空、安装路径含空格/中文 | 应用仍用resources/sidecar的运行时与完整生产闭包；不依赖源码/开发node_modules |
| PKG-02 / P1 | 拷贝产物后删掉一个native文件、改manifest hash或协议版本 | fail closed，绝不改用系统Node或其他ABI；无自动下载执行绕过 |
| PROC-02 / P1 | 正常关闭、窗口多开/二次启动、IPC断开、退出中再次请求 | 单实例、拒绝新请求、DB关闭、无遗留Worker；命令有硬截止时间 |
| SEC-W01 / 原型/P3前生产门禁 | 受影响Worker尝试FS/DB/凭据/外网/回环/额外进程 | OS拒绝+合法RPC成功，Windows必须解决DEC-001；记录进程身份/令牌/权限和实际系统调用结果 |

P1 不可用生产 credentials/实际用户DB测试；独立测试 userData/workspace 位于测试目录。检查日志脱敏、最终进程树、数据库hash、安装版本、OS build/arch/内核、关键配置和可复查报告。失败保留证据，不自动重试有副作用工具。

## 后续安全门禁追踪

| 阶段 | 必测编号 | 不得提前宣称 |
|---|---|---|
| P2 | SEC-09/13，事务/序号/重放 | P1只有基础migration，不是完整任务事件系统 |
| P3a | SEC-23 + 每目标平台SEC-08 | 最小沙箱成功不能开启highRisk；Git只读还须SEC-22 |
| P3b | SEC-04/05/06/07/08/11/12/16/17/19/21，Git只读SEC-22，Worker SEC-W01 | 未完成的OS不开放高危；未知不当作通过 |
| P4 | SEC-04/14/20，单Agent闭环 | safeStorage可调用不等于凭据链安全 |
| P5 | SEC-15 | MCP自报只读不授予权限 |
| P6/P7 | 全部适用SEC-01～23、签名/升级/SBOM/平台能力矩阵、安装后回归 | 对外功能×OS×arch必须都有证据 |

## 安装烟测流水线设计

1. 同平台/同架构干净 runner 拉取固定依赖、官方 Node 校验产物、生产闭包；原生模块以实际 Node ABI 构建。
2. 产物检查：resources/sidecar结构、运行时/SQL/native齐全、无源码敏感数据/跨目录symlink、生成manifest与SBOM。
3. 安装器安装到隔离目标目录（Windows NSIS用户级、macOS应用复制/签名检查、Linux目标包安装），**不能仅运行 unpacked 包代替安装器验收**。AppImage路径另测。
4. 通过打包应用测试模式走正式启动与认证路径；测试开关只在测试构建存在，不新增生产权限旁路。Main命令行不带token；Server在测试数据库做migration事务读写。
5. 关闭整树、独立再次启动、读回唯一测试marker；强杀场景复测；归档报告、退出码、日志脱敏证据与native hash。
6. release job 检查对应平台所有门禁、证书、公证/签名/SBOM；任一缺失阻止发布。自动更新完整性与回滚属于P7，P0不配置自动发布。

三平台检查工具通过不等于三平台安装烟测通过；macOS签名、Linux内核沙箱、Windows AppContainer都必须在对应目标真实运行。
