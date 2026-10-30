# FufuGateway 架构设计与实施计划

- 文档状态：已确认并完成实施
- 目标仓库：`FufuGateway`（当前为空工作区，仅有 IDE 元数据，无既有代码需要兼容）
- 编写日期：2026-10-30

---

## 1. 项目定位与范围

构建一个运行于 Cloudflare Workers 的多协议 AI Token Gateway，具备独立的协议转换引擎、模型路由引擎与 Combo 编排执行引擎，而不是简单反向代理。

第一版交付范围：

| 能力 | 第一版 | 说明 |
|------|--------|------|
| 下游协议入口 | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Gemini | 完整实现 |
| 上游协议 | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini generateContent | 完整实现 |
| 协议交叉转换 | 4 × 4 双向（请求/响应/流/错误/Usage） | 以 IR 为中枢 |
| 路由 | 前缀、原生模型、唯一匹配、歧义报错、Alias、Glob 通配符、Combo | 完整实现 |
| Combo | 无限层嵌套、循环检测、9 种策略、会话粘性、执行树 | 完整实现 |
| 调度 | 重试、超时、熔断、账户负载均衡、故障转移 | 完整实现 |
| 流式 | SSE 增量解析/生成、任意 Chunk 切分、取消传播 | 完整实现 |
| 认证与配额 | API Key、权限、RPM/TPM/并发/预算 | 完整实现 |
| 用量与成本 | 异步记录、价格表、日/周/月汇总 | 完整实现 |
| 管理 API | Provider/Model/Alias/Combo/Key/Usage/Config | 完整实现 |
| 管理 UI | 提供（只读 + 写入） | 零构建单页应用，静态资源由 Worker Assets 提供，复用 Admin API |
| Embeddings / 音频 / 视频 / 图像生成 | 不实现，仅预留 Adapter 注册接口 | 明确报错，不伪造成功 |

---

## 2. 技术选型与版本核验结果

所有版本已通过 npm registry 核验（2026-10-30）：

| 依赖 | 版本 | 用途 |
|------|------|------|
| TypeScript | `~5.9.3` | 选 5.9 而非 7.x：7.x 为原生新编译器，`wrangler types`、Vitest、esbuild 链路兼容性尚未经过本项目验证，先用稳定线 |
| Hono | `^4.13.14` | HTTP 路由 |
| Zod | `^4.6.7` | 边界校验（不引入 `@hono/zod-validator`，直接使用 `safeParse` 封装，避免版本耦合） |
| Wrangler | `^4.156.0` | 开发/迁移/部署 |
| Vitest | `^4.1.12` | 测试运行器（与 Cloudflare 插件 peer 要求一致） |
| @cloudflare/vitest-plugin | `^1.4.11` | 在 Workers Runtime（Miniflare）内运行测试；已取代 `@cloudflare/vitest-pool-workers` |
| @cloudflare/workers-types | `^5.20261030.1` | Workers 类型 |

关键测试 API（已核验文档）：

- 配置：`cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })`，来自 `@cloudflare/vitest-plugin`。
- 绑定：`import { env } from "cloudflare:workers"`。
- 集成：`import { exports } from "cloudflare:workers"`。
- D1 迁移：`applyD1Migrations` + `readD1Migrations`（`@cloudflare/vitest-plugin/config`）。
- 队列：`createMessageBatch` / `getQueueResult`。
- DO：`runInDurableObject` / `runDurableObjectAlarm`。
- 出站 fetch：Cloudflare 官方推荐 MSW；本项目不依赖它，改用**显式注入 `FetchLike`**，测试中注入假 fetch，同时便于精确测试超时、Abort 与重试。

约束遵循：不使用 Node.js 专有 API、不依赖本地文件系统与常驻进程、全部使用 Web 标准 API（`Request/Response/ReadableStream/TransformStream/AbortController/WebCrypto`）。

---

## 3. 总体架构

### 3.1 分层与依赖方向

```
L5  Composition      src/index.ts, src/app.ts            （唯一组装点）
L4  Interface        gateway/*（推理入口中间件）, admin/*（管理接口）
L3  Orchestration    execution/*, combo/executor, config/snapshot
L2  Domain           protocol/*, providers/*, router/*, combo/{validator,strategies}, usage/pricing
L1  Primitives       ir/*, stream/sse-*, security/*, auth/api-key, ratelimit/*
L0  Core             core/{errors,ids,logger,redact,result,limits,clock}
L-  Platform         env.ts（绑定类型）, durable-objects/*（独立运行时单元）
```

依赖规则（硬性）：

1. 只允许上层依赖下层，禁止反向依赖与循环依赖。
2. `protocol/*` 不得 import `providers/*`；`router/*` 不得 import `execution/*`；`providers/*` 不得 import `combo/*`。
3. `core` 不 import 任何业务模块。
4. 模块协作一律通过 `L2` 中定义的接口（`ProtocolAdapter`、`ProviderAdapter`、`ComboStrategy`、`RouteResolver`、`UsageSink`）完成。
5. 平台绑定 `Env` 只在 `env.ts` 定义，业务模块通过参数接收依赖，禁止在业务层直接读全局 `env`。

### 3.2 请求主链路

```
客户端 HTTP
  └─ Hono 路由 → 请求上下文（requestId/traceId/计时）
      └─ 认证（按协议识别凭据）→ 权限/模型白名单
          └─ 限流/并发/预算（Durable Object）
              └─ 下游 Protocol Adapter.parseRequest → UnifiedRequest(IR)
                  └─ Router.resolve(model) → RouteResolution
                      ├─ 单模型：ExecutionPlan[target...]
                      └─ Combo：递归执行树
                          └─ 候选选择（策略 + 账户 + 熔断 + 健康）
                              └─ Provider Adapter.buildRequest → fetch（超时/重试/取消）
                                  ├─ 非流式：parseResponse → UnifiedResponse → 下游 Adapter 渲染
                                  └─ 流式：parseStream → UnifiedStreamEvent → Stream Engine → 下游 SSE
      └─ Usage 记录（Queues 异步，失败降级直写 D1）
```

### 3.3 核心原则落地

- API Gateway 不包含任何厂商协议细节，只做编排。
- 同协议直通优化：当下游协议 == 上游协议，且无参数改写需求（除 `model` 与认证）时，Provider Adapter 可基于 `UnifiedRequest.raw` 走直通序列化路径，仍经过统一响应/流解析以完成 Usage 与错误归一化。
- 客户端认证头永不透传；上游所需的认证由 Provider Adapter 依据账户配置重建。

---

## 4. 目录结构

