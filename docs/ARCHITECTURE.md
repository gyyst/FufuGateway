# 架构设计

## 1. 目标与约束

FufuGateway 运行在 Cloudflare Workers 上，必须遵守：

- 无本地文件系统、无常驻进程、无普通服务器内存状态。
- 使用 Web 标准 API（Fetch、Request/Response、ReadableStream、TransformStream、AbortController、Web Crypto）。
- 所有持久状态落在 D1 / KV / Durable Objects / Queues / R2。
- 流式响应增量处理，不缓存完整上游响应。

## 2. 分层与依赖方向

```text
L5 Composition      src/index.ts, src/app.ts
L4 Interface        gateway/*, admin/*, ui/*
L3 Orchestration    execution/*, combo/executor, config/snapshot
L2 Domain           protocol/*, providers/*, router/*, combo/{normalize,strategies}, usage/pricing
L1 Primitives       ir/*, stream/*, security/*, auth/api-key, ratelimit/*
L0 Core             core/*
Platform            env.ts, durable-objects/*
```

强制规则：

1. 只允许上层依赖下层，禁止反向依赖与循环依赖。
2. `protocol/*` 不依赖 `providers/*`；`router/*` 不依赖 `execution/*`；`providers/*` 不依赖 `combo/*`。
3. `core` 不依赖任何业务模块。
4. 模块协作通过接口完成：`ProtocolAdapter`、`ComboStrategy`、`RouteResolver`、`UsageSink`。
5. 平台绑定只在 `env.ts` 定义，业务模块通过参数接收依赖。

## 3. 请求生命周期

### 3.1 非流式

```text
Hono 路由
  → 请求上下文（requestId / traceId / logger / 计时）
  → 推理认证（按协议提取凭据，D1 直读）
  → 下游 Protocol Adapter.parseRequest → UnifiedRequest
  → 配额检查（API Key + 用户级 RPM/TPM/并发/预算）
  → Router.resolve(model) → RouteResolution
  → Combo Engine / Provider Engine
      → 候选选择（策略 + 账户 + 熔断）
      → Protocol Adapter.buildUpstreamRequest
      → fetch（超时 / 重试 / Retry-After / AbortSignal）
      → 上游 Protocol Adapter.parseResponse → UnifiedResponse
  → 下游 Protocol Adapter.renderResponse
  → Usage 组装 → Queues 或 D1
  → 配额结算（TPM 修正、预算记录、释放并发租约）
```

### 3.2 流式

```text
上游 Response.body
  → createSseSource（可取消的字节读取）
  → Protocol Adapter.parseStream → UnifiedStreamEvent
  → 首事件探针（提交前允许故障转移）
  → 策略/Combo 执行器
  → 下游 Protocol Adapter.renderStream
  → ReadableStream<Uint8Array> → 客户端
```

一旦向客户端写出第一个字节，执行器视为已提交：后续错误只会生成协议错误事件并结束流，禁止切换上游或拼接输出。

## 4. 统一 IR

IR 定义在 `src/ir/`：

- `UnifiedRequest`：模型、系统指令、消息、工具、采样参数、结构化输出、推理配置、元数据、扩展参数、原始请求。
- `UnifiedMessage` / `UnifiedContentPart`：text、image、tool_call、tool_result、thinking、refusal。
- `UnifiedResponse`：内容块、统一 `StopReason`、`UnifiedUsage`。
- `UnifiedStreamEvent`：start、block_start、text_delta、thinking_delta、signature_delta、tool_input_delta、block_stop、finish、error、ping。
- `UnifiedTool` / `UnifiedToolCall` / `ModelCapabilities`。
- `UnifiedError`：错误码、上游状态、是否可重试、Retry-After。

流式事件采用 block 语义（对齐 Anthropic 的 content block），可以表达 thinking、文本与工具调用交错，再无损映射到 OpenAI chunk、Responses 事件与 Gemini parts。

## 5. 协议转换

每种协议实现一个 `ProtocolAdapter`，同时覆盖客户端方向与上游方向：

