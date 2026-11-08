# 实施计划：精简 Provider 操作与重复逻辑

## 批次 1：`src/providers` 去重

- [ ] `transport.ts`：合并 4 个 Transport 类为 `StandardTransport`（type + protocols + parser），新增 `parseCustomModels`，保留 `ProviderTransport` 接口与 `ProviderTransportRegistry`。
- [ ] `transport.ts`：`providerTransports` 用 4 个 `StandardTransport` 实例注册，`CUSTOM` 用 `protocols = null`。
- [ ] `engine.ts`：抽取 `requireTransport(provider)`，`buildProviderRequest` 与 `fetchProviderModels` 复用。
- [ ] `engine.ts`：删除 `code: cond ? "UPSTREAM_ERROR" : "UPSTREAM_ERROR"` 恒等三元。
- [ ] `test/unit/provider-metadata-parse.test.ts`：改用 `providerTransports.get(...)`，断言保持不变。
- [ ] `npm run typecheck && npx vitest run test/unit/provider-metadata-parse.test.ts test/unit/provider-paths.test.ts`

## 批次 2：管理 handler 去重

- [ ] `providers.ts`：新增 `probeProviderModels(c, provider, timeoutMs?)`，返回 `{ account, models }`。
- [ ] `testProviderHandler`：保留空账户分支，改用 helper。
- [ ] `refreshModelMetadataHandler`：保留无账户分支与 warning 文案，改用 helper。
- [ ] `updateProviderHandler`：删除 `mergeProvider`，改为 `{ ...provider, ...input, updatedAt: Date.now() }`。
- [ ] `updateProviderHandler`：URL/Header 只校验一次（`input.customHeaders ?? merged.customHeaders`）。
- [ ] `npm run typecheck && npx vitest run test/integration/model-metadata.test.ts test/integration/provider-accounts.test.ts test/integration/admin-lifecycle.test.ts`

## 批次 3：管理台 UI 收敛

- [ ] `app.js`：删除 `openProviderSetup` 整段与 `#setup-*` 绑定。
- [ ] `app.js`：抽取 `syncProviderModels(provider)` 与 `refreshProviderMetadata(provider)`，返回 boolean。
- [ ] `app.js`：`openProviderModels` 的两个按钮改用公共函数，保留 `closeModal → route → reopen` 顺序。
- [ ] `app.js`：新增 `openProviderTest` + `runProviderModelTest` + `runProviderChatTest`。
- [ ] `app.js`：`entities.providers.actions` 改为 账户 / 模型 / 测试 / 健康。
- [ ] grep 确认无 `openProviderSetup`、`setup-accounts`、`setup-sync`、`setup-refresh-metadata`、`setup-models`、`setup-test`、`setup-chat-test` 残留。
- [ ] grep 确认 `sync-models` 与 `refresh-model-metadata` 各只有 1 处 `api(...)` 调用。
- [ ] 手动走查：账户、模型（同步/刷新/添加）、测试（模型列表 + Chat）、健康。

## 批次 4：文档与收尾

- [ ] 更新 `docs/PROVIDERS.md` 中管理台操作入口描述。
- [ ] 全量验证：
  - [ ] `npm run typecheck`
  - [ ] `npm test`
  - [ ] `npm run deploy:dry-run`
- [ ] 通读 diff，确认无行为变化。

## 验证命令

```bash
npm run typecheck
npm test
npm run deploy:dry-run
grep -n "openProviderSetup\|setup-chat-test\|setup-refresh-metadata" public/ui-static/app.js
grep -n "sync-models" public/ui-static/app.js
grep -n "refresh-model-metadata" public/ui-static/app.js
```

预期 grep：前两条无输出；`sync-models` / `refresh-model-metadata` 各只剩公共函数中的 1 处。

## 评审门

- 批次 1、2 各自单测通过后再进入 UI 改动。
- UI 改动完成后做一次完整 `npm test`（含 Workers 集成测试）。
- 提交前确认：API 路径、响应字段、错误码与文案均未变。
