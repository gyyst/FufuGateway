# Provider 配置

Provider 表示一个独立的上游服务。一个 Provider 可以包含多个模型与多个账户（API Key）。

## 0. Provider 预设

管理台「Provider → 从预设添加」会调用 `GET /admin/provider-presets`，预填名称、类型、协议、Base URL 和认证扩展配置。当前预设包括：

- 火山方舟（OpenAI 兼容 / Anthropic 兼容）
- 华为云 MaaS（OpenAI 兼容）
- OpenAI、Anthropic、Google Gemini
- DeepSeek、Moonshot Kimi、智谱 GLM、阿里云百炼/Qwen
- OpenRouter、Groq、Mistral、xAI、Together、Fireworks、SiliconFlow
- 自定义 OpenAI 兼容 / Anthropic 兼容端点

预设只预填表单，不会自动创建账户或模型，也不会推断模型能力。预设 Base URL 可以修改，并应以厂商文档为准。

## 1. 字段

| 字段 | 说明 |
|------|------|
| `name` | 唯一名称，用于 `provider/model` 前缀；1-64 位字母、数字、点、下划线、连字符 |
| `type` | `OPENAI_COMPATIBLE` / `ANTHROPIC` / `GOOGLE_GEMINI` / `CUSTOM` |
| `protocol` | 上游实际协议：`openai-chat` / `openai-responses` / `anthropic` / `gemini` |
| `baseUrl` | 上游基地址，必须是 HTTPS，禁止私有地址与 URL 凭据 |
| `enabled` | 是否参与路由 |
| `priority` / `weight` | 优先级与权重 |
| `customHeaders` | 附加请求头，禁止认证类与 Hop-by-Hop 头 |
| `timeoutMs` | 响应头超时 |
| `firstTokenTimeoutMs` | 流式首 Token 超时 |
| `idleTimeoutMs` | 流式空闲超时 |
| `maxRetries` | 默认重试次数（与 `retry` 配合） |
| `retry` | 完整重试策略（可选） |
| `extraConfig` | 传输扩展配置 |
| `proxyConfig` | 预留 |

类型与协议约束：

- `OPENAI_COMPATIBLE`：`openai-chat` 或 `openai-responses`
- `ANTHROPIC`：`anthropic`
- `GOOGLE_GEMINI`：`gemini`
- `CUSTOM`：任意协议，需通过 `extraConfig.authMode` 指定认证方式

## 2. 端点解析

网关自动拼接常见端点：

| 协议 | baseUrl 示例 | 实际请求 |
|------|--------------|----------|
| OpenAI Chat | `https://api.openai.com/v1` | `/v1/chat/completions` |
| OpenAI Responses | `https://api.openai.com/v1` | `/v1/responses` |
| 火山方舟 OpenAI 兼容 | `https://ark.cn-beijing.volces.com/api/v3` | `/api/v3/chat/completions` |
| 华为云 MaaS OpenAI 兼容 | `https://api.modelarts-maas.com/openai/v1` | `/openai/v1/chat/completions` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `/api/paas/v4/chat/completions` |
| Anthropic | `https://api.anthropic.com` | `/v1/messages` |
| Gemini | `https://generativelanguage.googleapis.com` | `/v1beta/models/{model}:generateContent` |

网关识别路径末尾的版本段（`/v1`、`/v2`、`/v3`、`/v4` 等），不会重复追加版本。例如：

- `.../api/v3` → `.../api/v3/chat/completions`
- `.../openai/v1` → `.../openai/v1/chat/completions`
- `.../compatible-mode/v1` → `.../compatible-mode/v1/chat/completions`
- 不以版本段结尾的 Base URL 会追加 `/v1`。

模型列表端点使用同一规则：`.../api/v3/models`、`.../openai/v1/models`、`.../v1/models`。

完全自定义路径：

```json
{
  "extraConfig": {
    "endpointPath": "/custom/path"
  }
}
```

