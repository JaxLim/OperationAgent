# P0 实际执行与验证记录

日期：2026-10-23（Asia/Shanghai）。本记录只陈述真实动作；生产功能和平台安全能力仍全部未验证。

## 已完成

- 完整读取两份规范：ARCHITECTURE 685 行，AGENTS 96 行。
- 经用户确认，将扩展名前有空格的两个文件重命名为标准名称。正文未编辑；SHA-256 重命名前后一致，值存于 `build/p0-status.json`。
- 用户已选择 DEC-001 方案 A：保留全部 ADR，记录 P0 技术阻塞，后续另行授权 Windows Worker 原型；本轮不进入 P1。
- 初始化 Git `main`，创建私有远端 `https://github.com/JaxLim/OperationAgent`。原始规范首个提交为 `c7d77de`。
- Git 作者仅在本仓库设置为 JaxLim / `186766578+JaxLim@users.noreply.github.com`；未修改全局 Git 配置。
- Node 24.22.1 Windows x64 实际可执行文件下载于 `.tools/node/node.exe`，SHA-256 与官方清单匹配，运行时报告 ABI 137。pnpm 10.34.7 tarball 的 SHA-512 SRI 核验通过，解压于 `.tools/pnpm`。
- 五个直接开发依赖、98 个解析安装包；单个 `pnpm-lock.yaml`。安装使用 `--ignore-scripts`，所有 store/cache 均在工作区。未安装应用运行时依赖。

## 本地实际通过

| 验证 | 结果 |
|---|---|
| `pnpm typecheck` | strict TypeScript 检查通过 |
| `pnpm lint` | ESLint 零错误、零警告 |
| `pnpm test` | 10/10 通过，0 跳过 |
| `pnpm build` | P0 检查工具编译成功；不是 Electron 应用构建 |
| `pnpm verify:p0` | 原文 hash、运行时/ABI、精确版本、校验和、阶段与能力状态通过 |
| `pnpm check` | 上述检查组合通过，输出 `review-pending` 与 DEC-001 blocker |
| `pnpm install --frozen-lockfile --ignore-scripts --offline` | 锁文件离线重验通过 |
| `node dist/tooling/scripts/p0-check.js` | 编译后的检查工具运行通过 |
| `pnpm check:p0-exit` | 退出码1且包含 `P0_NOT_FROZEN`，符合预期；**P0冻结未通过** |
| `pnpm test:integration` / `package` / `test:smoke` | 各退出码1且包含 `NOT_IMPLEMENTED`；只验证拒绝占位成功，**未运行应用测试** |

检查经过三类验证：最初10项元数据测试；锁定工具链下完整检查及lint修复；冻结锁文件/编译产物/负向命令回归。没有为了“3轮”虚构应用或安全测试。

## 执行过的主要命令与工具动作

每个 PowerShell 命令入口先执行：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
```

系统命令通过 `C:/Program Files/Git/bin/bash.exe -c ...` 调用。以下为实际动作清单（长 JSON 查询与工具调用按用途归并）：

```text
git --version / node --version / npm --version / pnpm --version / gh --version
git status --short --branch
gh auth status
git config --get user.name / user.email
uname -m / python --version / cmake --version
vswhere.exe -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
rg --files / rg -n（工作区、指定skill定位和轻量记忆检索）
PowerShell .NET ReadAllLines/ReadAllText（文件工具拒绝当前路径后的读取备用方式）
PowerShell .NET File.Move + SHA256（获批重命名与内容验证）
node --input-type=module -e ...（官方npm版本/peer/engines/SRI及Node校验和查询）
node scripts/bootstrap-windows.mjs
curl --fail --location --silent --show-error --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 240 --output .tools/node/node.exe.part https://nodejs.org/dist/v24.22.1/win-x64/node.exe
PowerShell .NET SHA256 + File.Move（校验后将node.exe.part纳入本地工具链）
node .tools/pnpm/bin/pnpm.cjs install --ignore-scripts --store-dir .pnpm-store --cache-dir .cache/pnpm
node .tools/pnpm/bin/pnpm.cjs check
node .tools/pnpm/bin/pnpm.cjs install --frozen-lockfile --ignore-scripts --offline --store-dir .pnpm-store --cache-dir .cache/pnpm
node dist/tooling/scripts/p0-check.js
Node spawnSync 执行四个负向门禁，断言退出码1及指定错误标记
git init -b main
git config --local user.name JaxLim
git config --local user.email 186766578+JaxLim@users.noreply.github.com
git add -- ARCHITECTURE.md AGENTS.md .gitattributes
git diff --cached --stat
git commit -m "docs: preserve initial OperationAgent architecture and development rules"
gh repo create JaxLim/OperationAgent --private --source . --remote origin --description ... --push
git diff --check / git ls-remote origin refs/heads/main
```

运行 pnpm 时临时 PATH 首位为本仓库 `.tools/node`；`npm_config_cache`、`XDG_CACHE_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`PNPM_HOME` 均指向本仓库子目录。未执行全局安装、未更改系统 PATH、未更改执行策略。

