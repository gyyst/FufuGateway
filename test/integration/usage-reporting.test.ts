import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { persistUsage } from "../../src/usage/recorder";
import type { UsageQueueMessage } from "../../src/usage/events";
import { createHarness, jsonResponse, openAIChatCompletionResponse } from "./support";

const harness = createHarness();

let providerAId = "";
let keyA = "";
let keyB = "";
let keyBId = "";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageMessage(
  requestId: string,
  model: string,
  startedAt: number,
  finishedAt: number,
): UsageQueueMessage {
  return {
    requestId,
    traceId: `trace_${requestId}`,
    userId: null,
    apiKeyId: null,
    providerId: null,
    providerAccountId: null,
    requestedModel: model,
    actualModel: model,
    comboId: null,
    sourceProtocol: "openai-chat",
    targetProtocol: "openai-chat",
    stream: false,
    inputTokens: 1,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    totalTokens: 1,
    usageSource: "upstream",
    estimatedCost: 0,
    actualCost: 0,
    startedAt,
    firstTokenAt: null,
    finishedAt,
    status: "success",
    errorCode: null,
    httpStatus: 200,
    retryCount: 0,
    routeTrace: null,
  };
}

async function waitForLog(requestId: string): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = await env.DB.prepare("SELECT * FROM request_logs WHERE request_id = ?")
      .bind(requestId)
      .first<Record<string, unknown>>();
    if (row !== null) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

beforeAll(async () => {
  const userA = await harness.createUser({ displayName: "Usage Reporting A" });
  const createdA = await harness.createApiKey(userA.id, { name: "usage-a" });
  keyA = createdA.key;

  const userB = await harness.createUser({ displayName: "Usage Reporting B" });
  const createdB = await harness.createApiKey(userB.id, { name: "usage-b" });
  keyB = createdB.key;
  keyBId = createdB.data.id;

  const providerA = await harness.createProvider({
    name: "usage-report-a",
    baseUrl: "https://usage-a.test/v1",
  });
  providerAId = providerA.id;
  await harness.createAccount(providerA.id, { apiKey: "usage-a-upstream-key" });
  for (const model of [
    { id: "usage-main", upstream: "usage-main-up" },
    { id: "usage-no-usage", upstream: "usage-no-usage-up" },
    { id: "usage-error", upstream: "usage-error-up" },
  ]) {
    await harness.createModel({
      providerId: providerA.id,
      modelId: model.id,
      upstreamModelId: model.upstream,
      inputPrice: 1_000_000,
      outputPrice: 1_000_000,
    });
  }

  const providerB = await harness.createProvider({
    name: "usage-report-b",
    baseUrl: "https://usage-b.test/v1",
  });
  await harness.createAccount(providerB.id, { apiKey: "usage-b-upstream-key" });
  await harness.createModel({
    providerId: providerB.id,
    modelId: "usage-other",
    upstreamModelId: "usage-other-up",
    inputPrice: 1_000_000,
    outputPrice: 1_000_000,
  });

  await harness.publish("usage reporting");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream(() =>
    openAIChatCompletionResponse("usage-ok", { input: 2, output: 1 }),
  );
});

function chat(keyValue: string, model: string): Promise<Response> {
  return harness.call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${keyValue}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
  });
}

describe("用量记录", () => {
  it("上游未返回 Usage 时不伪造 upstream 用量", async () => {
    harness.setUpstream(() =>
      jsonResponse({
        id: "chatcmpl-no-usage",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "usage-no-usage-up",
        choices: [
          { index: 0, message: { role: "assistant", content: "no-usage" }, finish_reason: "stop" },
        ],
      }),
    );

    const response = await chat(keyA, "usage-report-a/usage-no-usage");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fufu-usage-source")).toBe("none");

    const requestId = response.headers.get("x-request-id") ?? "";
    const row = await waitForLog(requestId);
    expect(row).toBeDefined();
    expect(row?.["status"]).toBe("success");
    expect(row?.["usage_source"]).toBe("none");
    expect(row?.["input_tokens"]).toBe(0);
    expect(row?.["output_tokens"]).toBe(0);
    expect(row?.["actual_cost"]).toBe(0);
    expect(row?.["estimated_cost"]).toBe(0);
  });

  it("上游错误写入 error 请求日志", async () => {
    harness.setUpstream(() =>
      jsonResponse({ error: { message: "upstream exploded", type: "server_error" } }, 500),
    );

    const response = await chat(keyA, "usage-report-a/usage-error");
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_ERROR");

    const requestId = response.headers.get("x-request-id") ?? "";
    const row = await waitForLog(requestId);
    expect(row).toBeDefined();
    expect(row?.["status"]).toBe("error");
    expect(row?.["error_code"]).toBe("UPSTREAM_ERROR");
    expect(row?.["http_status"]).toBe(502);
    expect(row?.["provider_id"]).toBeNull();

    const detail = await harness.admin(`/admin/requests/${requestId}`, "GET");
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { status: string; errorCode: string; routeTrace: unknown };
    };
    expect(detailBody.data.status).toBe("error");
    expect(detailBody.data.errorCode).toBe("UPSTREAM_ERROR");
    expect(detailBody.data.routeTrace).toBeNull();
  });
});

