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
let versionOne = 0;

const fetchImpl: FetchLike = async () =>
  new Response(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "cfg-up",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

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

beforeAll(async () => {
  const user = await createUser(env.DB, { displayName: "Config User" });
  const generated = await generateApiKey();
  downstreamKey = generated.plaintext;
  await createApiKeyRecord(env.DB, {
    userId: user.id,
    name: "config-key",
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
  });

  const providerResponse = await adminCall("/admin/providers", "POST", {
    name: "cfg",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://cfg.test/v1",
    maxRetries: 0,
  });
  expect(providerResponse.status).toBe(201);
  providerId = ((await providerResponse.json()) as { data: { id: string } }).data.id;

  const account = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
    name: "primary",
    apiKey: "cfg-key",
  });
  expect(account.status).toBe(201);

  const model = await adminCall("/admin/models", "POST", {
    providerId,
    modelId: "cfg-v1",
    upstreamModelId: "cfg-up",
    supportsStream: true,
  });
  expect(model.status).toBe(201);

  const publish = await adminCall("/admin/config/publish", "POST", { note: "v1" });
  expect(publish.status).toBe(201);
  versionOne = ((await publish.json()) as { data: { version: number } }).data.version;
});

describe("配置版本与回滚", () => {
  it("发布新版本后生效，回滚后恢复旧路由", async () => {
    expect((await chat("cfg-v1")).status).toBe(200);

    const modelV2 = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "cfg-v2",
      upstreamModelId: "cfg-up",
      supportsStream: true,
    });
    expect(modelV2.status).toBe(201);

    const publishV2 = await adminCall("/admin/config/publish", "POST", { note: "v2" });
    expect(publishV2.status).toBe(201);
    const versionTwo = ((await publishV2.json()) as { data: { version: number } }).data.version;
    expect(versionTwo).toBeGreaterThan(versionOne);

    expect((await chat("cfg-v2")).status).toBe(200);

    const rollback = await adminCall("/admin/config/rollback", "POST", { version: versionOne });
    expect(rollback.status).toBe(200);

    const removed = await chat("cfg-v2");
    expect(removed.status).toBe(404);
    expect((await chat("cfg-v1")).status).toBe(200);

    const current = await adminCall("/admin/config/current", "GET");
    const currentBody = (await current.json()) as { data: { activeVersion: number } };
    expect(currentBody.data.activeVersion).toBe(versionOne);

    const versions = await adminCall("/admin/config/versions?limit=10", "GET");
    const versionsBody = (await versions.json()) as {
      data: Array<{ version: number; status: string }>;
    };
    expect(versionsBody.data.find((item) => item.version === versionOne)?.status).toBe("published");
  });

  it("校验失败不会破坏当前配置", async () => {
    const a = await adminCall("/admin/combos", "POST", {
      name: "cfg-cycle-a",
      strategy: "fallback",
      nodes: [{ combo: "cfg-cycle-b" }],
    });
    expect(a.status).toBe(201);
    const b = await adminCall("/admin/combos", "POST", {
      name: "cfg-cycle-b",
      strategy: "fallback",
      nodes: [{ combo: "cfg-cycle-a" }],
    });
    expect(b.status).toBe(201);

    const publish = await adminCall("/admin/config/publish", "POST", {});
    expect(publish.status).toBe(400);
    expect((await chat("cfg-v1")).status).toBe(200);

    const combos = await adminCall("/admin/combos", "GET");
    const list = (await combos.json()) as { data: Array<{ id: string; name: string }> };
    for (const combo of list.data.filter((item) => item.name.startsWith("cfg-cycle-"))) {
      await adminCall(`/admin/combos/${combo.id}`, "DELETE");
    }
    const republish = await adminCall("/admin/config/publish", "POST", {});
    expect([200, 201]).toContain(republish.status);
  });
});
