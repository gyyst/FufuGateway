import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { clearModelCatalogCache, MODEL_CATALOG_KV_KEY } from "../../src/models/catalog";
import type { FetchLike } from "../../src/providers/types";

const ADMIN_TOKEN = "test-admin-token";
const UPSTREAM_KEY = "upstream-test-key";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const modelsDevPayload = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        tool_call: true,
        structured_output: true,
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 2.5, output: 10, cache_read: 0.25 },
      },
      "gpt-image-1": {
        id: "gpt-image-1",
        name: "GPT Image 1",
        modalities: { input: ["text", "image"], output: ["image"] },
        limit: { context: 32_000, output: 8_000 },
      },
    },
  },
};

let upstreamModels: unknown[] = [];
let catalogStatus = 200;
let catalogBody: unknown = modelsDevPayload;
let modelsDevCalls = 0;

const fetchImpl: FetchLike = async (input, init) => {
  const request =
    input instanceof Request
      ? input
      : new Request(typeof input === "string" ? input : input.toString(), init);
  const url = new URL(request.url);
  if (url.hostname === "models.dev") {
    modelsDevCalls += 1;
    return catalogStatus === 200 ? json(catalogBody) : new Response("down", { status: catalogStatus });
  }
  if (url.pathname.endsWith("/models")) return json({ object: "list", data: upstreamModels });
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

let sequence = 0;

async function createProviderWithAccount(): Promise<string> {
  sequence += 1;
  const created = await adminCall("/admin/providers", "POST", {
    name: `metadata${sequence}`,
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    maxRetries: 0,
  });
  expect(created.status).toBe(201);
  const provider = (await created.json()) as { data: { id: string } };
  const account = await adminCall(`/admin/providers/${provider.data.id}/accounts`, "POST", {
    name: "primary",
    apiKey: UPSTREAM_KEY,
  });
  expect(account.status).toBe(201);
  return provider.data.id;
}

interface ModelRow {
  id: string;
  modelId: string;
  enabled: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  metadataSource?: string;
  pricing: { inputPrice: number; outputPrice: number; cachedInputPrice?: number };
  capabilities: {
    inputModalities: string[];
    outputModalities: string[];
    supportsStream: boolean;
    supportsTools: boolean;
    supportsJsonSchema: boolean;
    supportsReasoning: boolean;
    supportsVision: boolean;
    supportsPromptCache: boolean;
  };
}

async function listModels(providerId: string): Promise<ModelRow[]> {
  const response = await adminCall(`/admin/models?providerId=${providerId}`, "GET");
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ModelRow[] }).data;
}

beforeEach(async () => {
  clearModelCatalogCache();
  await env.CONFIG_KV.delete(MODEL_CATALOG_KV_KEY);
  modelsDevCalls = 0;
  upstreamModels = [];
  catalogStatus = 200;
  catalogBody = modelsDevPayload;
});

describe("模型同步元数据自动识别", () => {
  it("自动填充上下文、图像、能力与价格，并只启用文本模型", async () => {
    const providerId = await createProviderWithAccount();
    upstreamModels = [{ id: "gpt-5.4" }, { id: "unknown-model" }, { id: "gpt-image-1" }];

    const response = await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      created: number;
      autoEnabled: number;
      requiresConfirmation: boolean;
      metadata: { catalog: string; modelsDevMatched: number; unknown: number };
    };
    expect(body.created).toBe(3);
    expect(body.autoEnabled).toBe(1);
    expect(body.requiresConfirmation).toBe(true);
    expect(body.metadata.catalog).toBe("ok");
    expect(body.metadata.modelsDevMatched).toBe(2);
    expect(body.metadata.unknown).toBe(1);

    const models = await listModels(providerId);
    const matched = models.find((model) => model.modelId === "gpt-5.4");
    expect(matched?.enabled).toBe(true);
    expect(matched?.contextWindow).toBe(400_000);
    expect(matched?.maxOutputTokens).toBe(128_000);
    expect(matched?.metadataSource).toBe("models.dev");
    expect(matched?.pricing).toMatchObject({
      inputPrice: 2.5,
      outputPrice: 10,
      cachedInputPrice: 0.25,
    });
    expect(matched?.capabilities.inputModalities).toEqual(["text", "image"]);
    expect(matched?.capabilities.outputModalities).toEqual(["text"]);
    expect(matched?.capabilities.supportsStream).toBe(true);
    expect(matched?.capabilities.supportsTools).toBe(true);
    expect(matched?.capabilities.supportsJsonSchema).toBe(true);
    expect(matched?.capabilities.supportsReasoning).toBe(true);
    expect(matched?.capabilities.supportsVision).toBe(true);
    expect(matched?.capabilities.supportsPromptCache).toBe(true);

    const unknown = models.find((model) => model.modelId === "unknown-model");
    expect(unknown?.enabled).toBe(false);
    expect(unknown?.metadataSource).toBe("unknown");
    expect(unknown?.contextWindow).toBeUndefined();
    expect(unknown?.capabilities.supportsStream).toBe(false);
    expect(unknown?.capabilities.supportsTools).toBe(false);
    expect(unknown?.capabilities.supportsVision).toBe(false);

    const image = models.find((model) => model.modelId === "gpt-image-1");
    expect(image?.enabled).toBe(false);
    expect(image?.metadataSource).toBe("models.dev");
    expect(image?.capabilities.outputModalities).toEqual(["image"]);
    expect(image?.capabilities.supportsStream).toBe(false);
  });

  it("第二次同步复用 KV 目录缓存", async () => {
    const providerId = await createProviderWithAccount();
    upstreamModels = [{ id: "gpt-5.4" }];

    await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    expect(modelsDevCalls).toBe(1);

    clearModelCatalogCache();
    const second = await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    expect(second.status).toBe(200);
    expect(modelsDevCalls).toBe(1);
  });

  it("目录不可用时仍使用上游元数据并成功同步", async () => {
    const providerId = await createProviderWithAccount();
    catalogStatus = 500;
    upstreamModels = [
      {
        id: "relay-model",
        context_length: 128_000,
        max_output_tokens: 16_000,
        modalities: { input: ["text", "image"], output: ["text"] },
        supports_tools: true,
      },
    ];

    const response = await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      autoEnabled: number;
      metadata: { catalog: string; upstreamMatched: number };
    };
    expect(body.metadata.catalog).toBe("unavailable");
    expect(body.metadata.upstreamMatched).toBe(1);
    expect(body.autoEnabled).toBe(1);

    const model = (await listModels(providerId)).find((entry) => entry.modelId === "relay-model");
    expect(model?.enabled).toBe(true);
    expect(model?.metadataSource).toBe("upstream");
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.capabilities.supportsVision).toBe(true);
    expect(model?.capabilities.supportsTools).toBe(true);
  });
});

