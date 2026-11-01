import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateApiKey } from "../../src/auth/api-key";
import { createApiKeyRecord, createUser } from "../../src/auth/repository";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
const UPSTREAM_KEY = "upstream-secret-key";

let downstreamKey = "";
let providerId = "";
let primaryModelId = "";

const upstreamRequests: Request[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAIChatCompletion(text = "pong"): Record<string, unknown> {
  return {
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "gpt-upstream",
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
      prompt_tokens_details: { cached_tokens: 1 },
    },
  };
}

let upstreamHandler: (request: Request) => Promise<Response> = async () =>
  jsonResponse(openAIChatCompletion());

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  return upstreamHandler(request);
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

async function createProviderAndModel(
  name: string,
  modelId: string,
  upstreamModelId = "gpt-upstream",
): Promise<{ providerId: string; modelId: string }> {
  const providerResponse = await adminCall("/admin/providers", "POST", {
    name,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: `https://${name}.test/v1`,
  });
  expect(providerResponse.status).toBe(201);
  const provider = (await providerResponse.json()) as { data: { id: string } };

  const accountResponse = await adminCall(`/admin/providers/${provider.data.id}/accounts`, "POST", {
    name: "primary",
    apiKey: UPSTREAM_KEY,
  });
  expect(accountResponse.status).toBe(201);
  const accountText = JSON.stringify(await accountResponse.json());
  expect(accountText).not.toContain(UPSTREAM_KEY);

  const modelResponse = await adminCall("/admin/models", "POST", {
    providerId: provider.data.id,
    modelId,
    upstreamModelId,
    supportsStream: true,
    supportsTools: true,
  });
  expect(modelResponse.status).toBe(201);
  const model = (await modelResponse.json()) as { data: { id: string } };
  return { providerId: provider.data.id, modelId: model.data.id };
}

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Integration User" });
  const generated = await generateApiKey();
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "integration-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });

  const created = await createProviderAndModel("mock", "gpt-test");
  providerId = created.providerId;
  primaryModelId = created.modelId;

  const aliasResponse = await adminCall("/admin/aliases", "POST", {
    name: "test-alias",
    target: "mock/gpt-test",
  });
  expect(aliasResponse.status).toBe(201);

  const publishResponse = await adminCall("/admin/config/publish", "POST", { note: "integration" });
  expect([200, 201]).toContain(publishResponse.status);
});

beforeEach(() => {
  upstreamRequests.length = 0;
  upstreamHandler = async () => jsonResponse(openAIChatCompletion());
});

