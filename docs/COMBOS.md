# Combo 编排

Combo 是由多个节点组成的虚拟模型。节点可以是 Provider 模型、Alias、嵌套 Combo 或内联组合。名称含 `*` 或 `?` 的 Combo 同时承担通配符路由。执行时按策略选择、并发或故障转移。

## 1. 配置结构

```json
{
  "name": "coding-combo",
  "description": "编码任务首选组合",
  "strategy": "fallback",
  "priority": 100,
  "nodes": [
    { "model": "openai/gpt-5", "weight": 1, "priority": 100, "timeoutMs": 60000 },
    { "combo": "cheap-combo" },
    { "model": "anthropic/claude-sonnet-4-5", "strategy": "fallback" }
  ],
  "timeoutMs": 120000,
  "maxConcurrency": 4,
  "sticky": {
    "enabled": true,
    "ttlSeconds": 600,
    "mode": "round_robin",
    "hashFirstUserMessage": false
  },
  "judgeModel": "openai/gpt-5-mini",
  "enabled": true
}
```

节点简写：

- 字符串：等价于模型引用，例如 `"openai/gpt-5"`。
- 对象：`{ "model": "..." }`、`{ "alias": "..." }`、`{ "combo": "..." }`。旧配置中的 `{ "wildcard": "claude-*" }` 仍兼容，等价于引用同名 glob Combo。
- 对象可附带 `weight`、`priority`、`timeoutMs`、`maxRetries`、`strategy`（覆盖该节点的调度策略）。
- `maxRetries` 作用于模型叶子节点，覆盖该节点所属 Provider 的重试次数（上限 10）。

## 2. 策略

| 策略 | 流式 | 行为 |
|------|------|------|
| `fallback` | 支持 | 按配置顺序尝试；仅可重试错误切换 |
| `priority` | 支持 | 按节点优先级降序尝试 |
| `round_robin` | 支持 | Durable Object 原子游标轮询 |
| `weighted_round_robin` | 支持 | 平滑加权轮询（SWRR） |
| `random` | 支持 | 按权重随机选择起点 |
| `lowest_latency` | 支持 | 读取近期 EWMA 延迟，升序尝试 |
| `lowest_cost` | 支持 | 按模型价格（输入+输出）升序尝试 |
| `race` | 支持 | 并行请求，首个有效内容胜出，取消其余 |
| `fusion` | 不支持 | 并行收集候选，Judge Model 生成最终结果 |

顺序类策略在失败后是否继续，取决于统一错误码的 `retriable`。不可重试错误（例如参数错误、模型不存在）会立即结束，避免无意义切换。

### Race

- 参与节点并行执行，受 `maxConcurrency` 限制。
- 流式时首个产生有效内容的节点胜出。
- 胜出后取消其他节点；已经返回的流式失败结果会被主动释放。

### Fusion

- 仅非流式。流式请求返回 `UNSUPPORTED_FEATURE`。
- 必须配置 `judgeModel`，否则发布校验失败。
- 候选结果会拼接为 Judge Prompt，由 Judge Model 生成最终答案。
- 候选与 Judge 的 Token 费用目前只记录最终响应的 Usage；候选调用成本未并入单次统计（列为限制）。

## 3. glob Combo 与 Alias 节点

Combo 节点可以引用其他 Combo 或 Alias，发布/解析时展开：

- Alias 指向模型 → 模型节点。
- Alias 指向 Combo → 嵌套 Combo 节点。
- Combo 引用 → 嵌套 Combo 节点，策略取被引用 Combo。
- 名称含 `*` 或 `?` 的 Combo 是 glob 模式：可作为路由入口按 pattern 命中，也可被其他 Combo 以 `{ "combo": "pattern" }` 引用。
- 精确 Combo 名称优先于所有 glob Combo；glob Combo 之间按 `priority` 降序、具体度、ID 排序。

## 4. 会话粘性

```json
{
  "sticky": {
    "enabled": true,
    "ttlSeconds": 600,
    "mode": "round_robin",
    "hashFirstUserMessage": false
  }
}
```

会话标识提取链：

1. `x-fufu-session-id` / `x-session-id`
2. `metadata.session_id`
3. `prompt_cache_key`
4. `user` / `metadata.user_id`
5. 首条 user 消息哈希（仅当 `hashFirstUserMessage=true`）

