# Design: 移除 ENCRYPTION_KEY 并改为明文存储上游 API Key

## 1. 决策摘要

- 采用方案 B（明文存储），删除主密钥与对称加密。
- 保留 `secretRef`，继续支持用 Worker Secret 引用上游 Key。
- 新增 `provider_accounts.api_key_plain`，旧加密列保留但废弃。
- 配置快照继续包含账户凭据；这意味着明文会进入 `config_versions.payload` 与 KV 快照。这是方案 B 的直接后果，需在文档中明确。

## 2. 数据模型

### 2.1 Migration

新增 `migrations/0007_plaintext_provider_api_keys.sql`：

```sql
ALTER TABLE provider_accounts ADD COLUMN api_key_plain TEXT;

-- Legacy columns kept for backward compatibility.
-- api_key_enc / api_key_iv / api_key_tag are no longer read or written.
```

说明：

- 当前生产 `provider_accounts` 为 0 条，无数据迁移。
- 不删除旧列，避免 D1 上 `DROP COLUMN` 的兼容性风险；在文档中标记废弃。
- 新代码写入 `api_key_plain`，旧列写 `NULL`。

### 2.2 TypeScript 类型

`src/config/types.ts`：

```ts
export interface ProviderAccountRecord {
  id: string;
  providerId: string;
  name: string;
  apiKey?: string;      // plaintext, at rest in D1
  secretRef?: string;
  // ...
}

// Delete:
// export interface EncryptedCredential { ... }
// encryptedKey?: EncryptedCredential;
```

`apiKey` 与 `secretRef` 保持互斥语义；账户至少有一个。

### 2.3 Repository

`src/config/repository.ts`：

- `AccountRow` 增加 `api_key_plain: string | null`。
- `mapAccount`：
  - `...(row.api_key_plain === null ? {} : { apiKey: row.api_key_plain })`
  - 继续映射 `secret_ref`。
  - 删除 `api_key_enc/iv/tag` 到 `encryptedKey` 的映射。
- `CreateAccountInput`：`apiKey?: string` 取代 `encryptedKey?: EncryptedCredential`。
- `replaceAccount` SQL：
  - 插入 `api_key_plain`；
  - `api_key_enc/api_key_iv/api_key_tag` 固定写 `NULL`。

## 3. 凭据解析

`src/execution/accounts.ts`：

```ts
export async function resolveAccountApiKey(env, account) {
  if (account.secretRef !== undefined) {
    const value = readSecretRef(env, account.secretRef);
    if (value !== undefined) return value;
  }
  if (account.apiKey !== undefined) return account.apiKey;
  throw new GatewayError({
    code: "PROVIDER_UNAVAILABLE",
    message: "Provider account has no credential configured",
  });
}
```

- 删除 `decryptSecret` 引用。
- `secretRef` 解析失败（Worker Secret 不存在）时仍回退到 `apiKey`，与现有行为一致。

## 4. 管理 API

`src/admin/handlers/providers.ts`：

- `createAccountHandler`：
  - `input.apiKey` → `encryptedKey = encryptSecret(...)` 改为 `apiKey: input.apiKey`；
  - `input.secretRef` → 保持校验；
  - audit `credential`: `"api_key"` | `"secret_ref"`。
- `updateAccountHandler`：
  - `input.apiKey` → `updated.apiKey = input.apiKey; delete updated.secretRef;`
  - `input.secretRef` → `updated.secretRef = input.secretRef; delete updated.apiKey;`
  - 不提供凭据字段时保持原凭据不变。
- 账户对象写库后仍返回 `sanitizeAccount(account)`。

`src/admin/schemas.ts`：

- `accountCreateSchema` 保持 `apiKey` XOR `secretRef`。
- `accountUpdateSchema` 增加 `.refine`：`apiKey` 与 `secretRef` 不能同时提供。

`src/admin/shared.ts`：

```ts
export function sanitizeAccount(account) {
  const { apiKey, ...rest } = account;
  return {
    ...rest,
    hasKey: apiKey !== undefined || account.secretRef !== undefined,
    credentialType:
      apiKey !== undefined ? "api_key" :
      account.secretRef !== undefined ? "secret_ref" : "none",
  };
}
```

