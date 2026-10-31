# 参考 Magpie 修复并增强基础供应商、路由与网关可用性

## Goal

让管理员在空部署或现有半配置环境下，能够按照 UI 引导完成“Provider → 账户 → 模型 → 发布配置 → 下游 API Key → 网关自测 → 客户端接入”的完整链路，并参考 Magpie 的 Provider 预设和客户端接入体验，减少手工查文档、猜字段和猜 Base URL。

当前问题不是协议转换引擎缺失，而是初始化链路不可发现、不可验证：线上只有 1 个没有账户和模型的 Provider，配置版本为空，用户无法判断下一步该做什么。

## Background

2026-10-30 生产环境状态：

- 1 个 Provider `huawei`，`OPENAI_COMPATIBLE` / `openai-chat`，Base URL 为 `https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com`。
- 0 个账户、0 个模型、0 个别名/通配符/Combo。
- 0 个配置版本，`activeVersion = null`，`pendingChanges = true`。
- 校验 warning：`PROVIDER_NO_ACCOUNT`。
- Secrets 和 D1 迁移已就绪。

因此，本任务优先修复“基础能力不可用”的体验和实际拼接缺陷，而不是继续增加高级路由或隐私功能。

## Users and Scenarios

### 场景 A：首次部署

管理员打开 UI，看到“快速开始”，按清单：

1. 确认 Secrets。
2. 从预设添加 Provider（如火山方舟或华为云 MaaS）。
3. 添加账户，优先使用 Worker Secret 引用。
4. 同步模型或手动添加模型。
5. 确认能力并启用模型。
6. 发布配置。
7. 创建用户和下游 API Key。
8. 运行网关自测。

### 场景 B：已有半配置

管理员已有 Provider 但缺账户或模型。快速开始页显示缺失项和直接操作入口；不自动删除或改写现有 Provider。

### 场景 C：接入编码代理

管理员进入“客户端接入”，复制 Claude Code、Codex、Gemini CLI 或 OpenAI SDK 的 Base URL、环境变量和代码片段。

## Requirements

### R1. Provider 预设目录

- 内置预设至少覆盖：
  - 火山方舟（OpenAI 兼容）
  - 火山方舟（Anthropic 兼容）
  - 华为云 MaaS（OpenAI 兼容）
  - OpenAI
  - Anthropic
  - Google Gemini
  - DeepSeek
  - Moonshot Kimi
  - 智谱 GLM
  - 阿里云百炼/Qwen
  - OpenRouter
  - Groq
  - Mistral
  - xAI
  - Together
  - Fireworks
  - SiliconFlow
  - 自定义 OpenAI 兼容端点
  - 自定义 Anthropic 兼容端点
- 每个预设提供：名称、说明、类型、协议、Base URL、认证方式、可选 `endpointPath`、厂商文档链接和注意事项。
- 预设只预填表单，不自动创建 Provider，不自动写入账户，不自动启用模型。
- 预设 Base URL 必须允许管理员修改。
- 不根据模型名称推断能力。

### R2. 快速开始清单

- 新增管理员状态接口和 UI 页面，展示：
  - `ADMIN_TOKEN`、`API_KEY_PEPPER`、`ENCRYPTION_KEY` 是否已配置（只返回布尔值）。
  - Provider 数量、有账户的 Provider 数量、有模型的 Provider 数量。
  - 模型总数、启用模型数。
  - 当前配置版本、是否存在待发布变更、校验是否通过。
  - 活跃下游 API Key 数量。
  - 最近一次网关自测是否成功。
- 对每个未完成项提供页面跳转或直接操作按钮。
- 对 `PROVIDER_NO_ACCOUNT` 等配置校验警告显示可操作说明。
- 所有页面显示待发布配置提示。

### R3. Provider 设置向导

- Provider 列表支持“从预设添加”和“设置”两个入口。
- “设置”打开分步面板：
  1. Provider 基本信息（已有值只读展示，可跳转编辑）。
  2. 账户：新增、启用/停用、更新密钥、删除；支持 `apiKey` 和 `secretRef` 二选一。
  3. 模型：同步上游模型，或手动添加模型；同步结果列出新增/跳过数量。
  4. 能力确认：每个模型单独编辑能力并启用；提供“确认能力并启用”的明确操作。
  5. 测试：区分“模型列表可用”和“最小 Chat 可用”。
  6. 发布：提示发布配置并给出入口。
- 同步模型仍然默认禁用、能力全部 false，必须人工确认。
- 如果 `/models` 不支持或失败，提供手动模型表单；模型 ID 由管理员填写或从上游同步，不伪造成功。
- 账户密钥永远不出现在列表、审计或响应中。

### R4. 路由诊断

- 新增管理员接口和 UI：输入模型名，返回：
  - 命中的路由类型（Provider 前缀、原生模型、Alias、Wildcard、Combo）。
  - 解析 trace。
  - 目标 Provider/模型/上游模型。
  - 缺失账户、禁用模型、无效别名等诊断。
