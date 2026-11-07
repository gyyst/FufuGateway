# 技术设计：模型能力自动识别

## 1. 边界与模块

新增三个模块，避免把匹配、缓存、落库逻辑堆进 `sync.ts`：

| 文件 | 职责 |
|------|------|
| `src/models/catalog.ts` | models.dev 目录的类型、下载、压缩、KV/内存缓存、Provider 与模型匹配 |
| `src/models/metadata.ts` | 上游实时字段与目录字段合并、能力推导、自动启用判断、存量模型“只补空缺” |
| `src/models/sync.ts` | 编排同步与刷新流程，读写 D1 |

另外修改：

- `src/providers/transport.ts`：解析上游 `/models` 的上下文、模态、能力、价格字段。
- `src/config/types.ts`：`ModelRecord` 增加元数据来源字段。
- `src/config/repository.ts`：映射与持久化新字段。
- `src/admin/handlers/providers.ts`：同步响应统计、刷新元数据 handler。
- `src/admin/handlers/models.ts`：手工编辑能力时标记 `manual`。
- `src/admin/routes.ts`：新增刷新路由。
- `public/ui-static/app.js`：同步提示、刷新入口、列展示、扩展配置字段。
- `migrations/0008_model_metadata_source.sql`：新增列。
- `docs/PROVIDERS.md`、`docs/API.md`、`README.md`。

## 2. 数据源与缓存

### 2.1 models.dev 目录

远端：`https://models.dev/api.json`（约 4.6 MB）。只保留需要的字段，压缩后约 2.6 MB。

```ts
export interface CatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Modality[];
  outputModalities?: OutputModality[];
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCache?: boolean;
  pricing?: Partial<ModelPricing>;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  models: Record<string, CatalogModel>;
}

export interface CatalogData {
  fetchedAt: number;
  providers: Record<string, CatalogProvider>;
}
```

原始 models.dev 字段映射：

| models.dev | CatalogModel |
|------------|--------------|
| `name` | `displayName` |
| `limit.context` | `contextWindow` |
| `limit.output` | `maxOutputTokens` |
| `modalities.input` | `inputModalities`（`pdf` → `file`，未知丢弃） |
| `modalities.output` | `outputModalities`（未知丢弃） |
| `tool_call` | `supportsTools` |
| `structured_output` | `supportsJsonSchema` |
| `reasoning === true` 或 `reasoning_options` 非空 | `supportsReasoning` |
| `cost.cache_read` 存在 | `supportsPromptCache` |
| `cost.input` / `output` / `cache_read` / `cache_write` / `reasoning` | `pricing.*` |

### 2.2 缓存

```ts
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODEL_CATALOG_KV_KEY = "model_catalog:models.dev:v1";
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export type CatalogStatus = "ok" | "stale" | "unavailable";

export interface CatalogLoadResult {
  catalog: CatalogData;
  status: CatalogStatus;
}

export async function loadModelsDevCatalog(args: {
  kv?: KVNamespace;
  fetchImpl: FetchLike;
  forceRefresh?: boolean;
  now?: number;
}): Promise<CatalogLoadResult>;
```

加载顺序：

1. `forceRefresh !== true` 且 isolate 内存缓存未过期 → 直接返回 `ok`。
2. 从 `CONFIG_KV` 读取；未过期 → 解析并写入内存缓存，返回 `ok`。
3. 读取到过期缓存 → 保留为 stale 候选。
4. 下载 `MODELS_DEV_URL`（15 秒超时，非 2xx 或解析失败视为失败）。
5. 下载成功 → 压缩、写 KV（TTL 7 天，业务过期由 `fetchedAt` 判断）、写内存缓存，返回 `ok`。
6. 下载失败且有 stale 候选 → 返回 `stale`。
7. 下载失败且无缓存 → 返回空目录 + `unavailable`。

并发控制：

- 模块级 `inFlight: Promise<CatalogLoadResult> | null`，同一 isolate 并发调用复用同一个 Promise。
- 内存缓存键包含 `fetchedAt`；测试可传 `now` 控制过期。

