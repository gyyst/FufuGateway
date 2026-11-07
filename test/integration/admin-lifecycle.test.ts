import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createHarness, openAIChatCompletionResponse } from "./support";

const harness = createHarness();

let baseProviderId = "";
let downstreamKey = "";

beforeAll(async () => {
  const user = await harness.createUser({
    displayName: "Admin Lifecycle User",
    email: "admin-lifecycle@example.com",
  });
  downstreamKey = (await harness.createApiKey(user.id, { name: "lifecycle-key" })).key;

  const provider = await harness.createProvider({
    name: "life-base",
    baseUrl: "https://life-base.test/v1",
  });
  baseProviderId = provider.id;
  await harness.createAccount(provider.id, { apiKey: "life-base-upstream-key" });
  await harness.createModel({
    providerId: provider.id,
    modelId: "life-base-model",
    upstreamModelId: "life-base-upstream",
  });
  await harness.publish("lifecycle baseline");
});

beforeEach(() => {
  harness.upstreamRequests.length = 0;
  harness.setUpstream(() => openAIChatCompletionResponse("life-ok", { input: 2, output: 1 }));
});

function chat(model: string): Promise<Response> {
  return harness.call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
  });
}

describe("Provider 生命周期与校验", () => {
  it("Provider 创建、读取、更新后反映在列表中", async () => {
    const created = await harness.createProvider({
      name: "life-crud",
      baseUrl: "https://life-crud.test/v1",
    });

    const detail = await harness.admin(`/admin/providers/${created.id}`, "GET");
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      data: { name: string; accounts: unknown[]; models: unknown[] };
    };
    expect(detailBody.data.name).toBe("life-crud");
    expect(detailBody.data.accounts).toEqual([]);
    expect(detailBody.data.models).toEqual([]);

    const updated = await harness.admin(`/admin/providers/${created.id}`, "PUT", {
      name: "life-crud-renamed",
      priority: 55,
      timeoutMs: 12_345,
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      data: { name: string; priority: number; timeoutMs: number };
    };
    expect(updatedBody.data.name).toBe("life-crud-renamed");
    expect(updatedBody.data.priority).toBe(55);
    expect(updatedBody.data.timeoutMs).toBe(12_345);

    const list = await harness.admin("/admin/providers", "GET");
    const listBody = (await list.json()) as { data: Array<{ id: string; name: string }> };
    expect(listBody.data.find((provider) => provider.id === created.id)?.name).toBe(
      "life-crud-renamed",
    );

    await harness.admin(`/admin/providers/${created.id}`, "DELETE");
  });

  it("拒绝不安全或不匹配的 Provider 配置", async () => {
    const cases = [
      {
        name: "life-bad-http",
        body: { name: "life-bad-http", baseUrl: "http://insecure.test/v1" },
        expected: "CONFIG_INVALID",
      },
      {
        name: "life-bad-private",
        body: { name: "life-bad-private", baseUrl: "https://127.0.0.1/v1" },
        expected: "CONFIG_INVALID",
      },
      {
        name: "life-bad-credentials",
        body: { name: "life-bad-credentials", baseUrl: "https://user:pass@example.com/v1" },
        expected: "CONFIG_INVALID",
      },
      {
        name: "life-bad-header",
        body: {
          name: "life-bad-header",
          baseUrl: "https://example.com/v1",
          customHeaders: { authorization: "Bearer secret" },
        },
        expected: "CONFIG_INVALID",
      },
      {
        name: "life-bad-protocol",
        body: {
          name: "life-bad-protocol",
          type: "OPENAI_COMPATIBLE",
          protocol: "anthropic",
          baseUrl: "https://example.com/v1",
        },
        expected: "INVALID_REQUEST",
      },
      {
        name: "life bad name",
        body: { name: "life bad name", baseUrl: "https://example.com/v1" },
        expected: null,
      },
    ];

    for (const testCase of cases) {
      const response = await harness.admin("/admin/providers", "POST", {
        type: "OPENAI_COMPATIBLE",
        protocol: "openai-chat",
        ...testCase.body,
      });
      expect(response.status).toBe(400);
      if (testCase.expected !== null) {
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe(testCase.expected);
      }
    }
  });

  it("删除 Provider 会级联删除账户与模型，并在发布后停止路由", async () => {
    const provider = await harness.createProvider({
      name: "life-cascade",
      baseUrl: "https://life-cascade.test/v1",
    });
    const account = await harness.createAccount(provider.id, { apiKey: "cascade-upstream-key" });
    const model = await harness.createModel({
      providerId: provider.id,
      modelId: "life-cascade-model",
      upstreamModelId: "life-cascade-upstream",
    });
    await harness.publish("cascade before delete");

    expect((await chat("life-cascade/life-cascade-model")).status).toBe(200);

    const deleted = await harness.admin(`/admin/providers/${provider.id}`, "DELETE");
    expect(deleted.status).toBe(200);

    expect((await harness.admin(`/admin/providers/${provider.id}`, "GET")).status).toBe(404);
    expect((await harness.admin(`/admin/models/${model.id}`, "GET")).status).toBe(404);
    expect(
      (await harness.admin(`/admin/providers/${provider.id}/accounts/${account.id}`, "DELETE"))
        .status,
    ).toBe(404);

    await harness.publish("cascade after delete");
    expect((await chat("life-cascade/life-cascade-model")).status).toBe(404);
    expect((await chat("life-base/life-base-model")).status).toBe(200);
  });
});

