# 实施计划：基础供应商、路由与网关可用性

> 本文是执行清单。未经用户确认计划并执行 `task.py start` 前，不修改业务代码。

## 0. 基线确认

- [ ] 确认当前分支、工作区干净。
- [ ] 运行基线检查：
  ```bash
  npm run typecheck
  npm test
  npm run deploy:dry-run
  ```
- [ ] 记录当前测试数量（基线 200 项）和 dry-run 结果。
- [ ] 确认现有线上状态：`huawei` Provider、0 账户、0 模型、0 配置版本。不要自动修改线上数据。

## 1. Provider 预设与 URL 拼接

- [ ] 新增 `src/providers/presets.ts`：
  - `ProviderPreset` 类型。
  - 首批预设（火山方舟 OpenAI/Anthropic、华为云 MaaS、OpenAI、Anthropic、Gemini、DeepSeek、Kimi、GLM、Qwen、OpenRouter、Groq、Mistral、xAI、Together、Fireworks、SiliconFlow、自定义兼容端点）。
  - 每个预设包含 `docsUrl`/`notes`。
  - 预设 ID 唯一，Base URL 可被 UI 修改。
- [ ] 修改 `src/providers/transport.ts`：
  - 识别任意 `/vN` 版本后缀，不再只识别 `/v1`。
  - Chat/Responses/Anthropic/Models 端点共用规范化逻辑。
  - 保留 `extraConfig.endpointPath` 覆盖。
- [ ] 新增 `test/unit/provider-paths.test.ts`：
  - OpenAI、Ark `/api/v3`、Huawei `/openai/v1`、GLM `/api/paas/v4`、OpenRouter `/api/v1`、DashScope `/compatible-mode/v1`。
  - Chat 和 Models 两套断言。
  - `endpointPath` 覆盖。
- [ ] 新增 `test/unit/provider-presets.test.ts`：
  - 预设 ID 唯一。
  - 必填字段完整。
  - Ark OpenAI/Anthropic 使用不同 Base URL。
- [ ] 运行：
  ```bash
  npm run typecheck
  npm test -- test/unit/provider-paths.test.ts test/unit/provider-presets.test.ts
  ```

## 2. Admin API：预设、快速开始、诊断

- [ ] 新增 `src/admin/schemas.ts` 中的请求 schema：
  - `routingExplainSchema`（model）。
  - `gatewayTestSchema`（model、prompt 可选、maxOutputTokens 1–32）。
  - `providerTestSchema`（model 可选）。
- [ ] 新增 `src/admin/handlers/setup.ts`：
  - `listProviderPresetsHandler`（或放在 providers handler）。
  - `setupStatusHandler`。
  - 复用现有配置状态读取，不复制 snapshot 逻辑。
  - Secrets 只返回布尔值。
  - 查询 `audit_logs` 最近 `gateway.test.*`。
- [ ] 新增 `src/admin/handlers/diagnostics.ts`：
  - `routingExplainHandler`：`loadRuntimeConfig` + `ModelRouter.resolve`，返回安全摘要。
  - `gatewayTestHandler`：
    - 使用 OpenAI Chat 适配器构造最小请求。
    - 调用 `executeRoutePlan`，非流式，30 秒超时。
    - 只允许管理员。
    - 写审计 `gateway.test.success`/`gateway.test.failure`，不记录 prompt/reply/key。
    - 不写 Usage/配额。
- [ ] 修改 `src/admin/routes.ts`：
  ```ts
  app.get("/admin/provider-presets", listProviderPresetsHandler);
  app.get("/admin/setup/status", setupStatusHandler);
  app.post("/admin/routing/explain", routingExplainHandler);
  app.post("/admin/gateway/test", gatewayTestHandler);
  ```
- [ ] 修改 `src/admin/handlers/providers.ts`：
  - 保留模型列表测试，不新增请求体。
  - 无账户返回 `PROVIDER_NO_ACCOUNT` 可操作提示。
  - 401/403、404/405、网络错误区分。
- [ ] 新增/修改集成测试：
  - `test/integration/setup.test.ts`（完整链路、Ark/Huawei URL、setup status、explain、gateway test）。
  - Provider 无账户测试错误。
- [ ] 运行：
  ```bash
  npm run typecheck
  npm test -- test/integration/setup.test.ts
  ```

## 3. UI：快速开始与 Provider 预设

- [ ] `public/ui-static/app.js`：
  - `PAGES` 增加 `setup`、`diagnostics`、`connect`。
  - 新增 `setupPage`：调用 `/admin/setup/status`，渲染步骤卡片、warning、待发布横幅。
  - 扩展 `openEntityForm(entity, row, overrides)`，保持现有调用兼容。
  - Provider 页面增加“从预设添加”：
    - `GET /admin/provider-presets`。
    - 搜索/过滤 modal。
    - 选择后预填 Provider 表单。
  - Provider 行增加“设置”操作：
    - 基本信息、账户数、模型数。
    - 添加账户、同步模型、查看模型、测试连接、去发布。
  - 模型列表增加“启用/停用”快捷操作（调用现有 PUT）。
  - Provider 模型 modal：列出模型、能力状态、“编辑并启用”。
  - 配置页增加未发布横幅和发布按钮。
- [ ] `public/ui-static/app.css`：
  - 步骤卡片、完成/未完成状态、warning 横幅、预设列表、快捷操作按钮。
- [ ] 更新 `test/integration/ui.test.ts`：
  - 页面包含“快速开始”“路由诊断”“客户端接入”。
  - `/ui-static/app.js` 包含新页面标识。
- [ ] 手工本地验证：
  ```bash
  npm run dev
  ```
  - 打开 `http://localhost:8787/ui`。
  - 从预设添加 Provider，确认字段预填。
  - 快速开始步骤随配置变化。

