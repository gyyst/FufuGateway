# 合并别名到 Combo 并统一路由标识

## Goal

在通配符已并入 Combo 的基础上，把 Alias 也合并进 Combo：

- 别名等价于「单节点 Combo」：`nodes = [target]`，策略 `fallback`。
- 删除独立的 Alias 实体、API、页面与导航。
- 路由标识统一为：Provider 前缀 / 原生模型 / 精确 Combo / glob Combo。

## Background

- 上一任务已把通配符合并为 Combo（glob 名称），删除 `/admin/wildcards*`。
- 别名与 Combo 语义重合：别名是「名称 → 单目标」，Combo 是「名称 → 多节点 + 策略」。
- 现有校验禁止 Alias 与 Combo 同名，合并无命名歧义。
- 管理台已无模型页；本轮后「接入」组仅剩 Provider 与 Combo。

## Requirements

### R1. 数据模型与迁移

- 删除 `AliasRecord`、`aliasesByName`、`model_aliases` 表。
- 迁移 `0006_unify_aliases_into_combos.sql`：
  - `INSERT INTO combos`：`name`、`description`、`strategy='fallback'`、`nodes='[' || target || ']'`、`priority`、`enabled`、时间戳。
  - 名称冲突追加 `-alias-xxxx` 后缀。
  - 删除 `model_aliases` 表。
- 旧配置快照中的 `aliases` 在运行时合成为单节点 Combo，升级后无需立即重新发布。

### R2. 路由与兼容

- 匹配顺序：Provider 前缀 → 原生模型 → 精确 Combo → glob Combo。
- `{alias: "x"}` 目标保留为 deprecated 输入，等价于 `{combo: "x"}`。
- Alias 原有循环检测由 Combo 校验覆盖。
- 诊断/执行树中别名来源显示为 Combo。

### R3. 校验与 API

- 删除 Alias 实体校验、`/admin/aliases*` 端点与 handlers。
- Combo 名称规则沿用（不含斜杠、不与模型/Provider/Combo 冲突，glob 名称走 glob 校验）。
- `validateCombos` 不再接收 aliases；`{alias}` 目标按 Combo 校验。
- `assertVirtualNameAvailable` 仅检查 Combo/模型/Provider。

### R4. 前端

- 删除别名页、导航项、命令面板分组与路由目标下拉中的「别名」。
- `{alias}` 目标兼容显示为 Combo。
- `#/aliases` 重定向 `#/combos`。
- Combo 列表/表单无需新增字段。

### R5. 文档与测试

- README/docs：别名改为「单节点 Combo」；注明 `/admin/aliases*` 已删除。
- 更新 router、combo-normalize、集成测试。
- `typecheck`、`test`、`deploy:dry-run` 通过。

## Non-Goals

- 不改变 Combo 策略与执行语义。
- 不删除模型数据或 Provider 模型同步。
- 不做别名/Combo 内容对比。

## Constraints

- 保留旧快照与 `{alias}` 目标兼容。
- 迁移不可逆，升级前需备份 D1。
- 管理台是唯一已知客户端。

## Acceptance Criteria

- [ ] 原别名数据迁移后出现在 Combo 列表，节点/优先级/启用状态一致。
- [ ] 请求原别名名称命中对应 Combo。
- [ ] `{alias}` 旧目标仍可解析；新配置只写 `{combo}`。
- [ ] `/admin/aliases*` 已删除，前端无调用。
- [ ] 导航无「别名」；`#/aliases` 重定向 Combo。
- [ ] 旧快照未重新发布时别名行为仍生效。
- [ ] `typecheck`、`test`、`deploy:dry-run` 通过。
- [ ] 文档与实现一致。
