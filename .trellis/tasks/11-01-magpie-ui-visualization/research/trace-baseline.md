# 调研基线：路由执行轨迹与用量数据

## 1. 请求详情

`GET /admin/requests/:id` 返回 `routeTrace`：

```ts
{
  route: string[],          // ModelRouter 的匹配轨迹，例如 ["alias:fast", "combo:daily-coding", ...]
  execution: ComboTraceNode // 实际执行树
}
```

路由轨迹可能为 `null`（旧记录或未记录）。

## 2. ComboTraceNode（src/combo/strategies/types.ts）

```ts
{
  id: string;
  kind: "combo" | "model" | "inline";
  label: string;
  providerId?: string;
  modelId?: string;
  status: "ok" | "failed" | "skipped" | "cancelled";
  startedAt: number;       // epoch ms
  finishedAt?: number;
  attempts: {
    index: number;
    providerId?: string;
    accountId?: string;
    status: number | string; // HTTP 状态或状态名
    durationMs: number;
    errorCode?: string;
  }[];
  children: ComboTraceNode[];
}
```

- 执行树可嵌套（Combo 套 Combo）。
- 每个节点包含逐次尝试，可用于展示重试/故障转移。
- `durationMs` 可由 `finishedAt - startedAt` 计算，attempts 已直接给出耗时。

## 3. 路由解析

`POST /admin/routing/explain` 返回：

```ts
{
  ok: boolean;
  requestedModel: string;
  configVersion: number;
  match: { type: string; provider?: string; model?: string; /* 其他匹配信息 */ };
  trace: string[];                 // 匹配过程
  plan: {
    kind: "models";
    name: string;
    strategy: string;
    nodes: { kind: "model" | "combo"; target: {...}; weight?: number; priority?: number; timeoutMs?: number; maxRetries?: number; strategy?: string }[];
  };
}
```

`POST /admin/gateway/test` 额外返回 `provider`、`modelId`、`latencyMs`、`retryCount`、`text`、`usage`、`executionTrace`。

## 4. 用量汇总

`GET /admin/usage/summary?from&to&groupBy=day|week|month` 返回：

```ts
{
  from: string; to: string; groupBy: string;
  buckets: {
    period: string; requests: number; errors: number;
    inputTokens: number; outputTokens: number; cachedTokens: number;
    reasoningTokens: number; totalTokens: number; costUsd: number;
  }[];
  totals: 同上（无 period）;
}
```

注意：只返回有请求的周期，缺失日期不会补 0。

## 5. 前端现状

- 路由诊断结果使用 `<pre>` 直接输出 JSON。
- 请求详情弹窗同样输出 JSON（`bindRequestDetails`）。
- 用量页只有横向条形图（费用），无时间序列、缓存命中率、推理 Token、错误率细分。
- 客户端接入页为静态代码块，未按客户端切换。

## 6. 本批次范围

路由诊断可视化、请求详情执行树、用量页图表与细分指标、客户端接入向导。仅改前端静态资源，不新增后端接口。
