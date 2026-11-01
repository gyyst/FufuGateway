# 调研基线：别名并入 Combo

## 1. 现状

- `AliasRecord`：id、name、target（RouteTargetSpec，单目标）、priority、enabled、description、时间戳。
- 路由顺序：Provider 前缀 → 原生模型 → **Alias 精确匹配** → Combo 精确匹配 → glob Combo。
- `RuntimeConfig.aliasesByName` 用于 alias 解析；`resolveTargetSpec` 的 `{alias}` 分支递归解析 alias 目标并做循环检测。
- 校验：
  - Alias 名称/重复/与模型/Provider 冲突、与 Combo 同名冲突。
  - `validateCombos(combos, aliases, options)` 使用别名展开引用图与循环。
- API：`/admin/aliases` CRUD；`admin/handlers/routing.ts` 仅剩 alias handlers。
- 数据库：`model_aliases(id, name, target, priority, enabled, description, created_at, updated_at)`。
- 前端：`state.aliases`、别名页、导航、命令面板分组、路由目标下拉「别名」分组、`{alias}` 目标。
- 测试：`router.test.ts` 的 alias 精确匹配/循环；`combo-normalize.test.ts` 的 alias 引用；`test/integration/gateway.test.ts` 引用 alias。

## 2. 合并设计决策

1. **别名等价于单节点 Combo**：
   - `nodes = [target]`，`strategy = "fallback"`，沿用 `priority`、`enabled`、`description`、时间戳。
   - 别名目标中的 `{model}`/`{alias}`/`{combo}` 直接作为节点；`{alias}` 兼容解析为按名称引用 Combo。
2. **匹配顺序**：Provider 前缀 → 原生模型 → 精确 Combo → glob Combo。别名与 Combo 历史上禁止同名，合并无歧义。
3. **兼容**：
   - 旧快照中的 `aliases` 在运行时合成为单节点 Combo（priority、fallback），无需立即重新发布。
   - `{alias: "x"}` 目标保留为 deprecated 输入，等价于 `{combo: "x"}`。
4. **迁移** `0006_unify_aliases_into_combos.sql`：
   - `nodes` 由 `target` JSON 包裹为数组：`'[' || target || ']'`。
   - 名称冲突时追加 `-alias-xxxx`（历史校验通常已避免同名）。
   - 删除 `model_aliases` 表。
5. **校验**：
   - 删除 alias 实体校验；Combo 名称沿用现有规则（不含斜杠、不与模型/Provider/Combo 冲突）。
   - `validateCombos(combos, options)` 去掉 aliases 参数；`{alias}` 目标按 Combo 校验。
   - 名称唯一性冲突检查合并到 Combo 集合。
6. **API**：
   - 删除 `/admin/aliases*`；删除 `handlers/routing.ts`（只剩 alias）。
   - `assertVirtualNameAvailable` 只检查 Combo/模型/Provider；`validateVirtualName` 仅剩 combo。
7. **前端**：
   - 删除 `state.aliases`、`/admin/aliases` 请求、别名页、导航、命令面板分组。
   - 路由目标下拉删除「别名」分组；`{alias}` 兼容显示为 Combo。
   - `#/aliases` 重定向 `#/combos`。
8. **文档与测试**：
   - README/API/COMBOS 更新：别名即单节点 Combo。
   - 更新 router/combo 测试与集成测试。

## 3. 风险

- 别名循环检测转移到 Combo 校验（已有循环测试）。
- 旧快照兼容与迁移一致性。
- 删除别名 API 影响外部脚本（管理台为唯一客户端，文档注明）。
- 别名与 Combo 同名历史数据可能导致迁移冲突，迁移使用后缀兜底。
