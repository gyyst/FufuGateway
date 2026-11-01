# 调研基线：Magpie 对比与管理台现状

## 1. Magpie 的可借鉴点（与 FufuGateway 相关的部分）

| Magpie 能力 | 对本项目的适用性 | 本项目现状 | 本批次处理 |
|---|---|---|---|
| 可搜索的统一模型选择器（点击配置值弹出搜索列表） | 高 | 原生 select | 做（combobox） |
| 路由决策可视化、实时追踪 | 高 | 路由诊断为 JSON | 批次 2 |
| Agents 页面按客户端生成配置 | 中高 | 客户端接入为静态片段 | 批次 2（向导） |
| 用量/成本/缓存/会话洞察 | 高 | 基础汇总 + 横向条形 | 批次 1 指标与迷你图，批次 2 深度图表 |
| Profiles 一键切换 | 中 | 配置版本发布/回滚 | 批次 3（命名/对比） |
| 亮/暗主题 | 高 | 仅暗色 | 做 |
| Provider 预设 + 粘贴密钥 + 导入 | 中 | 预设与向导已完成 | 不重复 |
| 菜单栏/TUI/CLI、代理配置改写、订阅账号复用、隐私掩码、Web 搜索/图片、JS 中间件 | 低（Go 本地桌面网关定位） | 无 | 不做 |

## 2. 本地实测发现（2026-11-01，wrangler dev + Playwright）

- 概览页：`Promise.all` 中 `/admin/health/breakers` 返回 400，整页显示「加载失败 · Configuration validation failed with 3 error(s)」；空配置实例不可用。
- 导航：14 项平坦排列；视口 932px 时触发 `max-width: 980px` 断点，侧栏变为三列链接网格，层级丢失。
- 快速开始页：指标卡 + 步骤卡 + 徽章结构清晰，是本项目已有的较好交互，保留。
- Provider 页：表格列「启用」徽章、账户数、操作按钮发生换行，列宽失衡。
- 模型页：空状态仅「暂无数据」，无同步/新建入口。
- 用量页：筛选下拉被 `.btn` 样式拉满整行并垂直堆叠；趋势为横向条形，无时间序列感。
- 路由诊断：模型为原生 select；结果区 `JSON.stringify` 直接展示。
- 客户端接入：Base URL 卡 + 代码块 + 复制按钮，结构良好；缺少按客户端切换。

## 3. 关键实现事实（设计前提）

- `public/ui-static/app.js` 为 IIFE（`(() => { "use strict"; ... init(); })()`），约 3300 行；改为 ES module 时保留 IIFE，`import` 置于外层。
- `readForm(form, fields, isEdit)` 通过 `form.elements.namedItem(name)` 与 `input[type=checkbox][name=...]` 取值；新控件提供同名隐藏 input 即可兼容。
- `selectHtml(name, options, current, placeholder)` 生成原生 select。
- `tableHtml(entity, rows)` 无搜索/排序/分页；`crudPage(entity)` 统一列表页并在渲染后绑定行操作。
- `PAGES` 为 `[key, label]` 数组；`renderers` 按 key 映射页面函数；hash 路由 `#/<page>`。
- `/admin/usage/summary` 返回的 bucket/totals 含 `requests`、`errors`、`inputTokens`、`outputTokens`、`cachedTokens`、`reasoningTokens`、`costUsd`，可直接支撑概览错误率与迷你趋势图，无需后端改动。
- CSP：`script-src 'self'; style-src 'self' 'unsafe-inline'`；不能使用内联脚本，主题首帧需同源同步脚本。
- `src/ui/index.ts` 输出 HTML 外壳并设置安全头；静态资源来自 `public/ui-static/`。

## 4. 本批次范围

导航分组/抽屉、顶栏状态、可搜索 combobox、表格搜索排序分页与空状态、概览降级与迷你图、亮暗主题。不涉及后端、构建链、依赖变更。
