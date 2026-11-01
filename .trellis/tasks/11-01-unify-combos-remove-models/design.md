# 技术设计：通配符合并为 Combo、移除模型页

## 1. 领域模型

### 1.1 Combo

```ts
interface ComboRecord {
  id: string;
  name: string;            // 含 * 或 ? 即 glob 模式
  description?: string;
  strategy: StrategyId;
  nodes: ComboNodeSpec[];
  judgeModel?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  sticky?: StickyConfig;
  priority: number;        // 新增，默认 100
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

- 匹配模式由名称判断，不新增数据库列。
- `RouteTargetSpec` 与 `ComboNodeSpec` 保留 `{wildcard}` 作为 deprecated 输入（解析为 glob Combo），新写入只使用 `{combo}`。
- `RouteMatch` 增加：
  ```ts
  { type: "combo_glob"; comboId: string; comboName: string; pattern: string; priority: number }
  ```

### 1.2 运行时

`RuntimeConfig`：

- 删除 `wildcards: CompiledWildcardRule[]`。
- 新增 `globCombos: CompiledGlobCombo[]`：
  ```ts
  interface CompiledGlobCombo { combo: ComboRecord; compiled: CompiledGlob; }
  ```
- `combosByName` 仍包含全部 Combo（精确匹配只取名称不含通配符者，由 resolver 判断）。
- 旧快照兼容：读取 `data.wildcards`（若存在）合成 `ComboRecord`（id/pattern→name/strategy/targets→nodes/priority/enabled/description/时间戳），仅加入 `globCombos`，不写入 `combosByName`。
- `globCombos` 排序：priority DESC → `compareGlobSpecificity` → id。

## 2. 路由解析

`resolveExactOrWildcard`：

1. Provider 前缀（不变）
2. 原生模型（不变）
3. Alias（不变）
4. 精确 Combo：`combosByName.get(lower)` 且名称不含 `*`/`?`
5. glob Combo：遍历 `globCombos`，`globMatches(compiled, requestedModel)` 命中后：
   - `trace.push("combo:" + combo.name)`
   - `match = { type: "combo_glob", comboId, comboName, pattern: combo.name, priority }`
   - `plan = { kind: "combo", combo }`
6. 未匹配报错

`resolveTargetSpec`：

- `{combo: x}`：精确查找 `combosByName`；若未找到且 x 含通配符，按 `globCombos` 的 pattern 精确查找。
- `{wildcard: x}`（deprecated）：按 glob Combo 的 pattern 查找，等价于 `{combo: x}`；trace 使用 `combo:pattern`。
- 删除 `resolveWildcardRule`，复用 Combo plan。

## 3. 校验

`validateSnapshot`：

- 删除 wildcards 实体校验块与 wildcard 目标可达性检查。
- Combo 名称：
  - 含 `*`/`?`：`compileGlob(name)` 必须成功；与原生模型、Provider 名称冲突检查保留；重复检查使用统一小写集合。
  - 不含：保留现有 `VIRTUAL_NAME` 与冲突检查。
- 目标可达性：遍历 Combo nodes（及 alias targets）；`{wildcard}` 按 glob Combo 校验；`{combo}` 对精确 Combo；模型目标不变。
- `validateCombos(combos, aliases, options)`：去掉 `wildcards` 参数；内部 `wildcard` 分支改为按 Combo 名称（glob）查找并收集引用；错误文案改为 `model/alias/combo`。
- 配置错误信息中不再出现 wildcard 实体。

## 4. 数据库迁移

新增 `migrations/0004_unify_wildcards_into_combos.sql`：

```sql
ALTER TABLE combos ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;

INSERT OR IGNORE INTO combos
  (id, name, description, strategy, nodes, timeout_ms, max_concurrency, sticky,
   enabled, created_at, updated_at, priority)
