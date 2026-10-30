# API 参考

## 1. 通用约定

- 所有时间为 Unix 毫秒（响应中 `createdAt`、`startedAt` 等字段）。
- JSON 字段使用 camelCase；数据库列使用 snake_case。
- 管理接口与推理接口分离鉴权。
- 管理接口错误格式：

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid request body",
    "type": "gateway_error",
    "details": {},
    "request_id": "req_..."
  }
}
```

- 每个响应包含 `x-request-id` 与 `x-trace-id`；推理响应还包含 `x-fufu-model`、`x-fufu-provider`，部分包含 `x-fufu-usage-source`、`x-fufu-warnings`、`x-fufu-stream`。
- 超限错误在可计算时返回 `Retry-After`（秒）。

### 推理认证

| 协议 | 支持的凭据位置 |
|------|----------------|
| OpenAI Chat / Responses | `Authorization: Bearer <key>`，兼容 `x-api-key` |
| Anthropic | `x-api-key: <key>`，兼容 Bearer |
| Gemini | `x-goog-api-key`、`?key=`，兼容 Bearer |

### 管理认证

- `Authorization: Bearer <ADMIN_TOKEN>`
- `x-admin-token: <ADMIN_TOKEN>`
- 具备 `admin` scope 且用户角色为 `admin` 的 API Key（Bearer）

## 2. 推理 API

### POST /v1/chat/completions

OpenAI Chat Completions 入口。请求与响应保持 OpenAI 格式。

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "authorization: Bearer $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "openai/gpt-5",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": false
  }'
```

支持：系统/开发者消息、多模态图片、工具调用、并行工具、Tool Choice、JSON Object、JSON Schema、Reasoning、Stream、Usage。

### POST /v1/responses

OpenAI Responses 入口。支持 `instructions`、`input` items、`function_call`、`function_call_output`、`text.format`、`reasoning`、流式事件。

### POST /v1/messages

Anthropic Messages 入口。要求 `max_tokens`；支持 system、text/image/tool_use/tool_result/thinking、cache_control、thinking、stop_sequences、流式事件。

### POST /v1beta/models/{model}:generateContent

Gemini 非流式入口。`model` 可以包含 Provider 前缀（例如 `google/gemini-2.5-pro`）。

### POST /v1beta/models/{model}:streamGenerateContent

Gemini 流式入口，返回 SSE。网关会向上游追加 `alt=sse`。

### GET /v1/models、GET /v1/models/:id

OpenAI 模型目录。按当前 API Key 的模型/Provider 白名单过滤，返回原生模型、Alias 与 Combo。

### GET /v1beta/models、GET /v1beta/models/:model

Gemini 模型目录与单个模型查询。

### POST /v1/messages/count_tokens

本地估算 Anthropic 输入 Token，返回 `{"input_tokens": number}`，响应头 `x-fufu-usage-source: estimated`。结果不代表上游真实分词。

### 请求限制

- 请求体默认 4 MiB（系统设置 `limits.max_body_bytes`）。
- 非流式响应默认 16 MiB（`limits.max_response_bytes`）。
- 单个 SSE 事件默认 1 MiB（`limits.max_stream_event_bytes`）。

## 3. 管理 API

所有路径前缀 `/admin`，需要管理员认证。写操作会写入审计日志。

### 3.1 Provider

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/providers` | 列表（含账户数量） |
| POST | `/admin/providers` | 创建 |
| GET | `/admin/providers/:id` | 详情（含账户与模型） |
| PUT | `/admin/providers/:id` | 更新 |
| DELETE | `/admin/providers/:id` | 删除（级联账户/模型/价格） |
| POST | `/admin/providers/:id/test` | 拉取上游模型列表验证连通性 |
| POST | `/admin/providers/:id/sync-models` | 同步上游模型（默认禁用，需人工确认能力） |
| GET | `/admin/providers/:id/accounts` | 账户列表 |
| POST | `/admin/providers/:id/accounts` | 添加账户（`apiKey` 或 `secretRef` 二选一） |
| PUT | `/admin/providers/:id/accounts/:accountId` | 更新账户/密钥 |
| DELETE | `/admin/providers/:id/accounts/:accountId` | 删除账户 |

创建 Provider 示例：

```json
{
  "name": "openai",
  "type": "OPENAI_COMPATIBLE",
  "protocol": "openai-chat",
  "baseUrl": "https://api.openai.com/v1",
  "priority": 100,
  "weight": 1,
  "timeoutMs": 60000,
  "firstTokenTimeoutMs": 20000,
  "idleTimeoutMs": 60000,
  "maxRetries": 2,
  "customHeaders": {},
  "extraConfig": {}
}
```

### 3.2 模型与价格

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/models` | 列表，可带 `?providerId=` |
| POST | `/admin/models` | 创建 |
| GET | `/admin/models/:id` | 详情 |
| PUT | `/admin/models/:id` | 更新 |
| DELETE | `/admin/models/:id` | 删除 |
| GET | `/admin/pricing` | 价格覆盖列表 |
| POST | `/admin/pricing` | 新增/覆盖价格（Provider + 上游模型） |
| DELETE | `/admin/pricing/:id` | 删除 |

模型创建字段包含 `providerId`、`modelId`、`upstreamModelId`、能力布尔值、`inputModalities`/`outputModalities`、`contextWindow`、`maxOutputTokens`、四类价格与 `enabled`。

### 3.3 Alias

| 方法 | 路径 |
|------|------|
| GET/POST | `/admin/aliases` |
| GET/PUT/DELETE | `/admin/aliases/:id` |

