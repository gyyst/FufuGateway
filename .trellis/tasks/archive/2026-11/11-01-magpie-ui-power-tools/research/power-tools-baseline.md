# 调研基线：效率与运维能力

## 1. 可直接复用的现有能力

- `GET /admin/config/versions` 已返回 version/checksum/status/note/createdBy/createdAt/sizeBytes，配置页已有版本历史与回滚；没有读取版本 payload 的接口，因此本批次不做内容 diff。
- `GET /admin/health/breakers` 返回每个 Provider：
  ```ts
  {
    providerId, providerName,
    providerState: { id, name, state, consecutiveFailures, windowFailures, windowTotal },
    accounts: [{ id, name, state, consecutiveFailures, windowFailures, windowTotal }],
    models: [{ id, name, state, consecutiveFailures, windowFailures, windowTotal }]
  }
  ```
- `GET /admin/usage/summary` 支持过滤参数 `userId`、`apiKeyId`、`providerId`、`model`、`comboId`，返回 totals 与 buckets。
- 用户与 API Key 记录包含 `dailyBudgetUsd`、`monthlyBudgetUsd`。
- 前端 `state` 在 `ensureLookups`/`ensureRouteLookups` 后持有 providers、models、aliases、combos、wildcards、users。
- 页面路由为 `#/<page>`，`PAGES` 由导航分组展平。

## 2. 本批次三个能力

### 2.1 命令面板（Ctrl/Cmd+K）

- 纯前端；数据来自已加载的 state 与 PAGES。
- 支持搜索页面与实体名称，回车跳转对应页面。
- 选中实体后把名称写入该页面的列表搜索框（跨页面传递一个 pending query）。

### 2.2 Provider 健康

- 在 Provider 列表行增加「健康」操作，弹窗展示该 Provider 的断路器状态、账户与模型的失败计数。
- 数据源 `/admin/health/breakers`，按 providerId 过滤。
- 状态色沿用 ok/warn/bad 变量。

### 2.3 预算进度

- 在 API Key 列表与用户列表增加「预算」操作。
- 弹窗并行请求今日与本月用量（按 `apiKeyId` 或 `userId` 过滤），展示已用费用 / 预算与进度条。
- 无预算时提示「未设置预算」。
- 只读展示，不修改预算。

## 3. 约束

- 零构建、零依赖；不新增后端接口。
- 命令面板与弹窗内容全部经 `esc()`。
- 保持批次 1/2 的导航、主题、列表与可视化行为。
