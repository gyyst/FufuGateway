# 设计：精简 Provider 操作与重复逻辑

## 1. 边界与总览

改动分三层，彼此独立、可分批验证：

| 层 | 文件 | 目标 |
|----|------|------|
| 管理台 UI | `public/ui-static/app.js` | 操作入口 6 → 4，前端同步/刷新逻辑各 1 份 |
| 管理 API | `src/admin/handlers/providers.ts` | 抽取公共拉模型 helper，简化 merge 与校验 |
| Provider 核心 | `src/providers/transport.ts`、`src/providers/engine.ts` | 合并重复 Transport 类，抽取 transport 解析 |
| 测试/文档 | `test/unit/provider-metadata-parse.test.ts`、`docs/PROVIDERS.md` | 跟随调整 |

不涉及数据模型、D1、KV、配置发布与路由执行链。

## 2. 管理台 UI

### 2.1 操作定义（`entities.providers.actions`）

目标顺序与集合：

```js
actions: [
  { key: "accounts", label: "账户", run: (row) => openAccounts(row) },
  { key: "models",   label: "模型", run: (row) => openProviderModels(row) },
  { key: "test",     label: "测试", run: (row) => openProviderTest(row) },
  { key: "health",   label: "健康", run: (row) => openProviderHealth(row) },
]
```

删除 `setup` 与 `sync` 两个 action。

### 2.2 删除 `openProviderSetup`

整段删除（目前 `app.js:2757-2889`）。其中：

- 统计卡与「管理账户 / 查看模型」：信息已由列表列与「账户 / 模型」弹窗覆盖。
- 「同步模型 / 刷新元数据」：由「模型」弹窗覆盖。
- 「模型列表测试」：并入新的测试弹窗。
- 「Chat 自测」：并入新的测试弹窗。

### 2.3 新增 `openProviderTest(provider)`

```js
async function openProviderTest(provider) {
  const body = modal(
    "测试 · " + provider.name,
    '<p class="hint">模型列表测试只读取上游 /models，不产生推理费用；Chat 自测会发起真实请求并可能产生费用。</p>' +
      '<div id="provider-test-result"><p class="hint">正在测试模型列表...</p></div>' +
      '<div class="form-actions">' +
      '<button class="btn" id="provider-test-models">重新测试模型列表</button>' +
      '<button class="btn primary" id="provider-test-chat">Chat 自测</button>' +
      "</div>",
  );
  $("#provider-test-models", body).onclick = () => runProviderModelTest(provider, body);
  $("#provider-test-chat", body).onclick = () => runProviderChatTest(provider, body);
  await runProviderModelTest(provider, body);
}
```

`runProviderModelTest`：

- 结果区置为「正在测试...」。
- `POST /admin/providers/:id/test`。
- 成功用 `<pre class="mono">` 展示 JSON；失败 `notify(error.message, "bad")` 并把结果区恢复为错误提示。
- 保留原行级「测试」的行为：点击即可看到结果。

`runProviderChatTest`：

- 从 `state.models` 取该 Provider 已启用模型作为默认值（不额外请求 detail；`state.models` 由 `ensureLookups` 维护）。
- `prompt` 输入模型 ID，`confirm` 费用提示（沿用原文案）。
- `POST /admin/gateway/test`，body `{ model: provider.name + "/" + modelId, prompt: "Reply with OK.", maxOutputTokens: 16 }`。
- 结果用 `<pre class="mono">` 展示。

### 2.4 抽取同步 / 刷新函数

```js
async function syncProviderModels(provider) {
  if (!confirm("从上游同步模型？会自动识别上下文、图像等能力，识别到的文本模型将自动启用。")) return false;
  try {
    const result = await api("/admin/providers/" + provider.id + "/sync-models", { method: "POST" });
    notifyConfigOutcome(result, "同步完成：新增 " + result.created + "（自动启用 " + (result.autoEnabled || 0) + "），跳过 " + result.skipped + (元数据匹配统计));
    state.routeLookupsLoaded = false;
    return true;
  } catch (error) {
    notify(error.message, "bad");
    return false;
  }
}

async function refreshProviderMetadata(provider) { /* 同构，返回 boolean */ }
```

`openProviderModels` 中的 `#models-sync` / `#models-refresh-metadata` 改为：

```js
$("#models-sync", body).onclick = async () => {
  const ok = await syncProviderModels(provider);
  if (!ok) return;
  closeModal();
  await route();
  await openProviderModels(provider);
};
```

刷新按钮同构。

消息文案沿用现有的「元数据匹配」统计（原先行级同步没有该统计，统一取「模型」弹窗里更完整的文案）。

### 2.5 共享刷新顺序

保持现有顺序：`closeModal()` → `await route()` → `await openProviderModels(provider)`。`state.routeLookupsLoaded = false` 必须在 `route()` 前设置，与现有代码一致。

## 3. 管理 handler

### 3.1 公共 helper

```ts
interface ProviderModelsProbe {
  account: ProviderAccountRecord;
  models: RemoteModel[];
}

async function probeProviderModels(
  c: Context<AppEnv>,
  provider: ProviderRecord,
  timeoutMs = 20_000,
): Promise<ProviderModelsProbe> {
  const { account, apiKey } = await selectAnyProviderAccount(c.env, provider.id);
  const models = await fetchProviderModels({
    provider,
    apiKey,
    fetchImpl: c.get("fetchImpl"),
    timeoutMs,
  });
  return { account, models };
}
```

