# 移除 API_KEY_PEPPER，下游 Key 改为固定域前缀哈希

## Goal

彻底移除 `API_KEY_PEPPER` 部署 Secret 及其全部代码依赖，下游 API Key 改用无盐但带固定域前缀的 SHA-256 哈希进行存储与校验。`ENCRYPTION_KEY`、数据库 schema 与前端管理台保持不变。

## Background

- 当前 `hashApiKey` 使用 `SHA-256(pepper + ":" + apiKey)`（`src/auth/api-key.ts:44`），pepper 缺失时认证与 Key 创建直接报 `INTERNAL_ERROR`（`src/auth/middleware.ts:18`、`src/admin/handlers/keys.ts:40`）。
- 下游 Key 是 `fufu_sk_` 加 32 字节密码学随机值（256 bit 熵），本身不可穷举，pepper 的边际安全价值有限，却增加一处必配 Secret。
- 用户已确认移除，并接受现存 Key 全部失效。

## Requirements

### R1. 哈希算法

- `hashApiKey(apiKey)` 只接收一个参数，计算 `SHA-256("fufu_api_key:" + apiKey)`，输出 64 位十六进制字符串。
- 保留固定域前缀 `fufu_api_key:` 作为领域分隔，避免与其他用途的 SHA-256 摘要复用。

### R2. Key 生成

- `generateApiKey()` 不再接收参数，内部调用无参 `hashApiKey`。
- 返回结构（`plaintext` / `prefix` / `hash`）保持不变。

### R3. 认证链路

- `authenticateCredential` 删除 pepper 存在性检查，直接对 credential 计算哈希后查询 `key_hash`。
- `requireAdmin` 的管理员 API Key 分支行为不变。

### R4. 管理端 Key 创建与轮换

- 删除 `src/admin/handlers/keys.ts` 中的 `pepper()` 函数及其在 `createApiKeyHandler`、`rotateApiKeyHandler` 的调用。

### R5. 健康检查与配置

- `src/admin/handlers/setup.ts` 的 `secrets` 对象移除 `apiKeyPepper` 字段；`secretsComplete` 改为 `adminToken && encryptionKey`；`missingSecrets` 与步骤文案同步移除 `API_KEY_PEPPER`。
- `src/env.ts` 删除 `API_KEY_PEPPER` 声明。
- 删除 `.dev.vars.example`、`README.md`、`docs/DEPLOY.md`、`docs/API.md` 中的对应条目与示例字段。

### R6. 测试

- `vitest.config.ts` 删除 `API_KEY_PEPPER` 绑定。
- 6 个集成测试（gateway、cross-protocol、streaming、config、combo、resilience）改为无参 `generateApiKey()`，并删除 pepper 缺失断言。

## Non-Goals

- 不修改 `ENCRYPTION_KEY` 及其加解密逻辑。
- 不新增数据库 migration，不吊销或改写现存 `api_keys` 记录。
- 不修改数据库 schema、`key_hash` 列或前端管理台。
- 不处理历史任务文档（`.trellis/tasks/10-31-*`、`PLAN.md`）。

## Acceptance Criteria

- [ ] 全仓库检索 `API_KEY_PEPPER`、`apiKeyPepper`、`test-api-key-pepper`、`change-me-api-key-pepper` 仅剩历史任务文档与 `PLAN.md` 命中。
- [ ] 未配置 `API_KEY_PEPPER` 时，创建下游 Key、认证推理请求、`/admin/setup` 状态查询均不再报错。
- [ ] `generateApiKey()` 产出的 `hash` 等于 `SHA-256("fufu_api_key:" + plaintext)`。
- [ ] `/admin/setup` 的 `secrets` 只包含 `adminToken` 与 `encryptionKey`，`readyForInference` 不再依赖 pepper。
- [ ] `npm run typecheck`、`npm run lint`、`npm test` 通过（以项目实际脚本为准）。
- [ ] 部署文档明确提示：升级后所有旧下游 Key 失效，需要重新签发。

## Decisions

- 2026-11-01：旧 Key 数据库记录保留原状态（不新增 migration、不批量置 revoked），仅在部署文档说明需重新签发。
- 2026-11-01：无盐哈希保留固定域前缀 `fufu_api_key:`，成本为零且避免跨用途摘要复用。

## Notes

- 旧 `key_hash` 无法重算，升级后旧 Key 认证必然失败，这是移除 pepper 的固有代价。
- 本任务为轻量任务，PRD-only，不额外编写 `design.md` / `implement.md`。
