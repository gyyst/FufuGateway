# Design: 保存即自动发布配置

## 1. 目标与约束

- 取消管理端手动“发布配置”环节：每次有效配置写入自动生成版本并切换生效。
- 保留 `config_versions` 历史与回滚能力。
- 不修改数据库表结构与 KV 快照格式。
- 跨 isolate 生效仍受 `config.cache_ttl_ms`（默认 60 秒）与 KV 传播限制，不承诺强一致即时生效。

## 2. 现状关键路径

1. 写路径：管理端各 CRUD handler → `src/config/repository.ts` 写 D1；不会自动发布。
2. 发布：`POST /admin/config/publish` → `publishConfig`（`src/config/snapshot.ts:63-125`）：
   校验 → checksum 去重 → 写 `config_versions` → 写 KV 快照与当前指针 → 旧版本标记 superseded → 清理本 isolate 缓存。
3. 读取：`loadRuntimeConfig`（`src/config/cache.ts:81-104`）优先 KV 当前指针，无版本时回退 D1，内存缓存默认 60 秒。
4. 回滚：`rollbackConfig`（`src/config/snapshot.ts:128-170`）只切 KV 指针，不修改 D1。
5. 校验：Provider 无账户仅为 warning；启用 Combo 的无法解析目标、重名、账户无凭据、设置越界等为 error（`src/config/validate.ts`）。

## 3. 核心决策

### 3.1 自动发布触发点

所有会进入 `ConfigSnapshotData` 的写入都必须触发自动发布：

| 路径 | action |
|------|--------|
| `POST/PUT/DELETE /admin/providers` | `provider.create/update/delete` |
| `POST/PUT/DELETE /admin/providers/:id/accounts` | `account.create/update/delete` |
| `POST /admin/providers/:id/sync-models` | `provider.sync_models` |
| `POST/PUT/DELETE /admin/models` | `model.create/update/delete` |
| `POST/DELETE /admin/pricing` | `pricing.create/delete` |
| `POST/PUT/DELETE /admin/combos` | `combo.create/update/delete` |
| `PUT /admin/settings` | `settings.update` |
| 每日定时同步（`src/maintenance.ts`） | `maintenance` |

非配置写入（用户、API Key、请求日志、用量）不触发。

### 3.2 非法配置的保存语义（拟定，需确认）

采用“保存但不生效”：

- 写入 D1 成功后调用自动发布。
- 校验存在 error 时：不生成新版本，旧生效版本继续服务；写入本身保留。
- 响应仍返回实体写入成功状态码（200/201），附加 `config` 结果，包含 `applied=false` 与校验问题。
- 下一次写入使配置恢复合法时，自动发布会把累计变更一次性生效。
- 基础设施失败（如 KV 写入失败）：写入保留，返回 `applied=false` + `error`，旧版本继续服务。

理由：严格“校验失败就拒绝写入”会破坏增量编辑。例如 `gateway.test.ts:306-332` 覆盖“先创建引用 cycle-b 的 cycle-a，再创建 cycle-b”的合法中间态；删除被启用 Combo 引用的 Provider 也会产生暂时非法状态。直接拒绝会让这些操作无法逐步完成。

### 3.3 回滚语义（拟定，需确认）

自动发布后，D1 是新配置源。若回滚仍只切 KV 指针，下一次任意保存会重新发布 D1 并覆盖回滚。因此回滚必须同时恢复 D1：

1. 读取目标版本 payload 并校验。
2. 拒绝包含旧版 `aliases` / `wildcards` 的快照（当前表结构无法无损还原），返回 `CONFIG_INVALID`。
3. 用单个 D1 batch 原子重建 `providers / provider_accounts / models / combos / pricing / system_settings`。
4. 写 KV 快照与当前指针到目标版本，更新版本状态（当前 published → rolled_back，目标 → published）。
5. 清理本 isolate 缓存。

恢复后目标版本 checksum 与 D1 一致，后续保存不会复活被回滚掉的配置。

已知限制：

- 升级前用加密字段保存的旧版本（账户无 `apiKey`）会在校验阶段因“账户无凭据”被拒绝，属预期保护。
- 回滚会恢复旧账户凭据，可能重新启用已删除的上游 Key，需在文档中提示。

### 3.4 手动发布 API

保留 `POST /admin/config/publish`：

- 作为兼容入口与故障恢复手段（KV 写失败后可重试）。
- 从管理台正常流程与快速开始中移除。
- 文档标记为 deprecated，不再作为日常步骤。

### 3.5 响应契约

所有配置写入响应新增顶层 `config` 字段（不破坏现有字段）：

```json
{
  "data": { "...": "原实体数据" },
  "config": {
    "applied": true,
    "unchanged": false,
    "version": 7,
    "checksum": "…",
    "issues": [{ "severity": "warning", "code": "PROVIDER_NO_ACCOUNT", "message": "…" }]
  }
}
```