`endpointPath` 只包含路径，支持 `{model}` 与 `{action}` 占位符（`action` 为 `generateContent` 或 `streamGenerateContent`）。查询参数请放在 `baseUrl` 中，网关会保留 baseUrl 的 query。

Azure OpenAI 示例：

```json
{
  "name": "azure",
  "type": "CUSTOM",
  "protocol": "openai-chat",
  "baseUrl": "https://my-resource.openai.azure.com/openai/deployments/my-deployment?api-version=2024-10-21",
  "extraConfig": {
    "endpointPath": "/chat/completions",
    "authMode": "header",
    "authHeader": "api-key"
  }
}
```

## 3. 认证

| 默认方式 | 协议/类型 |
|----------|-----------|
| `Authorization: Bearer` | OpenAI 兼容、CUSTOM 默认 |
| `x-api-key` + `anthropic-version` | Anthropic |
| `x-goog-api-key` | Gemini |

CUSTOM 可通过 `extraConfig` 覆盖：

| 配置 | 说明 |
|------|------|
| `authMode` | `bearer` / `x-api-key` / `x-goog-api-key` / `header` / `query` / `none` |
| `authHeader` | `authMode=header` 时使用的头名称 |
| `authQueryParam` | `authMode=query` 时的查询参数名，默认 `key` |
| `anthropicVersion` | Anthropic 版本头，默认 `2023-06-01` |
| `maxTokensField` | OpenAI Chat 上游使用 `max_tokens`（默认）或 `max_completion_tokens` |
| `includeStreamUsage` | 流式请求是否发送 `stream_options.include_usage`，默认 `true` |

客户端认证头永远不会透传到上游。

## 4. 账户

每个账户拥有独立的 API Key、权重和优先级：

```json
{
  "name": "primary",
  "apiKey": "sk-...",
  "weight": 10,
  "priority": 100,
  "enabled": true
}
```

- 明文 `apiKey` 会使用 `ENCRYPTION_KEY` 进行 AES-256-GCM 加密后写入 D1。
- 也可以只提供 `secretRef`，引用 Worker Secret（推荐生产使用）。
- 账户选择：启用、未冷却、未熔断的账户按权重轮询；上游 401/403 时自动轮换账户。
- 账户密钥不会出现在任何管理响应中，只返回 `hasKey` 与 `credentialType`。

## 5. 重试

```json
{
  "maxRetries": 3,
  "retry": {
    "maxAttempts": 4,
    "baseDelayMs": 250,
    "maxDelayMs": 10000,
    "jitter": "full",
    "retryStatuses": [429, 500, 502, 503, 504],
    "retryOnNetworkError": true,
    "retryOnTimeout": "before_first_byte",
    "respectRetryAfter": true
  }
}
```

- 每次重试重新构造请求体，避免重复计费与已消费 Body。
- 流式请求仅在首个内容到达前重试。
- `Retry-After` 优先于指数退避。

## 6. 熔断

在 `extraConfig.breaker` 配置：

```json
{
  "failureThreshold": 3,
  "failureRate": 0.5,
  "minSamples": 5,
  "windowMs": 60000,
  "openMs": 30000,
  "halfOpenProbes": 2
}
```

- 维度：Provider、Account 与 Model。
- 状态：CLOSED / OPEN / HALF_OPEN。
- 连续失败达到阈值，或窗口内失败率达到阈值且样本足够时打开。
- 熔断状态可在 `/admin/health/breakers` 查看。

## 7. 模型同步

`POST /admin/providers/:id/sync-models` 会调用上游模型列表接口：

- OpenAI 兼容：`GET {base}/models`
- Anthropic：`GET {base}/v1/models`
- Gemini：`GET {base}/v1beta/models?pageSize=1000`

同步结果：

- 新模型以 `enabled=false` 创建，能力全部为 false。
- 已存在模型（按模型 ID 或上游模型 ID）跳过。
- 管理员必须人工确认能力并启用，网关不会根据名称猜测能力。