describe("用量汇总与请求日志", () => {
  it("汇总支持按模型、Provider 与 API Key 过滤", async () => {
    expect((await chat(keyA, "usage-report-a/usage-main")).status).toBe(200);
    expect((await chat(keyA, "usage-report-a/usage-main")).status).toBe(200);
    expect((await chat(keyB, "usage-report-b/usage-other")).status).toBe(200);

    const day = today();
    const byModel = (await (
      await harness.admin(`/admin/usage/summary?from=${day}&to=${day}&model=usage-main`, "GET")
    ).json()) as {
      data: {
        totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number };
      };
    };
    expect(byModel.data.totals.requests).toBe(2);
    expect(byModel.data.totals.inputTokens).toBe(4);
    expect(byModel.data.totals.outputTokens).toBe(2);
    expect(byModel.data.totals.costUsd).toBeCloseTo(6, 6);

    const byProvider = (await (
      await harness.admin(
        `/admin/usage/summary?from=${day}&to=${day}&providerId=${providerAId}`,
        "GET",
      )
    ).json()) as { data: { totals: { requests: number } } };
    expect(byProvider.data.totals.requests).toBeGreaterThanOrEqual(2);

    const byKey = (await (
      await harness.admin(`/admin/usage/summary?from=${day}&to=${day}&apiKeyId=${keyBId}`, "GET")
    ).json()) as { data: { totals: { requests: number; totalTokens: number } } };
    expect(byKey.data.totals.requests).toBe(1);
    expect(byKey.data.totals.totalTokens).toBe(3);
  });

  it("按周与按月聚合历史用量", async () => {
    const entries = [
      { id: "req_week_1", day: "2026-01-05T10:00:00.000Z" },
      { id: "req_week_2", day: "2026-01-20T10:00:00.000Z" },
      { id: "req_month_2", day: "2026-02-03T10:00:00.000Z" },
    ];
    for (const entry of entries) {
      const startedAt = Date.parse(entry.day);
      const inserted = await persistUsage(
        env.DB,
        usageMessage(entry.id, "usage-historical", startedAt, startedAt + 10),
      );
      expect(inserted).toBe(true);
    }

    const weekly = (await (
      await harness.admin(
        "/admin/usage/summary?from=2026-01-01&to=2026-02-28&model=usage-historical&groupBy=week",
        "GET",
      )
    ).json()) as {
      data: { buckets: Array<{ period: string; requests: number }>; totals: { requests: number } };
    };
    expect(weekly.data.buckets).toEqual([
      { period: expect.any(String), requests: 1, errors: 0, inputTokens: 1, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 1, costUsd: 0 },
      { period: expect.any(String), requests: 1, errors: 0, inputTokens: 1, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 1, costUsd: 0 },
      { period: expect.any(String), requests: 1, errors: 0, inputTokens: 1, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 1, costUsd: 0 },
    ]);
    expect(weekly.data.buckets.map((bucket) => bucket.period)).toEqual([
      "2026-01-05",
      "2026-01-19",
      "2026-02-02",
    ]);
    expect(weekly.data.totals.requests).toBe(3);

    const monthly = (await (
      await harness.admin(
        "/admin/usage/summary?from=2026-01-01&to=2026-02-28&model=usage-historical&groupBy=month",
        "GET",
      )
    ).json()) as {
      data: { buckets: Array<{ period: string; requests: number }>; totals: { requests: number } };
    };
    expect(monthly.data.buckets).toEqual([
      expect.objectContaining({ period: "2026-01", requests: 2 }),
      expect.objectContaining({ period: "2026-02", requests: 1 }),
    ]);
    expect(monthly.data.totals.requests).toBe(3);
  });

  it("请求日志支持 limit 与 before 游标，列表不返回路由树", async () => {
    const base = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const finishedAt = base - (3 - index) * 1000;
      await persistUsage(
        env.DB,
        usageMessage(`req_paged_${index}`, "usage-paged", finishedAt - 10, finishedAt),
      );
    }

    const first = (await (
      await harness.admin("/admin/requests?model=usage-paged&limit=2", "GET")
    ).json()) as {
      data: Array<{ requestId: string; createdAt: number; routeTrace?: unknown }>;
      nextCursor: number | null;
    };
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(first.data[0]?.routeTrace).toBeUndefined();
    expect(first.data[0]?.requestId).toBe("req_paged_2");
    expect(first.data[1]?.requestId).toBe("req_paged_1");

    const second = (await (
      await harness.admin(
        `/admin/requests?model=usage-paged&limit=2&before=${first.nextCursor}`,
        "GET",
      )
    ).json()) as { data: Array<{ requestId: string }> };
    expect(second.data.map((entry) => entry.requestId)).toEqual(["req_paged_0"]);
  });

  it("非法日期与分组参数返回 400", async () => {
    const badDate = await harness.admin("/admin/usage?from=2026-1-1", "GET");
    expect(badDate.status).toBe(400);
    const badGroup = await harness.admin("/admin/usage?groupBy=year", "GET");
    expect(badGroup.status).toBe(400);
  });
});
