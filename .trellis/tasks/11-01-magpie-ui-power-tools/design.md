# 技术设计：效率与运维（批次 3）

## 1. 总体方案

三个能力均为纯前端增量，复用现有 API 与状态：

- 命令面板：新增 `js/components/palette.js`，由 `app.js` 提供可搜索条目与执行动作。
- Provider 健康：新增弹窗渲染函数，数据来自 `/admin/health/breakers`。
- 预算进度：新增弹窗渲染函数，数据来自 `/admin/usage/summary` 的 `userId`/`apiKeyId` 过滤。

## 2. 命令面板

### 2.1 模块接口

```js
initCommandPalette({ button, getItems, prepare })
```

- `button`：顶栏入口按钮，点击打开。
- `getItems()`：返回 `{ group, label, description, words, run }[]`。
- `prepare()`：打开前异步准备（加载 lookups），失败不阻塞页面类条目。

### 2.2 DOM 与交互

- 模块动态创建 `#command-palette`（遮罩 + 面板 + 输入框 + 结果列表 + 空状态），追加到 `body`。
- 打开：`Ctrl+K` / `Cmd+K`，或顶栏按钮；`Esc` 关闭；点击遮罩关闭。
- 输入过滤：`words` 包含查询（小写）。
- 键盘：`ArrowUp/Down` 移动活动项，`Enter` 执行，`Esc` 关闭。
- 结果按 `group` 分组；最多渲染 50 条。
- 执行后先关闭面板，再调用 `run()`。

### 2.3 条目来源

- 页面：`PAGES` 展开，`run` 设置 `location.hash`。
- Provider：`state.providers`。
- 模型：`state.models`，label 为 `providerName / modelId`。
- 别名 / Combo / 通配符 / 用户：来自对应 state 数组。
- 实体条目 `run` 调用 `goToList(page, query)`：设置 `pendingListQuery = query` 并跳转页面。

### 2.4 列表搜索联动

- 模块级变量 `pendingListQuery`，一次性消费：
  - `crudPage` 渲染工具栏后、`renderList()` 前，若有 pending 值，则写入 `listState.query` 与搜索输入框，然后清空。
  - `keysPage` 同样处理（当前命令面板不生成 Key 条目，但保持一致）。
- 队列只有一项，重复跳转会覆盖。

## 3. Provider 健康

- `entities.providers.actions` 增加 `health`：
  ```js
  { key: "health", label: "健康", run: (row) => openProviderHealth(row) }
  ```
- `openProviderHealth(row)`：
  1. `GET /admin/health/breakers`。
  2. 按 `providerId` 查找；不存在时提示。
  3. `modal("Provider 健康 · " + name, html)`。
- 渲染：
  - Provider 级摘要：状态徽章、连续失败、窗口失败/总数。
  - 账户列表与模型列表：名称、状态、连续失败、窗口失败/总数。
  - 状态文字同时展示，颜色仅作辅助。
- 状态值（`closed`/`open`/`half_open`）按后端原样展示。

## 4. 预算进度

- 通用函数：
  ```js
  openBudgetDetail({ title, userId, apiKeyId, dailyBudgetUsd, monthlyBudgetUsd })
  ```
- 请求：
  - 今日：`from = to = toISOString().slice(0,10)`。
  - 本月：`from = yyyy-mm-01`，`to = 今天`。
  - 过滤参数按实体选择 `userId` 或 `apiKeyId`。
- `Promise.allSettled` 并行请求；单个失败显示「不可用」。
- 渲染两张卡（今日 / 本月）：
  - 已用费用、预算上限、使用百分比、剩余额度。
  - 进度条复用 `.bar-track` / `.bar-fill`；超过 100% 时 `.bar-fill.over` 使用危险色。
  - 未设置预算：显示「未设置预算」与已用费用。
- 入口：
  - `keysPage` 的 `entity.actions` 增加 `budget`。
  - `entities.users.actions` 增加 `budget`。

## 5. 样式

- `.palette`、`.palette-backdrop`、`.palette-panel`、`.palette-input`、`.palette-list`、`.palette-group`、`.palette-item`、`.palette-item.active`、`.palette-empty`。
- `.health-list`、`.health-row`、`.health-meta`（可复用 `.trace-row`，但使用独立类避免耦合）。
- `.budget-card`、`.budget-track`、`.bar-fill.over`。
- 亮/暗主题均使用变量。

## 6. 可访问性

- 面板 `role="dialog"`、`aria-modal="true"`、`aria-label="命令面板"`。
- 输入框 `role="combobox"`、`aria-expanded`、`aria-controls`；结果 `role="listbox"`、选项 `role="option"`、`aria-selected`。
- 顶栏按钮 `aria-label="打开命令面板（Ctrl+K）"`。
- 打开时聚焦输入框，关闭时恢复焦点到入口按钮或原焦点元素。

## 7. 数据流与兼容性

- 不新增网络请求类型，不修改响应结构。
- 命令面板只读取 state，不写业务数据。
- 预算与健康弹窗只读。
- 批次 1/2 的导航、列表、图表、combobox 行为不变。

## 8. 风险与回滚

- 风险：命令面板打开时实体数据过大导致构建耗时。缓解：条目上限 50、过滤在数组上进行、打开才构建。
- 风险：pendingListQuery 与页面渲染时序不一致。缓解：在 renderList 前消费并写入输入框。
- 风险：预算日期使用 UTC 与用户本地日期不一致。缓解：与后端 `day` 字段一致，说明为 UTC 日。
- 回滚：新增 `palette.js` 与 `app.js`/`app.css` 增量，无后端依赖。

## 9. 实施顺序

1. palette 组件与顶栏入口。
2. 命令条目与 pending query 联动。
3. Provider 健康弹窗。
4. 预算弹窗与两个入口。
5. 样式、走查、文档与提交。
