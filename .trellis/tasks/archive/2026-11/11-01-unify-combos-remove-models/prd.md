# 合并通配符到 Combo 并移除模型页（参考 9router）

## Goal

参考 9router「以 Combo 为唯一路由单元」的设计，把 FufuGateway 的「通配符」能力合并进 Combo：

- Combo 名称含 `*`/`?` 即为通配符模式，精确名称保持原语义。
- 删除独立的通配符实体、API、页面与导航。
- 移除「模型」独立页面，模型管理统一归入 Provider 的「模型」操作。

## Background

- 现状：Combo 与通配符是两套实体、两套 API、两个页面，但语义高度重合（名称/模式 → 多个目标 + 策略）。
- 9router 只提供 Combos 作为模型组合与 fallback 单元，没有独立通配符页；模型来自 Provider 目录，无独立模型管理页。
- 现有数据：`wildcard_rules` 表、`{wildcard}` 路由目标、前端通配符页与命令面板分组。
- 批次 1–3 已完成管理台基础体验、可视化与效率工具，本任务只做信息架构与领域模型收敛。

## Users and Scenarios

### 场景 A：把一批模型映射到同一组目标

管理员创建一个名称 `gpt-*` 的 Combo，配置目标与策略；请求 `gpt-4o` 时按 priority 命中该 Combo，行为与旧通配符一致。

### 场景 B：精确模型组合

管理员创建 `daily-coding`（无通配符）Combo，请求精确命中；与 `gpt-*` 同时存在时精确名称优先。

### 场景 C：模型管理

管理员不再进入独立模型页，而是在 Provider 行的「模型」操作中同步、启用/停用与编辑模型。

### 场景 D：旧配置升级

升级后首次启动，旧通配符规则自动出现在 Combo 列表中（名称即 pattern），旧 `{wildcard}` 引用继续可用并提示为兼容用法。

## Requirements

### R1. 统一 Combo 模型

- `ComboRecord` 增加 `priority`（默认 100）。
- 名称含 `*` 或 `?` 视为 glob 模式；否则精确模式。
- glob 名称必须通过现有 glob 编译校验（长度、字符集、通配符数量、段数）。
- 精确名称规则保持不变（不含斜杠、不与原生模型/Provider 冲突、与别名冲突检查）。

### R2. 路由解析

- 匹配顺序：Provider 前缀 → 原生模型 → Alias → 精确 Combo → glob Combo（priority DESC → 具体度 → id）。
- glob Combo 命中返回 `match.type = "combo_glob"`，包含 comboId、comboName、pattern、priority。
- Combo 节点与别名目标中的 `{wildcard: "pattern"}` 继续解析为对应 glob Combo；新写入只使用 `{combo}`。
- 循环检测覆盖 glob Combo 引用。

### R3. 数据迁移与兼容

- D1 迁移：为 `combos` 增加 `priority`；把 `wildcard_rules` 的每行转为 Combo（id/名称/策略/目标/优先级/启用/说明/时间戳），名称冲突追加 `-glob` 后缀；删除 `wildcard_rules` 表。
- 旧配置快照（KV 中仍含 `wildcards`）在运行时合成为内存 glob Combo，升级后无需立即重新发布即可保持行为；发布新版本后快照不再包含通配符。
- 旧 `{wildcard}` 目标保持解析兼容。

### R4. 校验与 API

- 删除通配符实体校验与 `/admin/wildcards*` 端点。
- `/admin/combos` 支持 `priority`，名称允许 glob 字符。
- Combo 校验覆盖：glob 名称合法性、重复、引用循环、目标可达性、fusion judge。
- 配置校验错误信息中不再出现 wildcard 实体。

### R5. 前端

- 导航移除「通配符」与「模型」；`#/models` 重定向到 `#/providers`。
- 删除通配符页面、字段、命令面板分组与路由目标下拉中的通配符项。
- Combo 表单增加「优先级」，名称帮助说明通配符模式；列表显示匹配类型（精确/通配符）与优先级。
- Combo 节点目标选择器包含精确与 glob Combo；旧数据中的 wildcard 目标可读。
- 命令面板的模型条目跳转 Provider 页并按 Provider 名称过滤。
- 快速开始、诊断、客户端接入等文案不再引导到独立模型页。

### R6. 文档与测试

- README/docs 中通配符说明改为「Combo 通配符模式」，注明 `/admin/wildcards` 已移除。
- 更新 router/combo 单元测试；新增 glob Combo、精确优先、目标兼容、迁移数据校验测试。
- 全量 `typecheck`、`test`、`deploy:dry-run` 通过。

## Non-Goals

- 不改变 Combo 策略集合与节点执行语义。
- 不引入 9router 的 fusion judge 之外的新策略。
- 不做拖拽排序（沿用权重/优先级输入）。
- 不删除模型数据或 Provider 模型同步能力。
- 不做配置快照内容 diff。

## Constraints

- 必须保留旧数据可用：迁移 + 旧快照合成 + `{wildcard}` 兼容。
- 管理台是唯一已知客户端；删除 `/admin/wildcards` 需在文档注明。
- 不新增前端依赖。
- 迁移必须可重复执行（幂等）。

## Acceptance Criteria

- [ ] Combo 名称含 `*`/`?` 时按 glob 匹配，精确 Combo 优先。
- [ ] `wildcard_rules` 数据迁移后出现在 Combo 列表，名称、策略、目标、优先级、启用状态一致。
- [ ] 旧快照未重新发布时，glob 行为仍生效。
- [ ] `{wildcard}` 目标仍可解析；新配置只写 `{combo}`。
- [ ] `/admin/wildcards*` 已移除，前端无调用。
- [ ] 导航无「通配符」「模型」；`#/models` 重定向到 Provider。
- [ ] Combo 表单可设置优先级，glob 名称有明确提示；列表区分精确/通配符。
- [ ] 模型同步、启用/停用、编辑仍可从 Provider 操作完成。
- [ ] `npm run typecheck`、`npm test`、`npm run deploy:dry-run` 通过。
- [ ] Playwright 走查：创建 glob Combo、解析命中、精确优先、迁移数据、模型重定向、命令面板。
- [ ] 更新后的文档与实现一致。

## Notes

- 详细影响面与迁移策略见 `research/unify-baseline.md` 与 `design.md`。
