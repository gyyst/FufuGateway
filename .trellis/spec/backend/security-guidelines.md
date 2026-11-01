# Security Guidelines

> Secret 管理、下游 API Key 哈希与上游凭据存储的可执行契约。

---

## Scenario: Secret 清单与凭据存储

### 1. Scope / Trigger

任何涉及以下内容的改动都必须先读本节：

- 新增或删除 `GatewayEnv` 中的 Secret 字段
- 修改下游 API Key 的生成、哈希或校验逻辑
- 修改上游 Provider 凭据的存储方式（`apiKey` / `secretRef`）
- 变更 `/admin/setup` 的 `secrets` 响应结构

### 2. Signatures

```ts
// src/auth/api-key.ts
generateApiKey(): Promise<{ plaintext: string; prefix: string; hash: string }>
hashApiKey(apiKey: string): Promise<string> // 64 位小写十六进制

// src/security/secrets.ts
isValidSecretRef(name: string): boolean
readSecretRef(env: GatewayEnv, name: string): string | undefined

// src/execution/accounts.ts
resolveAccountApiKey(env: GatewayEnv, account: ProviderAccountRecord): Promise<string>

// src/admin/handlers/setup.ts -> GET /admin/setup/status
secrets: { adminToken: boolean }
```

### 3. Contracts

**Worker Secrets**

| Secret | 必配 | 用途 | 缺失行为 |
|--------|------|------|----------|
| `ADMIN_TOKEN` | 是 | `requireAdmin` 管理员令牌 | 管理接口返回 503 |
| `ENCRYPTION_KEY` | 已移除（2026-11-01） | 原上游凭据 AES-256-GCM 主密钥 | 不要再引入、读取或校验 |
| `API_KEY_PEPPER` | 已移除（2026-11-01） | 原下游 Key 哈希盐 | 不要再引入或读取 |

**下游 API Key**

- 明文格式：`fufu_sk_` + 32 字节密码学随机值的 base64url，仅在创建或轮换响应中返回一次。
- 数据库只存 `api_keys.key_hash`，值为 `SHA-256("fufu_api_key:" + plaintext)` 的十六进制。
- 认证时对收到的 credential 重算同一哈希，按 `key_hash` 等值查询（`src/auth/repository.ts`）。
- 固定前缀 `fufu_api_key:` 是领域分隔符，不是盐；哈希本身无盐、无随机化。

**上游 Provider 凭据**

- `apiKey`：明文写入 `provider_accounts.api_key_plain`（`src/config/repository.ts`）。这是 2026-11-01 事故后的明确决策，用于避免主密钥轮换导致全部凭据失效。
- `secretRef`：大写 Worker Secret 名，必须匹配 `^[A-Z][A-Z0-9_]{0,63}$`，读取不落库。
- 两者互斥，且账户必须提供其一（`src/admin/handlers/providers.ts`、`src/config/validate.ts`）。
- 运行时 `resolveAccountApiKey` 先读取 `secretRef`；Secret 不存在时回退到 `apiKey`。
- 明文会进入 `config_versions.payload` 与 KV `config:snapshot:*`。管理响应必须通过 `sanitizeAccount` 脱敏，只返回 `hasKey` 与 `credentialType`（`api_key` / `secret_ref` / `none`）。
- 历史列 `api_key_enc` / `api_key_iv` / `api_key_tag` 已废弃，不再读写，仅保留列定义以兼容已部署的 D1。

### 4. Validation & Error Matrix

| 条件 | 错误码 | 对外消息 |
|------|--------|----------|
| `ADMIN_TOKEN` 未配置 | `CONFIG_INVALID` | HTTP 503 |
| 创建账户同时提供 `apiKey` 与 `secretRef`（或都不提供） | `INVALID_REQUEST` | 提示二者只能选一 |
| 更新账户同时提供 `apiKey` 与 `secretRef` | `INVALID_REQUEST` | 提示最多只能提供一个 |
| `secretRef` 不匹配大写 Secret 名正则 | `INVALID_REQUEST` | 提示必须为大写 Worker Secret 名 |
| 配置快照中的账户既无 `apiKey` 也无 `secretRef` | `CONFIG_INVALID` | 校验问题列表 |
| 运行时账户没有任何可用凭据 | `PROVIDER_UNAVAILABLE` | `Provider account has no credential configured` |

### 5. Good / Base / Bad Cases

- Good：管理台创建下游 Key → 只在响应中返回明文 → 后续请求用明文经 `hashApiKey` 查表。
- Base：上游账户使用 `secretRef` 引用 Worker Secret，数据库与配置快照都不保存任何密钥。
- Bad：把下游 Key 明文或可逆加密结果写入 `api_keys`；或在 `hashApiKey` 中加入每次调用变化的随机盐，导致无法按哈希查表。
- Bad：在管理 API 响应中直接返回账户的 `apiKey`，或把 `apiKey` 写入日志 / 审计详情。

### 6. Tests Required

- `test/integration/*.test.ts`：用 `generateApiKey()` 生成 Key 后调用推理接口成功；篡改 Key 一个字符返回 401。
- `/admin/setup/status`：`secrets` 只含 `adminToken`。
- Provider 账户：以 `apiKey` 创建后明文落库、推理时直接使用，且管理响应不含 `apiKey`；以 `secretRef` 创建时 `api_key_plain` 为空。
- 账户凭据切换：更新 `apiKey` 清除 `secretRef`，更新 `secretRef` 清除 `apiKey`。
- 断言点：`hash` 必须等于 `SHA-256("fufu_api_key:" + plaintext)`。

### 7. Wrong vs Correct

#### Wrong

```ts
// 重新引入部署盐，或在哈希中加入随机盐
export async function hashApiKey(pepper: string, apiKey: string): Promise<string> {
  return sha256(`${pepper}:${apiKey}`);
}
```

#### Correct

```ts
// 无盐 + 固定域前缀；调用方只需传 key
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(`fufu_api_key:${apiKey}`);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
```

#### Wrong

```ts
// 任何管理响应直接展开账户对象
return c.json({ data: account });
```

#### Correct

```ts
// 统一脱敏，明文永不离开服务端
return c.json({ data: sanitizeAccount(account) });
```

> **Warning**: 修改哈希算法、域前缀或 Secret 名称属于破坏性变更。现存 `key_hash` 无法反推重算，升级后所有旧下游 Key 立即失效，必须在 `README.md` / `docs/DEPLOY.md` 写明并要求重新签发。

> **Warning**: 上游 `apiKey` 明文存储意味着 D1 导出、备份、只读 SQL 访问、`config_versions.payload` 与 KV 快照都会泄露上游 Key。每次有效配置写入都会自动发布并新增版本，历史中会持续保留含明文 Key 的快照；生产环境优先使用 `secretRef`，限制 Cloudflare 账户与 D1 / KV 访问，并定期清理旧 `config_versions`。