- 确保明文 `apiKey` 永不出现在任何响应中。
- UI `public/ui-static/app.js` 不需要改创建/更新逻辑；`credentialType` 会显示 `api_key`。

## 5. 校验与启动检查

`src/config/validate.ts`：

- 删除 `encryptedKey` 与 incomplete credential 检查。
- 新规则：`account.apiKey === undefined && account.secretRef === undefined` → `CONFIG_INVALID`。
- `secretRef` 正则校验保留。

`src/admin/handlers/setup.ts`：

- `secrets` 改为 `{ adminToken: boolean }`。
- `secretsComplete = secrets.adminToken`。
- `missingSecrets` 只包含 `ADMIN_TOKEN`。
- 步骤文案改为"管理员令牌已配置"。

`src/env.ts`：

- 删除 `ENCRYPTION_KEY?: string`。

## 6. 加密模块

- 新建 `src/security/secrets.ts`，迁移 `isValidSecretRef` 与 `readSecretRef`。
- 删除 `src/security/crypto.ts`。
- 更新引用：
  - `src/admin/handlers/providers.ts`
  - `src/execution/accounts.ts`

## 7. 配置快照与运行时

- `loadConfigData` 继续返回完整账户（含明文 `apiKey`）。
- `publishConfig` 继续把完整账户写入 `config_versions.payload` 和 KV。
- `buildRuntimeConfig` 继续把 `apiKey` 带入 `accountsByProvider`。
- 因此 `publishConfig` → 发布 → 运行时读取 KV 的链路不需要结构性改动。

已知影响：

- 明文 Key 会同时出现在 `provider_accounts`、`config_versions.payload`、KV `config:snapshot:*`。
- 历史配置版本会保留旧 Key；文档要求管理员在轮换后清理不再需要的版本（当前无删除 API，可作为后续任务）。

## 8. 测试与验证

- `npm run typecheck`
- `npm test`
- 新增/调整测试：
  - 创建账户（apiKey）后 `GET /admin/providers/:id` 不含 `apiKey`，`credentialType === "api_key"`。
  - 创建账户（secretRef）后 `credentialType === "secret_ref"`。
  - 推理链路使用明文 apiKey 成功（现有集成测试覆盖）。
  - `/admin/setup` 的 `secrets` 不再包含 `encryptionKey`。
- 手动验证（部署后）：
  1. 部署新代码；
  2. 管理台创建 `huawei` 账户（apiKey）；
  3. 发布配置；
  4. 网关测试 `huawei/volcengine/deepseek-v4.1-flash`；
  5. 删除 `ENCRYPTION_KEY` Secret；
  6. 再次测试。

## 9. 兼容与回滚

- 升级后旧 `api_key_enc/iv/tag` 密文不可用，需重新录入上游 Key。
- 回滚到旧代码后，明文 `api_key_plain` 也不会被旧代码读取；旧代码会认为账户无凭据。回滚前需恢复旧密文或使用 `secretRef`。
- 迁移只加列，不破坏现有 schema；`0007` 可安全重复应用到空库。
- 保留 `secretRef` 作为无需回滚的安全路径。

## 10. 安全说明（必须写进文档）

- 明文存储意味着 D1 导出、备份、只读 SQL 访问都会泄露上游 Key。
- 建议：
  - 限制 Cloudflare 账户与 D1 访问；
  - 生产环境优先使用 `secretRef`；
  - 不把 `config_versions.payload` 导出到不受信任的位置；
  - 定期清理历史配置版本（后续能力）。

## 11. 涉及文件

- `migrations/0007_plaintext_provider_api_keys.sql`
- `src/security/secrets.ts`（新增）
- `src/security/crypto.ts`（删除）
- `src/env.ts`
- `src/config/types.ts`
- `src/config/repository.ts`
- `src/config/validate.ts`
- `src/admin/handlers/providers.ts`
- `src/admin/handlers/setup.ts`
- `src/admin/schemas.ts`
- `src/admin/shared.ts`
- `src/execution/accounts.ts`
- `public/ui-static/app.js`（仅 `credentialType` 显示，可选）
- `test/integration/*.test.ts`（按需）
- `vitest.config.ts`
- `.dev.vars.example`
- `README.md`
- `docs/API.md`
- `docs/DEPLOY.md`
- `docs/PROVIDERS.md`
- `.trellis/spec/backend/security-guidelines.md`