describe("推理链路（OpenAI Chat 上游）", () => {
  it("OpenAI 客户端请求成功并正确转换到上游", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        messages: [{ role: "user", content: "ping" }],
        temperature: 0.2,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-fufu-model")).toBe("gpt-test");
    expect(response.headers.get("x-fufu-provider")).toBe("mock");
    expect(response.headers.get("x-fufu-usage-source")).toBe("upstream");

    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("pong");
    expect(body.usage.prompt_tokens).toBe(3);
    expect(body.usage.total_tokens).toBe(5);

    expect(upstreamRequests).toHaveLength(1);
    const upstream = upstreamRequests[0];
    expect(upstream?.url).toBe("https://mock.test/v1/chat/completions");
    expect(upstream?.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    const upstreamBody = (await upstream?.json()) as { model: string; temperature: number };
    expect(upstreamBody.model).toBe("gpt-upstream");
    expect(upstreamBody.temperature).toBe(0.2);
  });

  it("Anthropic 客户端请求跨协议转换为 OpenAI 上游", async () => {
    const response = await call("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": downstreamKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-alias",
        max_tokens: 64,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      type: string;
      content: Array<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: string;
    };
    expect(body.type).toBe("message");
    expect(body.content[0]?.type).toBe("text");
    expect(body.content[0]?.text).toBe("pong");
    expect(body.usage.input_tokens).toBe(2);
    expect((body.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens).toBe(1);
    expect(body.usage.output_tokens).toBe(2);
    expect(body.stop_reason).toBe("end_turn");

    expect(upstreamRequests).toHaveLength(1);
    const upstream = upstreamRequests[0];
    expect(upstream?.url).toBe("https://mock.test/v1/chat/completions");
    const upstreamBody = (await upstream?.json()) as { model: string; messages: unknown[] };
    expect(upstreamBody.model).toBe("gpt-upstream");
    expect(upstreamBody.messages).toHaveLength(1);
  });

  it("缺少或错误的 API Key 返回协议格式错误且不请求上游", async () => {
    const missing = await call("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as { error: { type: string } };
    expect(missingBody.error.type).toBe("authentication_error");

    const invalid = await call("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "fufu_sk_invalid", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(invalid.status).toBe(401);
    const invalidBody = (await invalid.json()) as { type: string; error: { type: string } };
    expect(invalidBody.type).toBe("error");
    expect(upstreamRequests).toHaveLength(0);
  });

  it("Gemini 客户端可以通过带 Provider 前缀的模型访问上游", async () => {
    const response = await call("/v1beta/models/mock/gpt-test:generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": downstreamKey, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
    };
    expect(body.candidates[0]?.content.parts[0]?.text).toBe("pong");
    expect(upstreamRequests).toHaveLength(1);
  });

  it("模型列表包含原生模型与别名且不泄露上游密钥", async () => {
    const response = await call("/v1/models", {
      headers: { authorization: `Bearer ${downstreamKey}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(UPSTREAM_KEY);
    const body = JSON.parse(text) as { data: Array<{ id: string }> };
    const ids = body.data.map((model) => model.id);
    expect(ids).toContain("gpt-test");
    expect(ids).toContain("test-alias");
  });
});

describe("管理接口", () => {
  it("未授权访问管理接口返回 401", async () => {
    const response = await call("/admin/providers");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTHENTICATION_ERROR");
  });

  it("管理员可以读取 Provider 列表且账户密钥不返回", async () => {
    const response = await adminCall("/admin/providers", "GET");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(UPSTREAM_KEY);
    const body = JSON.parse(text) as { data: Array<{ id: string; accountCount: number }> };
    const provider = body.data.find((item) => item.id === providerId);
    expect(provider?.accountCount).toBe(1);
  });

  it("Provider 测试与模型同步可用", async () => {
    upstreamHandler = async (request) => {
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/models")) {
        return jsonResponse({ data: [{ id: "gpt-upstream" }, { id: "gpt-new" }] });
      }
      return jsonResponse(openAIChatCompletion());
    };

    const testResponse = await adminCall(`/admin/providers/${providerId}/test`, "POST");
    expect(testResponse.status).toBe(200);
    const testBody = (await testResponse.json()) as { ok: boolean; modelCount: number };
    expect(testBody.ok).toBe(true);
    expect(testBody.modelCount).toBe(2);
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);

    upstreamRequests.length = 0;
    const syncResponse = await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    expect(syncResponse.status).toBe(200);
    const syncBody = (await syncResponse.json()) as { created: number; skipped: number; requiresConfirmation: boolean };
    expect(syncBody.created).toBe(1);
    expect(syncBody.skipped).toBe(1);
    expect(syncBody.requiresConfirmation).toBe(true);

    const modelsResponse = await adminCall(`/admin/models?providerId=${providerId}`, "GET");
    const modelsBody = (await modelsResponse.json()) as { data: Array<{ modelId: string; enabled: boolean }> };
    const synced = modelsBody.data.find((model) => model.modelId === "gpt-new");
    expect(synced?.enabled).toBe(false);
  });

  it("Combo 循环引用会阻止配置发布且不影响已生效配置", async () => {
    const a = await adminCall("/admin/combos", "POST", { name: "cycle-a", strategy: "fallback", nodes: [{ combo: "cycle-b" }] });
    expect(a.status).toBe(201);
    const b = await adminCall("/admin/combos", "POST", { name: "cycle-b", strategy: "fallback", nodes: [{ combo: "cycle-a" }] });
    expect(b.status).toBe(201);

    const publish = await adminCall("/admin/config/publish", "POST", {});
    expect(publish.status).toBe(400);
    const publishBody = (await publish.json()) as { error: { code: string } };
    expect(publishBody.error.code).toBe("CONFIG_INVALID");

    const stillWorks = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(stillWorks.status).toBe(200);

    const combos = await adminCall("/admin/combos", "GET");
    const comboBody = (await combos.json()) as { data: Array<{ id: string; name: string }> };
    for (const combo of comboBody.data.filter((item) => item.name.startsWith("cycle-"))) {
      const deleted = await adminCall(`/admin/combos/${combo.id}`, "DELETE");
      expect(deleted.status).toBe(200);
    }
    const republish = await adminCall("/admin/config/publish", "POST", {});
    expect([200, 201]).toContain(republish.status);
  });

  it("同名模型返回歧义错误，前缀可精确路由", async () => {
    await createProviderAndModel("mock2", "gpt-test", "gpt-other");
    const publish = await adminCall("/admin/config/publish", "POST", {});
    expect([200, 201]).toContain(publish.status);

    const ambiguous = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(ambiguous.status).toBe(409);
    const ambiguousBody = (await ambiguous.json()) as { error: { type: string; message: string } };
    expect(ambiguousBody.error.message).toContain("multiple providers");

    const prefixed = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/gpt-test", messages: [{ role: "user", content: "ping" }] }),
    });
    expect(prefixed.status).toBe(200);
    expect(prefixed.headers.get("x-fufu-provider")).toBe("mock");
    expect(primaryModelId).not.toBe("");
  });
});
