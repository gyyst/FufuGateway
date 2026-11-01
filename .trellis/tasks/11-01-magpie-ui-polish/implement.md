# 实施计划：管理台交互与视觉优化（批次 1）

> 未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线确认

- [ ] 确认分支 `main`、工作区干净（`.dev.vars` 已被忽略）。
- [ ] 记录基线：
  ```bash
  npm run typecheck
  npm test
  npm run deploy:dry-run
  ```
- [ ] 启动本地服务用于走查：
  ```bash
  npm run dev
  ```
  打开 `http://127.0.0.1:8787/ui`，记录 14 个页面当前状态。

## 1. 主题基础设施

- [ ] `public/ui-static/app.css`：
  - 将现有颜色收敛为语义变量，保持深色默认值不变。
  - 新增 `:root[data-theme="light"]` 覆盖（背景、面板、边框、文本、弱化文本、强调、成功/警告/危险、输入框、阴影）。
  - 表格、徽章、按钮、表单、弹窗、图表均只引用变量。
- [ ] 新增 `public/ui-static/theme-init.js`：同步读取 `localStorage["fufu.theme"]`，写入 `document.documentElement.dataset.theme`。
- [ ] 新增 `public/ui-static/js/theme.js`：`initThemeToggle(button)`、`currentTheme()`。
- [ ] `src/ui/index.ts`：
  - `<head>` 增加 `<script src="/ui-static/theme-init.js"></script>`。
  - 顶栏增加 `#theme-toggle` 按钮（文案「主题」或图标，带 `aria-label`）。
- [ ] 验证：切换主题、刷新保持、无首帧闪烁；暗色视觉与基线一致。

## 2. ES module 化与导航分组

- [ ] `src/ui/index.ts`：`app.js` 脚本改为 `<script type="module" src="/ui-static/app.js"></script>`；顶栏增加 `#nav-toggle` 与 `#nav-backdrop`。
- [ ] 新增 `public/ui-static/js/nav.js`：导出 `NAV_GROUPS`（快速开始置顶；概览 / 接入 / 访问 / 观测 / 设置五组）。
- [ ] `public/ui-static/app.js`：
  - 顶部 `import` nav/theme/combobox/charts 模块；确认 IIFE 仍正常执行。
  - `PAGES` 由 `NAV_GROUPS` 展平生成。
  - `renderNav()` 渲染分组标题与链接，保持 `data-page` 与 active 状态。
  - 绑定 `#nav-toggle` 与 `#nav-backdrop` 的开关、`Esc` 关闭、焦点回归。
- [ ] `public/ui-static/app.css`：
  - 导航分组标题样式；侧栏可滚动。
  - `<=980px` 抽屉样式（fixed + transform + 遮罩），替换原三列网格布局。
  - 桌面端隐藏汉堡与遮罩。
- [ ] 验证：桌面/窄屏导航、深链、刷新后 active 状态；所有 14 页面可正常打开。

## 3. 可搜索选择器

- [ ] 新增 `public/ui-static/js/components/combobox.js`：
  - `comboboxHtml(name, entries, current, options)`。
  - `bindComboboxes(root)`：初始化 `[data-combobox]`，同步隐藏 input 的 value/change。
  - 单选、多选（标签 + 移除）、过滤、分组、键盘导航、点击外部关闭、ARIA。
- [ ] `public/ui-static/app.js`：
  - `fieldHtml` 增加 `combobox` 分支；`readForm` 无需改动（依赖同名隐藏 input）。
  - 将模型/目标选择字段改为 `combobox`：路由诊断模型、Combo 节点目标、别名/通配符 `routeTarget`、API Key 模型白名单/权限、用量页模型筛选。
  - 多选（`modelMulti`/`routeTargetMulti`）改为带搜索过滤的列表 + 已选项，保持提交值格式不变。
  - 无选项时显示引导文案（如「先同步或新建模型」）。
- [ ] `public/ui-static/app.css`：combobox 输入、面板、分组、选项、选中态、标签、空状态样式。
- [ ] 验证（逐表单提交）：
  - 路由诊断选择并解析。
  - 新建/编辑 Combo 节点目标保存成功。
  - 新建/编辑别名与通配符目标保存成功。
  - API Key 白名单保存成功。
  - 用量页模型筛选生效。
  - 键盘操作与移动端窄屏可用。

## 4. 表格与空状态

- [ ] `public/ui-static/app.js`：
  - `tableHtml(entity, rows, options)` 支持 `query`、`sort`、`page`、`pageSize`、`emptyState`；旧签名行为不变。
  - 表头可点击排序，显示方向；`aria-sort`。
  - `crudPage` 增加工具栏（搜索、每页条数、计数）与分页控件；重渲染后重绑行操作。
  - 为 Provider/模型/Combo/API Key/别名/通配符/用户/价格表配置 `emptyState`（文案 + 下一步操作）。
  - 修复 Provider 表格徽章/账户/操作列换行与列宽。
- [ ] `public/ui-static/app.css`：工具栏、排序指示、分页、空状态卡片样式。
- [ ] 验证：搜索/排序/分页、行操作、空状态按钮跳转；大数据量下列表不卡顿。

## 5. 顶栏状态

- [ ] `src/ui/index.ts`：顶栏加入 `#config-state`、`#breaker-state` 容器。
- [ ] `public/ui-static/app.js`：
  - `refreshStatusBar()` 使用 `Promise.allSettled` 请求 health/config/breakers，30 秒节流。
  - 登录成功与路由切换后调用；失败显示「状态不可用」。
  - 未发布变更与断路器数量使用徽章样式。