```
FufuGateway/
├── package.json
├── tsconfig.json
├── wrangler.jsonc
├── vitest.config.ts
├── README.md
├── PLAN.md
├── migrations/
│   ├── 0001_init.sql
│   └── 0002_seed.sql
├── src/
│   ├── index.ts                    # Worker 入口：fetch + queue
│   ├── app.ts                      # Hono 组装、错误边界、请求上下文
│   ├── env.ts                      # Env 绑定与 Secrets 类型
│   ├── core/
│   │   ├── errors.ts               # GatewayError + 错误码 + HTTP 映射
│   │   ├── ids.ts                  # requestId/traceId
│   │   ├── logger.ts               # 结构化日志 + 字段脱敏
│   │   ├── redact.ts
│   │   ├── json.ts                 # unknown → 类型安全的读取工具
│   │   ├── limits.ts               # 全局硬限制常量
│   │   └── time.ts
│   ├── ir/
│   │   ├── request.ts  response.ts  stream.ts  usage.ts
│   │   ├── capabilities.ts  errors.ts  index.ts
│   ├── protocol/
│   │   ├── types.ts                # ClientProtocolAdapter 接口
│   │   ├── registry.ts
│   │   ├── openai-chat/{request,response,stream,error,index}.ts
│   │   ├── openai-responses/{...}.ts
│   │   ├── anthropic/{...}.ts
│   │   └── gemini/{...}.ts
│   ├── stream/
│   │   ├── sse-parser.ts           # 字节级增量 SSE 解析
│   │   ├── sse-encoder.ts
│   │   ├── stream-engine.ts        # 统一事件 → 下游 SSE，统计与取消
│   │   └── timeouts.ts
│   ├── providers/
│   │   ├── types.ts                # ProviderAdapter 接口
│   │   ├── registry.ts
│   │   ├── openai-compatible/...
│   │   ├── anthropic/...
│   │   ├── gemini/...
│   │   └── custom/...
│   ├── router/
│   │   ├── types.ts
│   │   ├── glob.ts                 # 安全 Glob（无用户正则）
│   │   ├── resolver.ts             # 优先级解析
│   │   └── conflict.ts             # 配置期冲突检测
│   ├── combo/
│   │   ├── types.ts
│   │   ├── validator.ts            # 循环/深度/节点数
│   │   ├── executor.ts             # 递归执行 + 执行树
│   │   ├── session.ts              # 会话标识提取与粘性
│   │   └── strategies/{fallback,round-robin,weighted-round-robin,random,priority,lowest-latency,lowest-cost,race,fusion}.ts
│   ├── execution/
│   │   ├── executor.ts             # 单目标执行（含账户选择、重试、熔断）
│   │   ├── retry.ts
│   │   ├── timeout.ts
│   │   ├── breaker.ts
│   │   └── accounts.ts
│   ├── config/
│   │   ├── types.ts                # ConfigSnapshot 与记录类型
│   │   ├── repository.ts           # D1 数据访问（按表拆分亦可）
│   │   ├── snapshot.ts             # 构建/发布/回滚
│   │   ├── cache.ts                # KV 版本指针 + 隔离内存缓存
│   │   └── validate.ts
│   ├── auth/
│   │   ├── api-key.ts              # 生成/哈希/校验
│   │   ├── identify.ts             # 按协议提取凭据
│   │   └── middleware.ts           # 推理/管理员鉴权
│   ├── ratelimit/
│   │   ├── client.ts               # DO 调用封装（含降级策略）
│   │   └── types.ts
│   ├── usage/
│   │   ├── events.ts               # UsageEvent 类型
│   │   ├── producer.ts
│   │   ├── consumer.ts             # 幂等落库 + 汇总
│   │   ├── pricing.ts
│   │   └── query.ts
│   ├── models/
│   │   ├── registry.ts
│   │   └── sync.ts
│   ├── security/
│   │   ├── ssrf.ts
│   │   ├── headers.ts              # Hop-by-hop 过滤
│   │   └── crypto.ts               # AES-GCM 上游密钥加解密
│   ├── gateway/
│   │   ├── routes.ts               # /v1/* 推理入口
│   │   └── handlers.ts
│   ├── admin/
│   │   ├── routes.ts
│   │   └── handlers/{providers,models,aliases,combos,keys,usage,config}.ts
│   ├── ui/
│   │   ├── shell.ts                # HTML 外壳与内嵌样式/脚本
│   │   ├── app-js.ts               # 前端应用（Hash 路由 + CRUD 表单）
│   │   └── index.ts                # /ui 响应渲染
│   └── durable-objects/
│       ├── rate-limiter.ts
│       └── coordination.ts         # RR 游标/粘性/熔断/延迟 EWMA
├── test/
│   ├── unit/                       # 纯函数与状态机
│   ├── integration/                # app + 真实本地 D1/KV/DO/Queues
│   ├── fixtures/                   # 各协议请求/响应/SSE 样本
│   └── helpers/
└── docs/
    ├── ARCHITECTURE.md
    ├── PROVIDERS.md
    ├── COMBOS.md
    ├── API.md
    └── DEPLOY.md
```

---

## 5. 核心类型设计

### 5.1 IR（与外部协议无关）

```ts
export type ProtocolId = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

export interface UnifiedRequest {
  model: string;
  system: UnifiedContentPart[];        // 归一化的 system/developer 指令
  messages: UnifiedMessage[];
  tools: UnifiedTool[];
  toolChoice: UnifiedToolChoice;       // auto | none | required | named
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences: string[];
  stream: boolean;
  responseFormat?: UnifiedResponseFormat; // text | json_object | json_schema
  reasoning?: UnifiedReasoningConfig;     // effort | budgetTokens | includeInOutput
  metadata: UnifiedRequestMetadata;       // userId/sessionId/端侧提示
  extensions: ProtocolExtensions;         // 源协议扩展参数（带来源标签，受策略控制）
  raw: { protocol: ProtocolId; body: Record<string, unknown> };
}

export interface UnifiedMessage {
  role: "user" | "assistant" | "tool";
  content: UnifiedContentPart[];
  providerHints?: Record<string, unknown>; // 如 Anthropic cache_control 位置
}

export type UnifiedContentPart =
  | { type: "text"; text: string; cacheControl?: CacheControl }
  | { type: "image"; mimeType: string; data: Uint8Array | { url: string } }
  | { type: "tool_call"; call: UnifiedToolCall }
  | { type: "tool_result"; callId: string; content: UnifiedContentPart[]; isError?: boolean }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "refusal"; text: string };

export interface UnifiedToolCall { id: string; name: string; arguments: unknown; rawArguments?: string; }

export interface UnifiedTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;             // 统一为 JSON Schema Draft 2020-12 子集
}

export type StopReason =
  | "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "content_filter" | "error" | "unknown";

export interface UnifiedResponse {
  id: string;
  model: string;
  createdAt: number;
  content: UnifiedContentPart[];
  stopReason: StopReason;
  stopSequence?: string;
  usage: UnifiedUsage;
}

export interface UnifiedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  source: "upstream" | "estimated" | "none";
}

export interface UnifiedError {
  code: GatewayErrorCode;
  message: string;
  retriable: boolean;
  upstreamStatus?: number;
  upstreamCode?: string;
  details?: Record<string, unknown>;
}

export interface ModelCapabilities {
  inputModalities: ("text" | "image" | "audio" | "video" | "file")[];
  outputModalities: ("text" | "image" | "audio" | "embedding")[];
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsStream: boolean;
  supportsTools: boolean;
  supportsParallelTools: boolean;
  supportsJsonSchema: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsPromptCache: boolean;
}
```

