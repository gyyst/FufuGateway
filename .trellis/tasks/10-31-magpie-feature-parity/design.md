# 技术设计：基础供应商、路由与网关可用性

## 1. 设计目标

在不改变现有四协议转换、路由和 Combo 执行模型的前提下，补齐“从空配置到可调用”的管理链路：

- 用预设降低 Provider 配置门槛。
- 用快速开始清单暴露缺失步骤。
- 用 Provider 设置面板串联账户、模型、能力确认、测试和发布。
- 用路由诊断和网关自测把“配置错误”变成可读错误。
- 用客户端接入页解决“部署后不知道怎么调用”。
- 修复非 `/v1` Base URL 的拼接缺陷。

不引入新的持久化表，不引入前端框架，不改变推理协议路径。

## 2. 现状与约束

### 2.1 现有结构

- `public/ui-static/app.js`：零构建原生 JS 管理台，`PAGES` + `renderers` 注册页面。
- `src/admin/routes.ts`：Admin API 路由，所有 `/admin/*` 经过 `requireAdmin`。
- `src/admin/handlers/*`：Provider、模型、路由、配置、用量等处理器。
- `src/providers/transport.ts`：上游 URL、认证、模型列表。
- `src/router/resolver.ts`：模型路由解析。
- `src/combo/executor.ts`：执行 RoutePlan，支持 Combo/通配符/单模型。
- `src/gateway/inference.ts`：下游协议入口、配额、Usage。
- `src/config/snapshot.ts`、`src/config/cache.ts`：配置版本、KV 指针、D1 fallback。

### 2.2 约束

- Workers Runtime 无 Node 文件系统/动态代码执行。
- 管理台是静态资源，无构建步骤。
- 不新增 D1 表；状态尽量由现有表计算。
- 不自动推断模型能力。
- 不自动修改现有 `huawei` Provider。
- 网关自测会调用真实上游，必须由管理员显式触发并限制输出。

## 3. 模块设计

### 3.1 Provider 预设目录

新增 `src/providers/presets.ts`：

```ts
export interface ProviderPreset {
  id: string;
  label: string;
  description: string;
  type: ProviderType;
  protocol: ProtocolId;
  baseUrl: string;
  authMode?: "default" | "bearer" | "x-api-key" | "x-goog-api-key" | "header" | "query" | "none";
  authHeader?: string;
  authQueryParam?: string;
  endpointPath?: string;
  docsUrl?: string;
  notes?: string;
}

export function listProviderPresets(): ProviderPreset[];
export function getProviderPreset(id: string): ProviderPreset | undefined;
```

预设是静态数据，不写 D1。新增预设只需改此文件。

首批预设：

| id | 类型/协议 | Base URL | 认证 |
|----|-----------|----------|------|
| `volcengine-ark-openai` | OPENAI_COMPATIBLE / openai-chat | `https://ark.cn-beijing.volces.com/api/v3` | Bearer |
| `volcengine-ark-anthropic` | CUSTOM / anthropic | `https://ark.cn-beijing.volces.com/api/compatible` | Bearer (`authMode: "bearer"`) |
| `huawei-maas-openai` | OPENAI_COMPATIBLE / openai-chat | `https://api.modelarts-maas.com/openai/v1` | Bearer |
| `openai` | OPENAI_COMPATIBLE / openai-chat | `https://api.openai.com/v1` | Bearer |
| `anthropic` | ANTHROPIC / anthropic | `https://api.anthropic.com` | x-api-key |
| `google-gemini` | GOOGLE_GEMINI / gemini | `https://generativelanguage.googleapis.com` | x-goog-api-key |
| `deepseek` | OPENAI_COMPATIBLE / openai-chat | `https://api.deepseek.com` | Bearer |
| `moonshot-kimi` | OPENAI_COMPATIBLE / openai-chat | `https://api.moonshot.cn/v1` | Bearer |
| `zhipu-glm` | OPENAI_COMPATIBLE / openai-chat | `https://open.bigmodel.cn/api/paas/v4` | Bearer |
| `qwen-dashscope` | OPENAI_COMPATIBLE / openai-chat | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Bearer |
| `openrouter` | OPENAI_COMPATIBLE / openai-chat | `https://openrouter.ai/api/v1` | Bearer |
| `groq` | OPENAI_COMPATIBLE / openai-chat | `https://api.groq.com/openai/v1` | Bearer |
| `mistral` | OPENAI_COMPATIBLE / openai-chat | `https://api.mistral.ai/v1` | Bearer |
| `xai` | OPENAI_COMPATIBLE / openai-chat | `https://api.x.ai/v1` | Bearer |
| `together` | OPENAI_COMPATIBLE / openai-chat | `https://api.together.xyz/v1` | Bearer |
| `fireworks` | OPENAI_COMPATIBLE / openai-chat | `https://api.fireworks.ai/inference/v1` | Bearer |
| `siliconflow` | OPENAI_COMPATIBLE / openai-chat | `https://api.siliconflow.cn/v1` | Bearer |
| `custom-openai` | OPENAI_COMPATIBLE / openai-chat | 空，用户填写 | Bearer |
| `custom-anthropic` | ANTHROPIC / anthropic | 空，用户填写 | x-api-key |

