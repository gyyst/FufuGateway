# 补齐端到端集成测试覆盖

## Goal

以真实用户使用场景补齐 FufuGateway 的集成测试，验证四协议接入、上游路由、Combo 编排、权限、管理后台、配置发布与用量统计的端到端行为，降低回归风险。

## Background

- 现有 25 个测试文件、237 个用例全部通过，已有协议转换、流式、Combo、重试、用量等基础覆盖。
- 现有集成测试仍偏“单点验证”：多为 OpenAI Chat 上游，管理面只覆盖创建/列表，权限白名单、Responses/Gemini 流式、glob Combo、配置版本状态、审计与可观测接口等用户实际会走的链路尚未覆盖。
- 本次只补测试与测试基础设施，不改产品行为；若测试暴露真实缺陷，单独记录并在任务中说明处理方式。

## Requirements

### R1 协议端到端矩阵

- 覆盖 4 种下游协议（OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini）到 4 种上游协议（openai-chat、openai-responses、anthropic、gemini）的非流式组合。
- 每个组合验证：下游响应格式与文本、Usage 映射、`x-fufu-*` 响应头、上游 URL、上游认证头、上游请求中的模型映射。

### R2 协议特性与错误格式

- 覆盖 Responses 流式与 Gemini 流式的真实 SSE 输出。
- 覆盖工具调用、图片跨协议转换、`count_tokens`、兼容性警告头。
- 覆盖四种下游协议在模型不存在/请求错误时的协议专属错误结构。

### R3 认证与授权

- 覆盖 API Key 的 scope、模型白名单、Provider 白名单、过期、禁用用户、删除、篡改。
- 覆盖管理面仅允许 `ADMIN_TOKEN` 或 `admin` 角色 + `admin` scope 的 Key。
- 覆盖 Gemini `?key=` 与 Anthropic Bearer 兼容凭据位置。
- 覆盖 `/v1/models`、`/v1/models/:id`、`/v1beta/models` 的权限过滤。

### R4 管理生命周期

- 覆盖 Provider、账户、模型、价格、用户、API Key 的创建、读取、更新、删除与关键校验错误。
- 覆盖 Provider 删除级联、模型删除后路由消失、配置发布后生效。
- 覆盖配置 `current` 待发布状态、`validate`、重复发布、版本列表与回滚。
- 覆盖审计日志、管理健康、熔断状态接口。

### R5 路由与 Combo

- 覆盖 glob Combo 命中、精确名称优先、glob 优先级/具体度排序。
- 覆盖 `priority`、`weighted_round_robin`、`lowest_cost`、禁用 Combo。
- 覆盖 Combo `validate` 与 `preview` 的返回语义。

### R6 用量与可观测

- 覆盖上游缺少 Usage 时的行为（不得伪造真实用量）。
- 覆盖错误请求日志、用量汇总过滤、按周/月聚合、请求日志游标。
- 覆盖 CORS 设置发布前后的预检与实际请求行为。

### R7 测试工程质量

- 新测试通过公开 HTTP 接口驱动，仅 mock 上游 `fetch`，不访问真实付费 API。
- 测试文件之间相互隔离，不依赖执行顺序；单个用例可重复运行。
- 不修改生产代码；如必须修复测试暴露的缺陷，需在任务记录中明确说明并单独验证。

### Out of Scope

- 不新增性能/压力测试、混沌测试、真实厂商联调。
- 不覆盖 R2 归档、Cron 清理的完整端到端（现有单元/维护逻辑不在本次范围）。
- 不重构现有测试或生产代码。

## Acceptance Criteria

- [ ] 新增集成测试覆盖 R1-R6 中列出的全部场景，测试名称直接描述用户场景与预期结果。
- [ ] `npm test` 全量通过，新增用例数量不少于 55 个，原有 237 个用例不回退。
- [ ] `npm run typecheck` 通过。
- [ ] 新测试无真实网络访问，所有上游响应由测试内 mock 提供。
- [ ] 测试中不出现对内部函数/数据库结构的过度断言；数据库断言仅用于验证用户可见结果（如用量日志、审计记录）。
- [ ] 测试文件可单独运行（`npx vitest run test/integration/<file>`）且稳定通过。
- [ ] 任务记录中列出新增文件、覆盖矩阵与发现的产品问题（如有）。
