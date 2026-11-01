# 实施计划：通配符合并为 Combo、移除模型页

> 未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线确认

- [ ] 工作区干净，批次 1–3 已提交。
- [ ] 记录基线：
  ```bash
  npm run typecheck
  npm test
  npm run deploy:dry-run
  ```
- [ ] 备份本地 D1（迁移不可逆）：
  ```bash
  npx wrangler d1 export fufu-gateway --local --output .wrangler/backup-before-unify.sql
  ```
  （该文件在 `.wrangler/` 下，已被 gitignore。）

## 1. 类型与仓储

- [ ] `src/combo/types.ts`：
  - `ComboRecord` 增加 `priority: number`。
  - `RouteMatch` 增加 `combo_glob`。
  - `ComboNodeSpec`/`RouteTargetSpec` 保留 `wildcard`（标注 deprecated）。
- [ ] `src/config/types.ts`：
  - 删除 `WildcardRuleRecord`/`CompiledWildcardRule` 与 `RuntimeConfig.wildcards`。
  - `ConfigSnapshotData.wildcards` 改为可选 legacy 字段。
  - 新增 `CompiledGlobCombo` 与 `RuntimeConfig.globCombos`。
- [ ] `src/config/repository.ts`：
  - `ComboRow`/`mapCombo`/`createCombo`/`replaceCombo` 支持 priority。
  - 删除所有 wildcard 映射与 CRUD；`loadConfigData` 去掉 wildcards。
- [ ] `src/config/runtime.ts`：
  - 删除 wildcards 编译；新增 globCombos（含 legacy 快照合成与排序）。
- [ ] 迁移 `migrations/0004_unify_wildcards_into_combos.sql`：加列、迁移、删表。

## 2. 路由与校验

- [ ] `src/router/resolver.ts`：
  - `resolveExactOrWildcard`：精确 Combo（无通配符）→ glob Combo。
  - `resolveTargetSpec`：`{combo}`/`{wildcard}` 统一按 Combo 查找；删除 `resolveWildcardRule`。
  - `combo_glob` match 与 trace。
- [ ] `src/config/validate.ts`：
  - 删除 wildcard 实体校验；Combo 名称区分 exact/glob 校验。
  - 目标可达性：wildcard 目标按 glob Combo 检查。
  - 调用 `validateCombos(combos, aliases, options)`。
- [ ] `src/combo/validator.ts`：签名与 wildcard 分支改为 Combo 查找；错误文案更新。
- [ ] `src/admin/schemas.ts`：Combo 增加 priority；删除 wildcard schemas。
- [ ] `src/admin/routes.ts`：删除 wildcards 端点。
- [ ] `src/admin/handlers/combos.ts`：删除 wildcard handlers；Combo 读写 priority。

## 3. 测试更新（后端）

- [ ] `test/unit/router.test.ts`：glob Combo、精确优先、优先级/具体度、`combo_glob`。
- [ ] `test/unit/combo-normalize.test.ts`：`{wildcard}` 兼容、Combo 引用与循环。
- [ ] 配置校验测试：glob 名称非法/重复/冲突、目标可达性。
- [ ] 集成测试：`/admin/wildcards` 返回 404；Combo CRUD 带 priority；迁移后无 `wildcard_rules` 表。
- [ ] 运行：
  ```bash
  npm run typecheck
  npm test
  ```

## 4. 前端

- [ ] `app.js`：
  - 删除 `state.wildcards` 与 `/admin/wildcards` 请求。
  - `routeTargetEntries`/`routeTargetLabel`/Combo 节点：移除通配符分组，glob Combo 标注。
  - `comboFields` 增加 priority；名称帮助说明。
  - Combo 列表增加匹配类型与优先级列。
  - 导航删除「通配符」「模型」；`#/models`、`#/wildcards` 重定向 Provider。
  - 删除 `entities.wildcards`、`wildcardFields`、`renderers.wildcards`、`renderers.models`。
  - 命令面板：删除通配符组；模型条目跳 Provider 并过滤 Provider 名称。
  - 检查并更新「通配符」「模型页」相关文案。
- [ ] `app.css`：如需要，为 glob 徽章补充样式（复用 badge）。
- [ ] 验证：导航、重定向、Combo 创建/编辑、glob 命中、命令面板、亮/暗主题。

## 5. 文档

- [ ] `README.md`、`docs/API.md`、`docs/PROVIDERS.md`、`docs/DEPLOY.md` 等：
  - 通配符改为「Combo 通配符模式」。
  - 注明 `/admin/wildcards` 已删除。
  - 升级步骤：备份 → 迁移 → 发布配置。
- [ ] 配置校验错误示例更新。

## 6. 全量验证与清理

- [ ] `npm run typecheck`。
- [ ] `npm test`。
- [ ] `npm run deploy:dry-run`。
- [ ] Playwright 走查：
  - 迁移后 Combo 列表包含原通配符（本地构造数据）。
  - 创建 `gpt-*` Combo 并解析命中；精确 `gpt-4o` Combo 优先。
  - `{wildcard}` 旧引用解析。
  - `#/models`、`#/wildcards` 重定向。
  - 模型管理从 Provider「模型」操作完成。
  - 命令面板模型条目。
- [ ] 清理临时数据、截图、备份文件（备份保留在 `.wrangler/`，不提交）。
- [ ] `git status` 仅包含预期文件；`package.json` 未变。

## 7. 评审门禁

- [ ] 迁移可执行且不覆盖现有 Combo。
- [ ] 旧快照无需重新发布即可保持 glob 行为。
- [ ] `{wildcard}` 兼容路径有测试。
- [ ] 删除 API 后前端无残留调用。
- [ ] 配置校验不再产生 wildcard 实体错误。
- [ ] 无新增依赖、无内联脚本。

## 8. 回滚点

- 迁移不可逆：上线前必须备份 D1。
- 代码按提交回退；回退后数据库已无 wildcard_rules，需从备份恢复。
- 前端导航与页面删除可独立回退。

## 9. 完成记录

- 完成日期：2026-11-01
- 状态：实现与本地验证完成，待提交
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：24 个测试文件、230 项测试全部通过
  - `npm run deploy:dry-run`：通过
  - 本地迁移：`0005_unify_wildcards_into_combos.sql` 应用成功
  - 迁移转换模拟：旧 `wildcard_rules` 行正确转为 Combo（名称/策略/目标/优先级/启用状态一致）
  - 路由验证：
    - `gpt-4o` → native（原生模型优先）
    - `gpt-4p` → 精确 Combo
    - `gpt-x` → `combo_glob`（`gpt-*`）
  - Playwright 走查：导航无模型/通配符；`#/models` 重定向 Provider；Combo 列表显示匹配类型与优先级；编辑表单含优先级与通配符帮助；路由诊断展示 `combo_glob` 计划；命令面板模型条目跳 Provider 并过滤。
- 实现偏差：
  - 精确 Combo 名称仍不能与原生模型 ID 重名（原生模型优先，属既有规则）。
  - 旧配置快照在运行时合成为 glob Combo，发布新版本后快照收敛。
  - `/admin/wildcards*` 已删除，管理台是唯一已知客户端。
  - 本地备份位于 `.wrangler/backup-before-unify.sql`（已忽略，不提交）。
- 已知限制：
  - 迁移不可逆；升级前需备份 D1。
  - 旧 `{ wildcard }` 目标保留兼容，但新配置只写 `{ combo }`。
  - 工作区存在与本任务无关的未跟踪临时文件（`.acct.*`、`.cfgv1.*` 等），未处理。
- 提交：`010dc45`（后端合并与迁移）、`5a3620b`（前端与导航）。
