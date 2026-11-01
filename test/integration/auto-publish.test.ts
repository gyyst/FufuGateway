import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateApiKey } from "../../src/auth/api-key";
import { createApiKeyRecord, createUser } from "../../src/auth/repository";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
let downstreamKey = "";
let providerId = "";

interface ConfigOutcome {
  applied: boolean;
  unchanged: boolean;
  version: number | null;
  checksum: string | null;
  issues: Array<{ severity: "error" | "warning"; code: string; message: string }>;
  error?: { code: string; message: string };
}

interface ConfigStatusBody {
  activeVersion: number | null;
  activeChecksum: string | null;
  pendingChanges: boolean;
  validation: { valid: boolean } | null;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request ? input : new Request(typeof input === "string" ? input : input.toString(), init);
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.endsWith("/models")) {
    return json({ object: "list", data: [{ id: "auto-upstream" }, { id: "auto-synced" }] });
  }
  return json({
    id: "chatcmpl-auto",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "auto-upstream",
    choices: [{ index: 0, message: { role: "assistant", content: "auto-ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
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

function chat(model: string): Promise<Response> {
  return call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${downstreamKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }] }),
  });
}

async function configStatus(): Promise<ConfigStatusBody> {
  const response = await adminCall("/admin/config/current", "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ConfigStatusBody }).data;
}

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Auto Publish User" });
  const generated = await generateApiKey();
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "auto-publish-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });
});

describe("配置写入自动发布", () => {
  it("Provider、账户与模型写入后自动生成版本并立即生效", async () => {
    const providerResponse = await adminCall("/admin/providers", "POST", {
      name: "auto",
      type: "OPENAI_COMPATIBLE",
      protocol: "openai-chat",
      baseUrl: "https://auto.test/v1",
      maxRetries: 0,
    });
    expect(providerResponse.status).toBe(201);
    const providerBody = (await providerResponse.json()) as {
      data: { id: string };
      config: ConfigOutcome;
    };
    providerId = providerBody.data.id;
    expect(providerBody.config.applied).toBe(true);
    expect(providerBody.config.unchanged).toBe(false);
    expect(providerBody.config.version).not.toBeNull();
    expect(providerBody.config.issues.some((issue) => issue.code === "PROVIDER_NO_ACCOUNT")).toBe(true);

    let current = await configStatus();
    expect(current.activeVersion).toBe(providerBody.config.version);
    expect(current.pendingChanges).toBe(false);

    const accountResponse = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
      name: "primary",
      apiKey: "auto-upstream-key",
    });
    expect(accountResponse.status).toBe(201);
    const accountBody = (await accountResponse.json()) as { config: ConfigOutcome };
    expect(accountBody.config.applied).toBe(true);
    expect(accountBody.config.version ?? 0).toBeGreaterThan(providerBody.config.version ?? 0);

    const modelResponse = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "auto-chat",
      upstreamModelId: "auto-upstream",
      supportsStream: true,
    });
    expect(modelResponse.status).toBe(201);
    const modelBody = (await modelResponse.json()) as { config: ConfigOutcome };
    expect(modelBody.config.applied).toBe(true);
    expect(modelBody.config.version ?? 0).toBeGreaterThan(accountBody.config.version ?? 0);

    current = await configStatus();
    expect(current.activeVersion).toBe(modelBody.config.version);
    expect(current.validation?.valid).toBe(true);
    expect((await chat("auto-chat")).status).toBe(200);
  });

  it("Combo 写入自动发布并可立即路由", async () => {
    const comboResponse = await adminCall("/admin/combos", "POST", {
      name: "auto-combo",
      strategy: "fallback",
      nodes: ["auto/auto-chat"],
    });
    expect(comboResponse.status).toBe(201);
    const comboBody = (await comboResponse.json()) as {
      data: { id: string };
      config: ConfigOutcome;
    };
    expect(comboBody.config.applied).toBe(true);
    expect(comboBody.config.unchanged).toBe(false);

    const current = await configStatus();
    expect(current.activeVersion).toBe(comboBody.config.version);
    expect(current.pendingChanges).toBe(false);
    expect((await chat("auto-combo")).status).toBe(200);
  });

  it("设置保存后自动发布", async () => {
    const update = await adminCall("/admin/settings", "PUT", { "gateway.name": "AutoGateway" });
    expect(update.status).toBe(200);
    const updateBody = (await update.json()) as { data: Record<string, unknown>; config: ConfigOutcome };
    expect(updateBody.data["gateway.name"]).toBe("AutoGateway");
    expect(updateBody.config.applied).toBe(true);

    const current = await configStatus();
    expect(current.activeVersion).toBe(updateBody.config.version);
    expect(current.pendingChanges).toBe(false);
    expect(current.validation?.valid).toBe(true);

    const settings = await adminCall("/admin/settings", "GET");
    const settingsBody = (await settings.json()) as { data: Record<string, unknown> };
    expect(settingsBody.data["gateway.name"]).toBe("AutoGateway");
  });

  it("sync-models 自动发布", async () => {
    const syncResponse = await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    expect(syncResponse.status).toBe(200);
    const syncBody = (await syncResponse.json()) as {
      created: number;
      skipped: number;
      config: ConfigOutcome;
    };
    expect(syncBody.created).toBe(1);
    expect(syncBody.skipped).toBe(1);
    expect(syncBody.config.applied).toBe(true);

    const current = await configStatus();
    expect(current.activeVersion).toBe(syncBody.config.version);
    expect(current.pendingChanges).toBe(false);
  });

  it("手动 publish 在配置无变化时返回 200 且 unchanged", async () => {
    const before = await configStatus();
    const publish = await adminCall("/admin/config/publish", "POST", { note: "no-op" });
    expect(publish.status).toBe(200);
    const publishBody = (await publish.json()) as { data: { unchanged: boolean; version: number } };
    expect(publishBody.data.unchanged).toBe(true);
    expect(publishBody.data.version).toBe(before.activeVersion);

    const after = await configStatus();
    expect(after.activeVersion).toBe(before.activeVersion);
    expect(after.pendingChanges).toBe(false);
  });
});
