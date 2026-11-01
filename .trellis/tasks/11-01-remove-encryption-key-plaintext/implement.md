# Implementation Plan: 移除 ENCRYPTION_KEY 并改为明文存储

## Preconditions

- 当前生产 `provider_accounts` 为 0 条，无历史密文迁移负担。
- 任务目录：`.trellis/tasks/11-01-remove-encryption-key-plaintext/`
- 基线：`main`，当前工作区可能存在其他任务的改动；开始前先确认 `git status`。

## Checklist

### 1. 数据层

- [ ] 新建 `migrations/0007_plaintext_provider_api_keys.sql`，添加 `api_key_plain TEXT`。
- [ ] `src/config/types.ts`
  - 删除 `EncryptedCredential`。
  - `ProviderAccountRecord` 用 `apiKey?: string` 取代 `encryptedKey`。
- [ ] `src/config/repository.ts`
  - `AccountRow` 增加 `api_key_plain`。
  - `mapAccount` 映射 `apiKey`，停止映射加密列。
  - `CreateAccountInput` 使用 `apiKey`。
  - `replaceAccount` 写入 `api_key_plain`，加密列写 `NULL`。
- 验证：`npm run typecheck`

### 2. 加密模块移除

- [ ] 新建 `src/security/secrets.ts`，迁入 `isValidSecretRef` / `readSecretRef`。
- [ ] 删除 `src/security/crypto.ts`。
- [ ] 更新 `src/admin/handlers/providers.ts` 与 `src/execution/accounts.ts` 的 import。
- 验证：`rg "decryptSecret|encryptSecret|EncryptedCredential|EncryptedSecret" src` 无结果。

### 3. 运行时凭据解析

- [ ] `src/execution/accounts.ts`
  - `resolveAccountApiKey` 删除解密分支。
  - `secretRef` 优先；否则返回 `account.apiKey`。
  - 缺少凭据时仍抛 `PROVIDER_UNAVAILABLE`（消息改为无凭据配置）。

### 4. 管理 API

- [ ] `src/admin/handlers/providers.ts`
  - 创建/更新账户：`apiKey` 直接写入记录。
  - 更新时 `apiKey` 与 `secretRef` 互斥且互相清除。
  - audit `credential` 值改为 `api_key` / `secret_ref`。
- [ ] `src/admin/schemas.ts`
  - `accountUpdateSchema` 增加互斥 refine。
- [ ] `src/admin/shared.ts`
  - `sanitizeAccount` 脱敏 `apiKey`，`credentialType` 改为 `api_key` / `secret_ref` / `none`。
- 验证：
  - `rg "apiKey" src/admin` 确认没有透传响应。
  - 手动或集成测试确认响应无 `apiKey` 字段。

### 5. 环境与启动检查

- [ ] `src/env.ts` 删除 `ENCRYPTION_KEY`。
- [ ] `src/admin/handlers/setup.ts` 删除 `encryptionKey`，只检查 `ADMIN_TOKEN`。
- [ ] `vitest.config.ts` 删除 `ENCRYPTION_KEY` 测试绑定。
- [ ] `.dev.vars.example` 删除 `ENCRYPTION_KEY`。
- 验证：`rg "ENCRYPTION_KEY" src test vitest.config.ts .dev.vars.example` 无结果（task 文档除外）。

### 6. 配置校验

- [ ] `src/config/validate.ts`
  - 删除 `encryptedKey` 检查。
  - 账户必须至少有 `apiKey` 或 `secretRef`。
- 验证：`npm run typecheck` + `npm test`

### 7. UI

- [ ] `public/ui-static/app.js`
  - 确认 `credentialType` 新值可正常显示（若需要，映射为中文标签）。
  - "更新密钥" prompt 继续走 `apiKey`（明文存储）。
- 验证：本地 `npm run dev` 打开 `/ui` 检查账户表格与创建/更新流程。

### 8. 文档与规范

- [ ] `README.md`：Secret 清单、上游 Key 存储说明。
- [ ] `docs/DEPLOY.md`：删除 `ENCRYPTION_KEY` 步骤，新增明文风险说明。
- [ ] `docs/PROVIDERS.md`：改写凭据存储段落，推荐 `secretRef`。
- [ ] `docs/API.md`：`/admin/setup` 响应、账户字段说明。
- [ ] `.trellis/spec/backend/security-guidelines.md`：更新 Secret 清单、凭据契约、错误矩阵和测试要求。
- 验证：`rg "AES-256-GCM|encryptedKey|ENCRYPTION_KEY" docs README.md .trellis/spec` 剩余项均为历史说明或任务文档。

### 9. 测试补充

- [ ] 新增/调整集成测试：
  - `apiKey` 创建账户 → 推理成功。
  - 响应不含 `apiKey`，`credentialType === "api_key"`。
  - `secretRef` 创建账户 → `credentialType === "secret_ref"`。
  - `/admin/setup` 的 `secrets` 不含 `encryptionKey`。
- [ ] `npm test`

### 10. 最终检查

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `git diff` 自查：无明文测试 Key 被写入源码；无遗漏的加密引用。
- [ ] 汇总变更与部署注意事项，等待用户确认后再提交。

## Deployment / Rollout

1. 部署新代码（此时旧 `ENCRYPTION_KEY` 已不再被读取）：
   ```bash
   npm run deploy
   ```
2. 管理台创建/更新 `huawei` 账户，填入上游 API Key（或 `secretRef`）。
3. 发布配置，使新账户进入 KV 快照。
4. 删除线上 Secret：
   ```bash
   npx wrangler secret delete ENCRYPTION_KEY --name fufugateway
   ```
5. 网关测试 `huawei/volcengine/deepseek-v4.1-flash`。
6. 更新本地 `~/.fufu-gateway/secrets.env`（移除 ENCRYPTION_KEY，ADMIN_TOKEN 以线上为准）。

## Rollback Points

- 代码回滚：恢复 `src/security/crypto.ts` 与旧映射；旧密文仍然不可用，需要重新录入或使用 `secretRef`。
- 数据回滚：`api_key_plain` 为新增列，旧代码忽略；回滚不破坏 schema。
- 部署回滚：`npx wrangler deployments` 选择上一版本，但需确认上一版本仍能读取当前账户数据。

## Review Gates

- Gate 1：数据层与类型改动完成，`typecheck` 通过。
- Gate 2：API/运行时/校验完成，`npm test` 通过。
- Gate 3：文档与 spec 更新完成，人工检查无明文泄露响应。
- Gate 4：部署前确认生产账户状态与迁移说明。
