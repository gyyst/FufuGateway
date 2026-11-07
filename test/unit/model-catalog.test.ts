import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderRecord } from "../../src/config/types";
import type { FetchLike } from "../../src/providers/types";
import {
  MODEL_CATALOG_KV_KEY,
  clearModelCatalogCache,
  contextFromModelId,
  findCatalogModel,
  loadModelsDevCatalog,
  normalizeModelId,
  parseCatalogPayload,
  providerCatalogIds,
} from "../../src/models/catalog";

function provider(baseUrl: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "prv_test",
    name: "custom",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl,
    enabled: true,
    priority: 100,
    weight: 1,
    customHeaders: {},
    timeoutMs: 60_000,
    firstTokenTimeoutMs: 20_000,
    idleTimeoutMs: 60_000,
    maxRetries: 0,
    retry: null,
    proxyConfig: null,
    extraConfig: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function model(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, name: id.toUpperCase(), ...overrides };
}

const catalogPayload = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.4": model("gpt-5.4", {
        name: "GPT-5.4",
        tool_call: true,
        structured_output: true,
        reasoning: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 2.5, output: 10, cache_read: 0.25 },
      }),
      "gpt-image-1": model("gpt-image-1", {
        modalities: { input: ["text", "image"], output: ["image"] },
        limit: { context: 32_000, output: 8_000 },
      }),
    },
  },
  zai: {
    id: "zai",
    name: "Z.AI",
    models: {
      "glm-5.3-flash": model("glm-5.3-flash", {
        name: "GLM-5.3-Flash",
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_048_576, output: 131_072 },
        cost: { input: 0.12, output: 0.42 },
      }),
    },
  },
  volcengine: {
    id: "volcengine",
    name: "Volcengine Ark",
    models: {
      "doubao-seed-1-8-251228": model("doubao-seed-1-8-251228", {
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 256_000, output: 64_000 },
      }),
    },
  },
  alpha: {
    id: "alpha",
    name: "Alpha",
    models: { "shared-model": model("shared-model", { limit: { context: 1_000, output: 100 } }) },
  },
  beta: {
    id: "beta",
    name: "Beta",
    models: { "shared-model": model("shared-model", { limit: { context: 1_000, output: 100 } }) },
  },
  gamma: {
    id: "gamma",
    name: "Gamma",
    models: { "shared-model": model("shared-model", { limit: { context: 2_000, output: 200 } }) },
  },
};

function fakeKv(initial?: Record<string, string>): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map(Object.entries(initial ?? {}));
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function fakeFetch(payload: unknown, status = 200): { fetchImpl: FetchLike; calls: () => number } {
  let count = 0;
  const fetchImpl: FetchLike = async () => {
    count += 1;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls: () => count };
}

beforeEach(() => {
  clearModelCatalogCache();
});

describe("models.dev 目录解析", () => {
  it("提取上下文、模态、能力与价格", () => {
    const catalog = parseCatalogPayload(catalogPayload, 1_000);
    expect(catalog).toBeDefined();
    const entry = catalog?.providers["openai"]?.models["gpt-5.4"];
    expect(entry?.displayName).toBe("GPT-5.4");
    expect(entry?.contextWindow).toBe(400_000);
    expect(entry?.maxOutputTokens).toBe(128_000);
    expect(entry?.inputModalities).toEqual(["text", "image", "file"]);
    expect(entry?.outputModalities).toEqual(["text"]);
    expect(entry?.supportsTools).toBe(true);
    expect(entry?.supportsJsonSchema).toBe(true);
    expect(entry?.supportsReasoning).toBe(true);
    expect(entry?.supportsPromptCache).toBe(true);
    expect(entry?.pricing).toMatchObject({ inputPrice: 2.5, outputPrice: 10, cachedInputPrice: 0.25 });
  });

  it("非法目录负载返回 undefined", () => {
    expect(parseCatalogPayload(null, 0)).toBeUndefined();
    expect(parseCatalogPayload({ foo: "bar" }, 0)).toBeUndefined();
    expect(parseCatalogPayload({ openai: { models: {} } }, 0)).toBeUndefined();
  });
});

describe("模型 ID 归一化", () => {
  it.each([
    ["openai/gpt-5.4", "gpt-5-4"],
    ["GLM-5.3-Flash", "glm-5-3-flash"],
    ["glm-5-3-flash-260828", "glm-5-3-flash"],
    ["kimi-k3.1-pro-20260801", "kimi-k3-1-pro"],
    ["claude-opus-5[1m]", "claude-opus-5"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });

  it("解析末尾窗口标记", () => {
    expect(contextFromModelId("claude-opus-5[1m]")).toBe(1_000_000);
    expect(contextFromModelId("model[200k]")).toBe(200_000);
    expect(contextFromModelId("model[1.5m]")).toBe(1_500_000);
    expect(contextFromModelId("model[fast]")).toBeUndefined();
    expect(contextFromModelId("model")).toBeUndefined();
  });
});

describe("Provider 匹配", () => {
  it("按 Base URL 主机映射", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    expect(providerCatalogIds(provider("https://api.openai.com/v1"), catalog)).toContain("openai");
    expect(
      providerCatalogIds(provider("https://ark.cn-beijing.volces.com/api/v3"), catalog),
    ).toContain("volcengine");
    expect(providerCatalogIds(provider("https://api.z.ai/api/paas/v4"), catalog)).toContain("zai");
  });

  it("extraConfig.modelsDevProvider 优先于主机映射", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    const ids = providerCatalogIds(
      provider("https://api.openai.com/v1", { extraConfig: { modelsDevProvider: "zai" } }),
      catalog,
    );
    expect(ids[0]).toBe("zai");
  });

  it("按 Provider 名称匹配", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    expect(providerCatalogIds(provider("https://relay.test/v1", { name: "Z.AI" }), catalog)).toContain(
      "zai",
    );
  });
});