失败处理：

- `loadModelsDevCatalog` 永不抛出；所有异常转为 `unavailable` / `stale`。
- 用 `console.warn` 输出结构化日志（`msg: "model_catalog.load_failed"`），不包含请求头或密钥。
- KV 写入失败只记录警告，不影响本次同步。

## 3. Provider 匹配

```ts
export function providerCatalogIds(
  provider: ProviderRecord,
  catalog: CatalogData,
): string[];

export function findCatalogModel(
  catalog: CatalogData,
  provider: ProviderRecord,
  modelId: string,
): CatalogMatch | undefined;

export interface CatalogMatch {
  model: CatalogModel;
  providerId: string;
  method: "provider-exact" | "provider-normalized" | "global-exact" | "global-normalized";
}
```

Provider 候选 ID 顺序：

1. `provider.extraConfig.modelsDevProvider`（字符串，trim 后非空）。
2. Base URL 主机名映射表：

| 主机 | models.dev ID |
|------|---------------|
| `api.openai.com` | `openai` |
| `api.anthropic.com` | `anthropic` |
| `generativelanguage.googleapis.com` | `google` |
| `aiplatform.googleapis.com` | `google-vertex` |
| `openrouter.ai` | `openrouter` |
| `api.deepseek.com` | `deepseek` |
| `api.moonshot.ai` | `moonshotai` |
| `api.moonshot.cn` | `moonshotai-cn` |
| `api.z.ai` | `zai` |
| `open.bigmodel.cn` | `zhipuai` |
| `dashscope.aliyuncs.com` | `alibaba-cn` |
| `dashscope-intl.aliyuncs.com` | `alibaba` |
| `api.mistral.ai` | `mistral` |
| `api.groq.com` | `groq` |
| `api.x.ai` | `xai` |
| `api.together.xyz` / `api.together.ai` | `togetherai` |
| `api.fireworks.ai` | `fireworks-ai` |
| `api.siliconflow.com` | `siliconflow` |
| `api.siliconflow.cn` | `siliconflow-cn` |
| `ark.cn-beijing.volces.com` | `volcengine` |
| `*.openai.azure.com` / `*.cognitiveservices.azure.com` | `azure` |
| `bedrock-runtime.*.amazonaws.com` | `amazon-bedrock` |
| `api.cloudflare.com` | `cloudflare-workers-ai` |
| `api.githubcopilot.com` | `github-copilot` |
| `api.perplexity.ai` | `perplexity` |
| `integrate.api.nvidia.com` | `nvidia` |
| `api.cohere.com` | `cohere` |

3. Provider 名称归一化后与目录 Provider ID / `name` 精确匹配（只做确定性匹配，不做模糊包含）。

主机匹配使用 `host === domain || host.endsWith("." + domain)`。

## 4. 模型 ID 匹配

匹配顺序：

1. Provider 内原始 ID 精确匹配。
2. Provider 内去掉最后一个 `/` 前缀后精确匹配。
3. Provider 内归一化匹配。
4. 全局原始 ID 精确匹配。
5. 全局归一化匹配；多个 Provider 命中时聚合。

归一化：

```ts
export function normalizeModelId(raw: string): string {
  let id = raw.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replace(/\[[^\]]*\]\s*$/, "");     // claude-opus-5[1m]
  id = id.replace(/[_\s]+/g, "-");
  id = id.replace(/-(?:20\d{6}|\d{6})$/, ""); // -20260801 / -260813
  id = id.replace(/(\d)\.(\d)/g, "$1-$2");    // glm-5.3 == glm-5-3
  return id.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
```

窗口标记：

```ts
export function contextFromModelId(raw: string): number | undefined;
```

支持末尾 `[1m]`、`[200k]`、`[1.5m]`；作为 `contextWindow` 的最低优先级来源。

全局聚合规则（只有跨 Provider 命中时）：

