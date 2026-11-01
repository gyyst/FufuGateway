# Implement: 保存即自动发布配置

> 待确认决策：3.2 非法配置采用“保存但不生效”；3.3 回滚采用“恢复 D1 并重新激活目标版本”。确认后再 `task.py start`。

## 1. 核心发布能力

- [ ] `src/config/snapshot.ts`
  - [ ] 新增 `AutoPublishResult`：`applied / unchanged / version / checksum / issues / error?`。
  - [ ] 新增 `autoPublish(env, { createdBy?, reason })`：
    - 先 `loadConfigData` + `validateSnapshot`；存在 error 时返回 `applied=false` 与 issues，不写版本。
    - 合法时调用 `publishConfig`，`note` 使用 `auto:<reason>`；返回结果。
    - 捕获 `CONFIG_INVALID` / `INTERNAL_ERROR`：返回 `applied=false`、当前活跃版本、错误信息；issues 截断 50 条。
    - 不吞掉异常栈：基础设施失败记录 `console.warn` 结构化日志。
- [ ] `src/config/repository.ts`
  - [ ] 抽出 `providerStatement / accountStatement / modelStatement / comboStatement / pricingStatement / settingStatement`，现有 `replace*` 复用，保持列与序列化一致。
  - [ ] 新增 `restoreConfigData(db, data)`：
    - 单 `db.batch`：按依赖顺序 DELETE 六张配置表，再 INSERT 快照记录。
    - `system_settings` 从 `RuntimeSettings` 反向写入全部 12 个键（含默认值），保证重新加载后 checksum 与快照一致。
    - 不触碰用户、API Key、用量、审计表。
- [ ] `src/config/snapshot.ts` 改造 `rollbackConfig`
  - [ ] 解析目标 payload，校验；含非空 `aliases` / `wildcards` 时抛 `CONFIG_INVALID`。
  - [ ] 先 `restoreConfigData`，再写 KV 快照与指针；更新状态（当前 published → rolled_back，目标 → published）。
  - [ ] KV 失败时抛 `INTERNAL_ERROR`，D1 已恢复；重试回滚幂等。
  - [ ] `clearConfigCache`，返回 `unchanged` 语义与版本信息。

## 2. 管理端接线

- [ ] `src/admin/shared.ts`
  - [ ] 新增 `currentActorId(c)`（复用 `recordAudit` 的取法）。
  - [ ] 新增 `configMutationResponse(c, action, targetType, targetId, details, body, status)`：
    - 调用 `autoPublish`。
    - 审计 details 合并 `configVersion`、`configApplied`、`configUnchanged`。
    - 返回 `{ ...body, config: outcome }`。
- [ ] `src/admin/handlers/providers.ts`
  - [ ] `createProviderHandler`、`updateProviderHandler`、`deleteProviderHandler`。
  - [ ] `createAccountHandler`、`updateAccountHandler`、`deleteAccountHandler`。
  - [ ] `syncModelsHandler`：同步完成后自动发布，响应附 `config`。
  - [ ] 删除原有分散的 `recordAudit` 调用，统一走 `configMutationResponse`。
- [ ] `src/admin/handlers/models.ts`
  - [ ] 模型 create/update/delete、pricing create/delete 全部接入。
- [ ] `src/admin/handlers/combos.ts`
  - [ ] Combo create/update/delete 全部接入；validate/preview 保持只读。
- [ ] `src/admin/handlers/settings.ts`
  - [ ] 批量写入后自动发布一次；移除“需发布”文案，响应附 `config`。
- [ ] `src/maintenance.ts`
  - [ ] `handleScheduled` 在模型同步后执行一次 `autoPublish(env, { createdBy: "system", reason: "maintenance" })`，用于自愈与升级后未发布变更；日志记录结果。
- [ ] `src/admin/handlers/setup.ts`
  - [ ] 移除 `publish` 步骤；`configPublished` 语义改为“存在生效版本且 D1 无分叉且校验通过”；`readyForInference` 同步调整。

## 3. 管理台 UI

