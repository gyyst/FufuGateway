# 移除 ENCRYPTION_KEY 并改为明文存储上游 API Key

## Goal

删除 `ENCRYPTION_KEY` 部署 Secret 和整套上游凭据对称加密逻辑，把通过 `apiKey` 创建的上游账户密钥以明文存入 D1；同时保留 `secretRef`（Worker Secret 引用）作为可选的安全方案。

## Background

2026-11-01 在 Cloudflare Dashboard 更新 `ENCRYPTION_KEY` 后：

- 旧账户密文无法解密，网关测试返回 `PROVIDER_UNAVAILABLE`；
- 新建账户时加密失败，返回 `CONFIG_INVALID`（对外为 `Internal gateway error`）。

根因是主密钥轮换会立即让所有已保存的上游凭据失效。用户明确选择方案 B：取消 `ENCRYPTION_KEY`，上游 Key 明文入库。

## Requirements

### R1. 移除 ENCRYPTION_KEY

- 从 `GatewayEnv`、部署文档、`.dev.vars*`、测试配置和 `/admin/setup` 响应中删除 `ENCRYPTION_KEY`。
- 代码中不再读取、校验或依赖该 Secret。
- `src/security/crypto.ts` 中的 `encryptSecret` / `decryptSecret` / `EncryptedSecret` 全部删除。

### R2. 明文存储上游 apiKey

- `provider_accounts` 新增 `api_key_plain TEXT` 列（migration `0007_*`）。
- 通过管理台 `apiKey` 创建的账户，密钥明文写入 `api_key_plain`。
- 旧列 `api_key_enc` / `api_key_iv` / `api_key_tag` 保留但不再读写，作为历史遗留列。
- `secretRef` 路径保持不变，且仍优先于 `apiKey` 解析。

### R3. 管理 API 与 UI

- `POST /admin/providers/:id/accounts`：`apiKey` 或 `secretRef` 二选一，二者仍然互斥。
- `PUT /admin/providers/:id/accounts/:accountId`：可更新 `apiKey` 或 `secretRef`，更新其一时清除另一种凭据。
- 所有返回账户对象的管理 API 必须继续脱敏，不能返回明文 `apiKey`。
- `credentialType` 取值改为 `api_key` / `secret_ref` / `none`；`hasKey` 语义保持不变。

### R4. 运行时解析

- `resolveAccountApiKey()`：先处理 `secretRef`，否则返回账户的明文 `apiKey`。
- 不再执行任何解密操作，也不再产生与加密相关的 `CONFIG_INVALID` / `PROVIDER_UNAVAILABLE`。

### R5. 配置校验与启动检查

- `validateSnapshot` 要求账户至少具备 `apiKey` 或 `secretRef`。
- `/admin/setup` 的 `secrets` 只包含 `adminToken`；缺失项不再包含 `ENCRYPTION_KEY`。
- 未配置 `ENCRYPTION_KEY` 时，系统应能正常启动、创建账户和发起推理。

### R6. 文档与规范

- 更新 `README.md`、`docs/DEPLOY.md`、`docs/PROVIDERS.md`、`docs/API.md`、`.dev.vars.example`。
- 明确写明：`apiKey` 现在以明文存储在 D1 和配置快照中，建议生产使用 `secretRef`。
- 同步更新 `.trellis/spec/backend/security-guidelines.md` 中的凭据契约。

### R7. 兼容与迁移

- 历史 `api_key_enc/iv/tag` 密文在升级后不可用。
- 当前生产 `provider_accounts` 为 0 条，无需数据迁移；文档要求升级后重新录入上游 Key。
- 保留 `secretRef`，避免强制所有部署使用明文。

## Non-goals

- 不引入密钥版本化或信封加密。
- 不实现自动把历史密文迁移为明文。
- 不改变下游 API Key 的生成与哈希方式。
- 不改变请求 / 响应协议和路由逻辑。

## Acceptance Criteria

- [ ] `rg "ENCRYPTION_KEY" src test docs README.md .dev.vars.example vitest.config.ts` 无生产代码引用（task 文档除外）。
- [ ] 创建账户时只提供 `apiKey` 也能成功，D1 `api_key_plain` 有值，`api_key_enc/iv/tag` 为空。
- [ ] 创建账户时只提供 `secretRef` 也能成功，D1 `api_key_plain` 为空。
- [ ] 账户列表 / Provider 详情响应不包含明文 `apiKey`，`credentialType` 正确。
- [ ] 未配置 `ENCRYPTION_KEY` 时，网关测试和推理都能正常调用上游。
- [ ] `npm run typecheck` 通过。
- [ ] `npm test` 通过。
- [ ] 文档不再宣称上游 Key 使用 AES-256-GCM 加密。

## Risks

- 上游 Key 明文出现在 `provider_accounts.api_key_plain`、`config_versions.payload` 和 KV `config:snapshot:*` 中；任何能读取 D1 / KV 的凭据都能直接获得上游 Key。
- 历史配置版本会保留旧 Key；更换 Key 后建议清理过期的 `config_versions`。
- 误把明文 `apiKey` 返回给客户端会造成泄露，必须由 `sanitizeAccount` 统一脱敏。
