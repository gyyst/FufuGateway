import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateApiKey } from "../../src/auth/api-key";
import { createApiKeyRecord, createUser } from "../../src/auth/repository";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
let downstreamKey = "";

const upstreamRequests: Request[] = [];
const counters = new Map<string, number>();
let retryMode: "500" | "429" = "500";
let timeoutMode: "first_token" | "idle" = "first_token";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completion(content: string, model: string): Response {
  return json({
    id: `chatcmpl-${content}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

const encoder = new TextEncoder();

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  const host = new URL(request.url).hostname;
  counters.set(host, (counters.get(host) ?? 0) + 1);
  const count = counters.get(host) ?? 1;

  if (host === "retry.test") {
    if (retryMode === "429" && count === 1) {
      return json({ error: { message: "rate limited" } }, 429, { "retry-after": "0" });
    }
    if (retryMode === "500" && count <= 2) {
      return json({ error: { message: "temporary" } }, 500);
    }
    return completion("RETRIED", "retry-up");
  }
  if (host === "noretry.test") {
    return json({ error: { message: "bad request" } }, 400);
  }
  if (host === "acct.test") {
    const authorization = request.headers.get("authorization");
    if (authorization === "Bearer good-key") return completion("GOOD", "acct-up");
    return json({ error: { message: "invalid key" } }, 401);
  }
  if (host === "brk.test") {
    return json({ error: { message: "down" } }, 500);
  }
  if (host === "timeout.test") {
    if (timeoutMode === "first_token") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            try {
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"t","choices":[{"index":0,"delta":{"role":"assistant","content":"late"},"finish_reason":null}]}\n\n',
                ),
              );
              controller.close();
            } catch {
              // 网关已超时断开。
            }
          }, 400);
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"t","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n',
          ),
        );
        // 故意保持连接，不发送后续事件。
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return completion("OK", "default-up");
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

function chat(model: string, stream = false): Promise<Response> {
  return call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream }),
  });
}

async function createProvider(
  name: string,
  host: string,
  options: Record<string, unknown>,
  accounts: Array<{ name: string; key: string; weight?: number; priority?: number }>,
  model: string,
): Promise<void> {
  const response = await adminCall("/admin/providers", "POST", {
    name,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: `https://${host}/v1`,
    ...options,
  });
  expect(response.status).toBe(201);
  const provider = (await response.json()) as { data: { id: string } };
  for (const account of accounts) {
    const created = await adminCall(`/admin/providers/${provider.data.id}/accounts`, "POST", {
      name: account.name,
      apiKey: account.key,
      ...(account.weight === undefined ? {} : { weight: account.weight }),
      ...(account.priority === undefined ? {} : { priority: account.priority }),
    });
    expect(created.status).toBe(201);
  }
  const createdModel = await adminCall("/admin/models", "POST", {
    providerId: provider.data.id,
    modelId: model,
    upstreamModelId: `${model}-up`,
    supportsStream: true,
  });
  expect(createdModel.status).toBe(201);
}

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Resilience User" });
  const pepper = env.API_KEY_PEPPER;
  if (!pepper) throw new Error("API_KEY_PEPPER is not configured for tests");
  const generated = await generateApiKey(pepper);
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "resilience-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });

  await createProvider(
    "retryp",
    "retry.test",
    {
      maxRetries: 5,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 20,
        jitter: "none",
        retryStatuses: [429, 500],
        retryOnNetworkError: true,
        retryOnTimeout: "before_first_byte",
        respectRetryAfter: true,
      },
    },
    [{ name: "primary", key: "retry-key" }],
    "retry-model",
  );

  await createProvider(
    "noretryp",
    "noretry.test",
    { maxRetries: 5 },
    [{ name: "primary", key: "noretry-key" }],
    "noretry-model",
  );

  await createProvider(
    "acctp",
    "acct.test",
    { maxRetries: 0 },
    [
      { name: "bad", key: "bad-key", weight: 10, priority: 100 },
      { name: "good", key: "good-key", weight: 1, priority: 90 },
    ],
    "acct-model",
  );

  await createProvider(
    "brkp",
    "brk.test",
    {
      maxRetries: 0,
      extraConfig: {
        breaker: {
          failureThreshold: 2,
          failureRate: 1,
          minSamples: 100,
          windowMs: 60_000,
          openMs: 60_000,
          halfOpenProbes: 1,
        },
      },
    },
    [{ name: "primary", key: "brk-key" }],
    "brk-model",
  );

  await createProvider(
    "timeoutp",
    "timeout.test",
    { maxRetries: 0, firstTokenTimeoutMs: 100, idleTimeoutMs: 100, timeoutMs: 5_000 },
    [{ name: "primary", key: "timeout-key" }],
    "timeout-model",
  );

  const publish = await adminCall("/admin/config/publish", "POST", { note: "resilience" });
  expect([200, 201]).toContain(publish.status);
});

beforeEach(() => {
  upstreamRequests.length = 0;
  counters.clear();
  retryMode = "500";
  timeoutMode = "first_token";
});

describe("重试与账户故障转移", () => {
  it("5xx 按配置重试并在成功后返回", async () => {
    const response = await chat("retry-model");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("RETRIED");
    expect(counters.get("retry.test")).toBe(3);
  });

  it("429 遵循 Retry-After 后重试", async () => {
    retryMode = "429";
    const response = await chat("retry-model");
    expect(response.status).toBe(200);
    expect(counters.get("retry.test")).toBe(2);
  });

  it("4xx 不会重试", async () => {
    const response = await chat("noretry-model");
    expect(response.status).toBe(400);
    expect(counters.get("noretry.test")).toBe(1);
  });

  it("上游认证失败时轮换到下一个账户", async () => {
    const response = await chat("acct-model");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("GOOD");
    expect(counters.get("acct.test")).toBe(2);
    const authorizations = upstreamRequests.map((request) => request.headers.get("authorization"));
    expect(authorizations).toContain("Bearer bad-key");
    expect(authorizations).toContain("Bearer good-key");
  });
});

describe("熔断与超时", () => {
  it("连续失败后打开熔断并快速失败", async () => {
    const first = await chat("brk-model");
    expect(first.status).toBe(502);
    const second = await chat("brk-model");
    expect(second.status).toBe(502);
    const third = await chat("brk-model");
    expect(third.status).toBe(503);
    const body = (await third.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(counters.get("brk.test")).toBe(2);
  });

  it("首个内容超时返回 504 且不创建 SSE", async () => {
    const response = await chat("timeout-model", true);
    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(counters.get("timeout.test")).toBe(1);
  });

  it("流式空闲超时以错误事件结束", async () => {
    timeoutMode = "idle";
    const response = await chat("timeout-model", true);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"partial"');
    expect(text).toContain('"error"');
  });
});
