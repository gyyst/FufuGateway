# 实施计划：模型能力自动识别

> 未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线

- [ ] 确认工作区干净、当前分支为 `main`。
- [ ] 运行基线检查：
  ```bash
  npm run typecheck
  npm test
  npm run deploy:dry-run
  ```
- [ ] 记录基线测试数量与结果。

## 1. 数据模型与持久化

- [x] `src/config/types.ts`
  - 新增 `ModelMetadataSource = "manual" | "upstream" | "models.dev" | "unknown"`。
  - `ModelRecord` 新增可选 `metadataSource`、`metadataUpdatedAt`。
- [x] `migrations/0008_model_metadata_source.sql`
  - `ALTER TABLE models ADD COLUMN metadata_source TEXT NOT NULL DEFAULT 'manual';`
  - `ALTER TABLE models ADD COLUMN metadata_updated_at INTEGER;`
  - `UPDATE models SET metadata_source = 'unknown' WHERE source = 'sync';`
- [x] `src/config/repository.ts`
  - `ModelRow` 增加 `metadata_source`、`metadata_updated_at`。
  - `mapModel()` 映射新字段，缺省 `unknown`。
  - `CreateModelInput` 增加 `metadataSource`、`metadataUpdatedAt`。
  - `createModel()` 默认 `metadataSource = "manual"`。
  - `replaceModel()` 写入/更新新列。
- [x] `src/admin/handlers/models.ts`
  - 手工创建：`metadataSource = "manual"`、`metadataUpdatedAt = now`。
  - 更新：出现任意能力字段时标记 `manual` 并更新时间；仅改 `enabled`/`displayName`/价格时保留原来源。
- [x] 运行：
  ```bash
  npm run typecheck
  npm test -- test/integration/config.test.ts
  ```

## 2. 上游 `/models` 元数据解析

- [x] `src/providers/transport.ts`
  - 扩展 `RemoteModel` 字段。
  - 提取通用 helper：
    - `firstNumber(record, keys)`。
    - `modalityList(value)`：字符串数组/逗号字符串 → 输入/输出模态。
    - `firstBoolean(record, keys)`。
  - 更新 `parseOpenAIModels()`：
    - 上下文、最大输出、模态、能力、OpenRouter 价格。
    - 未知/非法字段忽略，不抛错。
  - 更新 `parseGeminiModels()`：继续解析 context/output；存在模态字段时解析。
  - `parseAnthropicModels()` 保持现状。
- [x] 新增/扩展单元测试：
  - `test/unit/provider-metadata-parse.test.ts`
  - OpenRouter 风格、火山风格、Gemini、缺失字段、错误类型。
- [x] 运行：
  ```bash
  npm run typecheck
  npm test -- test/unit/provider-metadata-parse.test.ts test/unit/provider-paths.test.ts
  ```

## 3. models.dev 目录模块

- [x] 新增 `src/models/catalog.ts`
  - 常量：`MODELS_DEV_URL`、`MODEL_CATALOG_KV_KEY`、`MODEL_CATALOG_TTL_MS`。
  - 类型：`CatalogModel`、`CatalogProvider`、`CatalogData`、`CatalogStatus`、`CatalogMatch`。
  - `loadModelsDevCatalog()`：
    - 内存缓存 + KV + 下载 + stale fallback。
    - 15 秒超时，异常不抛出。
    - 压缩只保留所需字段。
  - `providerCatalogIds()`：`extraConfig.modelsDevProvider` → 主机映射 → 名称匹配。
  - `normalizeModelId()`、`contextFromModelId()`。
  - `findCatalogModel()`：Provider 精确/前缀/归一化 → 全局精确/归一化；跨 Provider 多数聚合，不聚合价格。
  - 索引使用 `WeakMap<CatalogData, CatalogIndex>` 懒构建。
- [x] 新增 `test/unit/model-catalog.test.ts`
  - 缓存命中、过期刷新、远端失败 stale、无缓存 unavailable、并发只下载一次。
  - Provider 主机/名称/extraConfig 匹配。
  - 模型 ID 归一化与窗口标记。
  - 全局聚合与价格不跨 Provider。
- [x] 运行：
  ```bash
  npm run typecheck
  npm test -- test/unit/model-catalog.test.ts
  ```

## 4. 元数据合并与应用

- [x] 新增 `src/models/metadata.ts`
  - `ModelMetadata` 类型。
  - `buildModelMetadata()`：上游优先、目录兜底、模态映射、能力推导、价格、来源。
  - `shouldAutoEnable()`：识别 + 文本输出 + `syncAutoEnable !== false`。
  - `applyMetadataToModel()`：只补空缺，不覆盖、不改变 `enabled`，来源只升级。
  - `liveMetadataExists()`。