- 上下文、最大输出、模态列表、布尔能力：取出现次数最多的值；平票取目录中先出现的值。
- 布尔能力平票时取 `false`，避免过度声明。
- 价格只采用 Provider 精确命中；全局匹配不填价格，因为不同 Provider 对同名模型定价不同。

## 5. 上游 `/models` 扩展

`RemoteModel` 增加：

```ts
export interface RemoteModel {
  id: string;
  displayName?: string;
  createdAt?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Modality[];
  outputModalities?: OutputModality[];
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsReasoning?: boolean;
  supportsVision?: boolean;
  pricing?: Partial<ModelPricing>;
}
```

OpenAI 兼容解析新增字段别名：

- 上下文：`context_length`、`context_window`、`max_context_length`、`max_model_len`、`input_token_limit`、`inputTokenLimit`、`top_provider.context_length`。
- 最大输出：`max_output_tokens`、`max_completion_tokens`、`output_token_limit`、`outputTokenLimit`、`top_provider.max_completion_tokens`。
- 模态：
  - `architecture.input_modalities` / `architecture.output_modalities`（OpenRouter）
  - `input_modalities` / `output_modalities`（火山方舟、部分兼容端点）
  - `modalities.input` / `modalities.output`
  - 支持字符串数组与逗号分隔字符串。
- 能力：`tool_call`、`supports_tools`、`structured_output`、`supports_json_schema`、`reasoning`、`supports_reasoning`、`supports_vision`。
- 价格：OpenRouter `pricing.prompt`、`pricing.completion`、`pricing.input_cache_read`（每 Token 美元）乘以 `1_000_000`；无效或负数忽略。

Gemini 保持 `inputTokenLimit` / `outputTokenLimit`；如存在 `inputModalities` 等字段按同一映射解析。

## 6. 合并与自动启用

```ts
export interface ModelMetadata {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: Modality[];
  outputModalities: OutputModality[];
  supportsStream: boolean;
  supportsTools: boolean;
  supportsParallelTools: boolean;
  supportsJsonSchema: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsPromptCache: boolean;
  pricing: ModelPricing;
  source: ModelMetadataSource; // manual 由手工编辑设置，这里只产生 upstream/models.dev/unknown
  recognized: boolean;
}

export function buildModelMetadata(args: {
  live?: RemoteModel;
  catalog?: CatalogModel;
  catalogMatched: boolean;
  modelId: string;
}): ModelMetadata;
```

优先级：

- 上下文：`live.contextWindow` → `catalog.contextWindow` → `contextFromModelId()`。
- 最大输出：`live.maxOutputTokens` → `catalog.maxOutputTokens`。
- 输入模态：`live.inputModalities` → `catalog.inputModalities` → `["text"]`。
- 输出模态：`live.outputModalities` → `catalog.outputModalities` → `["text"]`。
- 工具 / JSON Schema / 推理：`live` 显式值 → `catalog`。
- Prompt Cache：`live` 显式值 → `catalog.supportsPromptCache`。
- `supportsVision`：`live.supportsVision` 显式值 → 输入模态包含 `image`。
- `supportsAudio` / `supportsVideo`：输入模态包含对应值。
- `supportsPromptCache`：目录 `cost.cache_read` 存在即视为支持。
- `supportsStream`：输出模态包含 `text` 或输出未知时为 `true`；纯图像/音频/embedding 为 `false`。
- `supportsParallelTools`：没有可靠数据源，保持 `false`。
- 价格：`live.pricing` 逐字段优先，`catalog.pricing` 补齐；缺失字段为 0。
- 显示名：`live.displayName` → `catalog.displayName`。

识别与自动启用：

```ts
recognized = catalogMatched || liveHasMetadata(live);
liveHasMetadata = 上下文 / 最大输出 / 模态 / 任一能力布尔值 / 价格 至少一项存在
autoEnable = recognized
  && (outputModalities 包含 "text" 或为空)
  && provider.extraConfig.syncAutoEnable !== false;
```

说明：`supportsStream` 不影响自动启用；纯图像输出模型即使被目录识别也不会自动启用。

