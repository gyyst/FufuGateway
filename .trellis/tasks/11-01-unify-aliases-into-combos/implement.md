# 实施计划：别名并入 Combo

> 未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线确认

- [ ] 工作区干净，通配符合并已提交。
- [ ] 备份本地 D1：
  ```bash
  npx wrangler d1 export fufu-gateway --local --output .wrangler/backup-before-alias-unify.sql
  ```
- [ ] 基线：`npm run typecheck`、`npm test`、`npm run deploy:dry-run`。

## 1. 类型、仓储与运行时

- [ ] `src/combo/types.ts`：`RouteMatch` 删除 `alias` 类型；`RouteTargetSpec` 保留 `{alias}`（deprecated）。
- [ ] `src/config/types.ts`：
  - 删除 `AliasRecord`；新增 `LegacyAliasRecord`。
  - `ConfigSnapshotData.aliases` 改为可选 legacy。
  - `RuntimeConfig` 删除 `aliasesByName`。
- [ ] `src/config/repository.ts`：删除 alias 映射/CRUD；`loadConfigData` 去掉 aliases。
- [ ] `src/config/runtime.ts`：legacy aliases 合成为单节点 Combo，加入 `combosByName`（必要时 globCombos）。
- [ ] 迁移 `migrations/0006_unify_aliases_into_combos.sql`：迁移、冲突后缀、删表。

## 2. 路由与校验

- [ ] `src/router/resolver.ts`：删除 alias 匹配步骤与 `{alias}` 递归分支；`{alias}` 等价 `{combo}`。
- [ ] `src/config/validate.ts`：删除 alias 校验块与目标循环；`validateCombos(combos, options)`。
- [ ] `src/combo/validator.ts`：删除 aliases 参数与 aliasMap；`{alias}` 目标按 Combo 收集引用。
- [ ] `src/admin/schemas.ts`：删除 alias schemas。
- [ ] `src/admin/routes.ts`：删除 `/admin/aliases*` 与 import。
- [ ] 删除 `src/admin/handlers/routing.ts`。
- [ ] `src/admin/shared.ts`：删除 alias 查询与 `validateVirtualName` 的 alias 分支。

## 3. 测试更新

- [ ] `test/unit/router.test.ts`：alias 精确匹配改为 Combo；保留 `{alias}` 兼容用例；删除 alias 循环用例（由 Combo 循环覆盖）。
- [ ] `test/unit/combo-normalize.test.ts`：alias 引用改为 Combo。
- [ ] `test/integration/gateway.test.ts`：更新 alias 相关用例。
- [ ] 运行 `npm run typecheck`、`npm test`。

## 4. 前端

- [ ] `app.js`：删除 `state.aliases` 与请求、`aliasFields`、`entities.aliases`、`renderers.aliases`、命令面板别名分组、`routeTargetEntries` 别名分组。
- [ ] `routeTargetLabel`：`{alias}` 兼容显示为 Combo。
- [ ] 导航删除「别名」；`#/aliases` 重定向 Combo。
- [ ] 验证：导航、重定向、Combo 列表、路由诊断、命令面板。

## 5. 文档

- [ ] README/docs/API.md/docs/COMBOS.md：别名 = 单节点 Combo；`/admin/aliases*` 已删除。
- [ ] 升级说明：备份 → 迁移 → 发布配置。

## 6. 全量验证与清理

- [ ] `npm run typecheck`、`npm test`、`npm run deploy:dry-run`。
- [ ] Playwright 走查：迁移后的别名以 Combo 出现；原别名名称解析命中；`#/aliases` 重定向；命令面板。
- [ ] 清理临时数据与截图。
- [ ] `git status` 仅包含预期文件；`package.json` 未变。

## 7. 评审门禁

- [ ] 迁移不覆盖现有 Combo。
- [ ] 旧快照无需重新发布即可保持别名行为。
- [ ] `{alias}` 兼容路径有测试。
- [ ] 删除 API 后前端无残留调用。
- [ ] 无新增依赖。

## 8. 回滚点

- 迁移不可逆：上线前备份 D1。
- 代码按提交回退；数据库需从备份恢复。

## 9. 完成记录

- 完成日期：2026-11-01
- 状态：实现与本地验证完成，待提交
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：24 个测试文件、230 项测试全部通过
  - `npm run deploy:dry-run`：通过
  - 本地迁移：`0006_unify_aliases_into_combos.sql` 应用成功
  - 迁移转换模拟：对象与字符串 target 的旧别名均正确转为单节点 Combo（`nodes:[target]`、`fallback`、priority 保留）
  - 路由验证：单节点 Combo `fast` 解析为 `combo`
  - Playwright 走查：导航无「别名」；`#/aliases` 重定向 `#/combos`；命令面板分组无别名；Combo 节点目标下拉无别名；Combo 列表正常
- 实现偏差：
  - 旧快照中的别名在运行时合成为单节点 Combo，发布后快照收敛。
  - `/admin/aliases*` 已删除，管理台是唯一已知客户端。
  - 本地备份位于 `.wrangler/backup-before-alias-unify.sql`（已忽略）。
- 已知限制：
  - 迁移不可逆；升级前需备份 D1。
  - 旧 `{ alias }` 目标保留兼容，但新配置只写 `{ combo }`。
  - 工作区仍有与本任务无关的未跟踪临时文件，未处理。
- 提交：`12ea344`（后端合并与迁移）、`ac56306`（前端与导航）。