describe("模型匹配", () => {
  it("Provider 内精确匹配优先", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    const match = findCatalogModel(catalog, provider("https://api.openai.com/v1"), "gpt-5.4");
    expect(match?.method).toBe("provider-exact");
    expect(match?.providerId).toBe("openai");
    expect(match?.model.contextWindow).toBe(400_000);
  });

  it("支持厂商前缀与点/横线差异", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    expect(
      findCatalogModel(catalog, provider("https://api.z.ai/api/paas/v4"), "zai/GLM-5.3-Flash")?.model
        .contextWindow,
    ).toBe(1_048_576);
    expect(
      findCatalogModel(catalog, provider("https://api.z.ai/api/paas/v4"), "glm-5-3-flash-260828")
        ?.model.contextWindow,
    ).toBe(1_048_576);
  });

  it("自定义端点跨 Provider 匹配并取多数值", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    const match = findCatalogModel(catalog, provider("https://relay.test/v1"), "shared-model");
    expect(match?.method).toBe("global-exact");
    expect(match?.model.contextWindow).toBe(1_000);
    expect(match?.model.pricing).toBeUndefined();
  });

  it("无法匹配时返回 undefined", () => {
    const catalog = parseCatalogPayload(catalogPayload, 0);
    expect(catalog).toBeDefined();
    if (catalog === undefined) return;
    expect(findCatalogModel(catalog, provider("https://relay.test/v1"), "unknown-model")).toBeUndefined();
  });
});

describe("目录缓存", () => {
  it("首次下载后使用 KV 与内存缓存", async () => {
    const { kv, store } = fakeKv();
    const remote = fakeFetch(catalogPayload);
    const first = await loadModelsDevCatalog({ kv, fetchImpl: remote.fetchImpl, now: 1_000 });
    expect(first.status).toBe("ok");
    expect(remote.calls()).toBe(1);
    expect(store.has(MODEL_CATALOG_KV_KEY)).toBe(true);

    const second = await loadModelsDevCatalog({ kv, fetchImpl: remote.fetchImpl, now: 2_000 });
    expect(second.status).toBe("ok");
    expect(remote.calls()).toBe(1);

    clearModelCatalogCache();
    const third = await loadModelsDevCatalog({ kv, fetchImpl: remote.fetchImpl, now: 3_000 });
    expect(third.status).toBe("ok");
    expect(remote.calls()).toBe(1);
  });

  it("KV 缓存过期后重新下载", async () => {
    const { kv } = fakeKv();
    const remote = fakeFetch(catalogPayload);
    await loadModelsDevCatalog({ kv, fetchImpl: remote.fetchImpl, now: 1_000 });
    clearModelCatalogCache();
    const refreshed = await loadModelsDevCatalog({
      kv,
      fetchImpl: remote.fetchImpl,
      now: 1_000 + 25 * 60 * 60 * 1000,
    });
    expect(refreshed.status).toBe("ok");
    expect(remote.calls()).toBe(2);
  });

  it("远端失败时使用过期缓存", async () => {
    const { kv } = fakeKv();
    const initial = fakeFetch(catalogPayload);
    await loadModelsDevCatalog({ kv, fetchImpl: initial.fetchImpl, now: 1_000 });
    clearModelCatalogCache();

    const failing: FetchLike = async () => new Response("boom", { status: 500 });
    const stale = await loadModelsDevCatalog({
      kv,
      fetchImpl: failing,
      now: 1_000 + 25 * 60 * 60 * 1000,
    });
    expect(stale.status).toBe("stale");
    expect(stale.catalog.providers["openai"]).toBeDefined();
  });

  it("无缓存且远端失败时返回 unavailable", async () => {
    const { kv } = fakeKv();
    const failing: FetchLike = async () => {
      throw new Error("network down");
    };
    const result = await loadModelsDevCatalog({ kv, fetchImpl: failing, now: 1_000 });
    expect(result.status).toBe("unavailable");
    expect(result.catalog.providers).toEqual({});
  });

  it("并发加载只下载一次", async () => {
    const { kv } = fakeKv();
    const remote = fakeFetch(catalogPayload);
    const results = await Promise.all([
      loadModelsDevCatalog({ kv, fetchImpl: remote.fetchImpl, now: 1_000 }),
      loadModelsDevCatalog({ kv, fetchImpl: remote.fetchImpl, now: 1_000 }),
    ]);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(remote.calls()).toBe(1);
  });
});