| 下游能力 | OpenAI Chat | OpenAI Responses | Anthropic | Gemini |
|----------|-------------|------------------|-----------|--------|
| 系统指令 | system/developer 消息 | instructions | system | systemInstruction |
| 图片 | image_url（URL/data URL） | input_image | base64/url/file | inlineData/fileData |
| 工具调用 | tool_calls | function_call item | tool_use | functionCall |
| 工具结果 | role=tool | function_call_output | tool_result | functionResponse |
| 推理 | reasoning_content 扩展 | reasoning item | thinking + signature | thought + thoughtSignature |
| 结构化输出 | response_format | text.format | 不支持 | responseMimeType/responseSchema |
| 结束原因 | finish_reason | status/incomplete_details | stop_reason | finishReason |
| Usage | prompt/completion tokens | input/output tokens | input/output/cache tokens | usageMetadata |

参数兼容策略：

- `strict`：无法表达的能力直接报错 `UNSUPPORTED_FEATURE`。
- `warn`（默认）：继续执行，记录 `CompatibilityIssue`，响应头 `x-fufu-warnings` 暴露摘要。
- `drop`：显式丢弃并记录。
- `passthrough`：仅同协议时保留厂商扩展字段；跨协议不会伪装成功。

同协议且策略为 `passthrough` 时，Provider Adapter 直接基于原始请求体构造上游请求（仅替换模型），失败/不满足条件时回退到 IR 序列化路径。

## 6. 路由引擎

解析顺序是固定的，禁止依赖配置遍历顺序：

1. `provider/model` 前缀精确匹配（Provider 只按名称匹配第一段）。
2. 原生模型精确匹配；唯一则路由，多条则 `MODEL_AMBIGUOUS`。
3. Alias / Combo 精确名称匹配（同一命名空间）。
4. Glob 通配符：
   - 排序：`priority` 降序 → 具体度（字面量多、通配符少、段数多）→ 规则 ID 升序。
   - 只支持 `*` 与 `?`，编译为锚定正则，不开放用户正则。
5. 未命中返回 `MODEL_NOT_FOUND`。

发布期冲突检测：Alias/Combo 与原生模型同名、Alias 与 Combo 同名、与 Provider 同名、非法 Pattern、目标不可解析、Combo 循环/深度/节点数超限。

权限约束在解析后应用：模型白名单与 Provider 白名单会过滤候选；Combo 在叶子执行时逐项校验。

## 7. Combo 引擎

### 7.1 归一化

配置态 Combo 在每次解析时归一化为 `ResolvedCombo` 树：

- 模型引用解析为 `ResolvedTarget`（含能力与价格）。
- Alias、Wildcard、嵌套 Combo 展开为内联节点。
- 节点保留 weight、priority、timeoutMs。
- 循环引用、深度、节点数在归一化阶段再次防御。

### 7.2 策略

每种策略独立实现 `ComboStrategy`：

| 策略 | 流式 | 选择方式 |
|------|------|----------|
| fallback | 是 | 配置顺序，可重试错误时切换 |
| priority | 是 | 优先级降序 |
| round_robin | 是 | Durable Object 原子游标 |
| weighted_round_robin | 是 | DO 中的平滑加权轮询状态 |
| random | 是 | 按权重随机 |
| lowest_latency | 是 | DO 中的 EWMA 延迟升序 |
| lowest_cost | 是 | 模型价格升序 |
| race | 是 | 并行，首个有效内容胜出，取消其余 |
| fusion | 否 | 并行收集候选，Judge Model 生成最终结果 |

顺序类策略只在错误可重试时继续下一个节点；不可重试错误立即结束。

### 7.3 资源限制与取消

- 每层 Combo 继承父级 `AbortSignal` 与绝对 deadline。
- 节点超时创建子 signal，超时映射为 `UPSTREAM_TIMEOUT`。
- Race/Fusion 并发受 `maxConcurrency` 与全局硬上限约束。
- 未胜出的并行请求必须取消；流式成功节点保持与父级取消链的连接。
- 执行树 `ComboTraceNode` 记录节点状态、尝试、耗时与子节点。

### 7.4 会话粘性

会话标识提取顺序：

1. `x-fufu-session-id` / `x-session-id`。
2. `metadata.session_id`（协议解析后归一化）。
3. `prompt_cache_key`。
4. `user` / `metadata.user_id`。
5. 可选：首条 user 消息哈希（仅当 Combo sticky 显式开启）。

粘性状态存放在按会话哈希分片的 Durable Object 中；失败时清除锁并重新选择；TTL 到期自动清理（DO alarm）。

## 8. 执行与高可用

