# FufuGateway

基于 Cloudflare Workers 的多协议 AI Token Gateway。统一接入 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Google Gemini，提供多上游管理、模型路由、Combo 编排、负载均衡、故障转移、流式转换、用量与成本统计。

项目不是简单反向代理：请求会先转换为与协议无关的 IR，再经路由引擎与 Combo 执行引擎选择上游，最后由目标协议 Adapter 生成上游请求；响应沿相反方向转换回客户端协议。

## 能力概览

| 能力 | 状态 |
|------|------|
| 下游协议入口 | OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini |
| 上游协议 | 同上，任意组合交叉转换 |
| 模型路由 | Provider 前缀、原生模型、歧义检测、Combo（精确 / 通配符） |
| Combo 策略 | fallback、round_robin、weighted_round_robin、random、priority、lowest_latency、lowest_cost、race、fusion |
| 高可用 | 重试、指数退避、Retry-After、首 Token/空闲/总超时、熔断、账户轮换 |
| 流式 | 字节级增量 SSE、任意 Chunk 切分、UTF-8 边界、取消传播、流内错误事件 |
| 认证与配额 | API Key / 用户权限、模型与 Provider 白名单、RPM、TPM、并发、日/月预算 |
| 用量 | 真实/估算 Usage 分离、缓存与推理 Token 计价、日/周/月汇总、请求执行树 |
| 管理 | 完整 Admin API、配置版本发布/回滚、审计日志、可写管理界面 `/ui` |
| 初始化引导 | Provider 预设、快速开始清单、路由诊断、网关自测、客户端接入页 |

## 架构

```text
客户端（OpenAI / Anthropic / Gemini SDK）
        │
        ▼
API Gateway（Hono）
  ├─ 认证与权限（D1 直读，吊销立即生效）
  ├─ 限流与预算（Durable Objects）
  ├─ 下游 Protocol Adapter ──► Unified IR
  ├─ Router Engine（前缀 → 原生 → Combo → Glob）
  ├─ Combo Engine（策略、嵌套、粘性、执行树）
  ├─ Provider Engine（账户、认证、端点、重试、熔断）
  ├─ 上游 Protocol Adapter ──► 各厂商 HTTP/SSE
  └─ Usage Engine（Queues → D1 日志与汇总）
```

配置通过「D1 → 校验 → 版本快照 → KV 原子指针」发布，Worker 隔离内缓存最多 60 秒；API Key 吊销不依赖缓存。

## 环境要求

- Node.js 20+
- Cloudflare 账号（Workers、D1、KV、Durable Objects、Queues；R2 可选）
- Wrangler 4.x

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

默认地址 `http://localhost:8787`。

`.dev.vars` 至少需要：

```dotenv
ADMIN_TOKEN=change-me-admin-token
```

升级到本版本后，下游 API Key 的哈希算法改为带固定域前缀的无盐 SHA-256，旧 Key 的哈希无法重算，所有已有下游 Key 会失效，需要在管理台重新签发。

上游账户通过管理台提交的 `apiKey` 现在以明文存入 D1（`provider_accounts.api_key_plain`），并会进入配置快照与 KV。生产环境建议使用 `secretRef` 引用 Worker Secret，避免明文落库；升级后历史 `api_key_enc/iv/tag` 密文不再可用，需要重新录入上游 Key 或改用 `secretRef`。

### 首次配置

1. 打开 `http://localhost:8787/ui`，使用 `ADMIN_TOKEN` 登录。
2. 进入「快速开始」，按清单完成 Secrets、Provider、账户、模型、发布和 API Key。
3. 在「Provider」点击「从预设添加」，选择火山方舟、华为云 MaaS、OpenAI、Anthropic、Gemini、DeepSeek、Kimi、GLM、Qwen、OpenRouter 等预设，或填写自定义兼容端点。
4. 添加账户。生产环境建议使用 Worker Secret 的 `secretRef`，不要通过页面保存明文密钥。
5. 同步上游模型或手动添加模型。同步结果默认禁用，必须编辑并确认能力后再启用。
6. 在「配置与审计」点击「发布配置」。
7. 在「用户」创建用户，在「API Key」创建下游 Key（明文只显示一次）。
8. 在「路由诊断」解析模型并运行网关自测；自测会产生真实上游费用，输出限制为 32 Token。
9. 在「客户端接入」复制 Base URL、环境变量或 SDK 示例。

发布前网关也可回退使用 D1 当前配置，但推荐显式发布。Provider 没有账户、模型全部禁用或配置未发布时，快速开始页会给出对应提示。

### 客户端接入

管理台「客户端接入」会根据当前域名生成四种协议的 Base URL、认证头、环境变量和代码片段。下面是本地开发示例。

OpenAI SDK：

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "fufu_sk_...",
  baseURL: "http://localhost:8787/v1",
});

const response = await client.chat.completions.create({
  model: "openai/gpt-5", // 或唯一模型 ID / Combo
  messages: [{ role: "user", content: "hello" }],
});
```

OpenAI Responses API 使用同一客户端：

```ts
const response = await client.responses.create({
  model: "openai/gpt-5",
  input: "hello",
});
```

Anthropic SDK：

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: "fufu_sk_...",
  baseURL: "http://localhost:8787", // SDK 会追加 /v1/messages
});

const message = await client.messages.create({
  model: "anthropic/claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hello" }],
});
```

