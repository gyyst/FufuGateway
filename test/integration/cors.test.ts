import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, openAIChatCompletionResponse } from "./support";

const harness = createHarness();

const ALLOWED_ORIGIN = "https://app.example.com";
const OTHER_ORIGIN = "https://evil.example.com";

let key = "";

beforeAll(async () => {
  const user = await harness.createUser({ displayName: "CORS User" });
  key = (await harness.createApiKey(user.id, { name: "cors-key" })).key;

  const provider = await harness.createProvider({
    name: "cors-provider",
    baseUrl: "https://cors-upstream.test/v1",
  });
  await harness.createAccount(provider.id, { apiKey: "cors-upstream-key" });
  await harness.createModel({
    providerId: provider.id,
    modelId: "cors-model",
    upstreamModelId: "cors-model-up",
  });
  await harness.publish("cors baseline");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream(() => openAIChatCompletionResponse("cors-ok", { input: 1, output: 1 }));
});

function preflight(path: string, origin?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type",
  };
  if (origin !== undefined) headers.origin = origin;
  return harness.call(path, { method: "OPTIONS", headers });
}

function chat(origin?: string): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (origin !== undefined) headers.origin = origin;
  return harness.call("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "cors-provider/cors-model",
      messages: [{ role: "user", content: "ping" }],
    }),
  });
}

async function setAllowedOrigins(origins: string[]): Promise<void> {
  const response = await harness.admin("/admin/settings", "PUT", {
    "cors.allowed_origins": origins,
  });
  expect(response.status).toBe(200);
}

async function ensureCors(origins: string[], note: string): Promise<void> {
  await setAllowedOrigins(origins);
  await harness.publish(note);
}

describe("CORS 默认关闭", () => {
  it("未配置允许来源时预检请求返回 403", async () => {
    const response = await preflight("/v1/chat/completions", ALLOWED_ORIGIN);
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(harness.upstreamRequests).toHaveLength(0);
  });

  it("无 Origin 的普通请求不受 CORS 影响", async () => {
    const response = await chat();
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("拒绝非字符串数组的配置", async () => {
    const response = await harness.admin("/admin/settings", "PUT", {
      "cors.allowed_origins": "https://app.example.com",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_REQUEST");
  });
});

describe("配置发布后生效", () => {
  it("保存设置但未发布时仍按当前生效配置拒绝", async () => {
    await setAllowedOrigins([ALLOWED_ORIGIN]);

    const response = await preflight("/v1/chat/completions", ALLOWED_ORIGIN);
    expect(response.status).toBe(403);

    await harness.publish("cors enable");
  });

  it("允许来源的预检在认证前返回 204 与 CORS 头", async () => {
    await ensureCors([ALLOWED_ORIGIN], "cors allow preflight");

    const response = await preflight("/v1/chat/completions", ALLOWED_ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-goog-api-key");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-request-id");
    expect(response.headers.get("access-control-max-age")).toBe("600");

    const gemini = await preflight(
      "/v1beta/models/cors-provider/cors-model:generateContent",
      ALLOWED_ORIGIN,
    );
    expect(gemini.status).toBe(204);
    expect(gemini.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
  });

  it("允许来源的普通响应带 CORS 头并暴露网关追踪头", async () => {
    await ensureCors([ALLOWED_ORIGIN], "cors allow actual response");

    const response = await chat(ALLOWED_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-request-id");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-fufu-provider");

    const upstream = harness.upstreamRequests[0];
    expect(upstream?.headers.get("origin")).toBeNull();
  });

  it("允许来源的错误响应同样带 CORS 头", async () => {
    await ensureCors([ALLOWED_ORIGIN], "cors allow error response");

    const response = await harness.call("/v1/chat/completions", {
      method: "POST",
      headers: {
        origin: ALLOWED_ORIGIN,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "cors-provider/missing-model",
        messages: [{ role: "user", content: "ping" }],
      }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toContain("x-request-id");
  });

  it("未允许来源预检被拒绝，普通请求成功但不返回 CORS 头", async () => {
    await ensureCors([ALLOWED_ORIGIN], "cors disallowed origin");

    const options = await preflight("/v1/chat/completions", OTHER_ORIGIN);
    expect(options.status).toBe(403);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();

    const response = await chat(OTHER_ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("通配符来源返回 * 而不是回显 Origin", async () => {
    await setAllowedOrigins(["*"]);
    await harness.publish("cors wildcard");

    const response = await preflight("/v1/chat/completions", OTHER_ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");

    const actual = await chat(OTHER_ORIGIN);
    expect(actual.status).toBe(200);
    expect(actual.headers.get("access-control-allow-origin")).toBe("*");
  });
});