### 5.2 统一流式事件

独立结构，不复用非流式响应：

```ts
export type UnifiedStreamEvent =
  | { type: "start"; id: string; model: string; role: "assistant" }
  | { type: "block_start"; index: number; block: { kind: "text" } | { kind: "thinking" } | { kind: "tool_use"; id: string; name: string } }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "block_stop"; index: number }
  | { type: "finish"; stopReason: StopReason; stopSequence?: string; usage: UnifiedUsage }
  | { type: "error"; error: UnifiedError }
  | { type: "ping" };
```

事件模型对齐 Anthropic 的 block 语义（最能表达 thinking / tool 交错），可无损映射到 OpenAI chunk 与 Gemini parts。

### 5.3 适配器接口

```ts
export interface ClientProtocolAdapter {
  readonly protocol: ProtocolId;
  parseRequest(input: ParsedIncomingRequest): UnifiedRequest;
  renderResponse(res: UnifiedResponse, ctx: RenderContext): Response;
  renderStream(events: AsyncIterable<UnifiedStreamEvent>, ctx: RenderContext): Response;
  renderError(err: GatewayError, ctx: RenderContext): Response;
  renderModels(models: PublicModel[], ctx: RenderContext): Response;
}

export interface ProviderAdapter {
  readonly protocol: ProtocolId;
  buildRequest(req: UnifiedRequest, target: ExecutionTarget, ctx: ProviderCallContext): UpstreamRequest;
  parseResponse(res: Response, target: ExecutionTarget): Promise<UnifiedResponse>;
  parseStream(res: Response, target: ExecutionTarget): AsyncIterable<UnifiedStreamEvent>;
  parseError(status: number, body: string): UnifiedError;
  fetchModels(ctx: ProviderCallContext): Promise<RemoteModel[]>;
  getCapabilities(target: ExecutionTarget): ModelCapabilities;
}
```

`buildRequest` 接收 `ExecutionTarget`（含 `upstreamModelId`、账户密钥、自定义 Headers、超时策略），协议差异全部封装在 Adapter 内，新增厂商无需改核心链路。

### 5.4 路由解析结果

```ts
export interface RouteResolution {
  kind: "model" | "combo";
  requestedModel: string;
  match:
    | { type: "provider_prefix"; provider: string; model: string }
    | { type: "native"; modelId: string; targets: ResolvedTarget[] }
    | { type: "alias"; alias: string; targets: ResolvedTarget[] }
    | { type: "wildcard"; ruleId: string; pattern: string; targets: ResolvedTarget[] }
    | { type: "combo"; comboId: string };
  strategy: StrategyId;                // 多目标时生效
  targets: ResolvedTarget[];
  trace: string[];
}
```

`ResolvedTarget` 在发布期完成解析，包含 `providerId`、`modelRecordId`、`upstreamModelId`、`capabilities`、`price`、`weight/priority`。

### 5.5 Combo 类型

```ts
export type StrategyId =
  | "fallback" | "round_robin" | "weighted_round_robin" | "random"
  | "priority" | "lowest_latency" | "lowest_cost" | "race" | "fusion";

export interface ComboDefinition {
  id: string;
  name: string;
  strategy: StrategyId;
  nodes: ComboNode[];
  timeoutMs?: number;
  maxConcurrency?: number;
  sticky?: { enabled: boolean; ttlSeconds: number; mode: "round_robin" | "first_available" };
}

// 发布期归一化后：
export type ResolvedComboNode =
  | { kind: "model"; target: ResolvedTarget; weight: number; priority: number; timeoutMs?: number; retries?: RetryPolicy }
  | { kind: "combo"; comboId: string; weight: number; priority: number; timeoutMs?: number; strategy?: StrategyId };

export interface ComboStrategy {
  readonly id: StrategyId;
  readonly supportsStreaming: boolean;
  execute(ctx: StrategyContext): Promise<NodeOutcome>;
}

export interface NodeOutcome {
  ok: boolean;
  response?: UnifiedResponse;
  stream?: AsyncIterable<UnifiedStreamEvent>;   // 仅在尚未向客户端输出时可用
  target?: ResolvedTarget;
  error?: GatewayError;
  trace: TraceNode;
}
```

`trace` 结构固定为可序列化执行树：

```ts
interface TraceNode {
  id: string; kind: "combo" | "model"; label: string;
  providerId?: string; model?: string;
  status: "ok" | "failed" | "skipped" | "cancelled";
  attempts: { attempt: number; providerId?: string; accountId?: string; status: number | "network" | "timeout"; durationMs: number; errorCode?: string }[];
  startedAt: number; finishedAt?: number;
  children: TraceNode[];
}
```

---

## 6. 协议转换与兼容策略

### 6.1 转换矩阵

请求方向：`parseRequest`（4 种下游）→ IR → `buildRequest`（4 种上游）。
响应方向：`parseResponse` / `parseStream`（4 种上游）→ IR → `renderResponse` / `renderStream`（4 种下游）。

覆盖要点：

| 语义 | OpenAI Chat | OpenAI Responses | Anthropic | Gemini |
|------|-------------|------------------|-----------|--------|
| 系统指令 | `messages[role=system/developer]` | `instructions` | `system` | `systemInstruction` |
| 多模态图片 | `image_url`（url/base64） | `input_image` | `image` source base64/url | `inlineData` / `fileData` |
| 工具调用 | `tool_calls` / `function` | `function_call` item | `tool_use` block | `functionCall` part |
| 工具结果 | `role=tool` | `function_call_output` | `tool_result` block | `functionResponse` part |
| 推理内容 | `reasoning`（部分兼容） | `reasoning` item + summary | `thinking` block + signature | `thought` part + `thoughtSignature` |
| 结构化输出 | `response_format` | `text.format` | 无原生 → 参数兼容策略 | `responseMimeType` + `responseSchema` |
| 结束原因 | `finish_reason` | `status` + `incomplete_details` | `stop_reason` | `finishReason` |
| Usage | `usage.prompt_tokens...` | `usage.input_tokens...` | `usage.input_tokens...` | `usageMetadata.*` |
| 流结束 | `data: [DONE]` | `response.completed` | `message_stop` | 最后 chunk + `[DONE]`（SSE 模式） |

### 6.2 参数兼容策略

```ts
export type CompatibilityPolicy = "strict" | "warn" | "drop" | "passthrough";
```