## 4. UI：路由诊断与客户端接入

- [ ] `diagnosticsPage`：
  - 输入模型名。
  - 调用 `/admin/routing/explain`。
  - 展示 match/trace/plan/目标/账户存在性/错误。
  - “运行网关自测”调用 `/admin/gateway/test`，提示真实费用，限制输出。
- [ ] `connectPage`：
  - 使用 `location.origin` 渲染 OpenAI/Anthropic/Gemini Base URL。
  - 认证头说明。
  - curl、OpenAI Python SDK、Claude Code、Codex、Gemini CLI 片段。
  - 复制按钮。
  - 提示下游 Key 只在创建/轮换时显示一次。
- [ ] 手工验证复制内容不含真实密钥。

## 5. 文档

- [ ] `docs/PROVIDERS.md`：
  - 预设列表和文档链接。
  - 火山方舟 OpenAI/Anthropic Base URL 区别。
  - 华为云 MaaS OpenAI 兼容 Base URL 和区域限制。
  - Base URL 版本路径规则。
  - `secretRef` 推荐用法。
- [ ] `docs/API.md`：
  - `/admin/provider-presets`
  - `/admin/setup/status`
  - `/admin/routing/explain`
  - `/admin/gateway/test`
  - Provider test 可选 `model`。
- [ ] `docs/DEPLOY.md`：
  - 首次部署快速开始流程。
  - Secrets 配置和备份。
  - 现有 Provider 缺账户/模型的排查。
- [ ] `README.md`：
  - 更新快速开始为“预设 → 账户 → 模型 → 发布 → Key → 自测”。
  - 客户端接入链接。
- [ ] 确保文档不包含真实密钥、账户 ID 或私有 URL。

## 6. 全量验证

- [ ] 类型检查：
  ```bash
  npm run typecheck
  ```
- [ ] 全部测试：
  ```bash
  npm test
  ```
  预期：现有 200 项 + 新增测试全部通过。
- [ ] 打包验证：
  ```bash
  npm run deploy:dry-run
  ```
- [ ] 本地冒烟：
  ```bash
  npm run dev
  ```
  - `/health` 200。
  - `/ui` 200。
  - 快速开始页可加载。
  - 预设 Provider 表单可预填。
  - 路由诊断接口对不存在的模型返回可读错误。
- [ ] 部署后冒烟（需要管理员令牌，不打印密钥）：
  - `/admin/setup/status` 200。
  - `/admin/provider-presets` 200。
  - `/admin/routing/explain` 对现有 `huawei` Provider 返回缺失账户提示。
  - 若用户提供有效上游 Key，完成一次真实 gateway test；否则只用假上游集成测试。

## 7. 评审门禁

- [ ] 不新增明文密钥。
- [ ] 不自动修改现有 `huawei` Provider。
- [ ] 不按模型名称推断能力。
- [ ] 不伪造 Provider 测试/网关自测成功。
- [ ] 不破坏四协议转换、Combo、限流、用量。
- [ ] 所有新管理接口经过 `requireAdmin`。
- [ ] 错误响应不包含上游密钥、Secrets、堆栈。
- [ ] UI 无构建依赖，仍由 Worker Assets 提供。
- [ ] 文档与实现一致。

## 8. 回滚点

- 后端新增 API 与预设是增量，可单独回退。
- URL 规范化修改影响所有 Provider，必须先通过单元/集成测试；如线上异常，回退 `transport.ts`。
- UI 新页面是增量，可回退 `app.js`/`app.css`。
- 无 D1 迁移，回滚不需要数据库操作。
- 现有配置数据不被自动修改。

## 9. 提交与部署

- [ ] 分支：`feature/magpie-provider-usability`（或按 Trellis 任务建议）。
- [ ] 提交信息按功能拆分：
  1. `feat: add provider presets and fix versioned base URLs`
  2. `feat: add setup status and gateway diagnostics APIs`
  3. `feat: add guided provider setup and client access pages`
  4. `docs: document presets, setup and client integration`
- [ ] 推送后等待 Workers Builds 成功。
- [ ] 部署后重新运行 `/admin/setup/status` 和 `/health/ready`。
- [ ] 如需生产验收，请用户提供有效上游 Key 或由用户在 UI 中添加上游账户；不要将真实密钥写入仓库或对话。

## 10. 完成记录

- 完成日期：2026-10-31
- 实现提交：`346e098` `feat: add guided provider setup and gateway diagnostics`
- 验证结果：
  - `npm run typecheck`：通过
  - `npm test`：24 个测试文件、226 项测试通过
  - `npm run deploy:dry-run`：通过
  - Cloudflare Workers Builds：成功
  - 线上 `/health`、`/health/ready`、`/ui`、`/ui-static/app.js`、`/admin/provider-presets`、`/admin/setup/status`、`/admin/routing/explain`、`/admin/gateway/test` 均返回预期结果
  - 本地 `wrangler dev` + 浏览器冒烟：登录、快速开始、预设预填、账户添加、手动模型、路由解析、客户端接入通过
- 实现偏差：
  - Provider 测试保持模型列表测试；Chat 测试由 `/admin/gateway/test` 和 Provider 设置面板的「Chat 自测」承担。
  - 预设不包含建议模型 ID；模型通过上游同步或管理员手动添加，避免使用过期/错误模型 ID。
- 未完成的外部验证：
  - 真实上游 Chat 自测需要有效上游账户。当前线上 `huawei` Provider 没有账户和模型，因此线上只验证到诊断/错误路径，未发起真实模型请求。
  - 用户需要自行在 UI 或 Worker Secret 中添加上游凭据，确认模型能力并发布配置。