说明：

- 预设的 `baseUrl` 必须与厂商文档一致，并附 `docsUrl`。
- 火山方舟 OpenAI 兼容与 Anthropic 兼容是不同 Base URL，分成两个预设。
- 华为云 MaaS 区域和 Base URL 可能不同，预设允许修改。
- 预设只预填表单，不创建账户、不创建模型。

### 3.2 Base URL 规范化

修改 `src/providers/transport.ts` 中的路径拼接逻辑，建议抽出：

```ts
function hasVersionSuffix(path: string): boolean {
  return /\/v\d+(?:beta\d*)?$/i.test(path);
}

export function ensureVersionedPath(base: URL, suffix: string): URL {
  const url = new URL(base.toString());
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") {
    url.pathname = `/v1${suffix}`;
  } else if (hasVersionSuffix(path)) {
    url.pathname = `${path}${suffix}`;
  } else {
    url.pathname = `${path}/v1${suffix}`;
  }
  return url;
}
```

覆盖用例：

| Base URL | Chat 结果 |
|----------|-----------|
| `https://api.openai.com` | `/v1/chat/completions` |
| `https://api.openai.com/v1` | `/v1/chat/completions` |
| `https://ark.cn-beijing.volces.com/api/v3` | `/api/v3/chat/completions` |
| `https://api.modelarts-maas.com/openai/v1` | `/openai/v1/chat/completions` |
| `https://open.bigmodel.cn/api/paas/v4` | `/api/paas/v4/chat/completions` |
| `https://openrouter.ai/api/v1` | `/api/v1/chat/completions` |
| `https://dashscope.aliyuncs.com/compatible-mode/v1` | `/compatible-mode/v1/chat/completions` |

模型列表端点复用同一逻辑：

| Base URL | Models 结果 |
|----------|-------------|
| `https://api.openai.com` | `/v1/models` |
| `https://ark.cn-beijing.volces.com/api/v3` | `/api/v3/models` |
| `https://api.modelarts-maas.com/openai/v1` | `/openai/v1/models` |

`extraConfig.endpointPath` 覆盖优先于上述规则，保留现有 `{model}` / `{action}` 替换。

### 3.3 Admin API

#### `GET /admin/provider-presets`

返回 `{ data: ProviderPreset[] }`。不包含任何密钥。用于 UI 预填。

#### `GET /admin/setup/status`

返回：

```ts
interface SetupStatus {
  secrets: {
    adminToken: boolean;
    apiKeyPepper: boolean;
    encryptionKey: boolean;
  };
  counts: {
    providers: number;
    providersWithAccounts: number;
    providersWithModels: number;
    models: number;
    enabledModels: number;
    activeApiKeys: number;
  };
  config: {
    activeVersion: number | null;
    pendingChanges: boolean;
    valid: boolean;
    issues: ConfigValidationIssue[];
  };
  lastGatewayTest: {
    success: boolean;
    at: number;
    errorCode: string | null;
  } | null;
  steps: Array<{
    id: "secrets" | "provider" | "account" | "model" | "publish" | "api_key" | "gateway_test";
    label: string;
    complete: boolean;
    detail: string;
    action?: { page: string; query?: string };
  }>;
}
```