- 每个请求携带策略（默认 `warn`，可按 Key/系统设置覆盖）。
- 转换器返回 `CompatibilityIssue[]`：`{ feature, source, target, action, message }`。
- `warn`：继续执行，响应头 `x-fufu-warnings` 摘要 + 日志记录；`strict`：抛出 `UNSUPPORTED_FEATURE`；`drop`：显式丢弃并记录；`passthrough`：仅同协议或明确支持扩展的上游保留。
- 关键行为（工具、结构化输出、推理）在 `strict` 下不允许静默降级；`warn` 下必须在 `route_trace.compatibility` 中留痕。
- 同协议且无改写：直通路径，避免重复序列化。

### 6.3 能力矩阵与降级

`src/protocol/compat-matrix.ts` 声明每种「源能力 × 目标协议」的支持级别：`native` / `emulated` / `unsupported`。例如：

- Anthropic `thinking` → OpenAI Chat：`unsupported`（warn 时丢弃 thinking，保留正文；strict 报错）。
- OpenAI `json_schema` → Anthropic：`emulated`（注入工具 + 提示词约束，仅在 `warn`/`passthrough` 下允许，并标记 `emulated`）。
- Gemini `safetySettings` → 其他：`unsupported`（默认 drop 并记录）。
- Anthropic `cache_control` → 非 Anthropic：`unsupported`（drop，记录）。

已知限制在 `docs/ARCHITECTURE.md` 与 README 中列明。

---

## 7. 路由引擎

### 7.1 解析顺序（严格按此实现）

1. `provider/modelId` 前缀精确匹配（Provider 可按 `name` 或 `id` 匹配，大小写不敏感；只匹配第一段，剩余部分作为 modelId，支持含 `/` 的上游模型名）。命中 Provider 但模型不存在 → `MODEL_NOT_FOUND`，禁止回退模糊匹配。
2. 原生模型精确匹配（Model Registry 中 `model_id`）。
   - 唯一 → 路由。
   - 多个 → `MODEL_AMBIGUOUS`。
3. 虚拟模型精确匹配（Alias / Combo 名称，同一命名空间）。
4. Glob 通配符匹配：
   - 排序：`priority` 降序 → 具体度降序 → 规则 id 升序（保证确定性）。
   - 具体度：字面量字符数多者优先；通配符少者优先；段数多者优先。
5. 未命中 → `MODEL_NOT_FOUND`。

发布期冲突检测（`router/conflict.ts`）：

- Alias/Combo 名称与原生模型 ID 冲突 → 拒绝发布。
- Alias 与 Combo 同名 → 拒绝发布。
- 通配符规则重复 pattern → 拒绝；pattern 非法或超长（>200 字符、>16 段）→ 拒绝。
- Alias/通配符目标解析失败 → 拒绝发布。
- Combo 名称不得包含 `/`，不得与 Provider 名冲突（避免前缀语义歧义）。

### 7.2 Glob 实现

- 支持 `*`（匹配任意非空字符序列，包括 `/` 与 `-`）与 `?`（单字符），其余字符全部转义。
- 编译为锚定正则，字符串长度与段数设上限，正则构造过程无回溯型结构（无嵌套量词），从机制上规避 ReDoS。
- 不开放用户自定义正则。
- 提供 `/admin/wildcards/preview?model=...` 预览命中结果与排序依据。

---

## 8. Combo 引擎

### 8.1 执行模型

- 发布期递归解析 Combo 引用，生成归一化执行计划（`ResolvedComboNode`），并完成：
  - 循环引用检测（DFS 三色标记，含 Alias → Combo → Alias 间接环）。
  - 最大深度（默认 16）、最大节点数（默认 256）校验。
  - 每个节点目标可解析性校验。
- 运行期不再做名称解析，保证执行路径确定。

### 8.2 策略

| 策略 | 流式 | 行为 |
|------|------|------|
| fallback | 支持 | 顺序尝试；仅可重试错误切换；已输出内容后禁止切换 |
| round_robin | 支持 | DO 原子游标选择 |
| weighted_round_robin | 支持 | 平滑加权轮询（SWRR），DO 持久化当前权重 |
| random | 支持 | 按权重随机 |
| priority | 支持 | 优先级高者优先，失败降级次优先 |
| lowest_latency | 支持 | 读取 DO 中 EWMA 延迟，取最低若干并 fallback |
| lowest_cost | 支持 | 按价格表预估成本升序 |
| race | 支持 | 并行请求，首个产出有效首事件者胜出，取消其余 |
| fusion | **不支持流式** | 并行收集多个结果，调用 Judge Model 生成最终结果；流式返回 `UNSUPPORTED_FEATURE` |

策略之间零 if/else 混合：注册表 + 接口实现，按 `StrategyId` 查找。

### 8.3 资源与取消

- 每层执行继承 `AbortSignal`，父级超时/客户端断开向所有子请求传播。
- 并发上限（Combo 级 `maxConcurrency`，默认 8；全局硬上限 32）。
- 总时间预算：`deadline = min(combo.timeout, parent.deadline, request.timeout)`；每次重试前检查剩余预算，不足则不重试。
- 失败回收：所有未胜出的 in-flight 请求在 `finally` 中 abort；流式读取器统一 `cancel()`。
- 执行树随请求结束写入 `route_trace`（并限制序列化大小，超限截断并标记）。

### 8.4 会话粘性

会话标识提取链（按顺序，命中即停）：

1. Header `x-fufu-session-id`；
2. Header `x-session-id`；
3. 请求体中的协议扩展字段：OpenAI `user` / `metadata.session_id` / `prompt_cache_key`；Anthropic `metadata.user_id`；Responses `user`；
4. 网关扩展字段 `fufu_session_id`；
5. 可选：首个 user 消息内容的哈希（默认关闭，需在 Combo sticky 配置中显式开启）。

粘性键：`sha256(comboId + ":" + sessionId)`；状态写入 `CoordinationDO`（按粘性键分片），TTL 可配置。模型失败/熔断时主动解除锁并重新选择。

### 8.5 流式不可拼接约束

- 执行器返回流时带 `committed: false` 状态；`StreamEngine` 在向客户端写出第一个字节后置为 `committed`。
- `committed === true` 后任何错误只允许生成协议错误事件并结束流，禁止切换节点。
- 测试专门覆盖该路径。

---

## 9. 执行管线（重试 / 超时 / 熔断 / 账户）

### 9.1 重试

```ts
export interface RetryPolicy {
  maxAttempts: number;          // 含首次
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: "full" | "none";
  retryStatuses: number[];      // 默认 [429,500,502,503,504]
  retryOnNetworkError: boolean;
  retryOnTimeout: "never" | "before_first_byte" | "always";
  respectRetryAfter: boolean;
}
```

- 每次尝试从 IR 重新构建请求体（`buildRequest` 幂等），避免复用已消费的 body。
- 仅以下阶段可重试：请求发送前、响应头返回前、响应头为可重试状态且尚未向客户端输出。
- 流式请求在首事件到达前可重试；首事件后仅允许结束。
- 遵循 `Retry-After`（秒或 HTTP 日期，带上限）。
- Provider 级默认策略 + 模型级覆盖 + Combo 节点级覆盖，逐层合并。

