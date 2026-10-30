# 部署指南

## 1. 前置条件

- Cloudflare 账号，已启用 Workers、D1、KV、Durable Objects。
- Queues 与 R2 为可选能力，取决于账号计划；不使用时可从 `wrangler.jsonc` 删除对应绑定。
- Node.js 20+，Wrangler 4.x。

## 2. 创建 Cloudflare 资源

```bash
npx wrangler login

npx wrangler d1 create fufu-gateway
npx wrangler kv namespace create CONFIG_KV

# 可选：异步 Usage 与日志归档
npx wrangler queues create fufu-usage
npx wrangler queues create fufu-usage-dlq
npx wrangler r2 bucket create fufu-gateway-archive
```

将输出写入 `wrangler.jsonc`：

- D1 的 `database_id`
- KV 的 `id`

仓库中的 `00000000-0000-0000-0000-000000000000` 与 `00000000000000000000000000000000` 是本地开发占位值，**部署前必须替换**。

## 3. 配置 Secrets

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put API_KEY_PEPPER
npx wrangler secret put ENCRYPTION_KEY
```

生成 `ENCRYPTION_KEY`：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Secret | 用途 |
|--------|------|
| `ADMIN_TOKEN` | 管理 API 与 `/ui` 登录 |
| `API_KEY_PEPPER` | 下游 API Key 哈希 |
| `ENCRYPTION_KEY` | 上游 API Key AES-256-GCM 加密 |

生产环境不要复用示例值，也不要提交 `.dev.vars`。

## 4. 执行 D1 迁移

```bash
npm run db:migrate:remote
```

本地：

```bash
npm run db:migrate:local
```

迁移文件按编号执行，包含建表、索引、默认设置与用户级限流字段。

## 5. 部署

```bash
npm run typecheck
npm test
npm run deploy:dry-run
npm run deploy
```

`deploy:dry-run` 会验证 Worker、Durable Object、队列、R2 与静态资源打包。

## 6. 绑定说明

| 绑定 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `DB` | D1 | 是 | 主数据与日志 |
| `CONFIG_KV` | KV | 是 | 配置快照与版本指针 |
| `RATE_LIMITER` | Durable Object | 是 | 限流与并发租约 |
| `COORDINATION` | Durable Object | 是 | 轮询、粘性、熔断、延迟 |
| `USAGE_QUEUE` | Queue | 可选 | Usage 异步落库 |
| `ARCHIVE_BUCKET` | R2 | 可选 | 日志归档 |

不使用 Queues 时：

1. 删除 `wrangler.jsonc` 中的 `queues` 配置。
2. 设置 `vars.USAGE_MODE = "direct"`，或删除 `USAGE_MODE` 并保持无队列绑定（网关会自动直写 D1）。
3. 保留 D1 的 `request_logs` 与汇总表。

不使用 R2 时：删除 `r2_buckets` 配置，定时任务会直接删除过期日志。

## 7. 首次配置流程

1. 访问 `https://<worker-domain>/ui`，使用 `ADMIN_TOKEN` 登录。
2. 创建用户与 API Key。
3. 创建 Provider 与账户。
4. 创建模型并确认能力与价格。
5. 配置 Alias / 通配符 / Combo。
6. 「配置与审计」→ 发布配置。
7. 使用客户端 SDK 调用推理入口。

首次发布前，网关在没有 KV 当前版本时会回退到 D1 数据（内存缓存 60 秒），但仍然建议显式发布。

本地开发如需访问 `http://localhost` 或私有地址的上游，可在 `.dev.vars` 中设置 `ALLOW_PRIVATE_UPSTREAMS=true`；生产环境不要启用。

## 8. 运维

### 健康检查

- `GET /health`：进程存活。
- `GET /health/ready`：D1、KV、Durable Object 检查。
- `GET /admin/health`：数据库、配置状态。
- `GET /admin/health/breakers`：Provider/Account/Model 熔断状态。

### 日志与追踪

- 每个请求包含 `x-request-id` 与 `x-trace-id`。
- 请求日志、执行树与费用在 `/admin/requests/:id` 查看。
- Worker 日志通过 `npx wrangler tail` 或 Dashboard 查看。
- 日志默认脱敏认证头、Key、Token、Secret 与常见密钥模式。

### 保留期

系统设置 `logging.retention_days` 控制请求日志保留天数（默认 30，最大 3650）。

定时任务每天执行：

- 有 R2：先批量归档为 JSONL，再删除已归档日志（每批 1000 条）。
- 无 R2：直接删除过期日志。
- 同时清理超过 365 天的日汇总。
- 对 `extraConfig.autoSyncModels=true` 的 Provider 执行模型同步（新模型默认禁用）。

### 队列

- `fufu-usage` 消费失败会重试，超过重试次数进入 `fufu-usage-dlq`。
- 消费者按 `request_id` 幂等去重，可安全重放。
- 检查 DLQ 可发现持续写入失败的架构问题。

### 配置发布与回滚

- 发布：Admin UI 或 `POST /admin/config/publish`。
- 校验：`POST /admin/config/validate`。
- 回滚：`POST /admin/config/rollback` 指向历史版本。
- 发布失败时旧配置保持生效。
- 配置传播最长约 60 秒；API Key 吊销直读 D1，立即生效。

## 9. 升级流程

```bash
git pull
npm install
npm run typecheck
npm test
npm run db:migrate:remote
npm run deploy
```

先迁移后部署，确保新代码需要的新列已存在。回滚 Worker 代码时注意迁移通常向前兼容；需要回滚数据库结构时请使用 D1 Time Travel 或备份。

## 10. 故障排查

| 现象 | 排查 |
|------|------|
| `/admin` 返回 503 | 未配置 `ADMIN_TOKEN` |
| 部署提示 D1/KV 不存在 | 占位 ID 未替换 |
| 推理 401 | Key 被禁用/过期/轮换后旧 Key |
| 推理 503 `PROVIDER_UNAVAILABLE` | 无可用账户、账户冷却或熔断打开 |
| 模型路由 409 | 同名模型存在于多个 Provider，使用前缀或 Alias |
| 配置发布 400 | 查看 `/admin/config/validate` 的问题列表 |
| 修改配置 60 秒内未生效 | 未发布，或 KV 指针/缓存 TTL |
| 上游请求被拒绝 | baseUrl 不是 HTTPS、包含私有地址/端口或重定向 |
| Usage 未落库 | 队列消费失败；查看 DLQ，或临时设置 `USAGE_MODE=direct` |
| 管理界面静态资源 404 | `assets.directory` 未指向 `./public` 或部署未上传 assets |

## 11. 生产建议

- 使用 `secretRef` 引用上游密钥，而不是通过管理 API 上传明文。
- 为管理令牌使用独立的高熵值，并限制管理入口访问范围。
- 为 API Key 设置模型白名单、RPM/TPM、并发与预算。
- 为 Provider 配置 `extraConfig.breaker`，避免故障上游持续消耗请求。
- 开启 Queues 与 R2 归档，并监控 DLQ。
- 定期检查 `/admin/health/breakers` 与 5xx/429 比例。
- 不要在日志中开启完整请求体记录；网关默认不记录正文。
