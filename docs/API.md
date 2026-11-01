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

OpenAI 模型目录。按当前 API Key 的模型/Provider 白名单过滤，返回原生模型与 Combo。

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

会进入配置快照的写操作（Provider、账户、模型、价格、Combo、系统设置、`sync-models`）在保存成功后自动发布配置：响应在原有字段之外附带顶层 `config` 对象，日常流程无需调用 `/admin/config/publish`。跨 isolate 生效受缓存 TTL 与 KV 传播限制，最迟约 60 秒。

### 3.1 Provider

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/providers` | 列表（含账户数量） |
| POST | `/admin/providers` | 创建 |
| GET | `/admin/providers/:id` | 详情（含账户与模型） |
| PUT | `/admin/providers/:id` | 更新 |
| DELETE | `/admin/providers/:id` | 删除（级联账户/模型/价格） |
| POST | `/admin/providers/:id/test` | 拉取上游模型列表验证连通性；无账户返回 `PROVIDER_NO_ACCOUNT` |
| POST | `/admin/providers/:id/sync-models` | 同步上游模型（默认禁用，需人工确认能力） |
| GET | `/admin/providers/:id/accounts` | 账户列表（响应不含明文 `apiKey`） |
| POST | `/admin/providers/:id/accounts` | 添加账户（`apiKey` 或 `secretRef` 二选一） |
| PUT | `/admin/providers/:id/accounts/:accountId` | 更新账户/密钥（`apiKey` 与 `secretRef` 互斥，更新其一会清除另一种） |
| DELETE | `/admin/providers/:id/accounts/:accountId` | 删除账户 |

通过 `apiKey` 添加的账户会以明文写入 `provider_accounts.api_key_plain`，并随配置快照进入 `config_versions.payload` 与 KV。账户对象始终脱敏，只返回 `hasKey` 与 `credentialType`（`api_key` / `secret_ref` / `none`）；生产环境推荐使用 `secretRef` 引用 Worker Secret。

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

### 3.3 别名（已合并）

别名已合并为单节点 Combo（`strategy=fallback`，`nodes=[target]`）。`/admin/aliases*` 端点已移除。

旧配置中的 `{"alias":"..."}` 目标仍可解析，等价于引用同名 Combo；`{"wildcard":"pattern"}` 等价于引用同名 glob Combo。新配置只使用 `{"combo":"..."}`。

### 3.4 Combo 通配符模式

通配符已合并进 Combo：名称包含 `*` 或 `?` 的 Combo 按 glob 匹配，名称即 pattern；`/admin/wildcards*` 端点已移除。

- 精确 Combo 优先于所有 glob Combo。
- 多个 glob Combo 按 `priority` 降序 → 具体度 → ID 升序。
- 通过 `/admin/combos/:id/preview` 查看节点解析结果。

### 3.5 Combo

| 方法 | 路径 |
|------|------|
| GET/POST | `/admin/combos` |
| GET/PUT/DELETE | `/admin/combos/:id` |
| POST | `/admin/combos/:id/validate` |
| POST | `/admin/combos/:id/preview` |

Combo 字段：`name`（含 `*`/`?` 时为通配符模式）、`strategy`、`nodes`、`judgeModel`、`timeoutMs`、`maxConcurrency`、`sticky`、`priority`（默认 100）、`enabled`、`description`。

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

每次有效配置写入都会自动生成版本并切换生效，日常流程不需要手动发布。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/config/current` | 当前生效版本、同步状态（`pendingChanges`）与校验结果 |
| POST | `/admin/config/validate` | 校验 D1 当前配置 |
| POST | `/admin/config/publish` | **Deprecated** 兼容/故障恢复入口：`{ "note": "..." }` 立即重新发布 D1 当前配置；正常保存无需调用 |
| GET | `/admin/config/versions?limit=50` | 版本列表 |
| POST | `/admin/config/rollback` | `{ "version": 3 }` 回滚：校验历史 payload、恢复 D1 配置并切换 KV 指针 |

#### 配置写入响应

会修改配置的写接口（Provider、账户、模型、价格、Combo、系统设置、`sync-models`）在实体写入成功后自动发布配置，响应保留原有字段并追加顶层 `config`：

```json
{
  "data": { "...": "原实体数据" },
  "config": {
    "applied": true,
    "unchanged": false,
    "version": 7,
    "checksum": "…",
    "issues": [{ "severity": "warning", "code": "PROVIDER_NO_ACCOUNT", "message": "…" }]
  }
}
```

- `applied=true` 且 `unchanged=true`：配置与当前生效版本一致，没有新增版本。
- `applied=false`：写入已保存但未生效，旧版本继续服务。`version` 为仍在生效的旧版本（可能为 `null`）；`issues` 为校验问题（最多 50 条）；基础设施失败时附带 `error: { code, message }`。
- 非法配置（`issues` 含 `error`）不会中断保存；修复后下一次合法写入或每日维护会自动收敛。
- 响应状态码仍为实体写入的 200/201，不因配置未生效变为错误。

`POST /admin/config/publish` 仅保留为兼容与故障恢复入口（例如 KV 写入失败后重试），返回 `{ "data": { "version", "checksum", "unchanged" } }`；不再作为日常步骤，管理台只在检测到未同步且校验通过时提供“重试生效”。

