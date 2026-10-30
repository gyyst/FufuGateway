import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateApiKey } from "../../src/auth/api-key";
import { createApiKeyRecord, createUser } from "../../src/auth/repository";
import { sleep } from "../../src/core/time";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
let downstreamKey = "";
let restrictedKey = "";

const upstreamRequests: Request[] = [];

type Behavior = "ok" | "fail" | "slow";
let behavior: Record<"a" | "b", Behavior> = { a: "ok", b: "ok" };
let streamingBehavior: Record<"a" | "b", "ok" | "broken" | "http_error"> = { a: "ok", b: "ok" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAIResponse(content: string, model: string): Response {
  return json({
    id: `chatcmpl-${content}`,
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

function sse(content: string): Response {
  const encoder = new TextEncoder();
  const body = [
    `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"${content}"},"finish_reason":null}]}\n\n`,
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function brokenSse(content: string): Response {
  const encoder = new TextEncoder();
  let stage = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(
          encoder.encode(
            `data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","content":"${content}"},"finish_reason":null}]}\n\n`,
          ),
        );
        return;
      }
      controller.error(new Error("upstream broke"));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  const host = new URL(request.url).hostname;
  const body = (await request.json()) as { model: string; stream?: boolean };

  if (body.model === "judge-up") {
    return openAIResponse("JUDGED", "judge-up");
  }
  const side: "a" | "b" = host.startsWith("a.") ? "a" : "b";
  const model = side === "a" ? "model-a-up" : "model-b-up";
  const content = side === "a" ? "A" : "B";

  if (body.stream === true) {
    if (streamingBehavior[side] === "http_error") {
      return json({ error: { message: "upstream failed", type: "server_error" } }, 500);
    }
    if (streamingBehavior[side] === "broken") {
      return brokenSse(content);
    }
    return sse(content);
  }

  const current = behavior[side];
  if (current === "fail") {
    return json({ error: { message: "upstream failed", type: "server_error" } }, 500);
  }
  if (current === "slow") {
    try {
      await sleep(40, init?.signal === null || init?.signal === undefined ? {} : { signal: init.signal });
    } catch {
      throw new DOMException("aborted", "AbortError");
    }
  }
  return openAIResponse(content, model);
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

function chat(model: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return call("/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${downstreamKey}`,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

async function createProvider(
  name: string,
  baseUrl: string,
  key: string,
  models: Array<{ modelId: string; upstreamModelId: string }>,
): Promise<string> {
  const providerResponse = await adminCall("/admin/providers", "POST", {
    name,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl,
    maxRetries: 0,
  });
  expect(providerResponse.status).toBe(201);
  const provider = (await providerResponse.json()) as { data: { id: string } };
  const account = await adminCall(`/admin/providers/${provider.data.id}/accounts`, "POST", {
    name: "primary",
    apiKey: key,
  });
  expect(account.status).toBe(201);
  for (const model of models) {
    const created = await adminCall("/admin/models", "POST", {
      providerId: provider.data.id,
      modelId: model.modelId,
      upstreamModelId: model.upstreamModelId,
      supportsStream: true,
    });
    expect(created.status).toBe(201);
  }
  return provider.data.id;
}

async function createCombo(name: string, body: Record<string, unknown>): Promise<void> {
  const response = await adminCall("/admin/combos", "POST", { name, ...body });
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Combo User" });
  const pepper = env.API_KEY_PEPPER;
  if (!pepper) throw new Error("API_KEY_PEPPER is not configured for tests");
  const generated = await generateApiKey(pepper);
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "combo-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });
  const restricted = await generateApiKey(pepper);
  restrictedKey = restricted.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "restricted-key",
    keyPrefix: restricted.prefix,
    keyHash: restricted.hash,
    providerAllowlist: ["pa"],
  });

  await createProvider("pa", "https://a.test/v1", "key-a", [
    { modelId: "model-a", upstreamModelId: "model-a-up" },
    { modelId: "judge", upstreamModelId: "judge-up" },
  ]);
  await createProvider("pb", "https://b.test/v1", "key-b", [
    { modelId: "model-b", upstreamModelId: "model-b-up" },
  ]);

  await createCombo("fb", { strategy: "fallback", nodes: ["pa/model-a", "pb/model-b"] });
  await createCombo("rr", { strategy: "round_robin", nodes: ["pa/model-a", "pb/model-b"] });
  await createCombo("sticky", {
    strategy: "round_robin",
    nodes: ["pa/model-a", "pb/model-b"],
    sticky: { enabled: true, ttlSeconds: 60, mode: "round_robin" },
  });
  await createCombo("nested", { strategy: "fallback", nodes: [{ combo: "fb" }] });
  await createCombo("race", { strategy: "race", nodes: ["pa/model-a", "pb/model-b"] });
  await createCombo("fusion", {
    strategy: "fusion",
    nodes: ["pa/model-a", "pb/model-b"],
    judgeModel: "pa/judge",
  });

  const publish = await adminCall("/admin/config/publish", "POST", { note: "combos" });
  expect([200, 201]).toContain(publish.status);
});

beforeEach(() => {
  upstreamRequests.length = 0;
  behavior = { a: "ok", b: "ok" };
  streamingBehavior = { a: "ok", b: "ok" };
});

describe("Combo 执行", () => {
  it("fallback 在首个上游 5xx 后切换到下一个模型", async () => {
    behavior = { a: "fail", b: "ok" };
    const response = await chat("fb");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fufu-provider")).toBe("pb");
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("B");
    expect(upstreamRequests).toHaveLength(2);
  });

  it("fallback 遇到不可重试的 4xx 不会切换", async () => {
    upstreamRequests.length = 0;
    behavior = { a: "fail", b: "ok" };
    // 让 a 返回 400（不可重试）
    const originalFetch = fetchImpl;
    void originalFetch;
    const strictApp = createApp({
      fetchImpl: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
        upstreamRequests.push(request.clone());
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const ctx = createExecutionContext();
    const response = await strictApp.fetch(
      new Request("https://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "fb", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("round_robin 在多次请求间轮换上游", async () => {
    const first = (await (await chat("rr")).json()) as { choices: Array<{ message: { content: string } }> };
    const second = (await (await chat("rr")).json()) as { choices: Array<{ message: { content: string } }> };
    const third = (await (await chat("rr")).json()) as { choices: Array<{ message: { content: string } }> };
    expect([first, second, third].map((body) => body.choices[0]?.message.content)).toEqual(["A", "B", "A"]);
  });

  it("sticky 会话保持同一上游", async () => {
    const headers = { "x-session-id": "session-sticky-1" };
    const first = await chat("sticky", headers);
    const second = await chat("sticky", headers);
    const firstBody = (await first.json()) as { choices: Array<{ message: { content: string } }> };
    const secondBody = (await second.json()) as { choices: Array<{ message: { content: string } }> };
    expect(firstBody.choices[0]?.message.content).toBe("A");
    expect(secondBody.choices[0]?.message.content).toBe("A");
  });

  it("Combo 叶子受 API Key 的 Provider 白名单约束", async () => {
    behavior = { a: "fail", b: "ok" };
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${restrictedKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fb", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(upstreamRequests.every((request) => request.url.includes("a.test"))).toBe(true);
  });

  it("嵌套 Combo 逐层故障转移", async () => {
    behavior = { a: "fail", b: "ok" };
    const response = await chat("nested");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("B");
  });

  it("race 采用最快成功者", async () => {
    behavior = { a: "slow", b: "ok" };
    const response = await chat("race");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("B");
    expect(upstreamRequests.length).toBeGreaterThanOrEqual(2);
  });

  it("fusion 使用 Judge Model 生成最终结果", async () => {
    const response = await chat("fusion");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("JUDGED");

    const judgeRequest = upstreamRequests.find((request) => {
      return request.url.includes("a.test");
    });
    expect(judgeRequest).toBeDefined();
  });

  it("fusion 流式请求明确报错", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fusion",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNSUPPORTED_FEATURE");
  });

  it("流式 fallback 在首内容前失败时切换上游", async () => {
    streamingBehavior = { a: "http_error", b: "ok" };
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fb",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"B"');
    expect(upstreamRequests).toHaveLength(2);
  });

  it("流式提交后出错不会切换上游", async () => {
    streamingBehavior = { a: "broken", b: "ok" };
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fb",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"A"');
    expect(text).toContain('"error"');
    expect(upstreamRequests).toHaveLength(1);
  });
});