实现：

- Secrets：检查 `c.env.ADMIN_TOKEN`、`c.env.API_KEY_PEPPER`、`c.env.ENCRYPTION_KEY` 是否存在，只返回布尔值。
- 计数：D1 查询 `providers`、`provider_accounts`、`models`、`api_keys`。
- 配置：复用 `src/config/snapshot.ts` 或 `src/admin/handlers/config.ts` 中的状态读取逻辑，避免复制。
- 最近自测：查询 `audit_logs` 中 action 为 `gateway.test.success` / `gateway.test.failure` 的最新记录。
- 不返回密钥、哈希或上游账户密文。

#### `POST /admin/routing/explain`

请求：

```json
{ "model": "volcengine-ark-openai/doubao-seed-2.1-pro" }
```

返回：

```ts
{
  ok: boolean;
  requestedModel: string;
  match?: RouteMatch;
  trace?: string[];
  plan?: {
    kind: "models" | "combo" | "inline_combo";
    strategy?: string;
    targets: Array<{
      providerId: string;
      providerName: string;
      modelId: string;
      upstreamModelId: string;
      enabled: boolean;
      hasAccount: boolean;
    }>;
    comboName?: string;
  };
  error?: { code: string; message: string; details?: unknown };
}
```

实现：`loadRuntimeConfig` → `new ModelRouter(config).resolve(model)`；将 `RouteResolution.plan` 序列化为安全摘要。捕获 `GatewayError` 返回 200 + `{ ok: false, error }`，便于 UI 展示。

#### `POST /admin/gateway/test`

请求：

```json
{
  "model": "volcengine-ark-openai/doubao-seed-2.1-pro",
  "prompt": "Reply with OK.",
  "maxOutputTokens": 16
}
```

限制：

- `prompt` 最长 2000 字符。
- `maxOutputTokens` 1–32，默认 16。
- 仅管理员。
- 30 秒超时。

实现：

1. 使用 OpenAI Chat 适配器解析最小请求：
   ```ts
   const adapter = protocolRegistry.get("openai-chat");
   const request = adapter.parseRequest({
     model,
     messages: [{ role: "user", content: prompt ?? "Reply with OK." }],
     max_tokens: maxOutputTokens ?? 16,
     stream: false,
   }, { requestId: c.get("requestId") });
   ```
2. `new ModelRouter(config).resolve(request.model)`。
3. `executeRoutePlan(plan, { env, config, router, fetchImpl, requestId, policy, request, signal, coordination, deadline, isStream: false })`。
4. 返回：
   ```json
   {
     "ok": true,
     "requestedModel": "...",
     "provider": "...",
     "accountId": "...",
     "modelId": "...",
     "latencyMs": 123,
     "usage": { "inputTokens": 1, "outputTokens": 1, "totalTokens": 2 },
     "text": "OK",
     "routeTrace": ["..."]
   }
   ```
5. 失败返回 `{ ok: false, error: { code, message, details } }`，HTTP 200（便于诊断）；同时写审计日志 `gateway.test.failure`。
6. 不写 Usage/配额，避免测试流量污染用户统计；审计日志只记录模型、Provider、耗时、错误码，不记录 prompt/reply。

#### `POST /admin/providers/:id/test`（增强）

保留模型列表测试，不新增请求体。错误区分：

- 无账户：`PROVIDER_NO_ACCOUNT`，提示先添加账户。
- 401/403：认证失败，检查 API Key/secretRef。
- 404/405：模型列表端点不可用，建议手动添加模型或使用 Chat 测试。
- 网络/超时：`UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT`。

Chat 测试由 `/admin/gateway/test` 承担；管理台 Provider 设置面板的「Chat 自测」直接调用该接口。

### 3.4 UI 设计

#### 页面注册

`PAGES` 增加：

```js
["setup", "快速开始"],
["diagnostics", "路由诊断"],
["connect", "客户端接入"],
```

