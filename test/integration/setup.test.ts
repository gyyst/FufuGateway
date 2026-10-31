import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
const ARK_KEY = "ark-upstream-secret";
const HUAWEI_KEY = "huawei-upstream-secret";

let downstreamKey = "";
let arkProviderId = "";
let emptyProviderId = "";
const upstreamRequests: Request[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(text: string, model: string): Response {
  return json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
}

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  upstreamRequests.push(request.clone());
  const url = new URL(request.url);
  if (url.pathname.endsWith("/models")) {
    return json({ object: "list", data: [{ id: "remote-model", object: "model" }] });
  }
  if (url.hostname === "ark.test") return completion("ark-ok", "ark-upstream");
  if (url.hostname === "huawei.test") return completion("huawei-ok", "huawei-upstream");
  return json({ error: { message: "not found" } }, 404);
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

async function createProvider(
  name: string,
  baseUrl: string,
  apiKey?: string,
  modelId?: string,
  upstreamModelId?: string,
): Promise<string> {
  const created = await adminCall("/admin/providers", "POST", {
    name,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl,
    maxRetries: 0,
  });
  expect(created.status).toBe(201);
  const provider = (await created.json()) as { data: { id: string } };
  if (apiKey !== undefined) {
    const account = await adminCall(`/admin/providers/${provider.data.id}/accounts`, "POST", {
      name: "primary",
      apiKey,
    });
    expect(account.status).toBe(201);
  }
  if (modelId !== undefined) {
    const model = await adminCall("/admin/models", "POST", {
      providerId: provider.data.id,
      modelId,
      upstreamModelId: upstreamModelId ?? modelId,
      supportsStream: true,
    });
    expect(model.status).toBe(201);
  }
  return provider.data.id;
}

beforeAll(async () => {
  arkProviderId = await createProvider(
    "ark",
    "https://ark.test/api/v3",
    ARK_KEY,
    "ark-chat",
    "ark-upstream",
  );
  await createProvider(
    "huawei",
    "https://huawei.test/openai/v1",
    HUAWEI_KEY,
    "huawei-chat",
    "huawei-upstream",
  );
  emptyProviderId = await createProvider("empty", "https://empty.test/v1");

  const userResponse = await adminCall("/admin/users", "POST", { displayName: "Setup User" });
  expect(userResponse.status).toBe(201);
  const user = (await userResponse.json()) as { data: { id: string } };
  const keyResponse = await adminCall("/admin/api-keys", "POST", {
    userId: user.data.id,
    name: "setup-key",
    scopes: ["inference"],
  });
  expect(keyResponse.status).toBe(201);
  const key = (await keyResponse.json()) as { key: string };
  downstreamKey = key.key;

  const published = await adminCall("/admin/config/publish", "POST", { note: "setup-test" });
  expect([200, 201]).toContain(published.status);
});

beforeEach(() => {
  upstreamRequests.length = 0;
});

describe("Provider 预设与快速开始", () => {
  it("返回预设目录且不包含密钥", async () => {
    const response = await adminCall("/admin/provider-presets", "GET");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(ARK_KEY);
    const body = JSON.parse(text) as {
      data: Array<{ id: string; baseUrl: string; suggestedName: string }>;
    };
    const ids = body.data.map((preset) => preset.id);
    expect(ids).toContain("volcengine-ark-openai");
    expect(ids).toContain("huawei-maas-openai");
    expect(ids).toContain("custom-openai");
    const ark = body.data.find((preset) => preset.id === "volcengine-ark-openai");
    expect(ark?.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("快速开始状态反映 Provider、账户、模型、配置和 Key", async () => {
    const response = await adminCall("/admin/setup/status", "GET");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        readyForInference: boolean;
        counts: Record<string, number>;
        steps: Array<{ id: string; complete: boolean; action?: { page: string } }>;
      };
    };
    expect(body.data.readyForInference).toBe(true);
    expect(body.data.counts.providers).toBeGreaterThanOrEqual(3);
    expect(body.data.counts.providersWithAccounts).toBeGreaterThanOrEqual(2);
    expect(body.data.counts.enabledModels).toBeGreaterThanOrEqual(2);
    expect(body.data.counts.activeApiKeys).toBe(1);
    expect(body.data.steps.every((step) => step.id === "gateway_test" || step.complete)).toBe(true);
    expect(body.data.steps.find((step) => step.id === "api_key")?.action?.page).toBe("keys");
  });
});

describe("基础推理链路", () => {
  it("火山方舟 /api/v3 的 OpenAI Chat URL 和认证正确", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "ark/ark-chat",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("ark-ok");
    expect(upstreamRequests[0]?.url).toBe("https://ark.test/api/v3/chat/completions");
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(`Bearer ${ARK_KEY}`);
  });

  it("华为云 /openai/v1 不重复追加版本段", async () => {
    const response = await call("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "huawei/huawei-chat",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
      }),
    });
    expect(response.status).toBe(200);
    expect(upstreamRequests[0]?.url).toBe("https://huawei.test/openai/v1/chat/completions");
    expect(upstreamRequests[0]?.headers.get("authorization")).toBe(`Bearer ${HUAWEI_KEY}`);
  });
});

