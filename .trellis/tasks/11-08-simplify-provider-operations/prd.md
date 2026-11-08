# 精简 Provider 操作与重复逻辑

## Goal

收敛管理台 Provider 页面的操作入口，并消除 `src/providers`、Provider 管理 handler 与前端中重复的实现，在**不改变任何 API 路径、响应契约与业务语义**的前提下，让每个操作只有一个入口、每段逻辑只有一份实现。

## Background

当前重复点：

1. **管理台行操作 6 个**：健康 / 设置 / 模型 / 账户 / 测试 / 同步模型。
   - 「设置」弹窗内又是 6 个按钮：管理账户、同步模型、刷新元数据、查看模型、模型列表测试、Chat 自测。除 Chat 自测外全部与其他入口重复。
   - 「同步模型」同时存在于行操作、「设置」弹窗与「模型」弹窗。
   - 「模型列表测试」同时存在于行操作与「设置」弹窗。
2. **前端逻辑重复**：同步模型逻辑 3 份（行操作 / 设置弹窗 / 模型弹窗），刷新元数据逻辑 2 份（设置弹窗 / 模型弹窗）。
3. **管理 handler 重复**：`testProviderHandler`、`refreshModelMetadataHandler` 各自重复「取可用账户 → 拉上游模型列表」；`updateProviderHandler` 对同一组 `baseUrl` + `customHeaders` 校验两次；`mergeProvider` 手写 14 个字段的逐项合并。
4. **`src/providers/transport.ts` 重复**：4 个 Transport 类的 `buildEndpoint` / `buildModelsEndpoint` / `buildAuth` 方法体完全相同；`engine.ts` 中 `fetchProviderModels` 与 `buildProviderRequest` 重复 `transport.supports()` 检查；`fetchProviderModels` 错误分支存在恒等三元表达式。

## Requirements

### R1. 管理台 Provider 行操作收敛为 4 个

保留且仅保留：

- **健康**：`openProviderHealth`（熔断状态）
- **账户**：`openAccounts`
- **模型**：`openProviderModels`
- **测试**：新增 `openProviderTest`，合并原行级「模型列表测试」与「设置」中的 Chat 自测

### R2. 删除「设置」聚合弹窗

- 删除 `openProviderSetup` 及 `#setup-*` 绑定。
- 其独有能力「Chat 自测」并入「测试」弹窗。
- 统计信息（账户数/模型数/凭据状态）不再单独展示：账户数已在列表列中，模型数在「模型」弹窗中。

### R3. 删除行级「同步模型」

- 同步模型只在「模型」弹窗内提供（保留「同步模型」「刷新元数据」「手动添加模型」三个按钮）。
- 不删除 `/admin/providers/:id/sync-models` 与 `/admin/providers/:id/refresh-model-metadata` 端点。

### R4. 前端抽取公共操作函数

- 抽取 `syncProviderModels(provider)` 与 `refreshProviderMetadata(provider)`，供「模型」弹窗复用。
- 两个函数负责确认、请求、`notifyConfigOutcome`、置 `state.routeLookupsLoaded = false` 并返回是否成功；调用方负责关闭/重开弹窗与 `route()`。

### R5. 管理 handler 去重

- 抽取「选择可用账户 + 拉取上游模型列表」的公共 helper，供 `testProviderHandler` 与 `refreshModelMetadataHandler` 使用。
- `updateProviderHandler` 只做一次 URL/Header 校验。
- `mergeProvider` 改为直接展开 schema 解析后的 partial 输入。
- 保留现有错误码、错误消息与响应字段不变。

### R6. `src/providers` 去重

- 合并 4 个 Transport 类为一个参数化的 `StandardTransport`（type + 支持的协议列表 + `parseModels` 函数）。
- `CUSTOM` 的 `supports` 语义保持「支持任意协议」。
- `engine.ts` 抽取 `requireTransport(provider)` 并删除恒等三元表达式。
- `providerTransports` 注册表与 `ProviderTransportRegistry` 行为不变。

### R7. 文档同步

- 更新 `docs/PROVIDERS.md` 中涉及管理台操作入口的表述（如「设置」、行级「同步模型」）。
- 不修改 API 文档的端点定义。

## Non-Goals

- 不删除或重命名任何 `/admin/*` 端点。
- 不改变同步、刷新元数据、连通性测试的行为与响应结构。
- 不改变配置自动发布、审计、凭据脱敏逻辑。
- 不调整 Provider 表单字段与模型能力字段。
- 不引入前端构建工具或新依赖。
- 不做视觉改版；仅调整操作入口与复用结构。

## Constraints

- 管理台是零构建原生 JS，保持 IIFE 与 `modal()` / `openEntityForm()` 现有模式。
- 所有插入 HTML 的动态值仍需 `esc()`。
- 每个配置写入仍必须通过 `configMutationResponse` 返回。
- `test/unit/provider-metadata-parse.test.ts` 如需调整，只能改为通过 `providerTransports` 取实例，不能削弱断言。
- 现有集成测试不得修改断言语义。

## Acceptance Criteria

- [ ] Provider 行操作仅剩「健康」「账户」「模型」「测试」4 个。
- [ ] 代码中不再存在 `openProviderSetup`、`setup-accounts`、`setup-sync`、`setup-refresh-metadata`、`setup-models`、`setup-test`、`setup-chat-test`。
- [ ] 「同步模型」前端调用点只有 1 处（模型弹窗，经公共函数）。
- [ ] 「刷新元数据」前端调用点只有 1 处（模型弹窗，经公共函数）。
- [ ] 「测试」弹窗可完成模型列表测试与 Chat 自测，Chat 自测仍有费用确认。
- [ ] `testProviderHandler` / `refreshModelMetadataHandler` 不再各自拼装「取账户 + 拉模型」逻辑。
- [ ] `updateProviderHandler` 对 URL/Header 只校验一次，行为与原先一致。
- [ ] `transport.ts` 不再有 4 份相同方法体；`engine.ts` 的 `transport.supports` 检查只有 1 处。
- [ ] `npm run typecheck`、`npm test` 全部通过。
- [ ] `docs/PROVIDERS.md` 中管理台操作描述与新 UI 一致。