describe("模型、价格、账户与用户", () => {
  it("模型创建、更新、删除生命周期", async () => {
    const provider = await harness.createProvider({
      name: "life-model-provider",
      baseUrl: "https://life-model.test/v1",
    });
    const created = await harness.createModel({
      providerId: provider.id,
      modelId: "life-model-a",
      upstreamModelId: "life-model-up",
    });

    const detail = await harness.admin(`/admin/models/${created.id}`, "GET");
    expect(detail.status).toBe(200);

    const updated = await harness.admin(`/admin/models/${created.id}`, "PUT", {
      upstreamModelId: "life-model-up-2",
      supportsTools: true,
      contextWindow: 128_000,
      inputPrice: 2,
      outputPrice: 4,
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      data: {
        upstreamModelId: string;
        capabilities: { supportsTools: boolean };
        contextWindow: number;
        pricing: { inputPrice: number; outputPrice: number };
      };
    };
    expect(updatedBody.data.upstreamModelId).toBe("life-model-up-2");
    expect(updatedBody.data.capabilities.supportsTools).toBe(true);
    expect(updatedBody.data.contextWindow).toBe(128_000);
    expect(updatedBody.data.pricing.inputPrice).toBe(2);
    expect(updatedBody.data.pricing.outputPrice).toBe(4);

    const list = await harness.admin(`/admin/models?providerId=${provider.id}`, "GET");
    const listBody = (await list.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((model) => model.id)).toEqual([created.id]);

    expect((await harness.admin(`/admin/models/${created.id}`, "DELETE")).status).toBe(200);
    expect((await harness.admin(`/admin/models/${created.id}`, "GET")).status).toBe(404);
    await harness.admin(`/admin/providers/${provider.id}`, "DELETE");
  });

  it("价格覆盖可创建、查询与删除", async () => {
    const created = await harness.admin("/admin/pricing", "POST", {
      providerId: baseProviderId,
      modelId: "life-base-upstream",
      inputPrice: 3,
      outputPrice: 6,
      currency: "USD",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string } };

    const list = await harness.admin("/admin/pricing", "GET");
    const listText = await list.text();
    expect(listText).toContain("life-base-upstream");

    const deleted = await harness.admin(`/admin/pricing/${createdBody.data.id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await (await harness.admin("/admin/pricing", "GET")).text()).not.toContain(
      createdBody.data.id,
    );
  });

  it("账户删除后 Provider 不再有可用账户", async () => {
    const provider = await harness.createProvider({
      name: "life-account-provider",
      baseUrl: "https://life-account.test/v1",
    });
    const account = await harness.createAccount(provider.id, { apiKey: "account-upstream-key" });

    const list = await harness.admin(`/admin/providers/${provider.id}/accounts`, "GET");
    const listBody = (await list.json()) as {
      data: Array<{ id: string; hasKey: boolean; credentialType: string; apiKey?: string }>;
    };
    expect(listBody.data[0]?.hasKey).toBe(true);
    expect(listBody.data[0]?.credentialType).toBe("api_key");
    expect(listBody.data[0]?.apiKey).toBeUndefined();

    expect(
      (await harness.admin(`/admin/providers/${provider.id}/accounts/${account.id}`, "DELETE"))
        .status,
    ).toBe(200);
    const after = (await (
      await harness.admin(`/admin/providers/${provider.id}/accounts`, "GET")
    ).json()) as { data: unknown[] };
    expect(after.data).toEqual([]);

    await harness.admin(`/admin/providers/${provider.id}`, "DELETE");
  });

  it("用户重复邮箱被拒绝，用户与 Key 可更新和删除", async () => {
    const email = `lifecycle-user-${Date.now()}@example.com`;
    const user = await harness.createUser({ displayName: "Lifecycle User", email });

    const duplicate = await harness.admin("/admin/users", "POST", {
      displayName: "Duplicate",
      email,
    });
    expect(duplicate.status).toBe(400);

    const updated = await harness.admin(`/admin/users/${user.id}`, "PUT", {
      displayName: "Lifecycle User Updated",
      rpmLimit: 30,
      dailyBudgetUsd: 2,
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      data: { displayName: string; rpmLimit: number; dailyBudgetUsd: number };
    };
    expect(updatedBody.data.displayName).toBe("Lifecycle User Updated");
    expect(updatedBody.data.rpmLimit).toBe(30);
    expect(updatedBody.data.dailyBudgetUsd).toBe(2);

    const created = await harness.createApiKey(user.id, { name: "lifecycle-key" });
    const filtered = await harness.admin(`/admin/api-keys?userId=${user.id}`, "GET");
    const filteredText = await filtered.text();
    expect(filteredText).toContain(created.data.id);
    expect(filteredText).not.toContain(created.key);
    expect(filteredText).not.toContain("keyHash");
    expect(filteredText).not.toContain("key_hash");

    const keyUpdate = await harness.admin(`/admin/api-keys/${created.data.id}`, "PUT", {
      name: "lifecycle-key-updated",
      modelAllowlist: ["life-base-model"],
      providerAllowlist: ["life-base"],
      expiresAt: Date.now() + 3_600_000,
    });
    expect(keyUpdate.status).toBe(200);

    expect((await harness.admin(`/admin/api-keys/${created.data.id}`, "DELETE")).status).toBe(200);
    const after = (await (
      await harness.admin(`/admin/api-keys?userId=${user.id}`, "GET")
    ).json()) as { data: Array<{ id: string }> };
    expect(after.data).toEqual([]);
  });
});

describe("配置版本、设置与可观测性", () => {
  it("配置状态反映待发布变更，重复发布返回 unchanged", async () => {
    await harness.publish("config status baseline");

    const before = (await (
      await harness.admin("/admin/config/current", "GET")
    ).json()) as { data: { activeVersion: number; pendingChanges: boolean } };
    expect(before.data.activeVersion).toBeGreaterThan(0);
    expect(before.data.pendingChanges).toBe(false);

    const provider = await harness.createProvider({
      name: "life-pending-provider",
      baseUrl: "https://life-pending.test/v1",
    });
    await harness.createAccount(provider.id, { apiKey: "pending-upstream-key" });
    await harness.createModel({
      providerId: provider.id,
      modelId: "life-pending-model",
      upstreamModelId: "life-pending-upstream",
    });

    const pending = (await (
      await harness.admin("/admin/config/current", "GET")
    ).json()) as { data: { activeVersion: number; pendingChanges: boolean; validation: { valid: boolean } } };
    expect(pending.data.activeVersion).toBe(before.data.activeVersion);
    expect(pending.data.pendingChanges).toBe(true);
    expect(pending.data.validation.valid).toBe(true);

    const validation = (await (
      await harness.admin("/admin/config/validate", "POST", {})
    ).json()) as { data: { valid: boolean; errorCount: number } };
    expect(validation.data.valid).toBe(true);
    expect(validation.data.errorCount).toBe(0);

    const published = await harness.publish("config status publish");
    expect(published.unchanged).toBe(false);
    expect(published.version).toBeGreaterThan(before.data.activeVersion);

    const after = (await (
      await harness.admin("/admin/config/current", "GET")
    ).json()) as { data: { activeVersion: number; pendingChanges: boolean } };
    expect(after.data.activeVersion).toBe(published.version);
    expect(after.data.pendingChanges).toBe(false);

    const republished = await harness.publish("config status republish");
    expect(republished.unchanged).toBe(true);
    expect(republished.version).toBe(published.version);

    const versions = (await (
      await harness.admin("/admin/config/versions?limit=10", "GET")
    ).json()) as { data: Array<{ version: number; status: string; note: string | null }> };
    expect(versions.data.find((version) => version.version === published.version)?.status).toBe(
      "published",
    );

    await harness.admin(`/admin/providers/${provider.id}`, "DELETE");
  });

  it("配置校验发现 Combo 循环但不影响当前生效版本", async () => {
    const baseline = (await (
      await harness.admin("/admin/config/current", "GET")
    ).json()) as { data: { activeVersion: number } };

    const a = await harness.admin("/admin/combos", "POST", {
      name: "life-cycle-a",
      strategy: "fallback",
      nodes: [{ combo: "life-cycle-b" }],
    });
    expect(a.status).toBe(201);
    const b = await harness.admin("/admin/combos", "POST", {
      name: "life-cycle-b",
      strategy: "fallback",
      nodes: [{ combo: "life-cycle-a" }],
    });
    expect(b.status).toBe(201);

    const validation = (await (
      await harness.admin("/admin/config/validate", "POST", {})
    ).json()) as {
      data: { valid: boolean; errorCount: number; issues: Array<{ code: string }> };
    };
    expect(validation.data.valid).toBe(false);
    expect(validation.data.errorCount).toBeGreaterThan(0);
    expect(validation.data.issues.some((issue) => issue.code === "COMBO_CYCLE_DETECTED")).toBe(
      true,
    );

    expect((await chat("life-base/life-base-model")).status).toBe(200);
    const current = (await (
      await harness.admin("/admin/config/current", "GET")
    ).json()) as { data: { activeVersion: number } };
    expect(current.data.activeVersion).toBe(baseline.data.activeVersion);

    const combos = (await (
      await harness.admin("/admin/combos", "GET")
    ).json()) as { data: Array<{ id: string; name: string }> };
    for (const combo of combos.data.filter((entry) => entry.name.startsWith("life-cycle-"))) {
      expect((await harness.admin(`/admin/combos/${combo.id}`, "DELETE")).status).toBe(200);
    }
    await harness.publish("config cycle cleanup");
  });

  it("系统设置拒绝未知键并保存允许的键", async () => {
    const unknown = await harness.admin("/admin/settings", "PUT", { "unknown.key": 1 });
    expect(unknown.status).toBe(400);

    const updated = await harness.admin("/admin/settings", "PUT", {
      "gateway.name": "Lifecycle Gateway",
      "limits.max_body_bytes": 2_097_152,
    });
    expect(updated.status).toBe(200);

    const settings = (await (
      await harness.admin("/admin/settings", "GET")
    ).json()) as { data: Record<string, unknown> };
    expect(settings.data["gateway.name"]).toBe("Lifecycle Gateway");
    expect(settings.data["limits.max_body_bytes"]).toBe(2_097_152);
  });

  it("管理健康与熔断状态可读取", async () => {
    const health = await harness.admin("/admin/health", "GET");
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as {
      status: string;
      db: boolean;
      config: { activeVersion: number };
    };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.db).toBe(true);
    expect(healthBody.config.activeVersion).toBeGreaterThan(0);

    const breakers = await harness.admin("/admin/health/breakers", "GET");
    expect(breakers.status).toBe(200);
    const breakerBody = (await breakers.json()) as {
      data: Array<{
        providerId: string;
        providerState: { state: string };
        accounts: Array<{ state: string }>;
        models: Array<{ state: string }>;
      }>;
    };
    const base = breakerBody.data.find((entry) => entry.providerId === baseProviderId);
    expect(base?.providerState.state).toBe("closed");
    expect(base?.accounts[0]?.state).toBe("closed");
    expect(base?.models[0]?.state).toBe("closed");
  });

  it("审计日志记录管理写操作且不泄露上游密钥", async () => {
    const upstreamSecret = "audit-upstream-secret-value";
    const provider = await harness.createProvider({
      name: "life-audit-provider",
      baseUrl: "https://life-audit.test/v1",
    });
    const account = await harness.createAccount(provider.id, { apiKey: upstreamSecret });
    await harness.createModel({
      providerId: provider.id,
      modelId: "life-audit-model",
      upstreamModelId: "life-audit-upstream",
    });

    const logs = await harness.admin("/admin/audit-logs?limit=200", "GET");
    expect(logs.status).toBe(200);
    const text = await logs.text();
    expect(text).not.toContain(upstreamSecret);
    const body = JSON.parse(text) as {
      data: Array<{
        action: string;
        targetType: string;
        targetId: string | null;
        actorType: string;
        details: Record<string, unknown> | null;
      }>;
    };
    expect(
      body.data.some(
        (entry) =>
          entry.action === "provider.create" &&
          entry.targetType === "provider" &&
          entry.targetId === provider.id,
      ),
    ).toBe(true);
    expect(
      body.data.some(
        (entry) =>
          entry.action === "account.create" &&
          entry.targetType === "provider_account" &&
          entry.targetId === account.id,
      ),
    ).toBe(true);
    expect(body.data.every((entry) => entry.actorType === "admin_token")).toBe(true);

    await harness.admin(`/admin/providers/${provider.id}`, "DELETE");
  });

  it("未配置变量的管理接口返回明确错误", async () => {
    const ctx = createExecutionContext();
    const app = createApp();
    const response = await app.fetch(
      new Request("https://gateway.test/admin/providers"),
      { ...env, ADMIN_TOKEN: undefined },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIG_INVALID");
  });
});
