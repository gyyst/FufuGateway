# Security Guidelines

> Secret 管理、下游 API Key 哈希与上游凭据加密的可执行契约。

---

## Scenario: Secret 清单与凭据存储

### 1. Scope / Trigger

任何涉及以下内容的改动都必须先读本节：

- 新增或删除 `GatewayEnv` 中的 Secret 字段
- 修改下游 API Key 的生成、哈希或校验逻辑
- 修改上游 Provider 凭据的存储方式（`encryptedKey` / `secretRef`）
- 变更 `/admin/setup` 的 `secrets` 响应结构

### 2. Signatures

```ts
// src/auth/api-key.ts
generateApiKey(): Promise<{ plaintext: string; prefix: string; hash: string }>
hashApiKey(apiKey: string): Promise<string> // 64 位小写十六进制

// src/security/crypto.ts
encryptSecret(env: GatewayEnv, plaintext: string): Promise<EncryptedSecret>
decryptSecret(env: GatewayEnv, secret: EncryptedSecret): Promise<string>
isValidSecretRef(name: string): boolean
readSecretRef(env: GatewayEnv, name: string): string | undefined

// src/admin/handlers/setup.ts -> GET /admin/setup
secrets: { adminToken: boolean; encryptionKey: boolean }
```

### 3. Contracts

**Worker Secrets**

| Secret | 必配 | 用途 | 缺失行为 |
|--------|------|------|----------|
| `ADMIN_TOKEN` | 是 | `requireAdmin` 管理员令牌 | 管理接口返回 503 |
| `ENCRYPTION_KEY` | 使用 `encryptedKey` 凭据时必配 | AES-256-GCM 主密钥，base64 编码的 32 字节 | 创建/读取上游账户报 `CONFIG_INVALID` |
| `API_KEY_PEPPER` | 已移除（2026-11-01） | 原下游 Key 哈希盐 | 不要再引入或读取 |

**下游 API Key**

- 明文格式：`fufu_sk_` + 32 字节密码学随机值的 base64url，仅在创建或轮换响应中返回一次。
- 数据库只存 `api_keys.key_hash`，值为 `SHA-256("fufu_api_key:" + plaintext)` 的十六进制。
- 认证时对收到的 credential 重算同一哈希，按 `key_hash` 等值查询（`src/auth/repository.ts`）。
- 固定前缀 `fufu_api_key:` 是领域分隔符，不是盐；哈希本身无盐、无随机化。

**上游 Provider 凭据**

- `encryptedKey`：AES-256-GCM，拆为 `ciphertext` / `iv` / `tag` 三列（`src/config/repository.ts`）。
- `secretRef`：大写 Worker Secret 名，必须匹配 `^[A-Z][A-Z0-9_]{0,63}$`，读取不落库。
- 两者互斥，且必须提供其一（`src/admin/handlers/providers.ts`）。

### 4. Validation & Error Matrix

| 条件 | 错误码 | 对外消息 |
|------|--------|----------|
| `ENCRYPTION_KEY` 未配置 | `CONFIG_INVALID` | 不暴露（`expose: false`） |
| `ENCRYPTION_KEY` 非 base64 或解码后长度不是 32 | `CONFIG_INVALID` | 不暴露 |
| 上游凭据解密失败 | `CONFIG_INVALID` | `Failed to decrypt provider credential`，不暴露 |
| `ADMIN_TOKEN` 未配置 | `CONFIG_INVALID` | HTTP 503 |
| 创建账户同时提供 `apiKey` 与 `secretRef`（或都不提供） | `INVALID_REQUEST` | 提示二者只能选一 |
| `secretRef` 不匹配大写 Secret 名正则 | `INVALID_REQUEST` | 提示必须为大写 Worker Secret 名 |

### 5. Good / Base / Bad Cases

- Good：管理台创建 Key → 只在响应中返回明文 → 后续请求用明文经 `hashApiKey` 查表。
- Base：上游账户使用 `secretRef` 引用 Worker Secret，数据库不保存任何密文。
- Bad：把下游 Key 明文或可逆加密结果写入 `api_keys`；或在 `hashApiKey` 中加入每次调用变化的随机盐，导致无法按哈希查表。

### 6. Tests Required

- `test/integration/*.test.ts`：用 `generateApiKey()` 生成 Key 后调用推理接口成功；篡改 Key 一个字符返回 401。
- `/admin/setup`：`secrets` 只含 `adminToken` 与 `encryptionKey`，未配置 pepper 时不再产生缺项。
- Provider 账户：以 `apiKey` 创建后能加密落库并在推理时解密；以 `secretRef` 创建时不写 `encryptedKey`。
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

> **Warning**: 修改哈希算法、域前缀或 Secret 名称属于破坏性变更。现存 `key_hash` 无法反推重算，升级后所有旧下游 Key 立即失效，必须在 `README.md` / `docs/DEPLOY.md` 写明并要求重新签发。