describe("存量模型元数据刷新", () => {
  it("只补空缺且不改变启用状态", async () => {
    const providerId = await createProviderWithAccount();
    const created = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "gpt-5.4",
      upstreamModelId: "gpt-5.4",
      enabled: false,
    });
    expect(created.status).toBe(201);
    const modelId = ((await created.json()) as { data: { id: string } }).data.id;

    await env.DB.prepare(
      `UPDATE models SET metadata_source = 'unknown', context_window = NULL, max_output_tokens = NULL,
         input_modalities = '["text"]', output_modalities = '["text"]',
         supports_stream = 0, supports_tools = 0, supports_json_schema = 0, supports_reasoning = 0,
         supports_vision = 0, supports_prompt_cache = 0, input_price = 0, output_price = 0,
         metadata_updated_at = NULL WHERE id = ?`,
    )
      .bind(modelId)
      .run();

    upstreamModels = [{ id: "gpt-5.4" }];
    const response = await adminCall(`/admin/providers/${providerId}/refresh-model-metadata`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      updated: number;
      skippedManual: number;
      metadata: { catalog: string };
    };
    expect(body.updated).toBe(1);
    expect(body.skippedManual).toBe(0);
    expect(body.metadata.catalog).toBe("ok");

    const model = (await listModels(providerId)).find((entry) => entry.id === modelId);
    expect(model?.enabled).toBe(false);
    expect(model?.contextWindow).toBe(400_000);
    expect(model?.metadataSource).toBe("models.dev");
    expect(model?.capabilities.supportsVision).toBe(true);
    expect(model?.pricing.inputPrice).toBe(2.5);
  });

  it("手工编辑能力后标记 manual 并跳过刷新", async () => {
    const providerId = await createProviderWithAccount();
    upstreamModels = [{ id: "gpt-5.4" }];
    await adminCall(`/admin/providers/${providerId}/sync-models`, "POST");
    const model = (await listModels(providerId)).find((entry) => entry.modelId === "gpt-5.4");
    if (model === undefined) throw new Error("model not found");

    const edited = await adminCall(`/admin/models/${model.id}`, "PUT", { supportsVision: false });
    expect(edited.status).toBe(200);
    const editedBody = (await edited.json()) as { data: { metadataSource: string } };
    expect(editedBody.data.metadataSource).toBe("manual");

    const response = await adminCall(`/admin/providers/${providerId}/refresh-model-metadata`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { updated: number; skippedManual: number };
    expect(body.skippedManual).toBe(1);
    expect(body.updated).toBe(0);

    const after = (await listModels(providerId)).find((entry) => entry.id === model.id);
    expect(after?.metadataSource).toBe("manual");
    expect(after?.capabilities.supportsVision).toBe(false);
  });

  it("无账户时只用目录刷新", async () => {
    const created = await adminCall("/admin/providers", "POST", {
      name: `metadata-no-account-${++sequence}`,
      type: "OPENAI_COMPATIBLE",
      protocol: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      maxRetries: 0,
    });
    expect(created.status).toBe(201);
    const providerId = ((await created.json()) as { data: { id: string } }).data.id;
    const model = await adminCall("/admin/models", "POST", {
      providerId,
      modelId: "gpt-5.4",
      upstreamModelId: "gpt-5.4",
      enabled: false,
    });
    expect(model.status).toBe(201);
    const modelId = ((await model.json()) as { data: { id: string } }).data.id;
    await env.DB.prepare("UPDATE models SET metadata_source = 'unknown' WHERE id = ?")
      .bind(modelId)
      .run();

    const response = await adminCall(`/admin/providers/${providerId}/refresh-model-metadata`, "POST");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { updated: number; warning?: string };
    expect(body.updated).toBe(1);
    expect(body.warning).toContain("no accounts");

    const refreshed = (await listModels(providerId)).find((entry) => entry.id === modelId);
    expect(refreshed?.contextWindow).toBe(400_000);
    expect(refreshed?.metadataSource).toBe("models.dev");
  });
});
