# 技术设计：可视化与洞察（批次 2）

## 1. 现状与约束

- 批次 1 已建立零构建 ES modules、主题变量、combobox、表格与概览。
- 后端数据已具备：路由解析（match/trace/plan）、网关自测（executionTrace）、请求详情（routeTrace.route/execution）、用量汇总（含 cached/reasoning/errors）。
- 不新增接口、不引入图表库；SVG 由字符串生成，颜色只用 CSS 变量。

## 2. 新增与修改模块

新增：

```
public/ui-static/js/components/trace.js     路由轨迹、执行树、计划树渲染
```

修改：

- `public/ui-static/js/components/charts.js`：新增 `barSeries()`（带基线、刻度与 title 提示）。
- `public/ui-static/app.js`：诊断页、请求详情、用量页、客户端接入页。
- `public/ui-static/app.css`：执行树、图表、分段控件、详情网格样式。

## 3. 渲染组件设计

### 3.1 trace.js

导出：

- `renderExecutionTree(node)`：递归渲染 `ComboTraceNode`。
- `renderRouteTrace(routeTrace)`：接受 `{ route, execution }`；分别渲染轨迹步骤与执行树。
- `renderRoutePlan(plan)`：渲染 `{ kind, name, strategy, nodes[] }` 计划树。
- `renderExplainResult(data)`：诊断结果整体（摘要 + 轨迹 + 计划 + 折叠 JSON）。

结构约定：

- 执行树节点：
  - 行：状态点（ok/failed/skipped/cancelled）+ `label` + kind 徽章 + 耗时。
  - 子行：`attempts` 列表（序号、provider/account、状态、耗时、errorCode）。
  - 递归 `children`，每层缩进 16px。
- 计划节点：
  - model：目标 `providerName / modelId`（含 upstream 时附加）、权重/优先级/超时。
  - combo：名称 + 策略，递归 `nodes`。
  - inline/未知：显示 kind 与名称。
- 所有用户/配置文本经 `esc()`。
- 耗时：优先 `finishedAt - startedAt`；缺失显示 `-`。

### 3.2 charts.js

`barSeries(items, options)`：

- `items: { label, value, title }[]`。
- 返回 SVG：等宽柱、底部基线、数值上限自适应、每柱 `<title>` 显示 label 与格式化值。
- `options.formatter` 将数值格式化为文本（费用用 `fmtUsd`，数量用 `fmtNumber`）。
- 空数组返回空串。
- 柱高为 0 时保留 1px 基线可见。

## 4. 页面改造

### 4.1 路由诊断

- `diagnosticsPage`：
  - 解析成功：`renderExplainResult(result)` 替换原 `<pre>`。
  - 解析失败：错误卡片（code + message）+ 折叠 JSON（若有 payload）。
  - 自测结果：摘要（Provider、模型、延迟、重试、Token）+ `renderExecutionTree(executionTrace)` + 文本回复 + 折叠 JSON。
- 保留原有表单与按钮行为。

### 4.2 请求详情

- 读取 `bindRequestDetails` 现有实现，将详情弹窗改为：
  - 基本信息网格（时间、状态、请求/实际模型、Provider、Token、耗时、费用、错误码）。
  - 路由轨迹步骤（`routeTrace.route`）。
  - 执行树（`routeTrace.execution`）。
  - 无轨迹提示。
  - 折叠原始 JSON。
- 详情请求仍使用 `GET /admin/requests/:id`。

### 4.3 用量页

- 指标卡改为 6 项：请求数、错误率、总 Token、缓存 Token、推理 Token、费用。
- 补零序列 `buildSeries(buckets, from, to, groupBy)`：
  - day：`from..to` 逐日；
  - week：按周一对齐；
  - month：`yyyy-mm` 逐月。
  - 上限 90 个桶，超出时截取最近 90 个。
- 三张柱状图：请求量、错误数、费用（`barSeries`）。
- 缓存命中率 = `cachedTokens / inputTokens`（input 为 0 显示 `-`）。
- 保留请求日志表格与模型筛选（combobox）。
- 无数据时保留现有引导。

### 4.4 客户端接入向导

- 新增分段控件（`.segmented`），客户端定义：
  - `claude-code`：环境变量（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN）+ 说明。
  - `codex`：`OPENAI_BASE_URL` + `OPENAI_API_KEY`。
  - `gemini-cli`：`GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`。
  - `openai-python`：Python SDK 片段。
  - `openai-curl`：curl Chat Completions。
  - `anthropic-curl`：curl Messages。
- 每个片段由 `location.origin` 与占位 Key `fufu_sk_...` 生成；提供复制按钮。
- 切换时只重渲染片段区域，保留选中状态（页面内存）。
- 默认选中 `claude-code`。
- 保留 Base URL 摘要卡与「Key 只显示一次」提示。

## 5. 数据流与兼容性

- 所有新请求均为现有接口；不改变请求参数。
- 用量补零只影响前端图表的展示序列，不改变接口返回。
- 诊断/详情保留原始 JSON 折叠，避免信息丢失。
- 批次 1 的导航、主题、列表、combobox 不改动行为。

## 6. 安全与可访问性

- 所有动态内容 `esc()`；SVG `aria-label` 转义。
- 执行树使用语义化列表（`ul/li`），状态文本不只依赖颜色。
- 复制按钮提供 `aria-label`，复制成功用现有 toast。
- 不写入真实密钥。

## 7. 验证策略

- 后端回归：`npm run typecheck`、`npm test`、`npm run deploy:dry-run`。
- 本地 `wrangler dev` + Playwright：
  1. 诊断：解析成功（构造临时模型）与失败（不存在的模型）。
  2. 请求详情：构造一条带 routeTrace 的记录较难，使用网关自测产生的执行树验证同一渲染函数；详情无轨迹时的提示。
  3. 用量：切换日/周/月，检查补零与图表。
  4. 客户端接入：6 个片段切换与复制。
  5. 亮/暗主题。
- 清理临时数据与截图。

## 8. 风险与回滚

- 风险：执行树/计划结构字段缺失导致渲染异常。缓解：所有字段可选，缺失显示 `-` 或跳过；递归深度上限。
- 风险：补零逻辑与时区偏差。缓解：使用 UTC 日期字符串（与后端一致），仅处理 `yyyy-mm-dd`。
- 风险：SVG 在窄屏溢出。缓解：`viewBox` + `preserveAspectRatio`，容器宽度 100%。
- 回滚：改动集中在 3 个文件（app.js、app.css、charts.js）与 1 个新文件，无后端依赖。

## 9. 实施顺序

1. `trace.js` 与 `barSeries`（可独立验证）。
2. 诊断页可视化。
3. 请求详情执行树。
4. 用量页指标与图表。
5. 客户端接入向导。
6. 样式、走查与文档。
