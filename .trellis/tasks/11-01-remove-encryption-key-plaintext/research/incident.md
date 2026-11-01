# Research: ENCRYPTION_KEY 轮换事故与明文方案决策

## 事故时间线（本地时间 UTC+8）

- 2026-11-01 00:19:40：账户 `acc_01M69C4XCW72CPYW7ZHFEDCFJV` 创建，上游 Key 使用当时的 `ENCRYPTION_KEY` 加密入库。
- 2026-11-01 09:15:01：Cloudflare Dashboard 更新 `ADMIN_TOKEN`。
- 2026-11-01 09:40:47：Dashboard 删除 `API_KEY_PEPPER` 绑定。
- 2026-11-01 09:40:57：Dashboard 更新 `ENCRYPTION_KEY`。
- 2026-11-01 10:23:28：部署代码。
- 2026-11-01 10:26:40 / 10:27:17：网关测试 `huawei/volcengine/deepseek-v4.1-flash` 返回 `PROVIDER_UNAVAILABLE`。
- 2026-11-01 10:51:03：用户删除旧账户。
- 之后创建新账户失败，返回 `CONFIG_INVALID` / `Internal gateway error`。

## 根因

- `resolveAccountApiKey()` 解密旧密文时，`importMasterKey()` 使用新的 `ENCRYPTION_KEY`，AES-GCM 解密失败，被包装为 `PROVIDER_UNAVAILABLE`。
- `encryptSecret()` 使用同一个 `importMasterKey()`；新密钥格式不合法（非 base64 32 字节）或为空时抛 `CONFIG_INVALID`，`expose: false`，对外显示 `Internal gateway error`。
- 上游本身正常：用旧密钥在本地解密账户凭据后直接请求 `https://st8tp3ajl0df3n8b8l8qu.apigateway-cn-beijing.volceapi.com/v1/chat/completions`，`model: volcengine/deepseek-v4.1-flash` 返回 200，实际服务模型 `deepseek-v4-1-flash-261017`。

## 决策

- 用户选择方案 B：移除 `ENCRYPTION_KEY`，上游 `apiKey` 明文存入 D1。
- 保留 `secretRef` 路径，作为安全替代方案。
- 接受明文出现在 `provider_accounts`、`config_versions.payload` 和 KV 快照中的风险，并在文档中明确。

## 官方文档参考

- Cloudflare Workers Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
  - Secret 按 Worker 管理；Dashboard / Wrangler 均可更新；
  - 更新 Secret 会创建并立即部署新版本。
- 更新 Secret 不会重新加密旧应用层密文；应用层主密钥轮换必须自带迁移机制。
