import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { loadConfigData } from "../../src/config/repository";
import { computeChecksum } from "../../src/config/runtime";
import type { ConfigSnapshotData, RuntimeSettings } from "../../src/config/types";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";

const fetchImpl: FetchLike = async () => new Response("unexpected upstream call", { status: 500 });

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

interface ConfigOutcome {
  applied: boolean;
  unchanged: boolean;
  version: number | null;
}

interface ConfigStatusBody {
  activeVersion: number | null;
  pendingChanges: boolean;
  validation: { valid: boolean } | null;
}

async function configStatus(): Promise<ConfigStatusBody> {
  const response = await adminCall("/admin/config/current", "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ConfigStatusBody }).data;
}

async function settings(): Promise<Record<string, unknown>> {
  const response = await adminCall("/admin/settings", "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

async function ids(path: string): Promise<string[]> {
  const response = await adminCall(path, "GET");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  return body.data.map((row) => row.id);
}

async function modelIds(): Promise<string[]> {
  const response = await adminCall("/admin/models", "GET");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<{ modelId: string }> };
  return body.data.map((row) => row.modelId);
}

beforeAll(async () => {
  // 数据由各测试自建，确保数据库已初始化。
  await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
});

describe("回滚恢复 D1", () => {
  it("重建六类配置表后 checksum 与目标版本一致，后续保存不撤销回滚", async () => {
    const providerResponse = await adminCall("/admin/providers", "POST", {
      name: "rbk",
      type: "OPENAI_COMPATIBLE",
      protocol: "openai-chat",
      baseUrl: "https://rbk.test/v1",
      maxRetries: 0,
    });
    expect(providerResponse.status).toBe(201);
    const providerId = ((await providerResponse.json()) as { data: { id: string } }).data.id;

    const accountResponse = await adminCall(`/admin/providers/${providerId}/accounts`, "POST", {
      name: "primary",
      apiKey: "rbk-upstream-key",
    });
    expect(accountResponse.status).toBe(201);

    const modelResponse = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "rbk-model",
      upstreamModelId: "rbk-upstream",
      supportsStream: true,
    });
    expect(modelResponse.status).toBe(201);

    const comboResponse = await adminCall("/admin/combos", "POST", {
      name: "rbk-combo",
      strategy: "fallback",
      nodes: ["rbk-model"],
    });
    expect(comboResponse.status).toBe(201);
    const comboId = ((await comboResponse.json()) as { data: { id: string } }).data.id;

    const pricingResponse = await adminCall("/admin/pricing", "POST", {
      providerId,
      modelId: "rbk-model",
      inputPrice: 1,
      outputPrice: 2,
    });
    expect(pricingResponse.status).toBe(201);
    const pricingId = ((await pricingResponse.json()) as { data: { id: string } }).data.id;

    const target = await configStatus();
    expect(target.activeVersion).not.toBeNull();
    const targetVersion = target.activeVersion ?? 0;
    const originalGatewayName = (await settings())["gateway.name"];

    // 在目标版本之后制造分叉：修改设置，并删除 Combo 与价格记录。
    const settingUpdate = await adminCall("/admin/settings", "PUT", {
      "gateway.name": "Rollback Diverged",
    });
    expect(settingUpdate.status).toBe(200);
    expect(((await settingUpdate.json()) as { config: ConfigOutcome }).config.applied).toBe(true);

    const comboDelete = await adminCall(`/admin/combos/${comboId}`, "DELETE");
    expect(comboDelete.status).toBe(200);
    expect(((await comboDelete.json()) as { config: ConfigOutcome }).config.applied).toBe(true);

    const pricingDelete = await adminCall(`/admin/pricing/${pricingId}`, "DELETE");
    expect(pricingDelete.status).toBe(200);
    expect(((await pricingDelete.json()) as { config: ConfigOutcome }).config.applied).toBe(true);

    expect((await settings())["gateway.name"]).toBe("Rollback Diverged");
    expect(await ids("/admin/combos")).not.toContain(comboId);
    expect(await ids("/admin/pricing")).not.toContain(pricingId);

    const rollback = await adminCall("/admin/config/rollback", "POST", { version: targetVersion });
    expect(rollback.status).toBe(200);
    const rollbackBody = (await rollback.json()) as {
      data: { version: number; unchanged: boolean };
    };
    expect(rollbackBody.data.version).toBe(targetVersion);
    expect(rollbackBody.data.unchanged).toBe(false);

    // checksum 一致说明六类数据全部按快照恢复；否则 pendingChanges 会为 true。
    const restored = await configStatus();
    expect(restored.activeVersion).toBe(targetVersion);
    expect(restored.pendingChanges).toBe(false);
    expect(restored.validation?.valid).toBe(true);

    expect((await settings())["gateway.name"]).toBe(originalGatewayName);
    expect(await ids("/admin/combos")).toContain(comboId);
    expect(await ids("/admin/pricing")).toContain(pricingId);
    expect(await modelIds()).toContain("rbk-model");

    // 回滚后的保存基于恢复的 D1，不会复活被回滚掉的分叉数据。
    const nextModel = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "rbk-model-2",
      upstreamModelId: "rbk-upstream-2",
      supportsStream: true,
    });
    expect(nextModel.status).toBe(201);
    const nextBody = (await nextModel.json()) as { config: ConfigOutcome };
    expect(nextBody.config.applied).toBe(true);

    expect((await settings())["gateway.name"]).toBe(originalGatewayName);
    expect(await ids("/admin/combos")).toContain(comboId);
    expect(await ids("/admin/pricing")).toContain(pricingId);
    expect(await modelIds()).toEqual(expect.arrayContaining(["rbk-model", "rbk-model-2"]));

    // 回滚到当前生效版本是幂等的：仍会以快照重建 D1，并返回 unchanged。
    const activeVersion = nextBody.config.version;
    const noopRollback = await adminCall("/admin/config/rollback", "POST", {
      version: activeVersion,
    });
    expect(noopRollback.status).toBe(200);
    const noopBody = (await noopRollback.json()) as { data: { version: number; unchanged: boolean } };
    expect(noopBody.data.version).toBe(activeVersion);
    expect(noopBody.data.unchanged).toBe(true);
    const afterNoop = await configStatus();
    expect(afterNoop.activeVersion).toBe(activeVersion);
    expect(afterNoop.pendingChanges).toBe(false);
  });

  it("拒绝包含旧版 aliases 或 wildcards 的配置回滚", async () => {
    const before = await configStatus();
    const modelIdsBefore = await modelIds();
    const legacyVersion = 900;
    const payload = JSON.stringify({
      version: legacyVersion,
      checksum: "legacy",
      createdAt: Date.now(),
      data: {
        providers: [],
        accounts: [],
        models: [],
        combos: [],
        pricing: [],
        settings: {},
        aliases: [
          {
            id: "als_legacy",
            name: "legacy-alias",
            target: "legacy-target",
            enabled: true,
            priority: 100,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        wildcards: [],
      },
    });
    await env.DB.prepare(
      `INSERT OR REPLACE INTO config_versions
        (version, checksum, payload, status, note, created_by, created_at)
       VALUES (?, ?, ?, 'superseded', 'legacy-fixture', 'test', ?)`,
    )
      .bind(legacyVersion, "legacy", payload, Date.now())
      .run();

    const rollback = await adminCall("/admin/config/rollback", "POST", { version: legacyVersion });
    expect(rollback.status).toBe(400);
    const body = (await rollback.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONFIG_INVALID");

    const after = await configStatus();
    expect(after.activeVersion).toBe(before.activeVersion);
    expect(after.pendingChanges).toBe(before.pendingChanges);
    expect(await modelIds()).toEqual(modelIdsBefore);
  });

  it("旧快照缺少设置字段时使用默认值补齐", async () => {
    const data = await loadConfigData(env.DB);
    const legacySettings = { ...data.settings } as Partial<RuntimeSettings>;
    delete legacySettings.configCacheTtlMs;
    const legacyData = { ...data, settings: legacySettings as RuntimeSettings };
    const checksum = await computeChecksum(legacyData as ConfigSnapshotData);
    const legacyVersion = 901;
    const payload = JSON.stringify({
      version: legacyVersion,
      checksum,
      createdAt: Date.now(),
      data: legacyData,
    });
    await env.DB.prepare(
      `INSERT OR REPLACE INTO config_versions
        (version, checksum, payload, status, note, created_by, created_at)
       VALUES (?, ?, ?, 'superseded', 'legacy-settings-fixture', 'test', ?)`,
    )
      .bind(legacyVersion, checksum, payload, Date.now())
      .run();

    const rollback = await adminCall("/admin/config/rollback", "POST", { version: legacyVersion });
    expect(rollback.status).toBe(200);

    const restored = await settings();
    expect(restored["config.cache_ttl_ms"]).toBe(60000);
    expect((await configStatus()).activeVersion).toBe(legacyVersion);
  });
});
