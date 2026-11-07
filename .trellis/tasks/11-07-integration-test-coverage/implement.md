# 实施计划：补齐端到端集成测试

## 前置

- [x] 创建 Trellis 任务 `11-07-integration-test-coverage`
- [x] 完成 PRD 与设计
- [x] 用户审阅规划并批准后 `task.py start`

## 步骤

### 1. 搭建测试基础设施

- [x] 新增 `test/integration/support.ts`
  - `createHarness()`、`call`、`admin`
  - `createProvider` / `createModel` / `createUser` / `createApiKey` / `publishConfig`
  - 四协议 JSON fixture 与 SSE fixture
- [x] 用 protocol-matrix 验证 helper

**验证**：`npm run typecheck` 通过。

### 2. 协议矩阵

- [x] 新增 `test/integration/protocol-matrix.test.ts`
- [x] 4 个上游 Provider + 4 个下游协议，16 个组合
- [x] 断言内容、Usage、响应头、上游 URL、认证头、模型映射

**验证**：16 passed。

### 3. 协议特性

- [x] 新增 `test/integration/protocol-features.test.ts`
- [x] Responses/Gemini 流式、count_tokens、工具调用、图片、兼容警告、四种错误格式

**验证**：11 passed。

### 4. 认证与授权

- [x] 新增 `test/integration/authz.test.ts`
- [x] scope / 白名单 / 过期 / 禁用用户 / 删除 / 篡改 / 管理 Key / 模型目录过滤

**验证**：15 passed。

### 5. 管理生命周期

- [x] 新增 `test/integration/admin-lifecycle.test.ts`
- [x] Provider/模型/价格/账户/用户/Key CRUD
- [x] 配置 current/validate/重复发布/版本
- [x] 审计、健康、熔断

**验证**：13 passed。

### 6. 路由与 Combo

- [x] 新增 `test/integration/routing-combos.test.ts`
- [x] glob、精确优先、priority、weighted RR、lowest_cost、禁用、validate、preview

**验证**：10 passed。

### 7. 用量与可观测

- [x] 新增 `test/integration/usage-reporting.test.ts`
- [x] 无 Usage、错误日志、汇总过滤、周/月聚合、游标、非法参数

**验证**：6 passed。

### 8. CORS

- [x] 新增 `test/integration/cors.test.ts`
- [x] 未允许来源 403；发布设置后允许来源 204/响应头；不允许来源仍 403
- [x] 允许来源的错误响应同样带 CORS 头；修复 `src/gateway/cors.ts` 实际推理响应未带 CORS 头

**验证**：9 passed。

### 9. 全量质量检查

- [x] `npm run typecheck`
- [x] `npm test`：38 个测试文件、371 个用例全部通过
- [x] 检查无真实网络调用、无跨文件依赖、无跳过用例
- [x] 记录新增用例数与覆盖矩阵
- [x] 记录测试暴露的产品问题（如有）

## 新增覆盖矩阵

| 文件 | 用例数 | 主要场景 |
| --- | ---: | --- |
| `protocol-matrix.test.ts` | 16 | 4 上游 × 4 下游非流式协议转换 |
| `protocol-features.test.ts` | 11 | 流式、工具、图片、count_tokens、兼容告警、错误格式 |
| `authz.test.ts` | 15 | API Key、scope、白名单、用户状态、管理面鉴权 |
| `admin-lifecycle.test.ts` | 13 | Provider/模型/账户/用户/Key/配置/设置/审计/健康 |
| `routing-combos.test.ts` | 10 | priority、加权轮询、最低成本、glob、Combo 管理 |
| `usage-reporting.test.ts` | 6 | 用量记录、错误日志、汇总过滤、周/月聚合、游标 |
| `cors.test.ts` | 9 | 默认关闭、发布生效、允许/拒绝来源、通配符、错误响应 |
| **合计** | **80** | |

## 发现与修复

1. `src/gateway/cors.ts`：中间件在 `await next()` 前用 `c.header()` 设置 CORS 头，推理 handler 返回自建 `Response` 时这些头不会合并到最终响应。结果是预检通过但浏览器仍会拦截实际响应。已改为在 `await next()` 后直接写入 `c.res.headers`，并补充 `cors.test.ts` 回归断言。

## 回滚点

- 测试改动仅新增 `test/integration/*.test.ts` 和 `test/integration/support.ts`。
- 生产代码改动仅 `src/gateway/cors.ts` 的响应头写入时机。
- 回滚方式：删除新增测试文件并还原 `src/gateway/cors.ts`；不影响既有测试与其他功能。

## 完成标准

- 新增用例 ≥ 55 且全部通过（实际 80）。
- 原有测试全部通过（全量 371 passed）。
- `npm run typecheck` 通过。
- 任务 notes 记录覆盖矩阵与发现项。
