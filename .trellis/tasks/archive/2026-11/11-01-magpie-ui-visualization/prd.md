# 参考 Magpie 优化管理台交互与视觉体验（批次 2：可视化与洞察）

## Goal

在批次 1（主题、导航、combobox、列表、概览）基础上，把管理台的「路由与成本」从 JSON/汇总数字升级为可读的可视化视图：路由解析轨迹、请求执行树、用量趋势与缓存/推理细分、按客户端生成接入配置。仅改前端静态资源。

## Background

- 批次 1 已完成并提交：主题、ES modules、导航、可搜索选择器、列表、概览、顶栏状态。
- 现有后端已提供所需数据，无需新接口：
  - `POST /admin/routing/explain`：`match`、`trace[]`、`plan.nodes`。
  - `POST /admin/gateway/test`：额外返回 `executionTrace`（`ComboTraceNode`）。
  - `GET /admin/requests/:id`：`routeTrace = { route, execution }`。
  - `GET /admin/usage/summary`：`buckets`/`totals` 含 requests、errors、input/output/cached/reasoning/totalTokens、costUsd。
- 现状：诊断与请求详情直接展示 JSON；用量页仅有费用横条；客户端接入为静态代码块。

## Users and Scenarios

### 场景 A：排查一次异常请求

管理员在「用量与请求」打开某条请求详情，看到请求从下游模型到路由决策、Combo 节点、Provider/账户、每次尝试的耗时与状态，快速定位失败环节。

### 场景 B：验证路由配置

管理员在「路由诊断」输入模型并解析，看到匹配类型、匹配轨迹、Combo 计划（策略/节点/权重/超时），而不是阅读一段 JSON。

### 场景 C：成本与缓存洞察

管理员在「用量与请求」查看按日/周/月的趋势图、错误率、缓存命中率、推理 Token 占比，判断成本变化来源。

### 场景 D：接入客户端

管理员在「客户端接入」选择 Clude Code / Codex / Gemini CLI / OpenAI SDK / Cursor 等，得到对应格式的配置片段并复制。

## Requirements

### R1. 路由解析可视化（诊断页）

- 解析成功后展示：
  - 匹配摘要：请求模型、匹配类型、Provider/模型（若存在）。
  - 匹配轨迹：`trace[]` 以步骤列表展示，保留顺序。
  - Combo 计划：`plan` 的策略、名称与节点列表；每个节点展示目标（模型/别名/Combo/通配符）、权重、优先级、超时、重试、策略。
  - 嵌套节点以缩进/连接线表达层级（若 plan 中节点目标为 Combo）。
- 原始 JSON 折叠保留（`<details>`），便于排查。
- 解析失败时展示错误码与消息，不显示空壳可视化。

### R2. 请求执行树（请求详情）

- 请求详情弹窗展示基础信息（时间、状态、模型、Provider、Token、耗时、费用、错误码）。
- 若 `routeTrace.execution` 存在，渲染执行树：
  - 节点：`label`、`kind`、`status`（ok/failed/skipped/cancelled）、耗时（finishedAt-startedAt）。
  - 每次 `attempts`：序号、Provider/账户（有则显示）、状态、耗时、错误码。
  - 嵌套结构用缩进与状态色表达。
- 若 `routeTrace.route` 存在，展示路由轨迹步骤。
- 无轨迹时明确提示「该记录未包含执行轨迹」。
- 保留原始 JSON 折叠。

### R3. 用量图表与细分指标

- 指标卡：请求数、错误率、总 Token、费用；补充缓存 Token 与推理 Token（有数据时）。
- 时间序列图：按所选粒度（日/周/月）绘制请求量、费用、错误数的折线或柱状图；缺失周期补 0（使用 `from`/`to` 与 `buckets` 对齐）。
- 缓存命中率：`cachedTokens / inputTokens`（inputTokens 为 0 时显示「-」）。
- 保留现有请求日志表格与筛选。
- 无数据时显示空状态与「前往客户端接入」引导。

### R4. 客户端接入向导

- 提供客户端切换（Tabs 或分段控件）：Claude Code、Codex、Gemini CLI、OpenAI Python SDK、OpenAI Chat（curl）、Anthropic Messages（curl）。
- 每个客户端展示对应的环境变量 / 配置文件 / 命令片段，使用 `location.origin` 与占位 Key。
- 每个片段提供复制按钮；复制成功有提示。
- 说明 API Key 只在创建/轮换时显示一次。
- 不写入真实密钥。

## Non-Goals

- 不新增或修改后端接口、数据库结构。
- 不做实时 WebSocket/SSE 追踪（现有请求为轮询式页面）。
- 不做成本预测、预算告警、账单导出（Magpie Bills/OTLP 等）。
- 不做 Ctrl+K 命令面板、配置快照对比、Provider 健康卡片（批次 3）。
- 不引入图表库或前端框架。

## Constraints

- 零构建、零依赖；图表使用内联 SVG。
- 兼容现有 CSP（`script-src 'self'`，无内联脚本）。
- 所有动态内容经 `esc()` 转义。
- 不破坏批次 1 的导航、主题、列表、combobox 行为。
- 中文界面与现有风格一致。

## Acceptance Criteria

- [ ] 路由诊断成功时展示匹配摘要、轨迹步骤、Combo 计划节点；JSON 可折叠查看。
- [ ] 路由诊断失败时展示错误信息，不出现空可视化。
- [ ] 请求详情有执行轨迹时渲染树与尝试明细；无轨迹时显示明确提示。
- [ ] 执行树的嵌套层级、状态色、耗时与错误码正确显示。
- [ ] 用量页展示请求量/费用/错误数时间序列，缺失周期补 0；显示缓存命中率与推理 Token。
- [ ] 切换日/周/月粒度后图表随之更新。
- [ ] 客户端接入支持至少 6 种片段切换与复制。
- [ ] 亮/暗主题下图表与执行树可读。
- [ ] `npm run typecheck`、`npm test`、`npm run deploy:dry-run` 通过。
- [ ] Playwright 走查：诊断解析、请求详情（有/无轨迹）、用量粒度切换、客户端切换与复制、主题切换。
- [ ] 工作区无临时文件，`package.json` 无变化。

## Notes

- 数据结构见 `research/trace-baseline.md`。
- 复杂任务，需 `design.md` 与 `implement.md` 后方可 `task.py start`。