行为：

- 同一会话优先使用上次成功的节点。
- 节点失败时清除会话锁，重新选择并写入新锁。
- TTL 到期由 Durable Object alarm 清理。
- `race` / `fusion` 不写入粘性，避免破坏并行语义。
- `mode=first_available` 与 `round_robin` 目前均表现为“粘性优先 + 失败后重新选择”；健康状态（熔断）会在选择时过滤不可用账户/模型。

## 5. 资源限制

| 限制 | 默认 | 配置 |
|------|------|------|
| 最大嵌套深度 | 16 | 系统设置 `limits.max_combo_depth` |
| 最大展开节点数 | 256 | `limits.max_combo_nodes` |
| 最大并发 | 8 | Combo `maxConcurrency`，硬上限 32 |
| Combo 整体超时 | 无 | `timeoutMs` |
| 节点超时 | 继承 | 节点 `timeoutMs` |
| 请求总预算 | 300s | `timeouts.request_ms` |

循环引用在发布校验与运行期归一化两处检测。

## 6. 执行树

每次执行都会生成 `ComboTraceNode`：

```json
{
  "id": "cmbtrc_...",
  "kind": "combo",
  "label": "coding-combo",
  "status": "ok",
  "startedAt": 1700000000000,
  "finishedAt": 1700000001200,
  "attempts": [],
  "children": [
    {
      "kind": "model",
      "label": "openai/gpt-5",
      "status": "failed",
      "attempts": [
        { "index": 0, "status": 429, "durationMs": 120, "errorCode": "UPSTREAM_RATE_LIMITED" }
      ],
      "children": []
    },
    {
      "kind": "model",
      "label": "anthropic/claude-sonnet-4-5",
      "status": "ok",
      "attempts": [
        { "index": 0, "status": 200, "durationMs": 900 }
      ],
      "children": []
    }
  ]
}
```

执行树会写入请求日志的 `route_trace`，可通过 `GET /admin/requests/:id` 查看。

## 7. 流式约束

- 在向客户端写出第一个字节前，允许节点切换与故障转移。
- 一旦提交，后续错误只能生成协议错误事件，禁止拼接其他模型的内容。
- `fusion`、以及任何不支持流式的自定义策略，会在打开上游前返回错误。

## 8. 示例

### 编码组合

```json
{
  "name": "coding-combo",
  "strategy": "fallback",
  "nodes": [
    "openai/gpt-5",
    "anthropic/claude-sonnet-4-5",
    { "combo": "cheap-combo" }
  ]
}
```

### 加权低成本组合

```json
{
  "name": "cheap-combo",
  "strategy": "weighted_round_robin",
  "nodes": [
    { "model": "google/gemini-2.5-flash", "weight": 70 },
    { "model": "openai/gpt-5-mini", "weight": 30 }
  ]
}
```

### Race

```json
{
  "name": "fastest",
  "strategy": "race",
  "maxConcurrency": 3,
  "nodes": [
    "openai/gpt-5",
    "anthropic/claude-sonnet-4-5",
    "google/gemini-2.5-pro"
  ],
  "timeoutMs": 60000
}
```

### Fusion

```json
{
  "name": "best-answer",
  "strategy": "fusion",
  "judgeModel": "openai/gpt-5-mini",
  "maxConcurrency": 2,
  "nodes": [
    "openai/gpt-5",
    "anthropic/claude-sonnet-4-5"
  ]
}
```

### 嵌套 + 粘性

```json
{
  "name": "main-combo",
  "strategy": "fallback",
  "sticky": { "enabled": true, "ttlSeconds": 600, "mode": "round_robin" },
  "nodes": [
    "coding-combo",
    { "combo": "premium-combo" },
    "openai/gpt-5"
  ]
}
```

## 9. 管理与校验

- 创建/更新：`POST /admin/combos`、`PUT /admin/combos/:id`
- 校验：`POST /admin/combos/:id/validate`，返回与 Combo 相关的发布校验问题。
- 预览：`POST /admin/combos/:id/preview`，逐节点展示解析后的目标与策略。
- 管理界面：`/ui` → Combo 页面，支持 JSON 节点编辑、校验与预览。
- 发布：在「配置与审计」发布后才会影响推理流量。
