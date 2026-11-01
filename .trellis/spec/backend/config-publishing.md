# 配置自动发布规范

> 配置写入、自动发布、响应契约与回滚恢复的可执行契约。涉及 `src/config/**`、管理端写接口、管理台配置页与相关测试时必须先读本文。

---

## Scenario: 配置写入自动发布与回滚恢复

### 1. Scope / Trigger

以下改动必须遵守本规范：

- 新增/修改任何会进入 `ConfigSnapshotData` 的写接口（Provider、账户、模型、价格、Combo、系统设置、模型同步）。
- 修改 `publishConfig` / `autoPublish` / `rollbackConfig` / `restoreConfigData`。
- 修改配置写入响应结构或管理台配置页。
- 修改 `RuntimeSettings` 字段或 `system_settings` 键。

### 2. Signatures

```ts
// src/config/snapshot.ts
export interface AutoPublishResult {
  applied: boolean;
  unchanged: boolean;
  version: number | null;
  checksum: string | null;
  issues: ConfigValidationIssue[];
  error?: { code: string; message: string };
}

export async function autoPublish(
  env: GatewayEnv,
  options: { createdBy?: string; reason: string },
): Promise<AutoPublishResult>;

export async function rollbackConfig(
  env: GatewayEnv,
  version: number,
  options?: PublishOptions,
): Promise<PublishResult>;

// src/config/repository.ts
export async function restoreConfigData(
  db: D1Database,
  data: ConfigSnapshotData,
): Promise<void>;

export const RUNTIME_SETTING_KEYS: readonly string[];

// src/admin/shared.ts
export async function configMutationResponse(
  c: Context<AppEnv>,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
  status?: 200 | 201,
): Promise<Response>;
```

### 3. Contracts

**配置数据**

- `ConfigSnapshotData` 固定由 `providers / accounts / models / combos / pricing / settings` 组成。
- 写入顺序：先完成实体 D1 写入，再调用 `autoPublish`；不要先发布后写实体。
- 所有配置写接口必须通过 `configMutationResponse` 返回，禁止各自拼装发布逻辑。

**响应契约**

配置写接口保留原有字段与状态码（创建为 201），并追加顶层 `config`：

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

- `applied=true`：当前 D1 配置已成为生效版本；`unchanged=true` 表示 checksum 与当前版本一致，未新建版本。
- `applied=false`：实体写入已保存但未生效，旧版本继续服务。
- `issues` 最多 50 条；基础设施失败时附带 `error: { code, message }`。
- 审计 details 必须含 `configVersion`、`configApplied`、`configUnchanged`；禁止写入凭据。

**自动发布语义**

- 先 `loadConfigData` + `validateSnapshot`；存在 `severity=error` 时不生成版本，返回 `applied=false`。
- 合法时调用 `publishConfig`，版本 note 为 `auto:<reason>`。
- 非法配置保留 D1 写入；下一次合法写入或每日维护会收敛。
- `autoPublish` 不得向调用方抛异常；所有失败通过返回值暴露并记录 `config.auto_publish_failed` 结构化日志。

**回滚语义**

- 回滚必须先用单个 D1 batch 重建六类配置表，再切换 KV 快照与当前指针；只切 KV 会被下一次保存覆盖。
- 目标快照含非空 `aliases` / `wildcards` 时拒绝，返回 `CONFIG_INVALID`。
- 恢复后 `loadConfigData` 的 checksum 必须与目标版本一致；设置字段缺失时用 `DEFAULT_RUNTIME_SETTINGS` 补齐。
- D1 恢复失败返回可重试 `INTERNAL_ERROR`；KV 切换失败同样返回可重试 `INTERNAL_ERROR`，重试必须幂等。
- 回滚不触碰用户、API Key、用量与审计表。

**设置键**

- `SETTING_KEY_MAP` 是 `RuntimeSettings` 字段与 `system_settings` 键的唯一映射。
- 管理接口允许键由 `RUNTIME_SETTING_KEYS` 派生，禁止另写一份 allowlist。
- 恢复设置时写入全部 12 个键（含默认值），保证重新加载得到完整 `RuntimeSettings`。

