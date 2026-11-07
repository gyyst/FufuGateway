# 集成测试补齐设计

## 1. 测试边界

```text
Test Client
   │  HTTP (app.fetch)
   ▼
FufuGateway (createApp)
   │  FetchLike 注入
   ▼
Mock Upstream (按厂商协议返回 JSON / SSE)
```

- 入口统一使用 `createApp({ fetchImpl })`，测试通过 `app.fetch(Request, env, ctx)` 调用，覆盖 Hono 中间件、认证、路由、协议转换、执行器、用量记录。
- 上游只 mock `FetchLike`，不 mock 网关内部模块；断言基于下游 HTTP 响应、上游收到的真实 Request 以及 D1 中用户可见的记录。
- 使用 `@cloudflare/vitest-plugin` 提供的真实本地 D1/KV/DO；每个测试文件独立存储，避免跨文件污染。
- `USAGE_MODE=direct` 已由 `vitest.config.ts` 设置，用量写入可在 `waitOnExecutionContext` 后直接查询。

## 2. 测试基础设施

新增 `test/integration/support.ts`：

- `createHarness()`：创建应用、捕获上游请求、提供 `setUpstream` / `call` / `admin`。
- `createProvider` / `createModel` / `createUser` / `createApiKey` / `publishConfig`：全部通过管理 API 完成，模拟真实初始化流程。
- `jsonResponse` / `sseResponse`：构造标准 JSON 与 SSE 上游响应。
- 四协议非流式 fixture：OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini generateContent。
- 流式 fixture：OpenAI Chat、OpenAI Responses、Anthropic、Gemini SSE。
- 只抽取重复度高的脚手架，测试场景与断言保留在各测试文件中，避免“测试生成器”掩盖场景。

## 3. 文件与场景映射

### `test/integration/protocol-matrix.test.ts`

4×4 非流式矩阵，共 16 个用例。

- 上游：`chat-up` / `resp-up` / `anth-up` / `gem-up`，各自返回厂商原生结构与不同 Usage。
- 下游：Chat / Responses / Anthropic / Gemini 请求构造器与响应提取器。
- 断言：文本、Usage 数值、`x-fufu-provider`、上游 URL、认证头、上游 `model`（Gemini 为路径模型）。

### `test/integration/protocol-features.test.ts`

- Responses 客户端 → Responses 上游流式：`response.output_text.delta`、`response.completed`、Usage。
- Gemini 客户端 → Gemini 上游流式：上游 `alt=sse`、下游 candidates/usageMetadata。
- Anthropic `count_tokens`：本地估算、`x-fufu-usage-source: estimated`、不请求上游。
- OpenAI Chat 工具调用往返：请求 tools，上游返回 tool_calls，下游保留函数名/参数。
- OpenAI Chat 图片 → Anthropic 上游：验证 base64 图片转换。
- JSON Schema 跨协议到 Anthropic：`x-fufu-warnings` 暴露 `response_format:dropped`，上游不携带该参数。
- 四种协议错误渲染：模型不存在时返回各自协议错误结构。

### `test/integration/authz.test.ts`

- 模型白名单、Provider 白名单、无 inference scope、过期 Key、禁用用户、删除/篡改 Key。
- 管理面：管理员 API Key 可用，普通 Key 拒绝。
- Gemini query key、Anthropic Bearer 兼容凭据。
- 模型目录按白名单过滤（OpenAI 与 Gemini 目录）。

### `test/integration/admin-lifecycle.test.ts`

- Provider CRUD 与 URL/类型校验（http、私网、URL 凭据、非法自定义头）。
- 模型 CRUD、价格覆盖 CRUD、账户删除、用户 CRUD、API Key 删除。
- Provider 删除级联与发布后路由消失。
- 配置 current 待发布、validate、重复发布、版本列表、回滚。
- 审计日志内容、管理健康、熔断状态。

### `test/integration/routing-combos.test.ts`

- glob 命中、精确名称优先、glob priority/具体度。
- priority 策略、weighted_round_robin 权重分布、lowest_cost 选择。
- 禁用 Combo 不可路由。
- `validate` 捕获 fusion 缺少 judge；`preview` 展示解析后的节点目标。

### `test/integration/usage-reporting.test.ts`

- 上游无 Usage 时不伪造 upstream 用量。
- 上游错误返回时写入 error 请求日志。
- 用量汇总按 provider/model/apiKey 过滤，按 week/month 聚合。
- 请求日志 limit 与 `before` 游标。
- 审计日志不包含明文密钥（与 admin-lifecycle 的审计用例互补）。

### `test/integration/cors.test.ts`

- 未配置允许来源时预检返回 403。
- 保存并发布 `cors.allowed_origins` 后，允许来源预检 204、实际推理响应带 CORS 头；未允许来源仍 403。

## 4. 状态与隔离策略

- 每个文件在 `beforeAll` 创建自己的 Provider/模型/用户/Key，使用唯一名称前缀。
- 会修改全局配置（settings、删除 Provider）的用例放在独立文件，避免影响同文件其他场景。
- 需要断言配置发布状态的用例自行发布并读取 `current`，不依赖其他文件的版本号。
- 时间相关断言使用容差或只断言字段存在；Combo 超时/并发使用足够大的余量，避免 CI 抖动。
- 对流式响应统一 `await response.text()` 后做包含断言，避免逐块读取的时序差异。

## 5. 断言原则

- 优先断言用户可观察结果：HTTP 状态、协议字段、错误码、响应头、上游收到的请求。
- 不直接断言内部 trace 结构、函数调用次数（除非是上游请求次数这类产品语义）。
- D1 断言仅用于验证用量/审计等“管理端可见”的结果。
- 对文档明确声明的兼容行为（警告头、协议错误结构、权限错误码）做断言。
- 若实际行为与 README 描述不一致，以“不伪造成功/不泄露密钥/权限默认拒绝”为优先，记录差异而不强行通过。

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| 测试文件间配置缓存/DO 状态串扰 | 每文件独立 Worker 存储；配置修改后立即发布；不跨文件依赖 |
| SSE 时序不稳定 | 上游流一次性写入并关闭，下游整体读取 |
| 权重/轮询策略分布断言抖动 | 断言计数而非严格顺序 |
| 日期/时区导致用量聚合差异 | 使用固定 `startedAt` 写入汇总，查询范围覆盖固定日期 |
| 共享 helper 变成“按实现写测试” | helper 只封装 HTTP 调用与厂商 wire fixture，场景断言留在测试文件 |
| 新测试暴露产品缺陷 | 记录到任务 notes；只做最小必要修复并单独说明，不静默放宽断言 |

## 7. 验证

```bash
npm run typecheck
npm test
npx vitest run test/integration/protocol-matrix.test.ts
npx vitest run test/integration/protocol-features.test.ts
npx vitest run test/integration/authz.test.ts
npx vitest run test/integration/admin-lifecycle.test.ts
npx vitest run test/integration/routing-combos.test.ts
npx vitest run test/integration/usage-reporting.test.ts
npx vitest run test/integration/cors.test.ts
```
