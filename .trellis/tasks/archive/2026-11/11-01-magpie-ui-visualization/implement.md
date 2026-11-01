# 实施计划：可视化与洞察（批次 2）

> 未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线确认

- [ ] 工作区干净，批次 1 提交存在。
- [ ] 记录基线：
  ```bash
  npm run typecheck
  npm test
  npm run deploy:dry-run
  ```
- [ ] `npm run dev` 启动本地服务，记录诊断/用量/客户端接入现状。

## 1. 渲染基础组件

- [ ] 新增 `public/ui-static/js/components/trace.js`：
  - `renderExecutionTree(node)`：状态、耗时、attempts、嵌套。
  - `renderRouteTrace({ route, execution })`：轨迹步骤 + 执行树。
  - `renderRoutePlan(plan)`：model/combo/inline 节点，递归。
  - `renderExplainResult(data)`：摘要 + 轨迹 + 计划 + 折叠 JSON。
  - 所有文本经 `esc()`，递归深度上限 32。
- [ ] `public/ui-static/js/components/charts.js` 增加 `barSeries(items, options)`：
  - 等宽柱、基线、`<title>` 提示、空数组返回空串、`options.formatter`。
- [ ] `public/ui-static/app.css` 增加：
  - `.trace-tree`、`.trace-node`、`.trace-row`、`.trace-status`、`.trace-attempts`、`.trace-children`
  - `.series-chart`、`.series-bars`、`.series-bar`、`.series-axis`
  - `.segmented`、`.segment`
  - `.detail-grid`
- [ ] 验证：在浏览器控制台动态 import，确认执行树与柱图 HTML 正常。

## 2. 路由诊断可视化

- [ ] `diagnosticsPage`：
  - 成功结果替换为 `renderExplainResult(data)`。
  - 失败展示错误码/消息 + 折叠 JSON。
  - 自测结果展示摘要、`renderExecutionTree(executionTrace)`、回复文本与折叠 JSON。
- [ ] 验证：
  - 不存在的模型：错误展示。
  - 临时创建 Provider/模型：解析成功，展示 match/trace/plan。
  - 自测（无上游账户）展示失败路径或明确错误。

## 3. 请求详情执行树

- [ ] 重写 `bindRequestDetails` 的详情渲染：
  - 基本信息网格。
  - `renderRouteTrace(routeTrace)`。
  - 无 `routeTrace` 时提示「该记录未包含执行轨迹」。
  - 折叠原始 JSON。
- [ ] 验证：
  - 无请求时不影响列表。
  - 使用网关自测生成的执行树验证渲染函数（同一组件）。

## 4. 用量页指标与图表

- [ ] `usagePage`：
  - 6 张指标卡：请求数、错误率、总 Token、缓存 Token、推理 Token、费用。
  - `buildSeries(buckets, from, to, groupBy)` 补零（day/week/month，最多 90 桶）。
  - 三张 `barSeries`：请求量、错误数、费用。
  - 缓存命中率提示。
  - 保留请求日志与模型筛选。
- [ ] 验证：日/周/月切换、无数据空态、有数据补零连续、亮/暗主题。

## 5. 客户端接入向导

- [ ] 重构 `connectPage`：
  - 分段控件与 6 个客户端定义。
  - 片段使用 `location.origin` 与占位 Key。
  - 每个片段复制按钮，复用现有复制/提示逻辑。
  - 默认 `claude-code`，切换仅重渲染片段区。
- [ ] 验证：切换、复制内容、窄屏布局、主题。

## 6. 全量验证与清理

- [ ] `npm run typecheck`。
- [ ] `npm test`（基线 226 项，允许既有 flaky 用例单独重跑）。
- [ ] `npm run deploy:dry-run`。
- [ ] Playwright 走查：
  - 诊断成功/失败、执行树、计划树。
  - 用量三图与粒度切换。
  - 客户端 6 片段与复制。
  - 亮/暗主题、980px 以下布局。
- [ ] 清理临时数据、截图、调试日志。
- [ ] `git status` 仅包含预期文件；`package.json` 未变。

## 7. 评审门禁

- [ ] 未修改后端接口/数据库。
- [ ] 未新增依赖。
- [ ] 未引入内联脚本，CSP 不变。
- [ ] 所有动态内容转义；SVG aria-label 转义。
- [ ] 执行树/计划对缺失字段容错。
- [ ] 批次 1 功能无回归。

## 8. 回滚点

- `trace.js`、`charts.js`、`app.js`、`app.css` 均为静态资源；按提交回退。
- 无数据库迁移与后端部署依赖。

## 9. 完成记录

- 完成日期：2026-11-01
- 状态：实现与本地验证完成，等待提交确认
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：24 个测试文件、227 项测试全部通过
  - `npm run deploy:dry-run`：通过
  - 本地 Playwright 走查：
    - 路由诊断：Combo 解析展示摘要/轨迹/计划；不存在的模型展示 `MODEL_NOT_FOUND`
    - 请求详情：本地构造记录展示基本信息、路由轨迹、嵌套执行树与两次尝试（200/429）
    - 用量页：6 项指标、日/周/月补零与柱状图（日 30、周 5、月 2）、缓存命中率 31.1%
    - 客户端接入：6 个片段切换、复制按钮、`aria-selected`
    - 亮/暗主题下图表、执行树、详情可读
- 实现偏差：
  - 执行树/计划的未知 `kind` 以原始文本展示；递归深度上限 32。
  - 补零序列上限 90 个桶，超出时取最近 90 个。
  - 客户端接入为静态片段模板，不自动写入代理配置文件。
  - 验证用本地 D1 临时数据（usage_rollups、request_logs、演示 Provider/模型/别名/Combo）已全部删除。
- 已知限制：
  - 请求日志列表仍为最近 50 条，没有游标分页 UI。
  - 图表无坐标轴刻度与 hover 数值面板（仅 SVG title 提示）。
  - `barSeries` 柱宽上限 40px，数据点很少时右侧留白。
- 提交：`8f0da45`（前端实现）。