### 9.2 超时

| 超时 | 默认 | 实现 |
|------|------|------|
| 连接/上游响应头 | Provider `timeoutMs`（60s） | `AbortController` + 定时器 |
| 首 Token | Provider `firstTokenTimeoutMs`（20s） | 等待首个有效事件的竞速 |
| 流空闲 | Provider `idleTimeoutMs`（60s） | 每次收到 chunk 重置定时器 |
| 总请求 | 系统设置（默认 300s） | 顶层 `AbortSignal` |
| Combo 节点 | 节点配置（默认继承） | 子 deadline |
| Combo 整体 | Combo 配置 | 子 deadline |

所有子请求使用 `AbortSignal.any([parent, local])`，保证父级预算优先。

### 9.3 熔断器

- 维度：Provider / Account / Model（默认 Provider+Account；模型级可选启用）。
- 状态机：`CLOSED → OPEN`（滑动窗口失败率 ≥ 阈值且样本数足够，或连续失败 ≥ N）→ `HALF_OPEN`（冷却后半开，允许 N 个探测）→ 成功则 `CLOSED`，失败则 `OPEN`。
- 状态存储于 `CoordinationDO`（按 `breaker:{providerId}:{accountId}` 分片），使用 DO alarm 处理半开转换。
- 熔断状态不阻塞请求主流程：选择候选时批量查询，记录结果用 `waitUntil` 异步写回。
- 被熔断的候选在路由中标记为 `skipped` 并写入执行树。

### 9.4 账户池

- 同一 Provider 多账户：按 `priority` 降序、`weight` 加权轮询。
- 账户失败记录健康状态；连续失败自动降权/冷却；冷却结束自动恢复探测。
- 上游密钥仅在 `execution` 层解密，生命周期局限在单次请求。

---

## 10. 流式引擎

### 10.1 SSE 解析器

`createSseParser(): TransformStream<Uint8Array, SseEvent>`：

- `TextDecoder("utf-8", { fatal: false, ignoreBOM: true })`，`stream: true` 处理跨 chunk 多字节字符。
- 状态机解析：行缓冲 → 字段 `event/data/id/retry` → 空行触发事件。
- 支持 `\n`、`\r\n`、`\r` 行结束符以及跨 chunk 的事件边界。
- 多行 `data` 以 `\n` 连接。
- 注释行（`:` 开头）作为心跳处理，不进入 `data`，但会重置空闲超时。
- 单个事件超过 1 MiB 时中止并报 `PROTOCOL_CONVERSION_ERROR`（防内存放大）。
- 流末尾未以空行结束的残留事件：若 `data` 非空则按完整事件处理（容错），但记录告警。

### 10.2 生成器

`encodeSse(event)` 生成符合下游协议的 `event:`/`data:` 帧，必要时附带 `[DONE]`（OpenAI）。所有输出使用 `TextEncoder`。

### 10.3 管线

```
upstream bytes
  → SseParser (TransformStream<Uint8Array, SseEvent>)
  → Provider.parseStream (AsyncIterable<UnifiedStreamEvent>)
  → [统计/超时/取消监控]
  → Client.renderStream (TransformStream<UnifiedStreamEvent, Uint8Array>)
  → downstream Response.body
```

- 全程增量处理，不缓存完整响应。
- 下游断开：`ReadableStream.cancel` → AbortSignal → 上游 `reader.cancel()`。
- 上游断开：生成协议错误事件并正常关闭下游流（HTTP 已无法改状态码，需在流内表达）。
- 首事件探针：在提交下游前等待首个事件，使「首字节前失败」可故障转移；同时完成首 Token 计时。
- Usage：优先取上游最终 usage 事件；缺失则按估算（`source: "estimated"`），响应头 `x-fufu-usage-source` 标注。

### 10.4 非流式

独立管线；对响应体大小设上限（默认 16 MiB），超限报错；解析出 Usage 后同样进入统一记录。

---

## 11. 数据模型（D1）

所有时间字段使用 Unix 毫秒整数。JSON 字段以 TEXT 存储并在 Repository 层解析校验。ID 使用 ULID 风格字符串（时间有序）。

### 11.1 表与索引

| 表 | 关键字段 | 唯一约束 / 索引 |
|----|----------|-----------------|
| `users` | id, tenant_id, email, display_name, role(admin/user), status, created_at, updated_at | UNIQUE(email)；INDEX(tenant_id) |
| `api_keys` | id, user_id, name, key_prefix, key_hash, scopes(JSON), model_allowlist(JSON), provider_allowlist(JSON), rpm_limit, tpm_limit, concurrency_limit, daily_budget_usd, monthly_budget_usd, expires_at, status, rotated_from, created_at, updated_at, last_used_at | UNIQUE(key_hash)；INDEX(user_id)；INDEX(status) |
| `providers` | id, name, type, protocol, base_url, enabled, priority, weight, custom_headers(JSON), timeout_ms, first_token_timeout_ms, idle_timeout_ms, max_retries, retry_config(JSON), proxy_config(JSON), extra_config(JSON), created_at, updated_at | UNIQUE(name COLLATE NOCASE)；INDEX(enabled) |
| `provider_accounts` | id, provider_id, name, api_key_enc, api_key_iv, api_key_tag, secret_ref, weight, priority, enabled, health_status, cooldown_until, last_checked_at, created_at, updated_at | UNIQUE(provider_id, name)；INDEX(provider_id, enabled) |
| `models` | id, provider_id, model_id, upstream_model_id, display_name, input_modalities(JSON), output_modalities(JSON), context_window, max_output_tokens, supports_stream/tools/parallel_tools/json_schema/reasoning/vision/audio/video/prompt_cache(INTEGER), input_price, output_price, cached_input_price, reasoning_price, price_unit, enabled, source, created_at, updated_at | UNIQUE(provider_id, model_id)；INDEX(model_id)；INDEX(provider_id)` |
| `model_aliases` | id, name, target(JSON), description, enabled, priority, created_at, updated_at | UNIQUE(name COLLATE NOCASE) |
| `wildcard_rules` | id, pattern, strategy, targets(JSON), priority, enabled, description, created_at, updated_at | UNIQUE(pattern)；INDEX(enabled, priority DESC) |
| `combos` | id, name, description, strategy, nodes(JSON), timeout_ms, max_concurrency, sticky(JSON), enabled, created_at, updated_at | UNIQUE(name COLLATE NOCASE)；INDEX(enabled) |
| `pricing` | id, provider_id, model_id, input_price, output_price, cached_input_price, reasoning_price, currency, effective_from, created_at | UNIQUE(provider_id, model_id) |
| `system_settings` | key, value(JSON), updated_at | PRIMARY KEY(key) |
| `config_versions` | version AUTOINCREMENT, checksum, payload(JSON), status(published/superseded/failed/rolled_back), note, created_by, created_at | INDEX(status, version DESC) |
| `request_logs` | 规格 §12 全字段 + http_status, usage_source, created_at | PRIMARY KEY(request_id)；INDEX(created_at DESC)；INDEX(user_id, created_at)；INDEX(api_key_id, created_at)；INDEX(combo_id)；INDEX(actual_model, created_at)；INDEX(status) |
| `usage_rollups` | day(YYYY-MM-DD), user_id, api_key_id, provider_id, model, combo_id, requests, errors, input/output/cached/reasoning/total tokens, cost_usd, updated_at | PRIMARY KEY(day,user_id,api_key_id,provider_id,model,combo_id) |
| `audit_logs` | id, actor_type, actor_id, action, target_type, target_id, details(JSON), created_at | INDEX(created_at)；INDEX(actor_id) |
| `budget_counters` | scope(day/month), subject(user/key), period, spend_usd, updated_at | PRIMARY KEY(scope, subject, period) |

### 11.2 关键约束

- 上游密钥不落明文：`api_key_enc/iv/tag` 为 AES-256-GCM 密文，或 `secret_ref` 指向 Worker Secret 名称。
- `request_logs` 不记录请求体、响应体、Authorization、API Key。
- `usage_rollups` 采用按日 UTC 分桶，支持日/周/月聚合（周/月由日桶汇总）。
- D1 迁移按编号文件管理（`wrangler d1 migrations apply`）。

---

## 12. 配置发布与缓存

```
Admin 修改 D1 草稿数据
  → 构建 ConfigSnapshot（纯数据，含预解析索引）
  → validate（路由冲突、Combo 环、URL 安全、价格、能力）
  → 写入 config_versions（payload + checksum）
  → KV 写入 config:snapshot:<version>
  → KV 原子更新 config:current = <version>
  → 各 Worker isolate 在下一次请求时检测版本并重建内存索引
