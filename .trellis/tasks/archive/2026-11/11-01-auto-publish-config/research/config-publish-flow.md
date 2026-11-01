# Research: 配置发布链路与自动发布改造点

## 范围

本文件记录“取消手动发布、保存即自动发布”改造所依赖的代码事实、调用链与测试锚点。实现时以本文与 `design.md` 为准。

## 1. 配置数据模型

`ConfigSnapshotData` 包含六类数据（`src/config/types.ts:171-182`）：

- `providers`
- `accounts`
- `models`
- `combos`（旧快照可能含 `aliases` / `wildcards`，运行时合成为 Combo）
- `pricing`
- `settings`

`loadConfigData` 一次性读取六类数据（`src/config/repository.ts:372-382`）。列表查询均有确定性排序（providers by name、accounts by provider/priority/weight/id、models by model_id/provider_id、combos by name、pricing by provider/model），这是回滚恢复后 checksum 能与快照一致的前提。

## 2. 运行时读取

`loadRuntimeConfig`（`src/config/cache.ts:81-104`）：

1. 内存缓存未过期（`config.cache_ttl_ms`，默认 60000）直接返回。
2. 读 KV `CONFIG_CURRENT_KEY` → `configSnapshotKey(version)`。
3. KV 无版本时回退 D1，重新校验并构建运行期配置（`source: "d1-fallback"`）。
4. KV 故障时保留最后一次可用配置。

结论：自动发布后跨 isolate 生效仍受缓存 TTL 与 KV 传播限制，最长约 60 秒。

## 3. 手动发布流程

`publishConfig`（`src/config/snapshot.ts:63-125`）：

1. `loadConfigData` + `validateSnapshot`，存在 error 抛 `CONFIG_INVALID`。
2. `computeChecksum`（`src/config/runtime.ts:142-152`，`JSON.stringify(data)` 的 SHA-256）。
3. 与当前 KV 活跃版本 checksum 相同则返回 `unchanged: true`。
4. `SELECT MAX(version)+1`，构造 `ConfigSnapshot`，写 `config_versions`。
5. 写 KV 快照、`CONFIG_PREVIOUS_KEY`、`CONFIG_CURRENT_KEY`。
6. 旧 published 版本标记 superseded，`clearConfigCache()`。

入口：`POST /admin/config/publish`（`src/admin/routes.ts:128`、`src/admin/handlers/config.ts:40-51`）；管理台按钮 `public/ui-static/app.js:4197-4215`。

## 4. 回滚现状

`rollbackConfig`（`src/config/snapshot.ts:128-170`）只写 KV 快照与指针、更新版本状态，不修改 D1。自动发布后，若仍保持该语义，任意后续保存都会把 D1 重新发布，覆盖回滚结果。因此本任务需要同时恢复 D1。

限制：

- 旧快照若含非空 `aliases` / `wildcards`，当前表结构无法无损还原，应在回滚前拒绝。
- 升级前使用加密字段保存的旧版本没有 `apiKey`，恢复后会在账户凭据校验阶段失败，属预期保护。

## 5. 写路径清单

所有进入配置快照的写接口（`src/admin/routes.ts:75-106,139-140`）：

- Provider：`src/admin/handlers/providers.ts:84-156`
- 账户：`src/admin/handlers/providers.ts:164-233`
- 模型同步：`src/admin/handlers/providers.ts:287-307` → `src/models/sync.ts:18-72`
- 模型：`src/admin/handlers/models.ts:57-173`
- 价格：`src/admin/handlers/models.ts:179-204`
- Combo：`src/admin/handlers/combos.ts:41-97`
- 设置：`src/admin/handlers/settings.ts:77-100`
- 每日维护同步：`src/maintenance.ts:79-108,113-142`

用户、API Key、请求日志、用量不属于配置快照，不触发自动发布。

## 6. 校验规则要点

`validateSnapshot`（`src/config/validate.ts:78-351`）：

- Provider 无账户：warning `PROVIDER_NO_ACCOUNT`（第 156-161 行）。
- 账户无凭据、引用未知 Provider、模型引用未知 Provider、重名、非法 URL/协议、启用 Combo 目标无法解析、设置越界：error。
- 禁用 Combo 的无法解析目标是 warning（`checkTarget` 的 `enabled` 参数，第 279-298 行）。

因此“先创建引用不存在目标的 Combo、再创建目标”的增量编辑会产生暂时非法配置；现有测试 `test/integration/gateway.test.ts:306-332` 与 `test/integration/config.test.ts:132-157` 均覆盖该中间态。实现不能简单拒绝所有非法写入。

## 7. 现有测试锚点

- 发布/回滚：`test/integration/config.test.ts:90-157`（注意第 91 行断言 publish 返回 201）。
- 循环引用：`test/integration/gateway.test.ts:306-332`。
- 快速开始步骤：`test/integration/setup.test.ts:158-175`。
- 各集成测试在 beforeAll 中调用 `/admin/config/publish`；多数断言已接受 `[200, 201]`。

## 8. 自动发布设计摘要

- 新增 `autoPublish(env, { createdBy, reason })`：加载 + 校验；有 error 返回 `applied=false` 与 issues；合法则调用 `publishConfig`；基础设施失败返回 `applied=false` + error。
- 写接口统一通过 `configMutationResponse` 返回 `{ ...body, config: outcome }`，审计记录 `configVersion/configApplied`。
- 非法写入保留 D1、旧版本继续服务；下一次合法写入自动收敛。
- 回滚恢复 D1（单 D1 batch 重建六张表）后再切 KV 指针。
- 定时维护末尾调用一次 `autoPublish` 做自愈与升级后收敛。
- 手动 publish API 保留为兼容/故障恢复入口，管理台移除。

## 9. 注意事项

- 账户明文 `apiKey` 会随每次自动发布进入 `config_versions.payload` 与 KV；需在文档中提示版本清理与访问控制（见 `.trellis/spec/backend/security-guidelines.md`）。
- `config_versions.version` 为 `INTEGER PRIMARY KEY AUTOINCREMENT`，当前发布用 `MAX+1` 显式分配；并发下可能冲突，`autoPublish` 失败应可观测并可重试。
- 不新增数据库迁移。
