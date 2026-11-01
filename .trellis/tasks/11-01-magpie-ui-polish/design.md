# 技术设计：管理台交互与视觉优化（批次 1）

## 1. 现状与约束

- 管理台为零构建单页：`src/ui/index.ts` 输出 HTML 外壳，`public/ui-static/app.js`（IIFE，约 3300 行）与 `app.css` 由 Static Assets 提供。
- `app.js` 使用 `sessionStorage` 保存管理员令牌，`api()` 统一请求 `/admin/*`。
- 表单由 `formHtml`/`readForm` 驱动；`readForm` 通过 `form.elements.namedItem(name)` 与 `input[type=checkbox][name]` 读取值，因此新控件只要提供同名表单元素即可兼容。
- 页面由 `PAGES` + `renderers` 映射，hash 路由 `#/<page>`；`crudPage(entity)` 统一生成列表页。
- CSP：`script-src 'self'; style-src 'self' 'unsafe-inline'`，不允许内联脚本。
- 无前端构建链、无测试框架、无第三方依赖。

设计必须在不引入构建与依赖的前提下完成。

## 2. 总体方案

保留 IIFE 与现有页面函数，新增少量原生 ES modules，由 `app.js` 以 `import` 引入；HTML 外壳将 `defer` 脚本改为 `type="module"`。模块只承载可复用的 UI 基础设施，页面逻辑继续留在 `app.js`，控制改动面。

新增文件：

```
public/ui-static/
  theme-init.js          同源同步脚本，首帧前应用主题（放在 <head>）
  js/
    theme.js             主题切换与持久化
    nav.js               导航分组配置
    components/
      combobox.js        可搜索选择器（单选/多选/过滤列表）
      charts.js          SVG 迷你趋势图
```

修改文件：

- `src/ui/index.ts`：`<head>` 增加 `theme-init.js`；`<script>` 改为 `type="module"`；顶栏增加状态位、主题按钮、汉堡按钮。
- `public/ui-static/app.js`：导入新模块；导航分组、状态栏、概览、表格、表单选择器改造。
- `public/ui-static/app.css`：主题变量、导航分组/抽屉、combobox、表格工具栏、状态栏、图表、空状态。

`package.json` 不变。

## 3. 模块设计

### 3.1 主题（theme-init.js + js/theme.js）

- CSS 以 `:root` 为深色默认值，新增 `:root[data-theme="light"]` 覆盖色变量；组件样式只引用变量，不写死颜色。
- `theme-init.js`（非 module、同步、同源）在 `<head>` 执行：读取 `localStorage["fufu.theme"]`，合法值（`dark`/`light`）写入 `document.documentElement.dataset.theme`。避免首帧闪烁，且符合 CSP。
- `js/theme.js` 导出 `initThemeToggle(button)` 与 `currentTheme()`：点击在 `dark`/`light` 间切换，更新 `dataset.theme` 与 `localStorage`，按钮 `aria-label` 同步。
- 默认深色；系统偏好不自动覆盖用户选择。

### 3.2 可搜索选择器（js/components/combobox.js）

导出两个工厂：

- `createCombobox({ input, panel, entries, value, multiple, maxHeight, onChange })`
  - `entries`: `{ value, label, group, description, keywords }[]`，由调用方从现有 lookup 数据生成。
  - 输入框键入即过滤（`label + value + description` 小写包含匹配），空查询显示全部分组。
  - 分组渲染：组标题 + 选项；高亮当前值；键盘 `ArrowUp/ArrowDown/Enter/Escape/Tab`。
  - 单选：选中后写回 input 的 `value` 并触发 `input`/`change` 事件，面板关闭。
  - 多选：点击选项切换勾选，渲染已选项标签（含移除），对外暴露 `getValues()`；调用方同步到隐藏表单元素。
