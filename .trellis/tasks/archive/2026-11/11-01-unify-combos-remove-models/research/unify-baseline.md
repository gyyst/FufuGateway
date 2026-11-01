# 调研基线：通配符合并到 Combo、移除模型页

## 1. 现状

### 1.1 路由匹配顺序（src/router/resolver.ts）

1. 显式 Provider 前缀 `provider/model`
2. 原生模型唯一匹配
3. Alias 精确匹配
4. Combo 名称精确匹配
5. 通配符规则（priority DESC → glob 具体度 → id）
6. 未匹配报错

通配符规则由 `config.wildcards`（已排序的 `CompiledWildcardRule[]`）提供，每项含 `rule.pattern/strategy/targets/priority/enabled` 与编译后的 glob。

### 1.2 数据模型

- `WildcardRuleRecord`：id、pattern、strategy、targets（RouteTargetSpec[]）、priority、enabled、description、时间戳。
- `ComboRecord`：id、name、description、strategy、nodes（ComboNodeSpec[]）、judgeModel、timeoutMs、maxConcurrency、sticky、enabled、时间戳。无 priority。
- `RouteTargetSpec`：string | {model} | {alias} | {combo} | {wildcard}。
- 数据库：`wildcard_rules(id, pattern, strategy, targets, priority, enabled, description, created_at, updated_at)`；`combos(..., name UNIQUE NOCASE, nodes, ...)`。

### 1.3 校验与运行时

- `validateSnapshot`：校验 wildcard pattern/strategy/targets/priority、与 combo/alias 冲突、目标可达性；`validateCombos(combos, aliases, wildcards, options)` 计算引用图与循环。
- `buildRuntimeConfig`：构建 `wildcards`（compileGlob + 排序）。
- 删除/更新 wildcard 经 `repository.ts` 的 `listWildcards/getWildcard/createWildcard/replaceWildcard/deleteWildcard`。
- API：`/admin/wildcards` CRUD + `/admin/wildcards/preview`。

### 1.4 前端

- `state.wildcards` 来自 `/admin/wildcards`。
- 通配符页 `entities.wildcards`、`wildcardFields`、`renderers.wildcards`。
- 路由目标下拉包含「通配符 · pattern」；Combo 节点编辑器支持 wildcard key。
- 导航与命令面板包含「通配符」；「模型」为独立页面。

### 1.5 测试

- `test/unit/router.test.ts`、`test/unit/combo-normalize.test.ts` 直接覆盖 wildcard 行为；其余测试通过快照数据间接涉及。

## 2. 合并设计决策

1. **名称即匹配模式**：Combo 名称含 `*` 或 `?` → glob 模式；否则精确匹配。不新增 match_mode 列，减少迁移复杂度。
2. **新增 priority**：`combos` 增加 `priority INTEGER NOT NULL DEFAULT 100`；glob combo 按 priority DESC → 具体度 → id 排序，与旧 wildcard 一致。
3. **路由顺序**：精确 combo 优先于 glob combo；glob combo 命中返回 `match.type = "combo_glob"`（含 comboId/comboName/pattern/priority）。
4. **目标兼容**：`{wildcard: "pattern"}` 保留为 deprecated 输入，解析时等价于 `{combo: "pattern"}`（按 glob combo 查找）；新写入只产生 `{combo}`。
5. **迁移**：
   - `ALTER TABLE combos ADD COLUMN priority INTEGER NOT NULL DEFAULT 100`。
   - `wildcard_rules` 每行转为 combos 行：id 沿用、name=pattern、strategy、nodes=targets JSON、priority、enabled、description、时间戳；名称冲突时追加 `-glob` 后缀。
   - 迁移后删除 `wildcard_rules` 表。
   - 旧配置快照中的 `wildcards` 在运行时合成为内存 glob combo（兼容未重新发布的实例）；发布新版本后不再包含。
6. **校验**：
   - glob combo 名称必须含 `*`/`?` 且通过 `compileGlob`；不与 Provider/原生模型冲突检查；与 exact combo/alias 的冲突仅在同名时检查。
   - exact combo 保持原规则（不含斜杠、不与原生模型/Provider 冲突、与别名冲突检查）。
   - 删除 wildcard 实体校验与引用可达性检查；`{wildcard}` 目标按 glob combo 校验。
7. **API**：删除 `/admin/wildcards*`；`/admin/combos` 支持 `priority`，名称允许 glob 字符。
8. **前端**：
   - 删除通配符页、导航、命令面板分组、目标下拉中的通配符项。
   - Combo 表单增加 priority，名称帮助说明 glob；列表显示匹配类型与优先级。
   - 导航移除「模型」；`#/models` 重定向 `#/providers`；命令面板模型条目跳 Provider 并过滤 Provider 名称。
9. **文档**：更新 README/docs 中通配符相关描述为「Combo 通配符模式」。

## 3. 风险

- 旧快照兼容与重新发布：运行时合成旧 wildcards，避免升级即刻失效。
- 名称冲突迁移：SQL 使用 CASE 追加后缀，保证不覆盖已有 combo。
- 删除 API 可能影响外部脚本：本项目管理台为唯一客户端，README 需注明。
- 大量测试更新：需覆盖 glob combo、迁移、目标兼容。