SELECT
  w.id,
  CASE
    WHEN EXISTS (SELECT 1 FROM combos c WHERE c.name = w.pattern COLLATE NOCASE)
      THEN w.pattern || '-glob-' || substr(w.id, -4)
    ELSE w.pattern
  END,
  w.description, w.strategy, w.targets,
  NULL, NULL, NULL, w.enabled, w.created_at, w.updated_at, w.priority
FROM wildcard_rules w;

DROP TABLE wildcard_rules;
```

- `nodes` 直接复用 `targets` JSON（结构兼容）。
- 名称冲突时追加 `-glob-xxxx`。
- 迁移由 D1 迁移系统保证只执行一次。

## 5. 仓储与 API

- `repository.ts`：
  - `ComboRow` 增加 `priority`；`mapCombo` 读取 `priority ?? 100`。
  - 删除 `WildcardRow`、`mapWildcard`、`list/get/create/replace/deleteWildcard`。
  - `CreateComboInput` 增加 `priority`；`createCombo`/`replaceCombo` 写列。
  - `loadConfigData` 不再查询 `wildcard_rules`。
- `admin/schemas.ts`：
  - `comboCreateSchema` 增加 `priority`（0–1_000_000）。
  - 删除 wildcard schemas。
- `admin/routes.ts`：删除 `/admin/wildcards*` 路由。
- `admin/handlers/combos.ts`：删除 wildcard handlers；Combo 列表/创建/更新包含 priority。
- `docs/API.md`：移除 wildcard 端点，注明行为迁移到 Combo。

## 6. 前端

- `state.wildcards` 与 `/admin/wildcards` 请求删除。
- `routeTargetEntries`：删除「通配符」分组；Combo 条目对 glob 名称显示「（通配符）」。
- `routeTargetLabel`：`target.wildcard` 兼容显示为「Combo · pattern」。
- Combo 节点编辑器：读取兼容 `wildcard` key；新选择只写 `combo`。
- Combo 表单：`comboFields` 增加 `priority`；名称帮助说明「含 * 或 ? 时为通配符匹配」。
- Combo 列表：增加「匹配」列（精确/通配符）与「优先级」列。
- 导航：`NAV_GROUPS` 删除 `models` 与 `wildcards`。
- 路由重定向：`activePage()` 或 `route()` 中若 hash 为 `models`/`wildcards`，改为 `#/providers`。
- 删除 `renderers.models`、`renderers.wildcards`、`entities.wildcards`、`wildcardFields`、`excludeRoute` 的 wildcard 分支。
- 命令面板：删除「通配符」分组；模型条目的 `run` 改为 `goToList("providers", providerName)`。
- 快速开始/诊断/客户端接入文案检查：不引导独立模型页。

## 7. 文档与测试

- README/docs：通配符章节改为「Combo 通配符模式」；注明 `/admin/wildcards` 已删除；说明升级需执行迁移。
- 单元测试：
  - `router.test.ts`：glob Combo 命中、精确优先、priority/具体度排序、`combo_glob` match。
  - `combo-normalize.test.ts`：`{wildcard}` 兼容、Combo 引用。
  - 配置校验测试：glob 名称非法/重复/冲突。
- 集成测试：迁移后 `wildcard_rules` 不存在；`/admin/wildcards` 404；Combo CRUD 带 priority。
- 全量 `typecheck`、`test`、`deploy:dry-run`。

## 8. 风险与回滚

- 旧快照兼容：运行时合成 legacy wildcards；首次发布后快照收敛。
- 迁移名称冲突：追加后缀，不覆盖现有 Combo。
- API 删除：管理台同步更新；文档注明。
- 回滚：迁移不可逆（表已删除）。回滚需从备份恢复数据库；代码回退需同时保留旧数据。上线前建议导出 D1 备份。
- 分阶段提交：后端统一模型与迁移 → 前端合并与导航 → 文档与测试收尾。

## 9. 实施顺序

1. 类型/仓储/运行时/路由/校验/API 与迁移。
2. 更新单元测试并跑通。
3. 前端合并、模型页移除、命令面板与文案。
4. 文档、全量验证与提交。