- `comboboxHtml(name, entries, current, options)`：返回 HTML 片段——可见输入框 + 隐藏 `<input type="hidden" name="...">` + 面板容器，供 `formHtml` 直接插入。
- `bindComboboxes(root)`：在页面渲染后统一初始化 `[data-combobox]`，并把 value 同步到隐藏字段，保证 `readForm` 无需改动。

表单集成：

- `fieldHtml` 增加 `field.type === "combobox"` 分支，复用 `bindComboboxes`。
- 现有 `select` 字段按页替换为 `combobox`，提交值语义不变。
- 多选场景保留 `name` 隐藏字段，提交数组（JSON 或字符串）与现有 `modelMulti`/`routeTargetMulti` 逻辑一致。

### 3.3 迷你图表（js/components/charts.js）

- `sparkline(values, { width=160, height=40 })`：返回 SVG 字符串，折线 + 面积渐变，空数组返回空串。
- `miniBars(values, labels)`：用于日粒度费用/请求量。
- 仅使用 `viewBox` 与 CSS 变量颜色，无脚本动画；数据点全部由调用方传入。
- 概览使用 `summary.buckets` 的 `requests` 与 `costUsd`；无 bucket 时不渲染。

### 3.4 导航分组（js/nav.js）

- 导出 `NAV_GROUPS`：`[{ title: null, items: [["setup","快速开始"]] }, { title: "概览", items: ... }, ...]`。
- `app.js` 的 `PAGES` 由 `NAV_GROUPS` 展平生成，保证 `renderers` 与路由行为不变。
- `renderNav()` 渲染分组标题与链接；`activePage()` 逻辑不变。
- 移动端：`index.ts` 顶栏增加 `#nav-toggle`；CSS `<=980px` 下 `.sidebar` 脱离文档流为抽屉（`transform`），`.sidebar.open` 显示；遮罩 `#nav-backdrop` 点击或 `Esc` 关闭。桌面端隐藏汉堡与遮罩。

### 3.5 顶栏状态（app.js）

- `index.ts` 顶栏新增：`#config-state`（版本/未发布）、`#breaker-state`、`#theme-toggle`、`#nav-toggle`、既有 `#status-dot/#status-text`。
- `app.js` 新增 `refreshStatusBar()`：并行请求 `/admin/health`、`/admin/config/current`、`/admin/health/breakers`，用 `Promise.allSettled`，分别渲染；30 秒节流缓存；失败显示「状态不可用」。
- 登录成功与 `route()` 后调用（节流）。

### 3.6 概览页（app.js overviewPage）

- 改为 `Promise.allSettled([health, summary(day), config, requests, breakers])`。
- 每个指标卡独立 `ok/error` 状态；失败卡片显示「不可用」与重试链接（跳转对应页面或刷新）。
- 指标：数据库、配置版本/待发布、近 30 天请求、近 30 天费用、错误率（`totals.errors / totals.requests`，来自现有 summary）、非 CLOSED 断路器数。
- 趋势：`sparkline` 请求量与费用（取 `buckets`）。
- Top 模型/Provider：从 `requests` 的最近记录按模型计数（前端聚合，最多 5 项），数据为空时隐藏。
- 空配置/校验失败：顶部显示引导卡（去快速开始）与配置问题数，不再抛出整页错误。
- 保留「最近请求」表格与详情绑定。

### 3.7 表格增强（app.js tableHtml / crudPage）

- `crudPage` 增加工具栏：搜索输入（`#list-search`）、每页条数（20/50）、结果计数；状态保存在闭包内，不写入 URL。
- `tableHtml(entity, rows, options)` 第三参可选：
  - `options.query`：对 `row` 的可搜索文本（列 key + render 文本优先取 `row[column.key]`）做小写包含过滤。
  - `options.sort`：`{ key, dir }`，表头可点击（`data-sort`），排序值优先原始字段，缺失时排后。
  - `options.page`、`options.pageSize`：前端分页，底部渲染上一页/下一页与页码信息。
  - `options.emptyState`: `{ text, action: { label, onClick } }`；无数据时渲染 `empty-state` 卡片。