- 每次尝试都重新构造上游请求体，避免复用已消费的 Body。
- 重试条件：配置的状态码、网络错误、首字节前超时；遵循 `Retry-After`；指数退避 + 全抖动。
- 账户池：优先启用、未冷却、未熔断的账户；按权重轮询；401/403 时轮换账户。
- 熔断器：Provider 下按 Account 与 Model 维度存储在 Durable Object，状态 CLOSED / OPEN / HALF_OPEN，支持冷却与半开探测。
- 总预算：请求 deadline 传播到所有子请求，重试前检查剩余时间。
- 流式重试只发生在首个内容到达前。

## 9. 流式引擎

`src/stream/sse.ts` 提供：

- 增量字节解码（TextDecoder stream 模式）。
- 跨 Chunk 的行与事件边界。
- CRLF / LF / CR 行结束符。
- 多行 `data`、注释心跳、`id`/`retry`。
- 事件大小与行长限制。
- 可取消的读取源：外部 `cancel()` 直接取消 reader，避免消费方阻塞在 `next()` 时无法退出。

`src/stream/sse-encoder.ts` 提供事件背压流与终端事件关闭；不会等待完整上游响应。

## 10. 配置发布

```text
D1 草稿数据
  → 构建 ConfigSnapshot
  → 校验（路由冲突、Combo 图、URL、价格、能力）
  → config_versions 写入 payload + checksum
  → KV config:snapshot:<version>
  → KV config:current 原子切换
  → Worker 隔离内缓存失效
```

- 无发布版本时回退到 D1 当前数据（内存缓存，最长 60 秒），便于首次启动。
- KV 故障时保持最后一次可用配置，避免切换到未发布数据。
- 回滚重新校验历史 payload 后切换指针。
- API Key 认证直接查询 D1，不经过配置快照。

## 11. Cloudflare 服务职责

| 服务 | 职责 |
|------|------|
| Worker | HTTP、认证、协议转换、路由、Combo、流式 |
| D1 | 用户、Key、Provider、账户、模型、路由配置、价格、配置版本、请求日志、日汇总、预算、审计 |
| KV | 配置快照与版本指针 |
| Durable Objects | 限流、并发租约、轮询游标、加权轮询、粘性会话、熔断、延迟 EWMA |
| Queues | Usage 异步落库（幂等，按 request_id 去重） |
| R2 | 日志归档（配置保留期时启用） |

DO 分片：

- `RateLimiterDO`：`key:{apiKeyId}`、`user:{userId}`。
- `CoordinationDO`：`combo:{comboId}`、`sticky:{sessionHash}`、`breaker:{providerId}`、`accounts:{providerId}`。

## 12. 用量与成本

- 上游返回 Usage 时记为 `source=upstream`；缺失时可估算，但必须标记 `estimated`，不混入真实统计。
- 费用按每百万 Token 计价，缓存输入与推理输出分别从输入/输出中拆出，避免重复计费。
- 请求日志写入 `request_logs`，并更新 `usage_rollups` 与 `budget_counters`。
- `route_trace` 保存路由轨迹与 Combo 执行树，写库前截断到 64 KiB。

## 13. 安全

- SSRF：HTTPS、端口 443、拒绝私有/环回/链路本地/元数据地址、拒绝 URL 凭据、拒绝重定向。
- Header：自定义头白名单校验，禁止认证头、Cookie、CF 头、转发头与 Host 等。
- API Key：高熵密钥 + 带固定域前缀的无盐 SHA-256 哈希；上游密钥 AES-GCM 或 Secret 引用。
- 请求体与 SSE 事件大小限制。
- 管理面与推理面独立鉴权；管理令牌支持常量时间比较，也支持 admin scope 的 API Key。
- 日志脱敏：认证头、API Key、Token、Secret 等字段与常见密钥模式。
- 配置校验在发布前执行，失败保持旧配置可用。

## 14. 扩展点

- 新增协议：实现 `ProtocolAdapter` 并注册到 `ProtocolRegistry`。
- 新增厂商传输：实现 `ProviderTransport` 并注册到 `ProviderTransportRegistry`。
- 新增 Combo 策略：实现 `ComboStrategy` 并注册到策略表。
- 新增管理实体：在 `admin/handlers` 增加路由与仓储，在 UI 的实体表中声明字段即可。
- 音频/视频/Embeddings/图像生成：预留协议与 Provider 接口，未在第一版实现。

## 15. 明确限制

见 README「已知限制」。核心原则：无法表达的协议能力必须报错或记录丢弃，禁止静默丢弃或伪造成功结果。
