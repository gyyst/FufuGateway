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

async function configStatus(): Promise<ConfigStatusBody> {
  const response = await adminCall("/admin/config/current", "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ConfigStatusBody }).data;
}

async function listModelIds(): Promise<string[]> {
  const response = await adminCall("/admin/models", "GET");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<{ modelId: string }> };
  return body.data.map((model) => model.modelId);
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

  // 兼容入口：配置已由写入自动发布，手动 publish 应返回 unchanged。
  const publish = await adminCall("/admin/config/publish", "POST", { note: "v1" });
  expect([200, 201]).toContain(publish.status);

  const current = await configStatus();
  expect(current.activeVersion).not.toBeNull();
  expect(current.pendingChanges).toBe(false);
  versionOne = current.activeVersion ?? 0;
});

describe("配置版本与回滚", () => {
  it("新增模型后无需手动发布即可推理", async () => {
    const created = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "cfg-v2",
      upstreamModelId: "cfg-up",
      supportsStream: true,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { config: ConfigOutcome };
    expect(createdBody.config.applied).toBe(true);
    expect(createdBody.config.unchanged).toBe(false);
    expect(createdBody.config.version ?? 0).toBeGreaterThan(versionOne);

    const current = await configStatus();
    expect(current.activeVersion).toBe(createdBody.config.version);
    expect(current.pendingChanges).toBe(false);

    expect((await chat("cfg-v2")).status).toBe(200);
    expect((await chat("cfg-v1")).status).toBe(200);
  });

  it("回滚恢复 D1，被回滚的模型不会在后续保存后复活", async () => {
    const beforeRollback = await configStatus();
    const versionTwo = beforeRollback.activeVersion ?? 0;
    expect(versionTwo).toBeGreaterThan(versionOne);
    expect(await listModelIds()).toContain("cfg-v2");

    const rollback = await adminCall("/admin/config/rollback", "POST", { version: versionOne });
    expect(rollback.status).toBe(200);
    const rollbackBody = (await rollback.json()) as { data: { version: number; unchanged: boolean } };
    expect(rollbackBody.data.version).toBe(versionOne);
    expect(rollbackBody.data.unchanged).toBe(false);

    // 恢复的 D1 数据必须与目标版本 checksum 一致，后续保存才不会撤销回滚。
    const afterRollback = await configStatus();
    expect(afterRollback.activeVersion).toBe(versionOne);
    expect(afterRollback.pendingChanges).toBe(false);
    expect(afterRollback.validation?.valid).toBe(true);

    expect((await chat("cfg-v2")).status).toBe(404);
    expect((await chat("cfg-v1")).status).toBe(200);
    expect(await listModelIds()).not.toContain("cfg-v2");

    const versions = await adminCall("/admin/config/versions?limit=20", "GET");
    const versionRows = ((await versions.json()) as { data: Array<{ version: number; status: string }> }).data;
    expect(versionRows.find((row) => row.version === versionOne)?.status).toBe("published");
    expect(versionRows.find((row) => row.version === versionTwo)?.status).toBe("rolled_back");

    // 回滚后的保存基于恢复的 D1 自动发布，不会复活被回滚掉的模型。
    const created = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "cfg-v3",
      upstreamModelId: "cfg-up",
      supportsStream: true,
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { config: ConfigOutcome };
    expect(createdBody.config.applied).toBe(true);

    const modelIds = await listModelIds();
    expect(modelIds).toContain("cfg-v3");
    expect(modelIds).not.toContain("cfg-v2");
    expect((await chat("cfg-v3")).status).toBe(200);
    expect((await chat("cfg-v2")).status).toBe(404);
  });

  it("非法组合保存成功但不生效，删除后自动收敛", async () => {
    const a = await adminCall("/admin/combos", "POST", {
      name: "cfg-cycle-a",
      strategy: "fallback",
      nodes: [{ combo: "cfg-cycle-b" }],
    });
    expect(a.status).toBe(201);
    const aBody = (await a.json()) as { data: { id: string }; config: ConfigOutcome };
    expect(aBody.config.applied).toBe(false);
    expect(aBody.config.issues.some((issue) => issue.severity === "error")).toBe(true);
    expect(aBody.config.version).toBeGreaterThan(0);

    const b = await adminCall("/admin/combos", "POST", {
      name: "cfg-cycle-b",
      strategy: "fallback",
      nodes: [{ combo: "cfg-cycle-a" }],
    });
    expect(b.status).toBe(201);
    const bBody = (await b.json()) as { data: { id: string }; config: ConfigOutcome };
    expect(bBody.config.applied).toBe(false);
    expect(bBody.config.issues.some((issue) => issue.code === "COMBO_CYCLE_DETECTED")).toBe(true);

    const publish = await adminCall("/admin/config/publish", "POST", {});
    expect(publish.status).toBe(400);
    expect((await chat("cfg-v1")).status).toBe(200);

    // 删除第一个组合后仍然非法，删除第二个后自动发布并收敛。
    const deleteA = await adminCall(`/admin/combos/${aBody.data.id}`, "DELETE");
    expect(deleteA.status).toBe(200);
    expect(((await deleteA.json()) as { config: ConfigOutcome }).config.applied).toBe(false);

    const deleteB = await adminCall(`/admin/combos/${bBody.data.id}`, "DELETE");
    expect(deleteB.status).toBe(200);
    expect(((await deleteB.json()) as { config: ConfigOutcome }).config.applied).toBe(true);

    const republish = await adminCall("/admin/config/publish", "POST", {});
    expect([200, 201]).toContain(republish.status);
    const republishBody = (await republish.json()) as { data: { unchanged: boolean } };
    expect(republishBody.data.unchanged).toBe(true);

    const current = await configStatus();
    expect(current.pendingChanges).toBe(false);
    expect(current.validation?.valid).toBe(true);
  });
});