Gemini HTTP：

```bash
curl http://localhost:8787/v1beta/models/google/gemini-2.5-pro:generateContent \
  -H "x-goog-api-key: $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}'
```

流式：

```bash
curl -N http://localhost:8787/v1/chat/completions \
  -H "authorization: Bearer $FUFU_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-5","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

## 测试

```bash
npm run typecheck
npm test
npm run deploy:dry-run
```

测试运行在 Cloudflare Workers Runtime 中，使用真实本地 D1/KV/Durable Objects/Queues，并通过注入 `FetchLike` 模拟上游，不访问任何付费 API。覆盖：

- 4×4 协议请求与响应交叉转换、工具调用、多模态、Usage、错误映射。
- SSE 任意字节切分、CRLF/LF、多行 data、UTF-8 跨 Chunk、取消传播。
- 路由优先级、歧义、Combo（含通配符）、权限过滤。
- Combo 全部策略、嵌套、循环、深度/节点限制、粘性、流式不可拼接。
- 重试、账户轮换、熔断、首 Token/空闲超时。
- API Key 生命周期、RPM/TPM/并发/预算、用量幂等与汇总。
- Provider 预设与版本路径拼接、快速开始状态、路由解析、网关自测、初始化端到端。

## 目录结构

```text
src/
  core/          错误、ID、日志、脱敏、时间与限制
  ir/            统一请求/响应/流事件/Usage/能力模型
  protocol/      四种协议的请求、响应、流、错误转换
  providers/     上游传输、认证、端点与模型同步
  router/        Glob、优先级解析、权限约束
  combo/         归一化、执行器、策略、会话粘性、Durable Object 协调
  execution/     单次上游调用、重试、超时、熔断、账户池
  stream/        SSE 解析、编码与可取消流
  config/        D1 仓储、快照校验、KV 发布、回滚
  auth/          API Key 哈希、用户与鉴权中间件
  ratelimit/     限流 DO 客户端
  usage/         计价、异步落库、队列消费者
  admin/         管理 API
  gateway/       推理入口、配额、Usage 组装、错误渲染
  durable-objects/
  ui/            /ui 外壳
public/ui-static/  零构建管理界面
migrations/        D1 迁移
test/              单元与集成测试
docs/              架构、API、Provider、Combo、部署文档
```

## 文档

- [架构设计](docs/ARCHITECTURE.md)
- [API 参考](docs/API.md)
- [Provider 配置](docs/PROVIDERS.md)
- [Combo 配置](docs/COMBOS.md)
- [部署指南](docs/DEPLOY.md)

## 安全要点

- 下游 API Key 只存 `SHA-256("fufu_api_key:" + key)` 与前缀，明文仅创建/轮换时返回一次。
- 上游 API Key 通过 `apiKey` 提交时以明文存入 D1（并进入配置快照与 KV）；生产环境推荐通过 `secretRef` 引用 Worker Secret。
- 任何能读取 D1、配置快照或 KV 的凭据都能直接获得明文上游 Key；请限制 Cloudflare 账户与数据库访问，并及时清理历史配置版本。
- 客户端 `Authorization` / `x-api-key` 永不透传；上游认证由 Provider Adapter 重建。
- 上游地址仅允许管理员配置，强制 HTTPS、拒绝私有/环回/元数据地址与重定向。
- 请求体默认限制 4 MiB，SSE 单事件默认限制 1 MiB。
- 日志与执行树不记录完整 Key、认证头或请求正文。

## 已知限制

1. `fusion` 仅支持非流式；流式请求返回 `UNSUPPORTED_FEATURE`。
2. 跨协议推理签名不能伪造：目标协议要求签名但源数据没有签名时，按兼容策略降级为文本或报错，并记录 `CompatibilityIssue`。
3. Anthropic 目标协议暂不支持 JSON Schema 结构化输出。
4. Gemini 输入图片支持 base64 数据 URL；任意公网 URL 不会由网关抓取（避免 SSRF），请在客户端转为 base64。
5. 限流作用于 API Key 与用户；Provider / Model / Combo 维度的独立限流配置未在第一版提供。
6. TPM 使用请求前估算、请求后按真实 Usage 修正；并发租约 TTL 为 10 分钟。
7. 配置发布传播最长约 60 秒；API Key 禁用/吊销直读 D1，立即生效。
8. 预算使用 Durable Object 缓存并从 D1 播种；极端故障切换时可能出现少量超额。
9. `count_tokens` 为本地估算，且音频/视频/Embeddings/图像生成 API 未实现。
10. 推理端 CORS 默认关闭；仅当系统设置 `cors.allowed_origins` 明确包含来源时才返回 CORS 头。
11. 厂商扩展参数（如 Gemini safetySettings、OpenAI service_tier）只在同协议且 `passthrough` 策略下原样保留；其他策略会记录为丢弃。
12. 跨协议转换到 Anthropic 且未提供 `max_tokens` 时默认 4096，并记录默认值兼容性问题。
13. Durable Object 限流/熔断协调层不可用时采取 fail-open（放行），D1 认证仍会拦截无效 Key。
