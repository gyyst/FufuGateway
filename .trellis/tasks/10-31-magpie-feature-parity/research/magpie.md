# Magpie 功能调研与 FufuGateway 差距

## 调研日期

2026-10-30

## 参考来源

- [Magpie 仓库](https://github.com/yetone/magpie)
- [Magpie README](https://github.com/yetone/magpie/blob/main/README.md)
- [Gateway routing and fallback](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-routing.md)
- [Providers and accounts](https://github.com/yetone/magpie/blob/main/docs/subsystems/providers-accounts.md)
- [Gateway middleware](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-middleware.md)
- [Gateway sessions](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-sessions.md)
- [火山方舟 Chat API](https://ark.volcengine.com/region:cn-beijing/docs/chat-api)
- [火山方舟 Base URL 与鉴权](https://ark.volcengine.com/region:cn-beijing/docs/base-url-and-authentication)
- [火山方舟兼容 OpenAI SDK](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh)
- [华为云 MaaS OpenAI 兼容接口](https://support.huaweicloud.com/model-call-maas/model-call-021.html)
- [华为云 MaaS 首次调用](https://support.huaweicloud.com/qs-maas/qs-maas-0001.html)

## Magpie 的定位

Magpie 是面向本地 AI 编码代理的网关与配置管理器。它把 Claude Code、Codex、Gemini CLI 等代理的模型、Provider、账户集中到一个本地网关（默认 `127.0.0.1:3425`），并完成四协议转换、账户故障转移、路由组、隐私脱敏、用量和客户端配置改写。

它不是单纯的 API 代理，优势主要来自“让普通用户能完成配置并持续使用”的产品化能力，而不是协议转换本身。

## 能力对比

| 能力 | Magpie | FufuGateway 现状 | 本次决策 |
|------|--------|------------------|----------|
| Provider 预设 | 大量厂商预设，填 Key 即用 | 需要手工填写 type/protocol/baseUrl | 采纳：内置预设目录 + 表单预填 |
| 账户发现/订阅登录 | 读取 Claude/ChatGPT/Copilot 等本地登录 | 只支持 API Key/Secret | 不采纳：Cloudflare 无法安全复用本地登录，且涉及订阅条款 |
| 模型目录 | 从厂商拉取模型，结合 models.dev | 支持 `/models` 同步，但同步后全部禁用，手工确认成本高 | 采纳并改进：同步 + 手动回退 + 明确的启用/能力确认流程 |
| 客户端接入 | 自动改写代理配置文件 | 只有协议入口，没有接入说明 | 采纳可行部分：客户端接入页，生成环境变量和代码片段 |
| 路由组 | smart/order/rotate/usage/pace、嵌套组、意图路由 | Alias/Wildcard/Combo，9 种策略、嵌套、粘性 | 基础路由已足够；smart/usage/pace/intent 延后 |
| 会话亲和 | 会话跟随命中的账户，利用 prompt cache | Combo 有会话粘性，但账户选择不按会话保持 | 延后；先确保基础路由可用 |
| 隐私脱敏 | Mask/Warn/Block、占位符、流式/工具参数还原 | 仅日志脱敏，无请求体脱敏 | 延后；独立安全任务 |
| 配额与用量 | Key 级日/周/月 token/成本、配额窗口、会话用量 | RPM/TPM/并发/日/月预算、日汇总 | 延后；独立配额任务 |
| 插件/中间件 | Bun/JS 动态中间件 | Workers 无动态代码执行环境 | 不采纳；后续可做声明式请求策略 |
| 本地网络共享/远程/同步 | 有 | 本身就是云端多租户网关 | 不采纳 |
| Web 搜索/图片/视频/MCP | 有 | 明确不实现媒体生成；有工具协议 | 不采纳 |

## 当前线上状态

2026-10-30 通过管理 API 检查 `fufugateway` 生产环境：

- `providers`: 1 个，名称 `huawei`，类型 `OPENAI_COMPATIBLE`，协议 `openai-chat`，`baseUrl = https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com`。
- `accounts`: 0。
- `models`: 0。
- `aliases` / `wildcards` / `combos`: 0。
- `config/versions`: 0，`activeVersion = null`，`pendingChanges = true`。
- 配置校验只有一个 warning：`PROVIDER_NO_ACCOUNT`。
- Secrets 已配置，迁移已执行。

结论：当前不是协议转换或路由算法不可用，而是**从 Provider 到账户、模型、发布、下游 Key 的初始化链路没有完成**，且 UI 没有引导用户完成这条链路。用户看到的“完全无法使用”是配置状态为空导致的。

另外，`huawei` 这个名字与 `volceapi.com` 主机不匹配：该主机更像火山引擎方舟的专属网关地址。不能假设它一定是华为 MaaS；实现中应提供方舟和华为两种预设，并允许自定义 Base URL。

## 关键实现缺陷

### 1. Base URL 版本路径只识别 `/v1`

`src/providers/transport.ts` 的 `ensureVersionedPath` 只在路径为空或以 `/v1` 结尾时正确拼接：

- `https://api.openai.com` -> `/v1/chat/completions`，正确。
- `https://api.modelarts-maas.com/openai/v1` -> `/openai/v1/chat/completions`，正确。
- `https://ark.cn-beijing.volces.com/api/v3` -> 当前会拼成 `/api/v3/v1/chat/completions`，错误。
- `https://open.bigmodel.cn/api/paas/v4` -> 当前会拼成 `/api/paas/v4/v1/chat/completions`，错误。
- `https://openrouter.ai/api/v1` -> `/api/v1/chat/completions`，正确。

这是“预设 Provider 添加后仍然请求失败”的直接风险。需要在保留 `/v1` 行为的同时，识别任意版本段（`/v1`、`/v2`、`/v3`、`/v4`、`/api/v3`、`/openai/v1`、`/compatible-mode/v1` 等），并补充 `endpointPath` 显式覆盖能力。

### 2. 同步模型后全部禁用，缺少引导

`syncProviderModels` 把新模型全部设为 `enabled: false`、能力全部 `false`，这是正确的安全策略（不能按名称猜能力），但 UI 没有：

- 同步结果的模型列表；
- 单模型/批量启用引导；
- “能力未确认”提示；
- 模型不存在时的手动创建入口。

用户同步后看到“模型”页面一堆禁用项，不知道下一步做什么。

### 3. Provider 测试只走 `/models`

`testProviderHandler` 只调用 `fetchProviderModels`。部分 OpenAI 兼容端点不提供 `/models`，测试必然失败，即使 `/chat/completions` 正常。需要支持传入一个模型做最小 Chat 测试，或明确区分“模型列表不可用”和“连接不可用”。

### 4. 配置发布状态不显眼

Provider/账户/模型创建后必须发布新配置版本；当前 `activeVersion` 为空，只有健康接口和配置页能看到 `pendingChanges`。需要一个全局待发布提示和快速开始清单。

### 5. 缺少客户端接入信息

网关支持四种协议，但 UI 没有告诉用户：

- OpenAI Chat/Responses 使用哪个 Base URL；
- Anthropic 使用 `x-api-key`；
- Gemini 使用 `x-goog-api-key`；
- Claude Code/Codex/Gemini CLI 应设置哪些环境变量。

这直接导致“网关部署好了但不知道怎么用”。

## 本次选定范围

参考 Magpie 的产品化能力，但只做适合 Cloudflare Workers 且能解决当前阻塞的部分：

1. Provider 预设目录（火山方舟、华为云 MaaS、OpenAI、Anthropic、Gemini、DeepSeek、Kimi、GLM、Qwen、OpenRouter、Groq、Mistral、xAI、Together、Fireworks、SiliconFlow、自定义兼容端点）。
2. 快速开始清单：Secrets、Provider、账户、模型、发布、下游 Key、自测。
3. Provider 设置向导：账户、模型同步/手动创建、能力确认与启用、测试、发布。
4. 路由诊断：解析结果、目标、缺失配置。
5. 网关自测：管理员选择模型，执行一次最小非流式请求，展示路由和错误。
6. 客户端接入页：四种协议 Base URL、认证方式、环境变量和代码片段。
7. 修复 Base URL 版本拼接、Provider 测试错误提示、发布提示等可用性问题。

## 非目标

- 隐私脱敏/占位符还原。
- 账户会话亲和、smart/usage/pace/intent 路由。
- 周/Token 配额、配额窗口、OTLP。
- 订阅 OAuth（Claude/ChatGPT/Copilot）、本地账户发现。
- 代理配置文件自动改写、插件运行时、Web 搜索/图片/视频/MCP。
- 自动推断模型能力或自动启用模型。

## 风险

- 预设 Base URL 会随厂商文档变化；每个预设必须带文档链接和“以厂商文档为准”的提示。
- 火山方舟有 OpenAI 兼容和 Anthropic 兼容两个不同 Base URL，不能混用。
- 华为云 MaaS 的 OpenAI 兼容接口有区域限制，Base URL 可能因区域不同；预设必须允许用户修改。
- 网关自测会消耗真实上游 token，必须在 UI 明确提示并限制输出长度。
- 现有 `huawei` Provider 不为空但缺少账户/模型，任何自动修复都可能误改用户配置；只提示，不自动删除或改写。