- [ ] `public/ui-static/app.js`
  - [ ] 新增 `notifyConfigOutcome(result, okMessage)`：按 `result.config` 提示“已生效 vN / 未生效 + 错误数”。
  - [ ] CRUD 保存与删除（`openEntityForm`、`removeEntity`）、账户增删改、模型启停、同步模型、设置保存改用该提示。
  - [ ] 顶部状态条：`待发布` 改为 `未同步`（仅发布失败或校验失败时出现）。
  - [ ] 配置页：
    - 移除“发布配置”按钮与发布弹窗逻辑；保留“校验配置”。
    - 卡片“待发布”改为“同步状态”；有分叉时显示只读告警与校验问题。
    - 仅当 `pendingChanges && validation.valid` 时提供“重试生效”按钮，调用保留的 publish API（故障恢复，不是日常步骤）。
    - 设置提示改为“保存后自动生效，最迟约 60 秒”。
  - [ ] 快速开始页：移除发布按钮与相关文案；配置版本卡片提示“自动同步”。
  - [ ] Provider 快速操作弹窗：移除“去发布配置”，更新底部提示；同步完成提示包含 `config` 结果。
  - [ ] 概览页：移除“未发布/待发布”文案，改为“未生效/未同步”。

## 4. 文档与示例

- [ ] `README.md`：架构描述、首次配置第 6 步、已知限制（60 秒传播）。
- [ ] `docs/ARCHITECTURE.md`：配置发布流程改为写入即发布。
- [ ] `docs/API.md`：写入接口新增 `config` 字段；`/admin/config/publish` 标记 deprecated；回滚恢复 D1 说明。
- [ ] `docs/DEPLOY.md`：部署步骤移除手动发布；说明升级后首次写入/每日维护自动发布。
- [ ] `examples/bootstrap.sh`：移除 `POST /admin/config/publish`。
- [ ] `.trellis/spec/backend/security-guidelines.md`（如涉及）：补充自动发布导致版本增多、明文 Key 历史保留的提示。

## 5. 测试

- [ ] 更新 `test/integration/config.test.ts`
  - [ ] beforeAll 创建实体后从 `/admin/config/current` 获取版本；手动 publish 断言改为 `[200, 201]`。
  - [ ] 新增：新增模型后无需 publish 即可推理。
  - [ ] 新增：Combo 循环引用写入返回 201 且 `config.applied=false`，旧版本仍可推理；删除后自动收敛。
  - [ ] 新增：回滚恢复 D1，被回滚模型不存在，后续保存不复活。
- [ ] `test/integration/gateway.test.ts`
  - [ ] 循环引用测试保留 publish 400 断言；补充写入响应的 `config.applied=false`。
- [ ] 新增 `test/integration/auto-publish.test.ts`（或并入 config.test.ts）
  - [ ] Provider/账户/模型/Combo/设置写入后自动生成版本。
  - [ ] `sync-models` 自动发布。
  - [ ] 手动 publish 在无变化时返回 200 + `unchanged=true`。
- [ ] 检查 `setup.test.ts` 步骤断言，移除对 publish 步骤的隐含依赖。
- [ ] 全量回归：`npm run typecheck`、`npm test`、`npm run deploy:dry-run`。

## 6. 验证命令

```bash
npm run typecheck
npx vitest run test/integration/config.test.ts test/integration/gateway.test.ts test/integration/setup.test.ts test/integration/provider-accounts.test.ts
npm test
npm run deploy:dry-run
```

## 7. 风险文件与回滚点

| 文件 | 风险 | 回滚方式 |
|------|------|----------|
| `src/config/snapshot.ts` | 自动发布/回滚核心逻辑 | `git restore` 单文件 |
| `src/config/repository.ts` | 语句构造重构、D1 重建 | 保留原 `replace*` 行为，先跑集成测试 |
| `src/admin/shared.ts` | 所有写接口响应契约 | 可移除 `config` 字段回到旧响应 |
| `public/ui-static/app.js` | 管理台流程 | 静态资源随 Worker 回滚 |

不涉及数据库迁移；回滚代码版本即可恢复旧的发布流程。

## 8. 完成标准

- [ ] PRD R1-R8 全部满足，验收标准逐条通过。
- [ ] 正常保存无需任何发布操作即可在缓存 TTL 内生效。
- [ ] 非法保存不会中断旧版本服务，且管理台明确提示未生效原因。
- [ ] 回滚后 D1 与生效版本一致，后续保存不会撤销回滚。
- [ ] typecheck、全量测试、deploy dry-run 通过。
