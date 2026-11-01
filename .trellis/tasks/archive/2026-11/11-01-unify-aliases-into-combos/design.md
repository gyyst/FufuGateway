# 技术设计：别名并入 Combo

## 1. 领域模型

### 1.1 Combo 承载别名

别名变为单节点 Combo：

```ts
{
  name: alias.name,
  description: alias.description,
  strategy: "fallback",
  nodes: [alias.target],
  priority: alias.priority,
  enabled: alias.enabled,
  createdAt / updatedAt
}
```

- `RouteTargetSpec` / `ComboNodeSpec` 保留 `{alias}` 作为 deprecated 输入（解析为按名称引用 Combo）。
- `RouteMatch` 删除 `alias` 类型（不再产生）。
- 删除 `AliasRecord`；`ConfigSnapshotData.aliases` 改为可选 legacy 字段：
  ```ts
  export interface LegacyAliasRecord {
    id: string;
    name: string;
    target: RouteTargetSpec;
    priority: number;
    enabled: boolean;
    description?: string;
    createdAt: number;
    updatedAt: number;
  }
  ```

### 1.2 运行时

- `RuntimeConfig` 删除 `aliasesByName`。
- 旧快照 `aliases` 在 `buildRuntimeConfig` 中合成为 Combo（策略 fallback、nodes `[target]`、priority），加入 `combosByName`；若名称含 `*`/`?`（历史不会出现）则同时进入 `globCombos`，编译失败则跳过。
- 现有 glob Combo 逻辑不变。

## 2. 路由解析

`resolveExactOrWildcard`：

1. Provider 前缀（不变）
2. 原生模型（不变）
3. 精确 Combo（原 alias 与 combo 合并）
4. glob Combo
5. 未匹配报错

`resolveTargetSpec`：

- `{combo: x}`：按 Combo 查找（精确）。
- `{alias: x}`（deprecated）：与 `{combo: x}` 等价；trace 使用 `combo:name`。
- 删除 alias 递归分支与 alias 循环检测（由 Combo 校验覆盖）。

## 3. 校验

- 删除 Alias 名称/重复/冲突/目标校验块。
- 删除 `aliasNames` 与「Alias 与 Combo 同名」检查（统一由 Combo 集合检查）。
- 目标可达性：仅遍历 Combo nodes；`{alias}` 目标按 Combo 查找。
- `validateCombos(combos, options)`：删除 aliases 参数与 aliasMap；`{alias}` 目标按 Combo 名称收集引用。
- 名称冲突：Combo 名称继续检查原生模型/Provider/Combo 唯一性。

## 4. 数据迁移

`migrations/0006_unify_aliases_into_combos.sql`：

```sql
INSERT OR IGNORE INTO combos
  (id, name, description, strategy, nodes, judge_model, timeout_ms, max_concurrency,
   sticky, priority, enabled, created_at, updated_at)
SELECT
  a.id,
  CASE
    WHEN EXISTS (SELECT 1 FROM combos c WHERE c.name = a.name COLLATE NOCASE)
      THEN a.name || '-alias-' || substr(a.id, -4)
    ELSE a.name
  END,
  a.description,
  'fallback',
  '[' || a.target || ']',
  NULL, NULL, NULL, NULL,
  a.priority, a.enabled, a.created_at, a.updated_at
FROM model_aliases a;

DROP TABLE model_aliases;
```

- `target` 是 JSON（对象或字符串）；`'[' || target || ']'` 形成单节点数组。
- 名称冲突追加 `-alias-xxxx`。

## 5. 仓储与 API

- `repository.ts`：删除 `AliasRow`、`mapAlias`、`listAliases/getAlias/createAlias/replaceAlias/deleteAlias`、`CreateAliasInput`；`loadConfigData` 不再查询 `model_aliases`。
- `admin/routes.ts`：删除 `/admin/aliases*` 与相关 import。
- 删除 `src/admin/handlers/routing.ts`。
- `admin/schemas.ts`：删除 alias schemas。
- `admin/shared.ts`：`assertVirtualNameAvailable` 删除别名查询；`validateVirtualName` 仅保留 combo。
- 文档注明 `/admin/aliases*` 已移除。

## 6. 前端

- 删除 `state.aliases` 与 `/admin/aliases` 请求。
- `routeTargetEntries`：删除「别名」分组；`{alias}` 兼容标签显示为 Combo。
- 删除 `aliasFields`、`entities.aliases`、`renderers.aliases`、导航「别名」、命令面板「别名」分组。
- `#/aliases` 重定向 `#/combos`。
- Combo 表单/列表无需新增字段。

## 7. 文档与测试

- README/API/COMBOS：别名 = 单节点 Combo；`/admin/aliases*` 删除。
- 测试：
  - `router.test.ts`：alias 精确匹配改为 Combo；删除 alias 循环（由 Combo 循环测试覆盖）；保留 `{alias}` 兼容测试。
  - `combo-normalize.test.ts`：alias 引用改为 Combo。
  - `test/integration/gateway.test.ts`：更新 alias 相关用例。
- 全量 `typecheck`、`test`、`deploy:dry-run`。

## 8. 风险与回滚

- 迁移不可逆：上线前备份 D1。
- 旧快照合成保证未发布实例行为不变。
- 删除 API：文档注明；管理台同步。
- 回滚：代码回退 + 数据库从备份恢复。

## 9. 实施顺序

1. 类型/运行时/路由/校验/仓储/API 与迁移。
2. 更新测试并跑通。
3. 前端删除别名入口与目标分组。
4. 文档、全量验证与提交。