设置 `extraConfig.autoSyncModels = true` 后，每日定时任务会使用第一个可用账户自动同步该 Provider 的模型（同样以禁用状态创建，仍需人工确认）。

## 8. 连通性测试

`POST /admin/providers/:id/test` 使用第一个可用账户拉取模型列表，返回延迟、模型数与样例。失败时返回脱敏错误码与消息：

- `PROVIDER_NO_ACCOUNT`：Provider 还没有账户，先添加账户。
- 401/403：认证失败，检查账户 API Key 或 `secretRef`。
- 404/405：上游不提供兼容的模型列表端点，请手动添加模型，或使用 `/admin/gateway/test` 做 Chat 测试。
- 网络/超时：检查 Base URL、DNS、网络和超时配置。

模型列表可用不代表 Chat 可用。完整链路测试请使用管理台「路由诊断」中的「运行网关自测」，或调用 `POST /admin/gateway/test`。

## 9. 常见 Provider 示例

### 火山方舟（OpenAI 兼容）

```json
{
  "name": "volcengine-ark",
  "type": "OPENAI_COMPATIBLE",
  "protocol": "openai-chat",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3"
}
```

模型 ID 使用方舟模型 ID 或推理接入点 ID。Base URL 不要漏掉 `/api/v3`。

### 火山方舟（Anthropic 兼容）

```json
{
  "name": "volcengine-ark-anthropic",
  "type": "CUSTOM",
  "protocol": "anthropic",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/compatible",
  "extraConfig": {
    "authMode": "bearer"
  }
}
```

Anthropic 兼容 Base URL 是 `/api/compatible`，与 OpenAI 兼容的 `/api/v3` 不同。网关会追加 `/v1/messages`，并发送 `anthropic-version`。

### 华为云 MaaS（OpenAI 兼容）

```json
{
  "name": "huawei-maas",
  "type": "OPENAI_COMPATIBLE",
  "protocol": "openai-chat",
  "baseUrl": "https://api.modelarts-maas.com/openai/v1"
}
```

华为云 MaaS 的 OpenAI 兼容接口存在区域限制，Base URL 可能因区域不同；请以控制台和厂商文档为准。若使用 `/v2` 路径，直接填写到 Base URL 中，网关不会重复追加 `/v1`。

### OpenAI

```json
{
  "name": "openai",
  "type": "OPENAI_COMPATIBLE",
  "protocol": "openai-chat",
  "baseUrl": "https://api.openai.com/v1"
}
```

### Anthropic

```json
{
  "name": "anthropic",
  "type": "ANTHROPIC",
  "protocol": "anthropic",
  "baseUrl": "https://api.anthropic.com"
}
```

### Google Gemini

```json
{
  "name": "google",
  "type": "GOOGLE_GEMINI",
  "protocol": "gemini",
  "baseUrl": "https://generativelanguage.googleapis.com"
}
```

### OpenRouter（OpenAI 兼容）

```json
{
  "name": "openrouter",
  "type": "OPENAI_COMPATIBLE",
  "protocol": "openai-chat",
  "baseUrl": "https://openrouter.ai/api/v1",
  "customHeaders": {
    "http-referer": "https://example.com",
    "x-title": "FufuGateway"
  }
}
```

OpenRouter 模型 ID 常包含 `/`（如 `google/gemini-2.5-pro`）。网关只在第一段匹配到 Provider 名称时才按前缀解析，因此 `openrouter/google/gemini-2.5-pro` 会正确路由；直接使用包含 `/` 的原生模型 ID 也不会被误拆。

### OpenAI 兼容但使用自定义认证

```json
{
  "name": "custom",
  "type": "CUSTOM",
  "protocol": "openai-chat",
  "baseUrl": "https://custom.example.com/v1",
  "extraConfig": {
    "authMode": "header",
    "authHeader": "x-custom-token"
  }
}
```