- 保持 `tableHtml(entity, rows)` 旧签名可用（默认不分页、搜索、排序）。
- 各 `crudPage` 实体补充 `emptyState` 配置与操作链接；Provider/模型/Combo/API Key 页面接入。
- Provider 表格：为徽章列、账户列、操作列设置 `nowrap`/最小宽度，操作区允许换行但不拆散单个按钮。

## 4. 数据流与兼容性

- 不新增/修改任何网络请求与响应结构；状态栏与概览只消费现有接口。
- combobox 的提交值仍通过同名隐藏 input 进入 `readForm`，`routeTarget`/`modelMulti`/`providerMulti` 的解析逻辑不变。
- `PAGES` 由导航分组展平，`renderers` 键不变，hash 路由与深链兼容。
- 旧 `tableHtml(entity, rows)` 调用保持行为；只有接入 `crudPage` 的列表获得搜索/排序/分页。
- 主题只影响样式，不影响功能与 API。

## 5. CSP 与安全

- 新增脚本全部同源；`theme-init.js` 为普通脚本，不使用内联 `<script>`，符合 `script-src 'self'`。
- 不引入 `eval`、`new Function`、内联事件处理器；所有事件用 `addEventListener`/`onclick` 赋值。
- combobox 渲染使用 `esc()` 转义用户/配置数据，禁止直接插入未转义 HTML。
- 不新增任何密钥或令牌存储；管理令牌仍只在 `sessionStorage`。

## 6. 可访问性

- combobox：`role="combobox"`、`aria-expanded`、`aria-controls`、`aria-activedescendant`；选项 `role="option"`、`aria-selected`。
- 抽屉导航：`aria-expanded`、`Esc` 关闭、焦点回到汉堡按钮。
- 主题按钮：`aria-pressed` 或动态 `aria-label`。
- 表格排序按钮：`aria-sort`。
- 颜色对比：亮/暗主题下正文、弱化文本、徽章、按钮对比度不低于现有深色主题水平。

## 7. 验证策略

- 后端回归：`npm run typecheck`、`npm test`、`npm run deploy:dry-run`。
- 前端手工走查（Playwright，本地 `wrangler dev`）：
  1. 空配置登录 → 概览降级与引导。
  2. 桌面/窄屏导航分组与抽屉。
  3. 各页面渲染与空状态操作。
  4. 路由诊断、Combo 表单、别名/通配符、API Key 表单、用量筛选的 combobox 选择与提交。
  5. 列表搜索、排序、分页。
  6. 亮/暗主题切换与刷新保持。
- 记录每步截图或快照，完成后清理。

## 8. 风险与回滚

- 风险 1：`app.js` 改为 ES module 后严格模式暴露隐式全局。缓解：先做 module 化并全页冒烟；如异常，可暂时保留 `defer` + 全局脚本，模块改为普通脚本挂载。
- 风险 2：combobox 值同步遗漏导致表单提交缺字段。缓解：隐藏 input 作为唯一数据源，逐表单验证提交。
- 风险 3：表格改造破坏行操作绑定。缓解：重渲染后统一重绑；保留旧签名。
- 风险 4：主题变量遗漏导致亮色下不可读。缓解：全部颜色收敛到变量清单，逐页检查。
- 回滚：改动集中在 3 个文件 + 4 个新文件，均为静态资源与 HTML 模板；回滚对应提交即可，无数据库/后端影响。

## 9. 实施顺序

1. 主题基础设施与 CSS 变量（可独立验证）。
2. ES module 化与导航分组/抽屉。
3. combobox 组件与表单接入。
4. 表格搜索/排序/分页与空状态。
5. 顶栏状态。
6. 概览页重构与图表。
7. 全量走查、清理与文档（README 的 UI 说明如需）。
