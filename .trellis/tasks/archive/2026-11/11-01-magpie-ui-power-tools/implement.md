# 实施计划：效率与运维（批次 3）

> 未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线确认

- [ ] 工作区干净，批次 1/2 已提交。
- [ ] 记录基线：
  ```bash
  npm run typecheck
  npm test
  npm run deploy:dry-run
  ```
- [ ] `npm run dev` 启动本地服务。

## 1. 命令面板组件

- [ ] 新增 `public/ui-static/js/components/palette.js`：
  - `initCommandPalette({ button, getItems, prepare })`。
  - 动态创建遮罩、面板、输入框、结果列表。
  - 快捷键 Ctrl/Cmd+K、Esc、点击遮罩关闭。
  - 输入过滤、分组渲染、最多 50 条、键盘上下/回车、鼠标点击。
  - `role="dialog"`、`role="combobox"`、`role="listbox"`、`aria-selected`。
- [ ] `src/ui/index.ts` 顶栏增加 `#palette-toggle` 按钮（文案「搜索」，带快捷键提示）。
- [ ] `public/ui-static/app.css` 增加 palette 样式（亮/暗主题）。

## 2. 命令条目与列表联动

- [ ] `app.js`：
  - import `initCommandPalette`。
  - `commandItems()`：页面、Provider、模型、别名、Combo、通配符、用户。
  - `goToList(page, query)`：设置 `pendingListQuery` 并跳转。
  - `init()` 中初始化命令面板（`prepare` 调用 `ensureLookups`/`ensureRouteLookups`）。
- [ ] `crudPage` 与 `keysPage`：渲染后消费 `pendingListQuery`，写入搜索输入框与 `listState.query`。
- [ ] 验证：快捷键、过滤、键盘与鼠标执行、实体跳转后搜索词生效。

## 3. Provider 健康

- [ ] `entities.providers.actions` 增加 `health`。
- [ ] 新增 `openProviderHealth(row)`：
  - 请求 `/admin/health/breakers`，按 providerId 查找。
  - Provider 级、账户、模型三级状态与失败计数。
  - 不存在或接口失败时展示提示。
- [ ] `app.css` 增加 health 行样式。
- [ ] 验证：正常 Provider、无健康数据、接口失败。

## 4. 预算进度

- [ ] 新增 `openBudgetDetail(options)`：
  - 今日与本月 summary 并行请求（`userId`/`apiKeyId` 过滤）。
  - 已用、预算、百分比、剩余与进度条；超支危险色；未设置预算提示。
- [ ] `keysPage` actions 增加 `budget`。
- [ ] `entities.users.actions` 增加 `budget`。
- [ ] `app.css` 增加预算进度条样式。
- [ ] 验证：有预算、无预算、超支、接口失败。

## 5. 全量验证与清理

- [ ] `npm run typecheck`。
- [ ] `npm test`。
- [ ] `npm run deploy:dry-run`。
- [ ] Playwright 走查：
  - Ctrl+K 打开/关闭、过滤、回车跳转、搜索词生效。
  - Provider 健康弹窗。
  - API Key / 用户预算弹窗（有/无预算）。
  - 亮/暗主题、窄屏。
- [ ] 清理临时数据、截图与调试日志。
- [ ] `git status` 仅包含预期文件；`package.json` 未变。

## 6. 评审门禁

- [ ] 未修改后端接口与数据库。
- [ ] 未新增依赖，未引入内联脚本。
- [ ] 所有动态内容转义；ARIA 属性正确。
- [ ] 批次 1/2 功能无回归。

## 7. 回滚点

- 新增 `palette.js` 与 `app.js`/`app.css`/`index.ts` 增量提交，按提交回退。
- 无数据库与后端部署依赖。

## 8. 完成记录

- 完成日期：2026-11-01
- 状态：实现与本地验证完成，待提交
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：24 个测试文件、227 项测试全部通过
  - `npm run deploy:dry-run`：通过
  - 本地 Playwright 走查：
    - Ctrl+K 打开面板、页面与实体分组、输入过滤、Enter 跳转、Esc 关闭
    - 选择模型后跳转 `#/models` 且搜索框自动填入 `gpt-4o`
    - Provider「健康」弹窗展示 Provider/账户/模型状态与失败计数
    - 用户与 API Key「预算」弹窗展示今日/本月用量、预算、百分比与进度条
    - 超支场景（$1.50 / $1.00）显示 150% 与危险色进度条
- 实现偏差：
  - 抽取共享 `js/text.js`，combobox/trace/charts/palette 统一使用同一 `esc()`，移除重复实现。
  - `keysPage` 的操作分发改为读取 `entity.actions[].run`，与 `crudPage` 一致。
  - 验证用本地数据（Provider/模型/别名/Combo/用户/API Key/用量）已全部删除。
- 已知限制：
  - 命令面板最多显示 50 条；结果按页面、实体顺序分组，未做权重排序。
  - 预算用量按 UTC 日统计。
  - Provider 健康为按需请求，不自动刷新。
- 提交：`795a94f`（前端实现）。
