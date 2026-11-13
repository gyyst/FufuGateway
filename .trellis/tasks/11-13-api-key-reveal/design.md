# 技术设计：API Key 随时查看与复制

## 数据模型

- 迁移 `0009_api_key_plaintext.sql`：`ALTER TABLE api_keys ADD COLUMN key_plain TEXT;`
- `ApiKeyRecord` 增加可选 `keyPlain?: string`。
- `key_hash` 保持唯一索引与认证用途不变；`key_plain` 不建索引。

## 后端

- `src/auth/repository.ts`：
  - `ApiKeyRow` / `mapApiKey` 映射 `key_plain`。
  - `CreateApiKeyInput` 增加 `keyPlain`，INSERT 写入。
  - `replaceApiKey` 不更新 `key_plain`（明文在生命周期内不变）。
- `src/admin/handlers/keys.ts`：
  - `publicApiKey` 剔除 `keyPlain`，确保列表/更新响应不泄露。
  - 创建与轮换传入 `generated.plaintext`。
  - 新增 `revealApiKeyHandler`：`GET /admin/api-keys/:id/reveal`
    - Key 不存在 → `NOT_FOUND`。
    - `keyPlain` 为空 → `NOT_FOUND`，消息提示轮换生成新 Key。
    - 成功 → `{ data: { id, key, keyPrefix } }`，审计 `api_key.reveal`（仅记录前缀）。
- `src/admin/routes.ts`：注册 reveal 路由（放在 `:id` 通用路由之前无冲突，方法与路径独立）。

## 前端

- `public/ui-static/app.js`：
  - `showPlaintextKey(key, options)` 支持创建/轮换与查看两种标题和说明。
  - 列表 actions 增加「查看」，调用 reveal 接口。
  - 复制失败时选中 `#plaintext-key` 内容并提示手动复制。
  - 更新页面 hint、空状态、快速开始文案中「只显示一次」的表述。

## 安全与文档

- `security-guidelines.md`：更新下游 Key 存储契约、Bad Case 与测试要求。
- `README.md`：更新安全说明、升级说明与管理台流程。
- 风险提示：任何可读 D1 的凭据都能取得下游 Key 明文；与上游 Key 明文存储的风险等级一致，需限制 D1 访问。reveal 操作进入审计。

## 兼容与回滚

- 旧 Key 的 `key_plain` 为 NULL，认证不受影响，仅无法查看明文；轮换即可获得新 Key。
- 回滚代码后新增列保持未使用，不影响旧逻辑。