## 7. 持久化与来源生命周期

新增迁移 `0008_model_metadata_source.sql`：

```sql
ALTER TABLE models ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE models ADD COLUMN metadata_updated_at INTEGER;
UPDATE models SET metadata_source = 'unknown' WHERE source = 'sync';
```

来源规则：

| 场景 | metadataSource |
|------|----------------|
| 手工创建模型 | `manual` |
| 手工编辑任意能力/模态/上下文/最大输出字段 | `manual` |
| 同步且 models.dev 命中 | `models.dev` |
| 同步且仅上游返回元数据 | `upstream` |
| 同步且无任何元数据 | `unknown` |
| 刷新时来源升级 | 只允许 `unknown` → `upstream`/`models.dev`，`upstream` → `models.dev` |

手工编辑检测：`modelUpdateSchema` 中任意 `inputModalities`、`outputModalities`、`contextWindow`、`maxOutputTokens`、`supports*` 字段出现即视为手工修改。仅修改 `enabled`、`displayName`、价格不改变来源。

`ModelRecord`：

```ts
export type ModelMetadataSource = "manual" | "upstream" | "models.dev" | "unknown";

export interface ModelRecord {
  // ...
  metadataSource?: ModelMetadataSource;
  metadataUpdatedAt?: number;
}
```

字段可选，兼容旧配置快照（KV 中已发布版本可能没有这两个字段）。`mapModel` 缺省为 `unknown`。

## 8. 同步与刷新流程

### 8.1 同步

```ts
export interface ModelSyncResult {
  total: number;
  created: number;
  skipped: number;
  createdModels: string[];
  autoEnabled: number;
  metadata: {
    catalog: CatalogStatus;
    modelsDevMatched: number;
    upstreamMatched: number;
    unknown: number;
  };
}
```

流程：

1. 并行执行 `fetchProviderModels()` 与 `loadModelsDevCatalog()`。
2. 对每个远端模型：`findCatalogModel()` → `buildModelMetadata()`。
3. 新模型 `createModel()`：
   - 能力、模态、上下文、价格、显示名来自合并结果。
   - `enabled = autoEnable`。
   - `source = "sync"`，`metadataSource` 按来源写入，`metadataUpdatedAt = now`。
4. 已存在模型（按 `modelId` / `upstreamModelId` 小写去重）跳过，不修改。
5. `requiresConfirmation = created > autoEnabled`。

目录不可用不抛错；同步仍以“仅上游字段”继续。

### 8.2 刷新存量

新增：

```ts
export async function refreshProviderModelMetadata(args: {
  env: GatewayEnv;
  provider: ProviderRecord;
  live: RemoteModel[];
  fetchImpl: FetchLike;
}): Promise<RefreshMetadataResult>;
```

流程：

1. `loadModelsDevCatalog()`。
2. 建立上游模型索引：`modelId` 与 `upstreamModelId` 小写。
3. 遍历该 Provider 的模型：
   - `metadataSource === "manual"` → `skippedManual++`。
   - 无上游条目且目录未命中 → `unmatched++`。
   - 否则 `buildModelMetadata()`，再 `applyMetadataToModel()`。
4. `applyMetadataToModel()` 只补空缺：
   - 若模型已有 `contextWindow`，保留。
   - 若模型已有非空 `maxOutputTokens`，保留。
   - 若输入模态不是默认 `["text"]`，保留；否则用合并结果。
   - 布尔能力只在当前为 `false` 且合并为 `true` 时提升。
   - 价格只在当前输入、输出价格都为 0 时填充。
   - 缺少显示名时填充。
   - `enabled` 永不改变。
   - 来源按第 7 节升级。
5. 有变化才 `replaceModel()`，返回统计。

Handler `refreshModelMetadataHandler`：

- 读取账户；无账户时 `live = []`，只用目录。
- 有账户时拉取上游模型列表；失败时记录 warning，`live = []`，仍执行目录匹配。
- 响应包含目录状态和统计。

