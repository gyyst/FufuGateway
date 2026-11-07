import { describe, expect, it } from "vitest";
import type { ModelRecord, ProviderRecord } from "../../src/config/types";
import { defaultCapabilities } from "../../src/ir/request";
import type { CatalogModel } from "../../src/models/catalog";
import {
  applyMetadataToModel,
  buildModelMetadata,
  shouldAutoEnable,
} from "../../src/models/metadata";

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "prv_test",
    name: "openai",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
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

function model(overrides: Partial<ModelRecord> = {}): ModelRecord {
  return {
    id: "mdl_test",
    providerId: "prv_test",
    modelId: "gpt-test",
    upstreamModelId: "gpt-test",
    inputModalities: ["text"],
    outputModalities: ["text"],
    capabilities: defaultCapabilities({ supportsStream: false }),
    pricing: { inputPrice: 0, outputPrice: 0, currency: "USD", unit: "per_million_tokens" },
    enabled: false,
    source: "sync",
    metadataSource: "unknown",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

const catalogModel: CatalogModel = {
  id: "gpt-test",
  displayName: "GPT Test",
  contextWindow: 400_000,
  maxOutputTokens: 128_000,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportsTools: true,
  supportsJsonSchema: true,
  supportsReasoning: true,
  supportsPromptCache: true,
  pricing: { inputPrice: 2.5, outputPrice: 10, cachedInputPrice: 0.25 },
};

describe("元数据合并", () => {
  it("仅上游字段时来源为 upstream 并识别", () => {
    const metadata = buildModelMetadata({
      live: {
        id: "gpt-test",
        contextWindow: 1_000,
        inputModalities: ["text", "image"],
        supportsTools: true,
        pricing: { inputPrice: 1 },
      },
      catalogMatched: false,
      modelId: "gpt-test",
    });
    expect(metadata.source).toBe("upstream");
    expect(metadata.recognized).toBe(true);
    expect(metadata.contextWindow).toBe(1_000);
    expect(metadata.supportsVision).toBe(true);
    expect(metadata.supportsTools).toBe(true);
    expect(metadata.supportsStream).toBe(true);
    expect(metadata.pricing.inputPrice).toBe(1);
  });

  it("目录字段补齐缺失值", () => {
    const metadata = buildModelMetadata({
      catalog: catalogModel,
      catalogMatched: true,
      modelId: "gpt-test",
    });
    expect(metadata.source).toBe("models.dev");
    expect(metadata.displayName).toBe("GPT Test");
    expect(metadata.contextWindow).toBe(400_000);
    expect(metadata.maxOutputTokens).toBe(128_000);
    expect(metadata.inputModalities).toEqual(["text", "image"]);
    expect(metadata.supportsVision).toBe(true);
    expect(metadata.supportsAudio).toBe(false);
    expect(metadata.supportsTools).toBe(true);
    expect(metadata.supportsJsonSchema).toBe(true);
    expect(metadata.supportsReasoning).toBe(true);
    expect(metadata.supportsPromptCache).toBe(true);
    expect(metadata.pricing.inputPrice).toBe(2.5);
    expect(metadata.pricing.cachedInputPrice).toBe(0.25);
  });

  it("上游显式值优先于目录", () => {
    const metadata = buildModelMetadata({
      live: {
        id: "gpt-test",
        contextWindow: 1_000,
        inputModalities: ["text"],
        supportsTools: false,
        supportsVision: false,
      },
      catalog: catalogModel,
      catalogMatched: true,
      modelId: "gpt-test",
    });
    expect(metadata.contextWindow).toBe(1_000);
    expect(metadata.inputModalities).toEqual(["text"]);
    expect(metadata.supportsVision).toBe(false);
    expect(metadata.supportsTools).toBe(false);
    expect(metadata.maxOutputTokens).toBe(128_000);
  });

  it("从模型 ID 的窗口标记兜底", () => {
    const metadata = buildModelMetadata({ catalogMatched: false, modelId: "claude-opus-5[1m]" });
    expect(metadata.contextWindow).toBe(1_000_000);
    expect(metadata.source).toBe("unknown");
    expect(metadata.recognized).toBe(false);
  });

  it("无法识别时能力为空且不自动启用", () => {
    const metadata = buildModelMetadata({ catalogMatched: false, modelId: "unknown-model" });
    expect(metadata.recognized).toBe(false);
    expect(metadata.source).toBe("unknown");
    expect(metadata.supportsStream).toBe(false);
    expect(shouldAutoEnable(metadata, provider())).toBe(false);
  });
});

describe("自动启用", () => {
  it("识别到的文本模型自动启用", () => {
    const metadata = buildModelMetadata({
      catalog: catalogModel,
      catalogMatched: true,
      modelId: "gpt-test",
    });
    expect(shouldAutoEnable(metadata, provider())).toBe(true);
  });

  it("纯图像输出不自动启用", () => {
    const metadata = buildModelMetadata({
      catalog: { ...catalogModel, outputModalities: ["image"] },
      catalogMatched: true,
      modelId: "gpt-image-1",
    });
    expect(metadata.supportsStream).toBe(false);
    expect(shouldAutoEnable(metadata, provider())).toBe(false);
  });

  it("syncAutoEnable=false 时保持禁用", () => {
    const metadata = buildModelMetadata({
      catalog: catalogModel,
      catalogMatched: true,
      modelId: "gpt-test",
    });
    expect(shouldAutoEnable(metadata, provider({ extraConfig: { syncAutoEnable: false } }))).toBe(false);
  });
});

describe("存量模型刷新", () => {
  const metadata = buildModelMetadata({
    catalog: catalogModel,
    catalogMatched: true,
    modelId: "gpt-test",
  });

  it("只补空缺并保持 enabled 不变", () => {
    const original = model();
    const result = applyMetadataToModel(original, metadata, 5_000);
    expect(result.changed).toBe(true);
    expect(result.model.enabled).toBe(false);
    expect(result.model.contextWindow).toBe(400_000);
    expect(result.model.maxOutputTokens).toBe(128_000);
    expect(result.model.inputModalities).toEqual(["text", "image"]);
    expect(result.model.capabilities.supportsVision).toBe(true);
    expect(result.model.capabilities.supportsTools).toBe(true);
    expect(result.model.capabilities.supportsStream).toBe(true);
    expect(result.model.pricing.inputPrice).toBe(2.5);
    expect(result.model.metadataSource).toBe("models.dev");
    expect(result.model.metadataUpdatedAt).toBe(5_000);
  });

  it("不覆盖已有非空值", () => {
    const original = model({
      contextWindow: 5_000,
      maxOutputTokens: 2_000,
      inputModalities: ["text"],
      capabilities: defaultCapabilities({
        supportsStream: false,
        supportsVision: false,
        supportsTools: false,
      }),
      pricing: { inputPrice: 9, outputPrice: 10, currency: "USD", unit: "per_million_tokens" },
      metadataSource: "upstream",
    });
    const result = applyMetadataToModel(original, metadata, 5_000);
    expect(result.model.contextWindow).toBe(5_000);
    expect(result.model.maxOutputTokens).toBe(2_000);
    expect(result.model.inputModalities).toEqual(["text", "image"]);
    expect(result.model.pricing.inputPrice).toBe(9);
    expect(result.model.pricing.outputPrice).toBe(10);
    expect(result.model.capabilities.supportsVision).toBe(true);
    expect(result.model.capabilities.supportsTools).toBe(true);
    expect(result.model.metadataSource).toBe("models.dev");
  });

  it("输入/输出价格只要有一个非零就完全不改价格", () => {
    const original = model({
      pricing: { inputPrice: 0, outputPrice: 7, currency: "USD", unit: "per_million_tokens" },
    });
    const result = applyMetadataToModel(original, metadata, 5_000);
    expect(result.model.pricing.inputPrice).toBe(0);
    expect(result.model.pricing.outputPrice).toBe(7);
    expect(result.model.pricing.cachedInputPrice).toBeUndefined();
  });

  it("manual 来源跳过", () => {
    const original = model({ metadataSource: "manual" });
    const result = applyMetadataToModel(original, metadata, 5_000);
    expect(result.changed).toBe(false);
    expect(result.model).toBe(original);
  });

  it("已填充完整时保持不变", () => {
    const original = model({
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      inputModalities: ["text", "image"],
      capabilities: defaultCapabilities({
        inputModalities: ["text", "image"],
        supportsStream: true,
        supportsTools: true,
        supportsJsonSchema: true,
        supportsReasoning: true,
        supportsVision: true,
        supportsPromptCache: true,
      }),
      pricing: {
        inputPrice: 2.5,
        outputPrice: 10,
        cachedInputPrice: 0.25,
        currency: "USD",
        unit: "per_million_tokens",
      },
      displayName: "GPT Test",
      metadataSource: "models.dev",
    });
    const result = applyMetadataToModel(original, metadata, 5_000);
    expect(result.changed).toBe(false);
    expect(result.model).toBe(original);
  });

  it("来源只升级不降级", () => {
    const result = applyMetadataToModel(
      model({ metadataSource: "models.dev" }),
      { ...metadata, source: "upstream" },
      5_000,
    );
    expect(result.model.metadataSource).toBe("models.dev");
  });
});