- 不执行上游请求。
- 诊断结果不包含任何密钥。

### R5. 网关自测

- 管理员可以选择一个已配置模型，执行一次最小非流式请求。
- 测试复用真实执行链路：路由解析、账户选择、URL 拼接、认证、协议转换、响应解析。
- 返回：成功文本、Provider、账户、模型、延迟、Usage、路由 trace；失败返回标准错误码和可操作说明。
- 请求默认 `max output tokens <= 32`，UI 明确提示会产生真实上游费用。
- 自测不写入用户配额，但应写入审计日志，便于快速开始页判断最近一次结果。
- 自测只允许管理员调用。

### R6. 客户端接入页

- 展示当前网关的四种协议入口：
  - OpenAI Chat/Responses：`/v1`，`Authorization: Bearer`。
  - Anthropic Messages：根路径，`x-api-key` + `anthropic-version`。
  - Gemini：`/v1beta`，`x-goog-api-key`。
- 提供可复制的环境变量片段，参考 Magpie 的代理接入方式：
  - `OPENAI_BASE_URL` / `OPENAI_API_KEY`
  - `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`
  - `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY`
- 提供 OpenAI SDK、curl 和 Claude Code/Codex/Gemini CLI 的配置示例。
- 明确说明下游 API Key 只能在创建/轮换时看到一次，并引导到 API Key 页面。

### R7. 基础拼接与错误修复

- 修复 OpenAI 兼容 Base URL 的版本路径拼接：
  - 支持 `/v1`、`/v2`、`/v3`、`/v4`。
  - 支持 `/api/v3`、`/openai/v1`、`/compatible-mode/v1`、`/api/paas/v4`。
  - 不得出现 `/api/v3/v1/chat/completions` 这类重复版本。
  - 保留 `extraConfig.endpointPath` 显式覆盖。
- Provider 测试错误要区分：
  - 没有账户。
  - 认证失败（401/403）。
  - 模型列表不可用（404/405）。
  - 网络/DNS/超时。
- 创建/修改 Provider、账户、模型后，UI 显示待发布状态。
- 不自动修改现有 `huawei` Provider；只在快速开始页提示缺失账户和模型。

## Non-Goals

- 隐私脱敏、占位符还原、Mask/Warn/Block。
- 账户会话亲和、prompt cache 亲和。
- 新路由策略 smart/usage/pace/intent。
- 周期/Token 配额、配额窗口、OTLP。
- 订阅 OAuth、本地账户发现、自动改写代理配置文件。
- 插件运行时、Web 搜索、图片/视频生成、MCP 工具。
- 自动推断或自动启用模型能力。
- 修复或验证用户真实上游密钥；这需要用户自行提供有效密钥。

## Constraints

- 所有代码必须兼容 Cloudflare Workers Runtime。
- 不新增不必要的 D1 表；优先使用现有表计算状态。
- 不新增明文密钥存储；继续使用 AES-GCM 加密或 Worker Secret 引用。
- 管理 API 只允许管理员访问。
- 不把上游密钥、Secrets 或敏感堆栈返回给客户端。
- UI 保持零构建原生 JS，不引入前端框架。
- 不破坏现有四协议转换、路由、Combo、限流、用量和部署流程。
- 预设和文档必须标注“以厂商文档为准”，不硬编码可能过期的价格或能力。

## Acceptance Criteria

- [ ] 从空部署开始，管理员可以在 UI 中通过预设创建 Provider、添加账户、创建/同步模型、确认能力、启用模型、发布配置、创建用户和 API Key，并成功运行网关自测。
- [ ] 现有 `huawei` Provider 在快速开始页被标记为缺少账户和模型，并提供直接修复入口；不会被自动删除或改写。
- [ ] 火山方舟 `/api/v3`、华为云 `/openai/v1`、OpenRouter `/api/v1`、智谱 `/api/paas/v4` 的 OpenAI Chat/Models URL 拼接正确。
- [ ] Provider 测试在没有账户、401、404、网络错误时返回不同且可操作的提示。
- [ ] 配置未发布时，快速开始页和相关页面有明确提示；发布后状态更新。
- [ ] 客户端接入页能复制四种协议的正确 Base URL、认证头和代码片段。
- [ ] 同步模型仍然默认禁用，能力必须人工确认；不存在按名称猜能力。
- [ ] 所有新增管理接口不返回上游密钥或 Secrets。
- [ ] `npm run typecheck` 通过。
- [ ] 现有测试全部通过，并新增预设/URL 拼接/设置状态/路由诊断/网关自测/端到端初始化测试。
- [ ] `npm run deploy:dry-run` 通过。
- [ ] 本地 `wrangler dev` 和部署环境完成一次手工验收。
- [ ] 文档更新 README、PROVIDERS、API、DEPLOY，包含火山方舟和华为云 MaaS 示例。