## 9. API 变更

- `POST /admin/providers/:id/sync-models`
  - 响应新增 `autoEnabled`、`metadata`。
  - `note` 更新为新语义。
- `POST /admin/providers/:id/refresh-model-metadata`
  - 无请求体。
  - 响应：

```json
{
  "providerId": "prv_x",
  "updated": 3,
  "unchanged": 1,
  "skippedManual": 2,
  "unmatched": 4,
  "metadata": { "catalog": "ok", "modelsDevMatched": 6, "upstreamMatched": 2 }
}
```

- 模型对象新增 `metadataSource`、`metadataUpdatedAt`。

## 10. UI 变更

- `openProviderSetup()` 模型区块：
  - 提示文案改为自动识别说明。
  - 按钮：`同步模型`、`刷新元数据`、`手动添加模型`。
  - 模型表新增“上下文”“来源”列。
- 模型实体列表：
  - 新增“上下文”列（格式化 1M / 128K）。
  - 新增“元数据”列（models.dev / 上游 / 手动 / 未识别）。
- 模型表单 note：说明自动填充与手工覆盖规则。
- Provider 扩展配置编辑器：
  - `modelsDevProvider` 文本框：留空自动按 Base URL/名称匹配。
  - `syncAutoEnable` 三态：默认 / 启用 / 禁用。
- 同步完成提示：`新增 X（自动启用 Y），跳过 Z，元数据匹配 N（目录状态）`。

## 11. 安全、性能与兼容

**安全**

- models.dev 是固定 HTTPS 公网地址，不接收用户输入，避免 SSRF。
- 目录数据不包含密钥；日志只记录状态和错误消息。
- 管理接口仍由 `requireAdmin` 保护。
- 不改变上游凭据存储与脱敏逻辑。

**性能**

- 目录压缩后约 2.6 MB；每个 isolate 24 小时内只下载/解析一次。
- KV 读取 2.6 MB；冷启动同步可接受。
- 匹配索引按目录对象懒构建，用 `WeakMap` 缓存。
- 同步与目录下载并行。
- 目录不可用时不重试整次同步。

**兼容/回滚**

- 迁移只新增列，旧代码可忽略。
- 旧配置快照缺少 `metadataSource` 时按 `unknown` 处理。
- 回滚代码后新列保留，不影响旧逻辑。
- `extraConfig.syncAutoEnable = false` 可立即恢复“同步后全部禁用”的行为。

## 12. 测试策略

**单元测试**（`test/unit/model-metadata.test.ts`、`test/unit/model-catalog.test.ts`）

- 归一化：厂商前缀、大小写、点/横线、快照日期、`[1m]`。
- Provider 匹配：主机映射、`extraConfig.modelsDevProvider`、名称匹配。
- 目录匹配：Provider 精确、前缀、归一化、全局聚合、价格不跨 Provider。
- 合并：上游优先、目录兜底、`pdf` → `file`、`vision` 推导、纯图像输出。
- 自动启用：识别/未识别、`syncAutoEnable=false`。
- 存量回填：只补空缺、不覆盖、不改变 `enabled`、manual 跳过。
- 缓存：KV 命中、过期刷新、远端失败使用 stale、无缓存返回 unavailable、并发只下载一次。
- 上游解析：OpenRouter 风格、火山风格、Gemini、非法字段容错。

**集成测试**（`test/integration/model-metadata.test.ts`）

- 注入假的 models.dev 响应与上游 `/models` 响应。
- 同步后断言上下文、图像、工具、推理、价格、自动启用、来源。
- 未识别模型保持禁用。
- 刷新旧模型只补空缺，启用状态不变。
- 手工编辑后刷新跳过。
- 第二次同步复用 KV，不重复请求 models.dev。
- 目录返回 500 时同步仍成功。

**回归测试**

- 现有 `setup.test.ts` / `gateway.test.ts` 中“未识别模型保持禁用”的断言保留。
- `npm run typecheck`、`npm test`、`npm run deploy:dry-run`。
