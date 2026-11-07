import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, openAIChatCompletionResponse } from "./support";

const harness = createHarness();

let fullKey = "";
let modelScopedKey = "";
let providerScopedKey = "";
let noInferenceKey = "";
let expiredKey = "";
let adminKey = "";
let adminInferenceOnlyKey = "";
let deletedKey = "";
let deletedKeyId = "";
let disabledUserKey = "";
let disabledUserId = "";

beforeAll(async () => {
  const user = await harness.createUser({ displayName: "Authorization User" });
  fullKey = (await harness.createApiKey(user.id, { name: "full" })).key;
  modelScopedKey = (
    await harness.createApiKey(user.id, {
      name: "model-scoped",
      modelAllowlist: ["alpha-visible"],
    })
  ).key;
  providerScopedKey = (
    await harness.createApiKey(user.id, {
      name: "provider-scoped",
      providerAllowlist: ["authz-alpha"],
    })
  ).key;
  noInferenceKey = (
    await harness.createApiKey(user.id, {
      name: "no-inference",
      scopes: ["billing"],
    })
  ).key;
  expiredKey = (
    await harness.createApiKey(user.id, {
      name: "expired",
      expiresAt: Date.now() - 60_000,
    })
  ).key;

  const deleted = await harness.createApiKey(user.id, { name: "deleted" });
  deletedKey = deleted.key;
  deletedKeyId = deleted.data.id;

  const admin = await harness.createUser({
    displayName: "Admin User",
    role: "admin",
    email: "authz-admin@example.com",
  });
  adminKey = (await harness.createApiKey(admin.id, { name: "admin", scopes: ["admin"] })).key;
  adminInferenceOnlyKey = (
    await harness.createApiKey(admin.id, { name: "admin-inference-only", scopes: ["inference"] })
  ).key;

  const disabled = await harness.createUser({
    displayName: "Disabled User",
    email: "authz-disabled@example.com",
  });
  disabledUserId = disabled.id;
  disabledUserKey = (await harness.createApiKey(disabled.id, { name: "disabled-user-key" })).key;

  const alpha = await harness.createProvider({
    name: "authz-alpha",
    baseUrl: "https://authz-alpha.test/v1",
  });
  await harness.createAccount(alpha.id, { apiKey: "alpha-upstream-key" });
  await harness.createModel({
    providerId: alpha.id,
    modelId: "alpha-visible",
    upstreamModelId: "alpha-visible-up",
  });
  await harness.createModel({
    providerId: alpha.id,
    modelId: "alpha-other",
    upstreamModelId: "alpha-other-up",
  });

  const beta = await harness.createProvider({
    name: "authz-beta",
    baseUrl: "https://authz-beta.test/v1",
  });
  await harness.createAccount(beta.id, { apiKey: "beta-upstream-key" });
  await harness.createModel({
    providerId: beta.id,
    modelId: "beta-visible",
    upstreamModelId: "beta-visible-up",
  });

  await harness.publish("authz");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream(() => openAIChatCompletionResponse("authz-ok", { input: 2, output: 1 }));
});

function chat(keyValue: string, model: string): Promise<Response> {
  return harness.call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${keyValue}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
  });
}