建议顺序：快速开始 → 概览 → Provider → 模型 → 别名 → 通配符 → Combo → API Key → 用户 → 价格表 → 路由诊断 → 客户端接入 → 配置与审计。

#### 快速开始页

- 调用 `GET /admin/setup/status`。
- 顶部显示总体状态：`readyForInference` / 待完成。
- 7 个步骤卡片，每张显示完成状态、说明、操作按钮。
- 配置未发布时固定显示“有未发布变更”横幅，按钮跳转配置页。
- 显示 `PROVIDER_NO_ACCOUNT` 等 warning，链接到 Provider 账户面板。
- 不自动修改任何配置。

#### Provider 预设

- Provider 页面工具栏增加“从预设添加”。
- 打开预设选择 modal，支持按名称/说明过滤。
- 选择后调用 `openEntityForm(entities.providers, null, presetToOverrides(preset))`。
- 需要扩展 `openEntityForm` 支持第三参数 `overrides`；现有调用不传，保持兼容。
- 预设填充 `name`（可编辑，需去重）、`type`、`protocol`、`baseUrl`、`extraConfig.authMode` 等。
- 表单提交仍走现有 `POST /admin/providers`，不做隐式创建。

#### Provider 设置面板

Provider 行增加“设置”操作：

- 显示 Provider 基本信息、账户数、模型数、同步状态。
- 按钮：
  - 添加账户（复用 `openAccounts`）。
  - 同步模型（复用现有 sync action）。
  - 查看模型（新 modal：列出该 Provider 模型，支持启用/编辑）。
  - 测试连接（调用 `/test`，可输入模型）。
  - 去发布（跳转配置页）。
- 若没有账户，顶部提示“先添加账户，再同步模型/测试”。

#### 模型能力确认

- 模型列表增加“启用/停用”快捷操作，调用现有 `PUT /admin/models/:id`。
- Provider 模型 modal 中每个模型显示：
  - 模型 ID / 上游 ID。
  - 能力状态（stream/tools/vision/reasoning）。
  - “编辑并启用”按钮，复用现有模型表单。
- 同步后所有模型仍是禁用 + 能力 false；UI 明确提示这不是自动启用。
- 不增加批量猜测能力。

#### 路由诊断页

- 输入模型名，调用 `/admin/routing/explain`。
- 显示命中类型、trace、目标列表、账户是否存在、错误。
- 提供“运行网关自测”按钮，调用 `/admin/gateway/test`，显示结果和路由 trace。
- 自测前提示会产生真实上游费用。

#### 客户端接入页

- 使用 `location.origin` 生成：
  - OpenAI Chat/Responses Base URL：`${origin}/v1`
  - Anthropic Base URL：`${origin}`
  - Gemini Base URL：`${origin}`（客户端自行拼 `/v1beta`）
- 显示认证头：
  - `Authorization: Bearer fufu_sk_...`
  - `x-api-key: fufu_sk_...`
  - `x-goog-api-key: fufu_sk_...`
- 代码片段：
  - curl Chat Completions
  - OpenAI Python SDK
  - Claude Code 环境变量
  - Codex 环境变量
  - Gemini CLI 环境变量
- 复制按钮；提示下游 Key 只在创建/轮换时显示一次。
- 不读取或展示真实 Key。

#### 配置页

- 顶部增加未发布横幅；发布按钮复用现有 `POST /admin/config/publish`。
- 发布成功后刷新状态。

### 3.5 数据与持久化

不新增 D1 表，不新增迁移。

- 预设：静态代码。
- 快速开始状态：实时查询现有表 + 配置状态。
- 最近自测：`audit_logs` 表，action `gateway.test.success` / `gateway.test.failure`。
- 模型启用：现有 `PUT /admin/models/:id`。
- Provider/账户：现有 API。

### 3.6 安全

- `GET /admin/provider-presets` 仅管理员；无密钥。
- `GET /admin/setup/status` 仅管理员；只返回 Secret 布尔值。
- 网关自测只允许管理员；限制 prompt/输出；审计不记录 prompt/reply/key。
- 不把 `apiKey`、`encryptedKey`、`secretRef` 值返回给客户端；`sanitizeAccount` 逻辑保持不变。
- 预设 Base URL 是服务端静态数据，不接受客户端传入任意 URL 作为预设。
- 现有 SSRF 校验仍对管理员配置生效；预设不能绕过。
- 网关自测使用现有执行链路，不新增绕过认证/SSRF 的路径。