- `testProviderHandler`：先 `listAccounts` 判断空账户（保留 `PROVIDER_NO_ACCOUNT` 响应），再 `probeProviderModels`，用返回的 `account.id`。
- `refreshModelMetadataHandler`：有账户时 `probeProviderModels`，失败转 warning；无账户时不调用。

### 3.2 `updateProviderHandler`

```ts
const merged: ProviderRecord = { ...provider, ...input, updatedAt: Date.now() };
validateProviderName(merged.name);
assertProviderTypeProtocol(merged.type, merged.protocol);
const customHeaders = validateProviderUrlAndHeaders(
  c,
  merged.baseUrl,
  input.customHeaders ?? merged.customHeaders,
);
const updated: ProviderRecord = { ...merged, customHeaders };
```

- 删除 `mergeProvider`。
- `??` 而非 `||`：空对象 `{}` 是合法值，必须保留。
- `providerUpdateSchema` 已过滤未知字段，展开是安全的。

行为差异检查：原实现先对 `input.customHeaders` 校验一次、再对结果校验一次；新实现只对最终 headers 校验一次。两者都执行 `validateUpstreamBaseUrl(merged.baseUrl)` 与 `sanitizeCustomHeaders`，输出一致。

### 3.3 不变的契约

- `testProviderHandler` 的响应字段：`ok / providerId / accountId / latencyMs / modelCount / sampleModels / error{code,message}`。
- `refreshModelMetadataHandler` 的 warning 文案。
- `syncModelsHandler` 保持直接调用 `selectAnyProviderAccount` + `syncProviderModels`（它不拉两次模型列表，无重复）。
- 所有写接口仍走 `configMutationResponse`。

## 4. `src/providers`

### 4.1 `transport.ts`

把 4 个重复类替换为：

```ts
type ModelParser = (payload: unknown) => RemoteModel[];

class StandardTransport implements ProviderTransport {
  constructor(
    readonly type: string,
    private readonly protocols: readonly ProtocolId[] | null,
    private readonly parser: ModelParser,
  ) {}

  supports(protocol: ProtocolId): boolean {
    return this.protocols === null || this.protocols.includes(protocol);
  }

  buildEndpoint(provider, protocol, options) {
    return buildProtocolEndpoint(provider, protocol, options);
  }

  buildModelsEndpoint(provider, protocol) {
    return buildProtocolModelsEndpoint(provider, protocol);
  }

  buildAuth(provider, apiKey) {
    return buildProviderAuth(provider, apiKey);
  }

  parseModels(payload) {
    return this.parser(payload);
  }
}

function parseCustomModels(payload: unknown): RemoteModel[] {
  return isRecord(payload) && Array.isArray(payload["models"])
    ? parseGeminiModels(payload)
    : isRecord(payload) && Array.isArray(payload["data"])
      ? parseOpenAIModels(payload)
      : [];
}

export const providerTransports = new ProviderTransportRegistry([
  new StandardTransport("OPENAI_COMPATIBLE", ["openai-chat", "openai-responses"], parseOpenAIModels),
  new StandardTransport("ANTHROPIC", ["anthropic"], parseAnthropicModels),
  new StandardTransport("GOOGLE_GEMINI", ["gemini"], parseGeminiModels),
  new StandardTransport("CUSTOM", null, parseCustomModels),
]);
```

- `ProviderTransport` 接口、`ProviderTransportRegistry` 保留。
- 不导出 `StandardTransport` 类；测试改用 `providerTransports.get(...)`。
- `CUSTOM` 的 `protocols = null` 表示支持任意协议（与原 `supports(_protocol) { return true; }` 一致）。

### 4.2 `engine.ts`

```ts
function requireTransport(provider: ProviderRecord): ProviderTransport {
  const transport = providerTransports.get(provider.type);
  if (!transport.supports(provider.protocol)) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Provider type ${provider.type} cannot speak protocol ${provider.protocol}`,
    });
  }
  return transport;
}
```

`buildProviderRequest` 与 `fetchProviderModels` 各调用一次。

错误分支简化为：

```ts
if (!response.ok) {
  throw new GatewayError({
    code: "UPSTREAM_ERROR",
    message: `Provider returned HTTP ${response.status} while listing models`,
    retriable: response.status === 429 || response.status >= 500,
    details: { upstream_status: response.status },
  });
}
```

## 5. 测试策略

- `test/unit/provider-metadata-parse.test.ts`：把 `new OpenAITransport()` / `new GeminiTransport()` 改为 `providerTransports.get("OPENAI_COMPATIBLE")` / `.get("GOOGLE_GEMINI")`，断言不变。
- 现有集成测试不改：`sync-models`、`refresh-model-metadata`、账户 CRUD、`/admin/providers/:id/test` 的路径与响应均不变。
- 无 UI 自动化测试；用 grep 与手动核对覆盖入口唯一性。

## 6. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 删除「设置」后用户找不到 Chat 自测 | 「测试」弹窗主动暴露，文案说明费用 |
| `{...provider, ...input}` 运行时被 `undefined` 覆盖 | zod 解析结果不会包含未提供的键；`JSON.parse` 不产生 `undefined` |
| `input.customHeaders ?? merged.customHeaders` 丢失「传空对象以清空」语义 | `{}` 不是 nullish，仍会走传入分支并 sanitize 为空对象 |
| Transport 合并改变 `CUSTOM` 行为 | 用 `protocols = null` 精确表达「全部支持」，并由现有 `provider-paths` 测试覆盖 |
| 前端重开弹窗顺序变化 | 保持 `closeModal → route → reopen` 原顺序 |

回滚粒度：三个代码层可独立回滚；UI 与后端无契约变更，回滚无数据迁移。