`target` 支持字符串（模型引用）或对象：`{"model":"..."}`、`{"alias":"..."}`、`{"combo":"..."}`、`{"wildcard":"..."}`。

### 3.4 通配符

| 方法 | 路径 |
|------|------|
| GET/POST | `/admin/wildcards` |
| GET/PUT/DELETE | `/admin/wildcards/:id` |
| POST | `/admin/wildcards/preview` |

预览请求：

```json
{ "pattern": "claude-*", "models": ["claude-sonnet-4-5", "gpt-5"] }
```

返回命中列表、具体度与相对其他规则的优先级位置。

### 3.5 Combo

| 方法 | 路径 |
|------|------|
| GET/POST | `/admin/combos` |
| GET/PUT/DELETE | `/admin/combos/:id` |
| POST | `/admin/combos/:id/validate` |
| POST | `/admin/combos/:id/preview` |

### 3.6 用户与 API Key

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/admin/users` | 用户列表/创建 |
| GET/PUT | `/admin/users/:id` | 详情/更新（角色、状态、限流与预算） |
| GET | `/admin/api-keys` | 列表，可带 `?userId=`；不返回哈希 |
| POST | `/admin/api-keys` | 创建，响应包含一次性明文 `key` |
| PUT | `/admin/api-keys/:id` | 更新状态、Scopes、白名单、限额、预算、过期时间 |
| DELETE | `/admin/api-keys/:id` | 删除 |
| POST | `/admin/api-keys/:id/rotate` | 轮换；默认吊销旧 Key，返回新明文 |

创建 API Key：

```json
{
  "userId": "usr_...",
  "name": "production",
  "scopes": ["inference"],
  "modelAllowlist": ["gpt-5", "coding-combo"],
  "providerAllowlist": ["openai"],
  "rpmLimit": 60,
  "tpmLimit": 200000,
  "concurrencyLimit": 8,
  "dailyBudgetUsd": 5,
  "monthlyBudgetUsd": 100,
  "expiresAt": 1790000000000
}
```

### 3.7 用量与日志

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/usage`、`/admin/usage/summary` | 汇总 |
| GET | `/admin/requests` | 请求日志列表 |
| GET | `/admin/requests/:id` | 详情，含 `routeTrace` |
| GET | `/admin/health` | 数据库与配置状态 |
| GET | `/admin/health/breakers` | Provider/Account/Model 熔断状态 |
| GET | `/admin/audit-logs` | 审计日志 |

用量汇总参数：

- `from`、`to`：`YYYY-MM-DD`
- `groupBy`：`day` | `week` | `month`
- `userId`、`apiKeyId`、`providerId`、`model`、`comboId`

请求列表参数：`from`、`to`、`limit`（1-200）、`before`（created_at 游标）、`userId`、`apiKeyId`、`providerId`、`model`、`status`、`comboId`。

### 3.8 配置版本

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/config/current` | 当前生效版本、待发布校验、待发布变更 |
| POST | `/admin/config/validate` | 校验 D1 草稿 |
| POST | `/admin/config/publish` | `{ "note": "..." }` 发布 |
| GET | `/admin/config/versions?limit=50` | 版本列表 |
| POST | `/admin/config/rollback` | `{ "version": 3 }` 回滚 |

### 3.9 系统设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/settings` | 读取 JSON 设置 |
| PUT | `/admin/settings` | 批量保存设置，发布配置后生效 |

允许的键：`gateway.name`、`compat.default_policy`、`limits.*`、`timeouts.request_ms`、`logging.retention_days`、`cors.allowed_origins`、`config.cache_ttl_ms`。

### 3.10 管理界面

- `GET /ui`、`GET /ui/`：零构建单页管理界面。
- 静态资源：`/ui-static/app.js`、`/ui-static/app.css`。

## 4. 错误码

| 错误码 | 默认 HTTP | 含义 |
|--------|-----------|------|
| AUTHENTICATION_ERROR | 401 | 缺少或无效 API Key |
| PERMISSION_DENIED | 403 | 权限/白名单拒绝 |
| INVALID_REQUEST | 400 | 参数不合法 |
| MODEL_NOT_FOUND | 404 | 模型不存在 |
| MODEL_AMBIGUOUS | 409 | 同一模型存在于多个 Provider |
| PROVIDER_NOT_FOUND | 404 | Provider 不存在 |
| PROVIDER_UNAVAILABLE | 503 | Provider/账户不可用或熔断 |
| UPSTREAM_TIMEOUT | 504 | 上游超时 |
| UPSTREAM_RATE_LIMITED | 429 | 上游限流 |
| UPSTREAM_ERROR | 502 | 上游错误 |
| PROTOCOL_CONVERSION_ERROR | 502 | 协议转换失败 |
| UNSUPPORTED_FEATURE | 400 | 能力不支持（严格策略或功能限制） |
| COMBO_CYCLE_DETECTED | 500 | Combo 循环引用 |
| COMBO_EXECUTION_FAILED | 502 | Combo 执行失败 |
| REQUEST_LIMIT_EXCEEDED | 429 | RPM/并发限制 |
| TOKEN_LIMIT_EXCEEDED | 429 | TPM 限制 |
| BUDGET_EXCEEDED | 402 | 预算耗尽 |
| REQUEST_CANCELLED | 499 | 客户端取消 |
| CONFIG_INVALID | 400 | 配置非法 |
| INTERNAL_ERROR | 500 | 内部错误 |

错误响应按下游协议转换：OpenAI 使用 `{error:{...}}`，Anthropic 使用 `{type:"error",error:{...}}`，Gemini 使用 `{error:{code,message,status}}`。
