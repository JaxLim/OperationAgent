# ADR-PROV-001：账号登录型供应商与自定义模型端点

状态：**D1、D2 已于 2026-11-15 获项目所有者批准**。批准范围与原话见 [批准记录](approvals/ADR-PROV-001.json)。D3 的运行验证继续适用。

自定义地址和官方设备码授权均由 Express 管理。每种渠道分别验证 D3；未通过的渠道保持关闭。

本 ADR 及批准记录为 P0 冻结规范的增补。主进程仅打开固定的供应商验证页，模型凭据由 Express 通过 Crypto Bridge 加密管理。自定义请求每次校验 DNS 并连接已校验的 IP，保持 TLS 主机名校验。Worker 的进程与权限边界继续由原规范约束。

## 1. 背景

M2 设置扩展（本 ADR 同批提交）已经实现 **API Key 型** 供应商：Anthropic、OpenAI、Google Gemini、OpenRouter，以及网页搜索供应商 Exa、Tavily、Brave、Firecrawl。它们遵循 M2 第一切片的同一套规则：

- 密钥只经 Renderer → Preload → Main → Express 单向传入一次，由 Main `safeStorage` 加密，SQLite 只保存密文和 4 位提示（迁移 `006`）。
- 每个供应商只有一个**代码中固定的官方端点**（`PROVIDER_ENDPOINTS`）；网关禁止重定向、限制回复大小，只返回经 Schema 校验的模型 ID 和归一化状态。
- 打包后的应用拒绝任何端点覆盖（PR #8 的 `MODEL_ENDPOINT_OVERRIDE_REJECTED`）。

用户还要求两项能力，它们会改变 AGENTS.md §9 与 ARCHITECTURE §6 的凭据和网络边界，因此不能作为“实现细节”直接加入：

1. **账号登录（OAuth / 设备码）**：例如 ChatGPT 套餐、GitHub Copilot。
2. **自定义端点**：任意 OpenAI 或 Anthropic 兼容的 URL。

## 2. 风险

| 能力 | 新增风险 |
|---|---|
| 账号登录 | 需要长期 refresh token 并自动续期，凭据生命周期比静态 key 更长；登录回调要么开放本机监听端口（与“不开放监听端口”的原则冲突），要么走设备码轮询；需要打开外部浏览器；部分供应商的套餐登录条款可能不允许第三方客户端使用，需要逐个确认。 |
| 自定义端点 | 用户输入的 URL 可能指向内网或本机服务（SSRF）、明文 HTTP 或恶意代理，真实 key 会发往任意主机；“兼容”接口的回复格式不受控制，需要更严格的解析和大小限制。 |

## 3. 提议的决策

**D1 自定义端点**：允许 `https://` 端点，以及仅在用户明确勾选“本机端点”时允许的 `http://127.0.0.1` / `localhost` 端点。保存前做 DNS 解析检查，拒绝私有、链路本地、元数据地址（如 169.254.169.254）以及解析结果变化后指向这些地址的情况（防 DNS rebinding）；每次请求都重新校验。每个自定义端点使用独立凭据槽，key 只发往该端点的源（origin）。界面在保存时显示完整的主机名，并要求按次确认。

**D2 账号登录**：只使用供应商官方公开的设备码流程（device authorization grant），不开放本机回调端口。由 Main 打开系统浏览器；Express 轮询令牌端点。refresh token 与 access token 都经 `safeStorage` 加密，只保存在 Express 的凭据槽中，Worker 永远不可见。每个供应商单独确认其条款允许第三方客户端后才能列入白名单；无法确认的供应商保持锁定。

**D3 门禁**：两项能力各自需要以下真实测试通过后才能开放，任何一项未知或失败都返回 `CAPABILITY_UNAVAILABLE`：

- SEC-PROV-01：自定义端点拒绝私有/本机/元数据地址、DNS rebinding、重定向，以及 URL 中携带的凭据。
- SEC-PROV-02：key 和 token 不出现在日志、错误、Renderer 状态、SQLite 明文或进程输出中（沿用 SEC-20 的扫描方法）。
- SEC-PROV-03：token 续期失败、被吊销或过期时一律拒绝（fail closed），不回退到其他凭据。
- SEC-PROV-04：设备码流程不开放监听端口；取消或超时后不留下凭据。

## 4. 批准与实施记录

1. D1、D2 的批准原话保存在 `docs/adr/approvals/ADR-PROV-001.json`。
2. 本次支持 OpenAI 兼容自定义渠道及 Hugging Face 官方设备码授权，后者需要应用自己的公开 Client ID。
3. 规范增补记录在本 ADR，P0 历史文件继续保持冻结哈希。
4. 验证涵盖固定 IP 连接、TLS 主机名、重定向拒绝、本机勾选、跨地址密钥分离、令牌加密、刷新与取消，以及真实 Electron 保存后重启读回。真实供应商账号登录尚未联调。

2026-11-15：两项决策均已批准，验收按渠道记录。