describe("模型与 Provider 白名单", () => {
  it("模型白名单只允许列出的模型", async () => {
    expect((await chat(modelScopedKey, "authz-alpha/alpha-visible")).status).toBe(200);

    const denied = await chat(modelScopedKey, "authz-alpha/alpha-other");
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_DENIED");

    const deniedOtherProvider = await chat(modelScopedKey, "authz-beta/beta-visible");
    expect(deniedOtherProvider.status).toBe(403);
  });

  it("Provider 白名单只允许列出的 Provider", async () => {
    expect((await chat(providerScopedKey, "authz-alpha/alpha-visible")).status).toBe(200);
    expect((await chat(providerScopedKey, "authz-alpha/alpha-other")).status).toBe(200);

    const denied = await chat(providerScopedKey, "authz-beta/beta-visible");
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_DENIED");
  });

  it("OpenAI 模型目录按白名单过滤", async () => {
    const full = (await (
      await harness.call("/v1/models", { headers: { authorization: `Bearer ${fullKey}` } })
    ).json()) as { data: Array<{ id: string }> };
    expect(full.data.map((model) => model.id).sort()).toEqual([
      "alpha-other",
      "alpha-visible",
      "beta-visible",
    ]);

    const scoped = (await (
      await harness.call("/v1/models", { headers: { authorization: `Bearer ${modelScopedKey}` } })
    ).json()) as { data: Array<{ id: string }> };
    expect(scoped.data.map((model) => model.id)).toEqual(["alpha-visible"]);

    const providerScoped = (await (
      await harness.call("/v1/models", {
        headers: { authorization: `Bearer ${providerScopedKey}` },
      })
    ).json()) as { data: Array<{ id: string }> };
    expect(providerScoped.data.map((model) => model.id).sort()).toEqual([
      "alpha-other",
      "alpha-visible",
    ]);
  });

  it("Gemini 模型目录同样按白名单过滤，单个模型查询不可越权", async () => {
    const list = (await (
      await harness.call("/v1beta/models", {
        headers: { "x-goog-api-key": modelScopedKey },
      })
    ).json()) as { models: Array<{ name: string }> };
    expect(list.models.map((model) => model.name)).toEqual(["models/alpha-visible"]);

    const allowed = await harness.call("/v1beta/models/alpha-visible", {
      headers: { "x-goog-api-key": modelScopedKey },
    });
    expect(allowed.status).toBe(200);

    const denied = await harness.call("/v1beta/models/alpha-other", {
      headers: { "x-goog-api-key": modelScopedKey },
    });
    expect(denied.status).toBe(404);
  });
});

describe("API Key 生命周期与凭据位置", () => {
  it("没有 inference scope 的 Key 不能调用推理接口", async () => {
    const response = await chat(noInferenceKey, "authz-alpha/alpha-visible");
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_DENIED");
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("过期 Key 在推理前被拒绝", async () => {
    const response = await chat(expiredKey, "authz-alpha/alpha-visible");
    expect(response.status).toBe(401);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("篡改 Key 一个字符后立即失效", async () => {
    const response = await chat(`${fullKey}x`, "authz-alpha/alpha-visible");
    expect(response.status).toBe(401);
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("删除 Key 后立即失效", async () => {
    expect((await chat(deletedKey, "authz-alpha/alpha-visible")).status).toBe(200);

    const deleted = await harness.admin(`/admin/api-keys/${deletedKeyId}`, "DELETE");
    expect(deleted.status).toBe(200);

    expect((await chat(deletedKey, "authz-alpha/alpha-visible")).status).toBe(401);
  });

  it("禁用用户后其所有 Key 立即失效", async () => {
    expect((await chat(disabledUserKey, "authz-alpha/alpha-visible")).status).toBe(200);

    const updated = await harness.admin(`/admin/users/${disabledUserId}`, "PUT", {
      status: "disabled",
    });
    expect(updated.status).toBe(200);

    expect((await chat(disabledUserKey, "authz-alpha/alpha-visible")).status).toBe(401);
  });

  it("Gemini 支持 ?key= 凭据位置", async () => {
    const response = await harness.call(
      `/v1beta/models/authz-alpha/alpha-visible:generateContent?key=${encodeURIComponent(fullKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
      },
    );
    expect(response.status).toBe(200);
  });

  it("Anthropic 兼容 Authorization Bearer 凭据", async () => {
    const response = await harness.call("/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${fullKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "authz-alpha/alpha-visible",
        max_tokens: 32,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(response.status).toBe(200);
  });
});

describe("管理面鉴权", () => {
  it("admin 角色且具备 admin scope 的 Key 可以访问管理接口", async () => {
    const response = await harness.admin("/admin/providers", "GET", undefined, adminKey);
    expect(response.status).toBe(200);
  });

  it("普通推理 Key 不能访问管理接口", async () => {
    const response = await harness.admin("/admin/providers", "GET", undefined, fullKey);
    expect(response.status).toBe(401);
  });

  it("admin 角色但缺少 admin scope 的 Key 不能访问管理接口", async () => {
    const response = await harness.admin(
      "/admin/providers",
      "GET",
      undefined,
      adminInferenceOnlyKey,
    );
    expect(response.status).toBe(401);
  });

  it("缺少凭据时返回统一错误且不请求上游", async () => {
    const response = await harness.call("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "authz-alpha/alpha-visible",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("AUTHENTICATION_ERROR");
    expect(harness.upstreamRequests).toHaveLength(0);
  });
});