**传播**

- `publishConfig` 只清理当前 isolate 内存缓存；跨实例生效受 `config.cache_ttl_ms`（默认 60 秒）与 KV 传播限制。
- 文案必须写“最迟约 60 秒”，不得承诺即时生效。

### 4. Validation & Error Matrix

| 条件 | 实体响应 | `config` 结果 |
|------|----------|---------------|
| 合法且 checksum 变化 | 200/201 | `applied=true, unchanged=false, version=新版本` |
| 合法且 checksum 未变化 | 200/201 | `applied=true, unchanged=true, version=当前版本` |
| 校验存在 error | 200/201（写入保留） | `applied=false, version=旧版本, issues=[...]` |
| 加载/发布/KV 故障 | 200/201（写入保留） | `applied=false, error={code,message}`，旧版本继续服务 |
| `POST /admin/config/publish` 校验失败 | 400 | `CONFIG_INVALID`，不切换版本 |
| 回滚目标不存在/损坏 | 400 | `NOT_FOUND` / `CONFIG_INVALID` |
| 回滚目标含旧版 aliases/wildcards | 400 | `CONFIG_INVALID`，D1 不变 |
| 回滚恢复 D1 或切 KV 失败 | 500 | `INTERNAL_ERROR`，`retriable=true` |

### 5. Good / Base / Bad Cases

- Good：创建模型 → D1 写入 → `autoPublish` 生成新版本 → 响应 `config.applied=true` → 推理立即可路由（缓存 TTL 内）。
- Base：创建引用尚不存在目标的 Combo → 返回 201 + `config.applied=false` + 校验错误；创建目标后自动收敛。
- Bad：写接口只写 D1 不调用 `autoPublish`，用户必须手动发布。
- Bad：回滚只切 KV 指针，下一次保存重新发布 D1 并撤销回滚。
- Bad：为每个 handler 复制一套发布、审计与响应拼装逻辑。
- Bad：在管理响应或审计 details 中返回账户 `apiKey`。

### 6. Tests Required

- `test/integration/auto-publish.test.ts`：Provider/账户/模型/Combo/设置/`sync-models` 写入后自动发布；无变化的手动 publish 返回 200 + `unchanged=true`。
- `test/integration/config.test.ts`：新增模型无需发布即可推理；非法 Combo 循环写入返回 201 + `config.applied=false` 且旧版本继续服务；删除后自动收敛；回滚后后续保存不复活被回滚数据。
- `test/integration/rollback-restore.test.ts`：六类表 + 设置恢复后 `pendingChanges=false`；回滚到当前版本幂等；拒绝旧版 aliases/wildcards；旧快照缺设置字段用默认值补齐。
- `test/integration/gateway.test.ts`：循环引用写入 `config.applied=false`，手动 publish 返回 400。

断言点：响应顶层 `config` 字段、`applied/unchanged/version`、`/admin/config/current` 的 `pendingChanges`、版本状态 `published/rolled_back`、D1 列表在回滚后的增减。

### 7. Wrong vs Correct

#### Wrong

```ts
// handler 写完 D1 直接返回，依赖用户手动发布
await replaceModel(c.env.DB, updated);
await recordAudit(c, "model.update", "model", updated.id, { modelId: updated.modelId });
return c.json({ data: updated });
```

#### Correct

```ts
await replaceModel(c.env.DB, updated);
return configMutationResponse(
  c,
  "model.update",
  "model",
  updated.id,
  { modelId: updated.modelId },
  { data: updated },
);
```

#### Wrong

```ts
// 回滚只切 KV，D1 仍是新配置
await env.CONFIG_KV.put(CONFIG_CURRENT_KEY, String(version));
```

#### Correct

```ts
await restoreConfigData(env.DB, snapshot.data); // 单个 D1 batch 重建六类配置表
await env.CONFIG_KV.put(configSnapshotKey(version), row.payload);
await env.CONFIG_KV.put(CONFIG_CURRENT_KEY, String(version));
```