- [ ] 验证：正常、配置未发布、接口 500 三种情况；不影响页面加载。

## 6. 概览页与图表

- [ ] 新增 `public/ui-static/js/components/charts.js`：`sparkline()`、`miniBars()`。
- [ ] `public/ui-static/app.js` `overviewPage`：
  - `Promise.allSettled` 改造，各卡片独立错误态。
  - 指标：数据库、配置版本/待发布、近 30 天请求、近 30 天费用、错误率、非 CLOSED 断路器。
  - 请求量/费用迷你趋势图（无数据不渲染）。
  - Top 模型/Provider 摘要（前端聚合最近请求，空则隐藏）。
  - 空配置/校验失败的引导卡与「去快速开始」。
  - 保留最近请求表格与详情绑定。
- [ ] `public/ui-static/app.css`：图表、错误卡片、引导卡、Top 列表样式。
- [ ] 验证：空实例、正常实例、部分接口失败三种情况。

## 7. 全量验证与清理

- [ ] `npm run typecheck`。
- [ ] `npm test`（基线 226 项应全部通过）。
- [ ] `npm run deploy:dry-run`。
- [ ] Playwright 走查清单：
  - 登录、退出。
  - 14 个页面渲染。
  - 空状态按钮。
  - combobox 键盘/鼠标选择与提交。
  - 搜索/排序/分页。
  - 亮/暗主题切换与刷新保持。
  - 980px 以下抽屉导航。
  - 概览降级与正常态。
- [ ] 清理：临时截图、`.playwright-mcp` 产物、调试日志、未使用导入。
- [ ] `git status` 检查仅包含预期文件；`package.json` 无变化。

## 8. 评审门禁

- [ ] 未修改任何后端 API/数据库/配置发布逻辑。
- [ ] 未新增依赖，`package.json` 不变。
- [ ] 未引入内联脚本，CSP 仍为 `script-src 'self'`。
- [ ] 所有用户/配置数据经 `esc()` 转义。
- [ ] 旧 `tableHtml(entity, rows)` 调用未破坏。
- [ ] 表单提交值与改造前一致（逐字段对比请求体）。
- [ ] 两个主题下页面可读。
- [ ] 现有 14 个页面无功能回归。

## 9. 回滚点

- 主题：回退 `theme-init.js`/`js/theme.js`/CSS 主题块与 `index.ts` 引用。
- module 化：回退 `index.ts` 的 `type="module"` 与 `app.js` 顶部 import。
- 导航/表格/概览/combobox：按提交粒度回退 `app.js`/`app.css` 对应段落。
- 无数据库迁移，无后端部署依赖。

## 10. 完成记录

- 完成日期：2026-11-01
- 状态：实现、验证与提交完成
- 提交：`ee2539b`（前端实现）、`5538482`（任务与规范文档）
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：226/227 通过；唯一失败为 `test/unit/rate-limiter.test.ts` 的「RPM 固定窗口限制」，单独重跑通过，属时间敏感 flaky，与本次改动无关
  - `npm run deploy:dry-run`：通过
  - 本地 Playwright 走查：登录、导航分组、移动端抽屉、亮/暗主题与持久化、诊断 combobox（过滤/键盘/选择/解析提交）、别名与 Combo 表单 combobox 提交、API Key 多选过滤、Provider 搜索/排序/分页、概览降级与指标、空状态
- 实现偏差：
  - Provider 模型编辑表单的 `providerModelSelect` 保留原生 select（依赖 Provider 切换联动，模型量有限）。
  - 设置页等枚举字段保留原生 select。
  - 表格搜索/排序/分页为前端实现，未改后端分页语义。
  - 本地验证使用的演示 Provider/模型/别名/Combo 已删除，本地 D1 恢复为原有 1 个 Provider。
- 已知限制：
  - 弹窗内靠近底部的 combobox 面板可能被 `.modal-body` 的滚动区域裁剪，需要滚动弹窗查看。
  - 概览趋势图按有数据的 bucket 等距绘制，缺失日期未补零。
  - 抽屉关闭后未强制将焦点移回汉堡按钮。
  - 导航「概览」与「快速开始」共用无标题分组。
  - 设计中的 `miniBars()` 未实现，迷你趋势统一使用 `sparkline()`。
### 独立审查后的修复

- Combo 删除最后一个节点后补回的行现在会重新绑定 combobox。
- combobox 清除按钮改为始终渲染并按值显隐；无候选项时正确显示引导文案；Enter 始终阻止表单隐式提交；补充 `aria-label`。
- 列表搜索无匹配时显示「没有匹配的记录」，不再误用实体空状态。
- 搜索覆盖派生列（Provider 名称、用户邮箱）；模型条目按 Provider 分组。
- 发布/回滚后重置状态栏节流，立即刷新配置状态。
- 顶栏与概览的熔断统计纳入 Provider 级状态。
- API Key 列表接入搜索、排序、分页与空状态，复用 `tableHtml`/`paginationHtml`/`bindListControls`。
- 表头排序补充 `aria-sort` 与键盘操作；移动端保留配置状态徽章。
- 路由目标当前值改为可读标签（模型/别名/Combo/通配符），不再显示原始 JSON。
- 概览页在任一请求 401 时直接返回，避免 `allSettled` 吞掉登录失效。
- 用量页无请求时提供「前往客户端接入」引导。
- 复用 `paginationHtml`/`bindListControls` 消除分页与排序绑定的重复代码。

- 后续：
  - 批次 2（路由执行树可视化、用量深度图表、客户端接入向导）尚未开始。