GitHub 插件用于确认账户和新仓库权限/可见性；插件没有创建仓库接口，故创建与本地推送采用已有认证的 gh。官方 Node/Electron/pnpm/Builder/Microsoft 文档通过联网核实；没有采用旧项目代码或架构。

## 真实遇到的问题及处理

- 文件工具允许路径错误地配置为另一工作区；改为当前工作区的本机只读调用，未修改工具权限设置。
- 两份文档最初名字含空格；获用户确认后仅改名。
- 命令工具直接选Bash误入WSL且 `/bin/bash` 不存在；改为显式启动真实Git Bash，之后成功。未将WSL当生产环境。
- 指定 `ps-utf8-io` skill 不在可用目录；已检查指定路径并检索 `.codex`/`.claude`/工作区，未找到可加载文件，**未声称已使用该skill**。所有PowerShell入口实际设置UTF-8。
- Node二进制第一次fetch超时，第二次连接被重置；从同一官方URL以curl重试成功，校验通过才执行。已给bootstrap加入相同源fallback。
- pnpm 12.15.0 实际包已切为原生Rust启动器，与既定JS调用方式不符；正式工程选用官方 `latest-10` 的 10.34.7（2026-10-12发布）。试验产物仅保留在忽略的 `.tools/pnpm12-probe*`，未进入依赖树或版本控制。
- 完整lint首轮发现bootstrap的 `fetch` 全局声明缺失与错误因果链未保留；修复后完整check通过。
- cmake未在PATH；P0无需它。VS C++组件可发现不代表SDK/原生构建验证已完成。

## 未完成或不适用的验证

- DEC-001 的 Windows Worker 隔离原型与所有 OS 安全属性：未实现/未验证。
- Electron/Express/Worker 应用、生产 contracts、SQLite原生addon构建和加载、SEC-03/17/18真实进程测试：P1计划，未运行。
- 安装器、打包后迁移/读写/重启、无系统Node场景、macOS签名公证、Linux内核门禁、Windows AppContainer/Job安全验证：未运行。
- Node发布签名链验证、产品代码签名、SBOM、更新回滚：尚未完成，当前哈希/SRI不等同这些验证。
- 当前CI仅配置P0工程检查，后续实际运行结果另记；任何绿色结果都不开放产品平台能力。

## 本轮文件范围

规范：`ARCHITECTURE.md`、`AGENTS.md` 仅改名，正文保持。

新增工程元数据：`.gitignore`、`.gitattributes`、`.editorconfig`、`.node-version`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json`、`tsconfig.tools.json`、`eslint.config.mjs`。

新增方案/门禁配置：`build/runtime-lock.json`、`build/electron-builder.config.json`、`build/p0-status.json`、`.github/workflows/p0.yml`。

新增P0工具/测试：`scripts/bootstrap-windows.mjs`、`scripts/p0-check.ts`、`scripts/run-checks.mjs`、`scripts/phase-required.mjs`、`tests/p0/baseline.test.ts`。

新增文档：`README.md`、`docs/P0-REVIEW.md`、`docs/ACCEPTANCE.md`、`docs/EXECUTION.md`、`docs/adr/DEC-001-worker-isolation.md`。

本地忽略产物：`.git/`、`.tools/`、`.cache/`、`.pnpm-store/`、`node_modules/`、`dist/tooling/`。未创建 `apps/` 或 `packages/`；未修改工作区之外的文件。