失败示例：

```json
{
  "data": { "...": "原实体数据" },
  "config": {
    "applied": false,
    "unchanged": false,
    "version": 6,
    "checksum": null,
    "issues": [{ "severity": "error", "code": "COMBO_CYCLE_DETECTED", "message": "…" }]
  }
}
```

- `applied=true` 且 `unchanged=true` 表示配置与当前生效版本一致，未新增版本。
- `applied=false` 时 `version` 为仍然生效的旧版本（可能为 null）。
- `issues` 截断到 50 条，避免响应过大。

### 3.6 缓存与传播

- `publishConfig` 已调用 `clearConfigCache()`，但只影响当前 isolate。
- 其他 isolate 最长在 `config.cache_ttl_ms` 后读取新版本；文档与管理台文案统一写“最迟约 60 秒生效”。
- 不新增配置广播机制，避免本轮扩大范围。

### 3.7 版本分配与并发

- 现有 `SELECT MAX(version)+1` + INSERT 存在并发竞争；管理端写入频率低，保持现状。
- 并发冲突时 `autoPublish` 返回 `applied=false`，下一次写入或手动 publish 可恢复。设计上接受这一失败窗口。

### 3.8 升级兼容

- 不新增迁移。
- 升级前 D1 中存在未发布变更时：下一次配置写入会自动发布；每日维护也会尝试一次自动发布；`POST /admin/config/publish` 仍可立即触发。
- 旧版本快照保留，回滚限制见 3.3。

## 4. 数据流

写入：

```text
Admin handler
  → repository 写 D1
  → autoPublish
      → loadConfigData + validateSnapshot
      → 有 error：返回 applied=false（旧版本继续生效）
      → 无 error：publishConfig（版本、KV、指针、清缓存）
  → 记录审计（含 configVersion / configApplied）
  → 返回实体数据 + config 结果
```

回滚：

```text
POST /admin/config/rollback
  → 读取目标版本 payload + 校验
  → restoreConfigData（单 batch 重建 6 张配置表）
  → 写 KV 快照与指针、更新版本状态
  → clearConfigCache
```

## 5. 代码改动点

| 文件 | 改动 |
|------|------|
| `src/config/snapshot.ts` | 新增 `AutoPublishResult`、`autoPublish`；改造 `rollbackConfig` |
| `src/config/repository.ts` | 抽出可复用的 INSERT 语句构造；新增 `restoreConfigData` |
| `src/admin/shared.ts` | 新增 `configMutationResponse`（自动发布 + 审计 + 统一响应） |
| `src/admin/handlers/providers.ts` | 所有写接口改用统一响应；同步模型后自动发布 |
| `src/admin/handlers/models.ts` | 模型/价格写接口改用统一响应 |
| `src/admin/handlers/combos.ts` | Combo 写接口改用统一响应 |
| `src/admin/handlers/settings.ts` | 保存后自动发布，更新提示文案 |
| `src/maintenance.ts` | 定时任务末尾执行一次 `autoPublish` 自愈 |
| `src/admin/handlers/setup.ts` | 移除“发布配置版本”步骤与相关文案 |
| `public/ui-static/app.js` | 移除发布按钮/横幅；展示自动生效结果；调整状态与提示 |
| `test/integration/*` | 更新发布断言；新增自动发布、非法保存、回滚恢复测试 |
| `README.md`、`docs/*`、`examples/bootstrap.sh` | 更新流程与文案 |

## 6. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 回滚重建 D1 出错导致配置部分恢复 | 单 D1 batch 原子执行；先校验；失败时不切 KV 指针 |
| 非法保存导致 D1 与生效版本分叉 | `pendingChanges` 与校验问题在管理台显著提示；下一次合法保存自动收敛 |
| 每次写入增加 D1/KV 开销 | 管理端写入频率低；checksum 未变化时不新增版本 |
| 版本膨胀包含明文 Key | 文档提示定期清理历史版本；沿用现有安全说明 |
| 跨 isolate 生效延迟 | 文案明确“最迟约 60 秒”；不承诺即时 |
| 回滚恢复已删除的上游 Key | 文档明确回滚会恢复快照中的凭据 |

## 7. 测试策略

- 单元/集成：
  - 创建 Provider/账户/模型/Combo/设置后无需 publish，`/admin/config/current` 立即显示新版本。
  - 相同配置再次 publish 返回 `unchanged` 且不新增版本。
  - 非法配置写入返回 200/201 + `config.applied=false`，旧版本继续服务；修复后自动收敛。
  - 回滚恢复 D1：被回滚的模型不再存在，后续保存不会复活。
  - `sync-models` 自动发布。
- 回归：`npm run typecheck`、`npm test`、`npm run deploy:dry-run`。
