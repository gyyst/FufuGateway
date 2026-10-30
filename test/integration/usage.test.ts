import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { FetchLike } from "../../src/providers/types";
import { persistUsage } from "../../src/usage/recorder";
import { dayKey } from "../../src/core/time";
import type { UsageQueueMessage } from "../../src/usage/events";

const ADMIN_TOKEN = "test-admin-token";

let providerId = "";
let modelId = "";
let userId = "";
let normalKey = "";
let rpmKey = "";
let tpmKey = "";
let budgetKey = "";
let rotateKey = "";

const upstreamRequests: Request[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(): Response {
  return json({
    id: "chatcmpl-usage",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "usage-up",
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  return completion();
};

const app = createApp({ fetchImpl });

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function adminCall(path: string, method: string, body?: unknown): Promise<Response> {
  return call(path, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function chat(key: string, model = "usage-model"): Promise<Response> {
  return call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
  });
}

async function createKey(name: string, options: Record<string, unknown> = {}): Promise<string> {
  const response = await adminCall("/admin/api-keys", "POST", {
    userId,
    name,
    ...options,
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { key: string; data: Record<string, unknown> };
  expect(body.key.startsWith("fufu_sk_")).toBe(true);
  expect(JSON.stringify(body.data)).not.toContain(body.key);
  return body.key;
}

async function waitForLog(requestId: string, timeoutMs = 3000): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
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
  const userResponse = await adminCall("/admin/users", "POST", {
    email: "usage@example.com",
    displayName: "Usage User",
    role: "user",
  });
  expect(userResponse.status).toBe(201);
  const user = (await userResponse.json()) as { data: { id: string } };
  userId = user.data.id;

  const providerResponse = await adminCall("/admin/providers", "POST", {
    name: "usagep",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://usage.test/v1",
    maxRetries: 0,
  });
  expect(providerResponse.status).toBe(201);
  const provider = (await providerResponse.json()) as { data: { id: string } };
  providerId = provider.data.id;

  const account = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
    name: "primary",
    apiKey: "usage-upstream-key",
  });
  expect(account.status).toBe(201);

  const modelResponse = await adminCall("/admin/models", "POST", {
    providerId,
    modelId: "usage-model",
    upstreamModelId: "usage-up",
    supportsStream: true,
    inputPrice: 1_000_000,
    outputPrice: 1_000_000,
  });
  expect(modelResponse.status).toBe(201);
  const model = (await modelResponse.json()) as { data: { id: string } };
  modelId = model.data.id;

  normalKey = await createKey("normal");
  rpmKey = await createKey("rpm", { rpmLimit: 1 });
  tpmKey = await createKey("tpm", { tpmLimit: 10 });
  budgetKey = await createKey("budget", { dailyBudgetUsd: 1 });
  rotateKey = await createKey("rotate-base");

  const publish = await adminCall("/admin/config/publish", "POST", { note: "usage" });
  expect([200, 201]).toContain(publish.status);
});

describe("用量记录与统计", () => {
  it("请求完成后幂等写入日志、汇总与费用", async () => {
    const response = await chat(normalKey);
    expect(response.status).toBe(200);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).toBeTruthy();

    const row = await waitForLog(requestId ?? "");
    expect(row).toBeDefined();
    expect(row?.["input_tokens"]).toBe(2);
    expect(row?.["output_tokens"]).toBe(1);
    expect(row?.["actual_cost"]).toBeCloseTo(3, 6);
    expect(row?.["status"]).toBe("success");
    expect(row?.["actual_model"]).toBe("usage-model");
    expect(row?.["usage_source"]).toBe("upstream");
    expect(row?.["api_key_id"]).toBeTruthy();

    const detail = await adminCall(`/admin/requests/${requestId}`, "GET");
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { data: { routeTrace: unknown } };
    expect(detailBody.data.routeTrace).not.toBeNull();

    const summary = await adminCall("/admin/usage/summary?groupBy=day", "GET");
    expect(summary.status).toBe(200);
    const summaryBody = (await summary.json()) as {
      data: { totals: { requests: number; costUsd: number; inputTokens: number } };
    };
    expect(summaryBody.data.totals.requests).toBe(1);
    expect(summaryBody.data.totals.inputTokens).toBe(2);
    expect(summaryBody.data.totals.costUsd).toBeCloseTo(3, 6);
    expect(modelId).not.toBe("");
  });

  it("请求日志列表返回摘要且不包含路由树", async () => {
    const response = await adminCall("/admin/requests?limit=5", "GET");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]?.["routeTrace"]).toBeUndefined();
  });

  it("RPM 超限返回 429 与 Retry-After", async () => {
    const first = await chat(rpmKey);
    expect(first.status).toBe(200);
    const second = await chat(rpmKey);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("REQUEST_LIMIT_EXCEEDED");
  });

  it("TPM 超限在请求上游前拒绝", async () => {
    const before = upstreamRequests.length;
    const response = await chat(tpmKey);
    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("TOKEN_LIMIT_EXCEEDED");
    expect(upstreamRequests.length).toBe(before);
  });

  it("预算耗尽后返回 402", async () => {
    const first = await chat(budgetKey);
    expect(first.status).toBe(200);
    const second = await chat(budgetKey);
    expect(second.status).toBe(402);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("API Key 轮换后旧 Key 立即失效", async () => {
    const before = await chat(rotateKey);
    expect(before.status).toBe(200);

    const rotate = await adminCall("/admin/api-keys", "GET");
    const listBody = (await rotate.json()) as { data: Array<{ id: string; name: string }> };
    const target = listBody.data.find((key) => key.name === "rotate-base");
    expect(target).toBeDefined();

    const rotated = await adminCall(`/admin/api-keys/${target?.id}/rotate`, "POST", {});
    expect(rotated.status).toBe(201);
    const rotatedBody = (await rotated.json()) as { key: string };
    expect(rotatedBody.key).not.toBe(rotateKey);

    const oldResponse = await chat(rotateKey);
    expect(oldResponse.status).toBe(401);
    const newResponse = await chat(rotatedBody.key);
    expect(newResponse.status).toBe(200);
  });

  it("禁用 API Key 立即生效", async () => {
    const list = await adminCall("/admin/api-keys", "GET");
    const body = (await list.json()) as { data: Array<{ id: string; name: string }> };
    const key = body.data.find((item) => item.name === "normal");
    expect(key?.id).toBeTruthy();
    const disabled = await adminCall(`/admin/api-keys/${key?.id}`, "PUT", { status: "disabled" });
    expect(disabled.status).toBe(200);
    const response = await chat(normalKey);
    expect(response.status).toBe(401);
  });

  it("用户级预算跨 Key 生效", async () => {
    const userResponse = await adminCall("/admin/users", "POST", {
      email: `user-budget-${Date.now()}@example.com`,
      dailyBudgetUsd: 1,
      role: "user",
    });
    expect(userResponse.status).toBe(201);
    const user = (await userResponse.json()) as { data: { id: string } };
    const keyResponse = await adminCall("/admin/api-keys", "POST", {
      userId: user.data.id,
      name: "user-budget-key",
    });
    expect(keyResponse.status).toBe(201);
    const key = (await keyResponse.json()) as { key: string };

    const first = await chat(key.key);
    expect(first.status).toBe(200);
    const second = await chat(key.key);
    expect(second.status).toBe(402);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("用量写入按 request_id 幂等", async () => {
    const now = Date.now();
    const message: UsageQueueMessage = {
      requestId: `req_idem_${now}`,
      traceId: "trace_idem",
      userId: null,
      apiKeyId: null,
      providerId: "idem-provider",
      providerAccountId: null,
      requestedModel: "idem-model",
      actualModel: "idem-model",
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
      startedAt: now,
      firstTokenAt: null,
      finishedAt: now + 10,
      status: "success",
      errorCode: null,
      httpStatus: 200,
      retryCount: 0,
      routeTrace: null,
    };
    expect(await persistUsage(env.DB, message)).toBe(true);
    expect(await persistUsage(env.DB, message)).toBe(false);
    const rollup = await env.DB.prepare(
      "SELECT requests FROM usage_rollups WHERE day = ? AND api_key_id = '' AND model = 'idem-model'",
    )
      .bind(dayKey(now))
      .first<{ requests: number }>();
    expect(rollup?.requests).toBe(1);
  });

  it("管理端不返回 Key 哈希或明文", async () => {
    const response = await adminCall("/admin/api-keys", "GET");
    const text = await response.text();
    expect(text).not.toContain("keyHash");
    expect(text).not.toContain("key_hash");
    expect(text).not.toContain(normalKey);
  });
});