## 4. 文件变更清单

新增：

- `src/providers/presets.ts`
- `src/admin/handlers/setup.ts`
- `src/admin/handlers/diagnostics.ts`
- `test/unit/provider-paths.test.ts`
- `test/unit/provider-presets.test.ts`
- `test/integration/setup.test.ts`

修改：

- `src/providers/transport.ts`：版本路径拼接。
- `src/admin/schemas.ts`：新增请求 schema。
- `src/admin/routes.ts`：注册新路由。
- `src/admin/handlers/providers.ts`：测试错误信息/可选 model。
- `src/admin/handlers/config.ts` 或 `src/config/snapshot.ts`：抽出可复用配置状态读取（如已有则复用）。
- `public/ui-static/app.js`：页面、预设、向导、诊断、接入页。
- `public/ui-static/app.css`：步骤卡片、横幅、预设列表样式。
- `docs/PROVIDERS.md`、`docs/API.md`、`docs/DEPLOY.md`、`README.md`。

不改：

- 四协议转换器、IR、Combo 策略、执行器核心逻辑。
- D1 迁移。
- 现有推理路由路径。

## 5. 测试设计

### 单元测试

- `provider-paths.test.ts`：
  - OpenAI、Ark、Huawei、GLM、OpenRouter、DashScope 的 Chat/Models URL。
  - 空路径、`/v1`、`/api/v3`、`/api/paas/v4`、`/compatible-mode/v1`。
  - `endpointPath` 覆盖。
- `provider-presets.test.ts`：
  - 预设 ID 唯一。
  - 必填字段完整。
  - Ark OpenAI/Anthropic 预设 Base URL 不同。
  - 自定义预设允许空 Base URL。

### 集成测试

`test/integration/setup.test.ts`：

1. 通过 Admin API 创建预设 Provider（Ark `/api/v3`）。
2. 创建账户（使用测试密钥）。
3. 创建模型，启用，发布配置。
4. 创建用户和 API Key。
5. 调用 `/v1/chat/completions`，假上游断言：
   - URL 为 `https://ark.test/api/v3/chat/completions`。
   - `Authorization: Bearer ...`。
   - 响应文本正确。
6. 调用 `/admin/setup/status`，断言 provider/account/model/publish/api key 完成。
7. 调用 `/admin/routing/explain`，断言命中类型和目标。
8. 调用 `/admin/gateway/test`，断言成功并写审计。
9. 华为 `/openai/v1` 变体断言 URL。
10. 无账户 Provider 的 `/test` 返回 `PROVIDER_NO_ACCOUNT` 提示。
11. 同步模型后模型全部 `enabled: false`、能力 false。

现有测试全部保持通过。

### 手工验收

- 本地 `wrangler dev` 打开 `/ui`：
  - 快速开始显示 7 步。
  - 从预设添加 Ark Provider，账户、模型、发布、自测。
  - 路由诊断和客户端接入可复制。
- 部署环境重复一次；现有 `huawei` Provider 显示缺失账户/模型。

## 6. 风险与回滚

- 预设 Base URL 可能变化：每个预设带文档链接和可编辑 Base URL；不硬编码模型能力/价格。
- 火山方舟/华为区域差异：允许修改 Base URL；文档注明。
- 网关自测消耗 token：限制 32 输出 token，UI 明确提示。
- 现有配置被误改：不自动修改 `huawei` Provider；所有写入来自管理员点击。
- 回滚：新增文件/路由/UI 可整体回退；无 DB 迁移；现有推理路径不变。

## 7. 后续阶段（不在本任务）

- 隐私脱敏。
- 账户会话亲和与 prompt cache。
- smart/usage/pace/intent 路由。
- 周/Token 配额与配额窗口。
- 声明式请求策略（system prompt、param override、word guard）。
- 订阅 OAuth 与本地账户发现。