describe("路由诊断与网关自测", () => {
  it("解释火山方舟路由并给出目标和账户状态", async () => {
    const response = await adminCall("/admin/routing/explain", "POST", { model: "ark/ark-chat" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        ok: boolean;
        match: { type: string };
        plan: { nodes: Array<{ kind: string; target?: { providerName: string; modelId: string; hasEnabledAccount: boolean } }> };
      };
    };
    expect(body.data.ok).toBe(true);
    expect(body.data.match.type).toBe("provider_prefix");
    expect(body.data.plan.nodes[0]?.kind).toBe("model");
    expect(body.data.plan.nodes[0]?.target?.providerName).toBe("ark");
    expect(body.data.plan.nodes[0]?.target?.modelId).toBe("ark-chat");
    expect(body.data.plan.nodes[0]?.target?.hasEnabledAccount).toBe(true);
  });

  it("不存在的模型返回可读错误", async () => {
    const response = await adminCall("/admin/routing/explain", "POST", { model: "missing-model" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { ok: boolean; error: { code: string } } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error.code).toBe("MODEL_NOT_FOUND");
  });

  it("网关自测走完整链路并写入最近自测状态", async () => {
    const testResponse = await adminCall("/admin/gateway/test", "POST", {
      model: "ark/ark-chat",
      prompt: "ping",
      maxOutputTokens: 16,
    });
    expect(testResponse.status).toBe(200);
    const testBody = (await testResponse.json()) as {
      data: { ok: boolean; provider: string; text: string; modelId: string };
    };
    expect(testBody.data.ok).toBe(true);
    expect(testBody.data.provider).toBe("ark");
    expect(testBody.data.modelId).toBe("ark-chat");
    expect(testBody.data.text).toBe("ark-ok");

    const statusResponse = await adminCall("/admin/setup/status", "GET");
    const statusBody = (await statusResponse.json()) as {
      data: { lastGatewayTest: { success: boolean } | null };
    };
    expect(statusBody.data.lastGatewayTest?.success).toBe(true);
  });

  it("Provider 没有账户时返回明确错误", async () => {
    const response = await adminCall(`/admin/providers/${emptyProviderId}/test`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PROVIDER_NO_ACCOUNT");
  });

  it("Provider 有账户时可以列出上游模型", async () => {
    const response = await adminCall(`/admin/providers/${arkProviderId}/test`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; modelCount: number };
    expect(body.ok).toBe(true);
    expect(body.modelCount).toBe(1);
  });
});

describe("模型同步安全语义", () => {
  it("同步模型默认禁用且能力全部为 false", async () => {
    const response = await adminCall(`/admin/providers/${arkProviderId}/sync-models`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { created: number; skipped: number };
    expect(body.created).toBe(1);
    expect(body.skipped).toBe(0);

    const modelsResponse = await adminCall("/admin/models?providerId=" + arkProviderId, "GET");
    const modelsBody = (await modelsResponse.json()) as {
      data: Array<{
        modelId: string;
        enabled: boolean;
        capabilities: { supportsStream: boolean; supportsTools: boolean; supportsVision: boolean };
      }>;
    };
    const synced = modelsBody.data.find((model) => model.modelId === "remote-model");
    expect(synced?.enabled).toBe(false);
    expect(synced?.capabilities.supportsStream).toBe(false);
    expect(synced?.capabilities.supportsTools).toBe(false);
    expect(synced?.capabilities.supportsVision).toBe(false);
  });
});