回滚会同时恢复 D1 中的 `providers / provider_accounts / models / combos / pricing / system_settings`，保证回滚后 D1 与生效版本一致，后续保存不会撤销回滚。包含非空旧版 `aliases` / `wildcards` 的快照无法无损还原，回滚会被拒绝（`CONFIG_INVALID`）；升级前以加密字段保存的旧版本也可能因账户无凭据被校验拒绝。更早期的快照即使 `aliases` / `wildcards` 为空，其历史 checksum 仍包含这些字段，回滚后可能短暂显示“未同步”，下一次保存或重试生效会自动收敛。

自动发布会持续写入 `config_versions.payload`，其中可能包含明文上游 `apiKey`；请限制版本读取权限并定期清理旧版本。

### 3.9 系统设置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/settings` | 读取 JSON 设置 |
| PUT | `/admin/settings` | 批量保存设置，保存后自动发布并生效 |

允许的键：`gateway.name`、`compat.default_policy`、`limits.*`、`timeouts.request_ms`、`logging.retention_days`、`cors.allowed_origins`、`config.cache_ttl_ms`。

### 3.10 管理界面

- `GET /ui`、`GET /ui/`：零构建单页管理界面。
- 静态资源：`/ui-static/app.js`、`/ui-static/app.css`。

### 3.11 快速开始、预设与诊断

#### GET /admin/provider-presets

返回服务端静态 Provider 预设，供管理台预填表单。不包含密钥。

```json
{
  "data": [
    {
      "id": "volcengine-ark-openai",
      "label": "火山方舟（OpenAI 兼容）",
      "suggestedName": "volcengine-ark",
      "description": "火山引擎方舟数据面 API，兼容 OpenAI Chat Completions。",
      "type": "OPENAI_COMPATIBLE",
      "protocol": "openai-chat",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
      "docsUrl": "https://ark.volcengine.com/region:cn-beijing/docs/base-url-and-authentication",
      "notes": "模型 ID 使用方舟模型 ID 或推理接入点 ID；Base URL 不要漏掉 /api/v3。"
    }
  ]
}
```

#### GET /admin/setup/status

返回初始化清单、资源计数、配置状态和最近一次网关自测。Secrets 只返回布尔值。

```json
{
  "data": {
    "readyForInference": false,
    "secrets": {
      "adminToken": true
    },
    "counts": {
      "providers": 1,
      "providersWithAccounts": 0,
      "providersWithModels": 0,
      "models": 0,
      "enabledModels": 0,
      "activeApiKeys": 0
    },
    "config": {
      "activeVersion": null,
      "pendingChanges": true,
      "valid": true,
      "issues": [
        {
          "severity": "warning",
          "code": "PROVIDER_NO_ACCOUNT",
          "message": "Provider \"huawei\" has no accounts"
        }
      ]
    },
    "lastGatewayTest": null,
    "steps": [
      {
        "id": "provider",
        "label": "添加 Provider",
        "complete": true,
        "detail": "已有 1 个 Provider。",
        "action": { "page": "providers" }
      }
    ]
  }
}
```

`action.page` 对应管理台 Hash 路由：`providers`、`models`、`config`、`keys`、`diagnostics`。

#### POST /admin/routing/explain

只解析路由，不请求上游。

```json
{ "model": "volcengine-ark/ark-chat" }
```

返回命中类型、trace 和解析后的目标：

```json
{
  "data": {
    "ok": true,
    "requestedModel": "volcengine-ark/ark-chat",
    "configVersion": 3,
    "match": { "type": "provider_prefix", "provider": "volcengine-ark", "model": "ark-chat" },
    "trace": ["provider-prefix:volcengine-ark"],
    "plan": {
      "kind": "models",
      "name": "route:fallback",
      "strategy": "fallback",
      "nodes": [
        {
          "kind": "model",
          "target": {
            "providerId": "prv_...",
            "providerName": "volcengine-ark",
            "modelId": "ark-chat",
            "upstreamModelId": "doubao-...",
            "providerEnabled": true,
            "hasEnabledAccount": true,
            "weight": 1,
            "priority": 100
          }
        }
      ]
    }
  }
}
```

路由不存在或配置非法时返回 HTTP 200 和 `data.ok=false`，便于管理台展示诊断信息。

#### POST /admin/gateway/test

执行一次最小非流式请求，复用真实路由、账户选择、URL 拼接、认证和协议转换。

```json
{
  "model": "volcengine-ark/ark-chat",
  "prompt": "Reply with OK.",
  "maxOutputTokens": 16
}
```

限制：

- `prompt` 最长 2000 字符。
- `maxOutputTokens` 为 1–32，默认 16。
- 只允许管理员调用。
- 会发起真实上游请求并可能产生费用。
- 不写入用户配额/Usage；写入审计日志 `gateway.test.success` 或 `gateway.test.failure`，不记录 prompt、回复或密钥。

成功响应：

```json
{
  "data": {
    "ok": true,
    "requestedModel": "volcengine-ark/ark-chat",
    "provider": "volcengine-ark",
    "accountId": "acc_...",
    "modelId": "ark-chat",
    "httpStatus": 200,
    "latencyMs": 812,
    "retryCount": 0,
    "text": "OK",
    "usage": {
      "inputTokens": 12,
      "outputTokens": 1,
      "totalTokens": 13,
      "cachedInputTokens": 0,
      "reasoningTokens": 0,
      "source": "upstream"
    },
    "routeTrace": ["provider-prefix:volcengine-ark"],
    "executionTrace": {}
  }
}
```

失败响应仍为 HTTP 200：

```json
{
  "data": {
    "ok": false,
    "requestedModel": "volcengine-ark/ark-chat",
    "latencyMs": 120,
    "error": {
      "code": "PROVIDER_UNAVAILABLE",
      "message": "No available provider account"
    }
  }
}
```

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