- [x] 新增 `test/unit/model-metadata.test.ts`
  - 合并优先级、`pdf` → `file`、vision/audio/video 推导。
  - 纯图像输出不自动启用、未识别不启用、`syncAutoEnable=false`。
  - 存量回填只补空缺、manual 跳过、来源升级。
- [x] 运行：
  ```bash
  npm run typecheck
  npm test -- test/unit/model-metadata.test.ts
  ```

## 5. 同步编排与刷新

- [x] 修改 `src/models/sync.ts`
  - `ModelSyncResult` 增加 `autoEnabled`、`metadata`。
  - 并行拉取上游模型与 models.dev 目录。
  - 新模型写入合并元数据、`metadataSource`、`metadataUpdatedAt`。
  - `enabled = shouldAutoEnable(...)`。
  - 已存在模型跳过。
  - `requiresConfirmation = created > autoEnabled`。
  - 新增 `refreshProviderModelMetadata()`。
- [x] 修改 `src/admin/handlers/providers.ts`
  - `syncModelsHandler` 返回新统计与 note。
  - 新增 `refreshModelMetadataHandler`：
    - 无账户时只用目录。
    - 有账户时拉取 `/models`，失败降级为目录。
    - 调用 `refreshProviderModelMetadata()`。
- [x] 修改 `src/admin/routes.ts`
  - `app.post("/admin/providers/:id/refresh-model-metadata", refreshModelMetadataHandler);`
- [x] 修改 `src/maintenance.ts`
  - 定时同步复用新逻辑；日志增加 `autoEnabled`。
- [x] 新增 `test/integration/model-metadata.test.ts`
  - 假 models.dev + 假上游。
  - 同步自动填充与自动启用。
  - 未识别保持禁用。
  - 刷新只补空缺。
  - 手工编辑后刷新跳过。
  - 目录不可用仍同步成功。
  - KV 缓存复用。
- [x] 运行：
  ```bash
  npm run typecheck
  npm test -- test/integration/model-metadata.test.ts test/integration/setup.test.ts test/integration/gateway.test.ts
  ```

## 6. 管理 UI

- [x] `public/ui-static/app.js`
  - 同步确认文案与完成提示。
  - Provider 设置模型区块：
    - “刷新元数据”按钮，调用新接口。
    - 表格增加“上下文”“来源”列。
  - 模型实体列表增加“上下文”“元数据”列。
  - 模型表单 note 说明自动填充与手工覆盖。
  - Provider 扩展配置：
    - `modelsDevProvider` 文本框。
    - `syncAutoEnable` 三态选择。
    - `readProviderExtra()` 读取两个新字段。
  - 格式化上下文：`1000000` → `1M`，`128000` → `128K`。
- [x] `public/ui-static/app.css`（仅在需要时补充样式）。
- [x] 更新 `test/integration/ui.test.ts`（如包含文案断言）。
- [ ] 本地手工验证：
  ```bash
  npm run dev
  ```
  - 打开 UI，Provider 设置中可见“刷新元数据”。
  - 同步提示含自动识别说明。
  - 模型列表显示上下文与来源。

## 7. 文档

- [x] `docs/PROVIDERS.md` 第 7 节：
  - 上游字段解析、models.dev 兜底、匹配规则、自动启用、刷新接口、来源字段。
- [x] `docs/API.md`：
  - 同步响应新增字段。
  - 新增 `POST /admin/providers/:id/refresh-model-metadata`。
  - 模型对象新增 `metadataSource` / `metadataUpdatedAt`。
- [x] `README.md`：模型同步能力描述。
- [x] `docs/DEPLOY.md`：定时同步说明如涉及自动启用需更新。

## 8. 全量验证

- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run deploy:dry-run`
- [x] 检查迁移：
  ```bash
  npm run db:migrate:local
  ```
- [x] 检查无密钥/敏感信息进入日志或响应。
- [x] 检查 `git diff`，确认无无关格式化改动。
- [ ] 更新 Trellis spec（若发现可复用模式）。
- [ ] 提交并归档任务。

## 9. 回滚点

- 代码回滚：删除/回退新增模块与 handler，旧同步行为恢复；`0008` 新增列可保留。
- 行为回滚：Provider `extraConfig.syncAutoEnable = false`，同步模型全部保持禁用。
- 目录回滚：KV 键 `model_catalog:models.dev:v1` 可删除；下次同步重新下载。

## 10. 完成记录

- 实现完成日期：2026-11-07。
- 验证结果：
  - `npm run typecheck`：通过。
  - `npm test`：29 个测试文件、282 项测试全部通过。
  - `npm run deploy:dry-run`：通过。
  - `npm run db:migrate:local`：`0008_model_metadata_source.sql` 执行成功。
- 未执行项：本地 `npm run dev` 手工 UI 验证、Trellis spec 更新（本次未发现需要沉淀的新模式）、git 提交与任务归档（等待用户确认）。