```

- 读取路径：内存缓存（60s 或版本变化）→ KV `config:current` → KV snapshot → 构建索引；KV 不可用时回退到进程内最后可用快照，并记录告警。
- 回滚：把 `config:current` 指向历史版本，同时将当前版本标记 `rolled_back`。
- 发布失败（校验不通过 / KV 写入失败）保持旧版本可用。
- 安全关键操作（API Key 禁用/删除/轮换）**不依赖配置缓存**：认证直接读 D1（`key_hash` 唯一索引），确保吊销立即生效。
- Combo/Route 等配置变更最多 60s 内全量生效（KV 最终一致性 + 内存 TTL）。

---

## 13. Cloudflare 服务职责

| 服务 | 职责 | 不承担 |
|------|------|--------|
| Worker | HTTP 入口、协议转换、路由、Combo、流式、限流编排 | 持久化 |
| D1 | 用户、Key、Provider、账户、模型、Alias、通配符、Combo、价格、配置版本、请求日志、汇总 | 高频原子计数 |
| KV | 配置快照与版本指针、模型目录缓存、路由规则缓存 | 立即吊销、强一致 |
| Durable Objects | 限流（令牌桶/滑动窗口）、并发租约、RR 游标、粘性会话、熔断状态、延迟 EWMA | 大对象存储 |
| Queues | Usage 异步落库与汇总、后续通知 | 实时查询 |
| R2（可选） | 历史日志归档、导出文件 | 在线事务 |

DO 分片策略：

- `RateLimiterDO`：`idFromName("key:"+apiKeyId)`、`"user:"+userId`、`"provider:"+providerId`。
- `CoordinationDO`：`"rr:"+comboId`、`"sticky:"+hash`、`"breaker:"+providerId+":"+accountId`、`"latency:"+targetId`。
- 全部使用 SQLite 存储后端；alarm 处理冷却与租约过期。

---

## 14. 安全设计

| 风险 | 措施 |
|------|------|
| SSRF | 仅 https；拒绝私有/环回/链路本地/元数据地址与 IP 字面量；拒绝 URL 内嵌凭据；`redirect: "manual"` 拒绝 3xx；端口白名单（443，可配置） |
| 客户端随意指定上游 | 上游地址只来自管理员配置的 Provider |
| API Key 泄露 | 下游 Key 仅存 `sha256(pepper + key)` + 前缀；上游 Key AES-GCM 加密或引用 Secret；响应/日志/执行树全量脱敏 |
| 认证头透传 | 白名单构造上游 Headers；丢弃 Hop-by-Hop、`authorization`、`x-api-key`、`cookie`、`cf-*` |
| Header 注入 | 自定义 Headers 校验名称与值（禁 CR/LF、禁受保护头） |
| 管理面隔离 | `/admin/*` 独立鉴权（Admin Token 或 admin 角色 Key）；推理 Key 默认无管理权限 |
| 请求体滥用 | 默认 4 MiB 上限；JSON 解析异常归一化；SSE 单事件 1 MiB 上限 |
| Combo 资源耗尽 | 循环检测、深度/节点/并发/总时长限制 |
| 暴力破解 | 认证失败统一延迟 + 失败计数（DO）；不在响应中区分「Key 不存在/已禁用」 |
| CORS | 默认关闭；可配置允许来源，仅对推理入口生效 |
| 审计 | 管理操作写 `audit_logs`，记录操作者、目标、结果（不含密钥） |

密钥配置（Secrets）：`ADMIN_TOKEN`、`API_KEY_PEPPER`、`ENCRYPTION_KEY`（base64 32 字节）。开发环境可用 `.dev.vars`（加入 `.gitignore`）。

---

## 15. API 路由

### 15.1 推理入口（下游协议）

| 方法 | 路径 | 协议 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI Chat |
| POST | `/v1/responses` | OpenAI Responses |
| GET | `/v1/models` | OpenAI Models |
| GET | `/v1/models/:id` | OpenAI Models |
| POST | `/v1/messages` | Anthropic |
| POST | `/v1/messages/count_tokens` | Anthropic（本地估算，标注 estimated） |
| GET | `/v1beta/models` | Gemini Models |
| GET | `/v1beta/models/:model` | Gemini Models |
| POST | `/v1beta/models/:modelAndAction` | Gemini（`:generateContent` / `:streamGenerateContent`） |
| GET | `/health`、`/health/ready` | 运维 |

### 15.2 管理入口

规格 §14 全部接口，另补充：

- `GET/POST /admin/wildcards`、`PUT/DELETE /admin/wildcards/:id`、`POST /admin/wildcards/preview`
- `GET /admin/providers/:id/accounts`、`POST /admin/providers/:id/accounts`、`PUT/DELETE /admin/providers/:id/accounts/:accountId`
- `GET /admin/users`、`POST /admin/users`、`PUT /admin/users/:id`
- `GET /admin/config/current`、`POST /admin/config/publish`、`POST /admin/config/validate`
- `GET /admin/audit-logs`
- `GET /admin/pricing`、`POST /admin/pricing`、`PUT/DELETE /admin/pricing/:id`

统一约定：分页 `?limit=&cursor=`；错误返回统一错误体；写操作返回资源；密钥字段仅返回 `hasKey` / 前缀。

### 15.3 管理界面（可写）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/ui` | 单页管理界面（内嵌 HTML/CSS/JS，零构建） |
| GET | `/ui/` | 同上 |

界面能力（全部通过 Admin API 写入）：

- 登录：输入 Admin Token（保存于 `sessionStorage`，不落 Cookie、不写日志）。
- 概览：健康状态、配置版本、请求量/成本/错误率。
- Provider：列表、创建、编辑、启停、删除、测试连通、同步模型、账户 CRUD。
- Model：CRUD、能力开关、价格、启停。
- Alias / 通配符：CRUD、通配符命中预览。
- Combo：列表、JSON 编辑、校验、预览、CRUD。
- API Key：创建（仅创建时返回一次明文）、启停、轮换、删除、限额与预算配置。
- 用量与请求：汇总、按日趋势、请求列表、执行树查看。
- 配置：版本列表、发布、回滚、校验、审计日志。

UI 安全：所有请求同源并携带 Admin Token；不渲染未转义的服务端数据；密钥只显示前缀；删除操作二次确认。

### 15.4 错误格式映射

- OpenAI / Responses：`{"error":{"message","type","param","code"}}`
- Anthropic：`{"type":"error","error":{"type","message"}}`
- Gemini：`{"error":{"code","message","status","details"}}`
- 流内错误：各协议原生 SSE 错误事件（OpenAI 为 `data: {"error":...}`，Anthropic 为 `error` 事件，Gemini 为 `data: {"error":...}`）。

错误码全集按规格 §19 实现，映射表集中于 `core/errors.ts`。

---

## 16. 可观测性与用量

- 每个请求生成 `request_id`（ULID）与 `trace_id`；响应头返回 `x-request-id`、`x-trace-id`、`x-fufu-model`、`x-fufu-provider`、`x-fufu-usage-source`、`x-fufu-warnings`。
- 结构化日志（JSON）：入口、认证主体（脱敏）、协议、请求模型、匹配规则、Combo 树摘要、Provider/账户、实际模型、上游状态、耗时、首 Token、重试数、Usage、最终状态。
- 日志脱敏：`authorization`、`x-api-key`、`x-goog-api-key`、`api_key`、`key`、`token`、`secret`、`password`；请求体默认不记录。
- `route_trace` 落库并在 `/admin/requests/:id` 返回完整执行树。
- Usage 先投递 Queues；无 Queue 绑定时降级为 `waitUntil` 直写 D1。消费者幂等：`request_logs` 主键去重，仅首次插入时累加 `usage_rollups`。
- 价格：模型级价格优先，其次 `pricing` 表覆盖；支持输入/输出/缓存/推理分别计价；缺失价格时成本记 0 且 `estimated_cost` 标注 `no_price`。
- 估算用量：上游未返回 usage 时按字符数/4 估算，`usage_source=estimated`，不混入真实统计（查询接口可按来源过滤）。
- 保留期：`system_settings` 配置日志保留天数（默认 30），定时任务（Cron）清理过期 `request_logs` 并可选归档至 R2。

---

## 17. 测试策略

| 层 | 范围 | 工具 |
|----|------|------|
| 单元 | IR 转换、Glob、路由优先级、Combo 校验、策略、重试/退避、熔断状态机、SSE 解析/编码、脱敏、错误映射、定价 | Vitest（Workers runtime） |
| 集成 | Hono app + 本地 D1/KV/DO/Queues；认证、限流、路由、Combo、流式端到端 | `cloudflare:test` + `exports.default.fetch` |
| 上游模拟 | 注入 `FetchLike`：正常、429、5xx、超时、断流、乱序 chunk、UTF-8 切分 | 假 fetch 工厂 |
| 协议矩阵 | 4×4 请求/响应/流/错误/Usage | 固定 fixtures |
| 安全 | SSRF 地址表、Header 过滤、密钥不泄露、请求体上限、循环 Combo | 单元 + 集成 |

测试不访问任何真实付费 API。核心 fixtures 覆盖：

- SSE 任意切分：逐字节切分、双字节边界切分、多行 data、CRLF/LF 混合、注释心跳、残缺结尾。
- 协议语义：工具调用并行、tool_result 顺序、thinking 签名、JSON Schema、停止原因、缓存 Token。
- Combo：9 种策略中已实现的全部路径、嵌套故障转移、流式提交后禁止切换、循环/深度/节点/并发/超时。

验收门槛：`tsc --noEmit` 0 错误；单元 + 集成测试全绿；`wrangler deploy --dry-run` 成功。

---

## 18. 关键技术风险与对策

| # | 风险 | 影响 | 对策 |
|---|------|------|------|
| 1 | 协议语义不可完全对齐（thinking、签名、严格 JSON Schema、tool 顺序） | 转换错误或静默降级 | 兼容矩阵 + 四策略机制；strict 模式报错；测试覆盖矩阵；文档列明限制 |
| 2 | Workers 子请求数上限（免费 50 / 付费 1000） | Race/Fusion/深层 Combo 超限 | 并发与节点硬上限（32/256）；提前预算校验；错误码明确 |
| 3 | Workers CPU 时间限制 | 大流量转换触发 CPU 超限 | 流式零缓存增量处理；避免 O(n²) 字符串拼接；非流式响应体上限 |
| 4 | DO 热点与延迟 | 限流/熔断成为瓶颈 | 按 Key/用户/Provider/目标分片；批量查询；结果异步回写 |
| 5 | KV 最终一致性 | 配置/吊销延迟 | 安全操作直读 D1；配置采用版本指针 + 短 TTL + 回退 |
| 6 | D1 写入吞吐与日志膨胀 | 写入失败、查询变慢 | Queues 批量写；按日汇总；保留期清理；关键索引 |
| 7 | 流式取消与重复计费 | 资源泄漏/费用错误 | AbortSignal 全链路传播；reader.cancel；提交后不重试 |
| 8 | 跨协议工具调用 ID/顺序丢失 | 客户端无法匹配 tool_result | IR 保留 call id 与块顺序；矩阵测试断言 |
| 9 | Gemini 路径与查询参数认证差异 | 认证识别失败 | 专用凭据提取器；支持 `x-goog-api-key` 与 `?key=`（仅读取，不回显） |
| 10 | Zod v4 API 与 Workers 兼容性 | 校验运行时异常 | 仅用稳定核心 API；封装 `parseJson`；集成测试覆盖 |
| 11 | 上游流提前结束但无结束事件 | 客户端挂起 | 空闲超时 + 流末尾状态机收敛 + 生成终止事件 |
| 12 | 同协议直通可能绕过 Usage/错误归一化 | 统计缺失 | 直通仅限请求序列化；响应始终经统一解析 |

---

## 19. 阶段计划与验收标准

### Phase 1：项目基础

交付：`package.json`、`tsconfig.json`、`wrangler.jsonc`（D1/KV/DO/Queues/R2）、`vitest.config.ts`、`0001_init.sql`、`env.ts`、`core/*`、`app.ts`、`index.ts`、`/health`。

验收：
- `npm run typecheck` 通过。
- `npm test` 通过（含 D1 迁移应用测试）。
- `npm run dev` 启动，`GET /health` 返回 200；`GET /health/ready` 校验 D1/KV。
- `wrangler deploy --dry-run` 成功。

### Phase 2：协议转换引擎

交付：IR 全套类型、四个协议 Adapter（请求/响应/错误/Usage）、兼容矩阵与策略、交叉转换测试。

验收：
- 4×4 非流式请求转换与响应渲染测试全绿。
- 工具调用、多模态、结构化输出、停止原因、Usage 转换断言通过。
- `strict` 模式对不支持能力返回 `UNSUPPORTED_FEATURE`；`warn` 记录兼容性告警。
- 同协议直通路径有测试。

### Phase 3：Provider 与模型路由

交付：Provider/Alias/Wildcard/Model 数据访问、Provider Adapter 注册、路由解析、冲突检测、模型同步、Models API。

验收：
- 路由优先级测试：前缀、唯一原生、歧义、Alias、Glob 具体度、未命中。
- 发布期冲突检测覆盖：同名、目标不存在、非法 pattern、Provider 名冲突。
- `/v1/models` 按 Key 白名单过滤。
- Provider 测试接口可连通并返回脱敏结果。

### Phase 4：流式处理

交付：SSE Parser/Encoder、Stream Engine、四种协议流式渲染、首 Token 统计、取消与超时、流式 Usage。

验收：
- 逐字节切分、CRLF/LF、多行 data、UTF-8 跨 chunk、残缺事件测试通过。
- 4×4 流式转换测试通过（固定事件序列）。
- 客户端断开后上游请求被 cancel（假 fetch 断言 AbortSignal）。
- 首 Token 计时与 Usage 最终事件正确。

### Phase 5：Combo 引擎

交付：Combo 校验器、递归执行器、9 种策略、执行树、会话粘性、资源限制。

验收：
- Fallback / RR / WRR / Random / Priority / LowestLatency / LowestCost / Race 行为测试；Fusion 非流式测试 + 流式明确报错。
- 三层嵌套故障转移、循环检测、深度/节点限制、并发限制、超时传播测试。
- 执行树结构断言；粘性会话跨请求复用同一目标。
- 流式提交后注入故障，断言不切换、错误事件收尾。

### Phase 6：高可用

交付：重试、指数退避 + 抖动、Retry-After、超时体系、熔断 DO、账户池、健康检查、延迟记录。

验收：
- 429/503 重试次数与退避符合配置；4xx 不重试。
- 熔断状态转换（CLOSED/OPEN/HALF_OPEN）测试。
- 多账户加权轮询与故障转移测试。
- 父级 deadline 到达后停止重试。

### Phase 7：用户与用量

交付：API Key 生命周期、角色权限、限流 DO（RPM/TPM/并发/预算）、价格表、用量记录、Queues 消费、汇总查询、日志查询。

验收：
- Key 创建/禁用/过期/轮换；禁用后立即失效。
- RPM 超限 429、并发上限 429、预算超限 `BUDGET_EXCEEDED`。
- 用量事件幂等（重复投递不重复计数）。
- 日/周/月汇总正确；估算与真实用量分离。
- 敏感字段不出现在日志与响应。

### Phase 8：管理平台

交付：完整 Admin API、配置版本发布/校验/回滚、审计日志、可写管理界面（`/ui`）、`docs/` 全套文档、README、客户端接入示例、Provider/Combo 配置示例。

验收：
- Admin 鉴权失败 401/403；推理 Key 访问管理接口 403。
- 配置发布 → 新请求生效；回滚 → 恢复旧行为；校验失败 → 旧配置保持可用。
- 所有管理接口有集成测试。
- `/ui` 可登录，Provider/模型/别名/通配符/Combo/API Key 的增删改查均可通过界面完成，并正确反映到推理链路。
- 文档覆盖本地开发、部署、Secrets、示例。

---

## 20. 明确限制（不静默降级）

1. Fusion 策略仅支持非流式；流式请求返回 `UNSUPPORTED_FEATURE`。
2. 跨协议不支持的能力（如 Anthropic thinking → OpenAI Chat）在 `strict` 下报错；`warn`/`drop` 下丢弃并记录 `CompatibilityIssue`，绝不在响应中伪造。
3. Embeddings、音频、视频、图像生成仅保留 Adapter 注册接口，第一版入口返回 `UNSUPPORTED_FEATURE`。
4. 跨协议 Prompt Cache 控制无法等价表达时，`strict` 报错，默认丢弃并记录；同协议保留。
5. `count_tokens` 为本地估算（标注 estimated），不保证与上游一致。
6. 配置变更传播存在最长约 60 秒窗口；API Key 吊销不在此列（直读 D1）。
7. 管理界面为无构建的原生单页应用，不引入 React/Vue 等前端框架与构建链。
8. 不做跨区域多主写入；D1 为唯一写入源。

---

## 21. 交付物清单

1. 完整项目目录与 TypeScript 源码。
2. D1 迁移文件（建表、索引、种子数据）。
3. `wrangler.jsonc` 与 `vitest.config.ts`。
4. `.dev.vars.example` 与 Secrets 配置说明。
5. `README.md`（本地开发、部署、客户端接入）。
6. `docs/ARCHITECTURE.md`、`docs/API.md`、`docs/PROVIDERS.md`、`docs/COMBOS.md`、`docs/DEPLOY.md`。
7. Provider / Combo / Alias / 通配符配置示例。
8. 单元测试与集成测试（可重复执行，不依赖付费 API）。
9. 可写管理界面（`/ui`）。
10. 阶段验收记录。

---

## 22. 已确认决策

1. 交付方式：一次性完成全部 8 个阶段，阶段间持续运行类型检查与测试，仅在遇到架构级偏差时暂停。
2. 管理界面：提供可写 UI，采用零构建原生单页应用，通过 Admin API 完成增删改查。

## 23. 实施结果

全部 8 个阶段已完成。最终验证：

- `npm run typecheck`：0 错误。
- `npm test`：200 项单元与集成测试通过。
- `npm run deploy:dry-run`：Worker、Durable Objects、队列、R2、静态资源打包成功。
- 本地 `wrangler dev` 冒烟：健康检查、管理界面、静态资源、用户/Key/Provider/模型创建、配置发布、模型目录与用量查询均正常。

与计划的主要差异：

- 限流第一版覆盖 API Key 与用户维度；Provider/Model/Combo 维度未提供独立配置（文档已列明）。
- 增加定时模型同步开关 `extraConfig.autoSyncModels`。
- 增加系统设置 API 与 CORS 白名单支持。
