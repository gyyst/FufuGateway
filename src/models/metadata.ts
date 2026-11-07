import type { ModelCapabilities, OutputModality } from "../ir/request";
import type { Modality } from "../ir/common";
import type { ModelMetadataSource, ModelPricing, ModelRecord, ProviderRecord } from "../config/types";
import type { RemoteModel } from "../providers/transport";
import { contextFromModelId, type CatalogModel } from "./catalog";

export interface BuiltModelMetadata {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities: Modality[];
  outputModalities: OutputModality[];
  supportsStream: boolean;
  supportsTools: boolean;
  supportsParallelTools: boolean;
  supportsJsonSchema: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsPromptCache: boolean;
  pricing: ModelPricing;
  source: Exclude<ModelMetadataSource, "manual">;
  recognized: boolean;
}

function liveHasMetadata(live: RemoteModel | undefined): boolean {
  if (live === undefined) return false;
  return (
    live.contextWindow !== undefined ||
    live.maxOutputTokens !== undefined ||
    live.inputModalities !== undefined ||
    live.outputModalities !== undefined ||
    live.supportsTools !== undefined ||
    live.supportsJsonSchema !== undefined ||
    live.supportsReasoning !== undefined ||
    live.supportsVision !== undefined ||
    (live.pricing !== undefined && Object.keys(live.pricing).length > 0)
  );
}

function sameList<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique<T>(values: T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** 合并上游实时字段与 models.dev 目录字段，上游优先。 */
export function buildModelMetadata(args: {
  live?: RemoteModel;
  catalog?: CatalogModel;
  catalogMatched: boolean;
  modelId: string;
}): BuiltModelMetadata {
  const { live, catalog, catalogMatched, modelId } = args;
  const inputModalities = unique([
    ...(live?.inputModalities ?? catalog?.inputModalities ?? ["text" as Modality]),
  ]);
  const outputModalities = unique([
    ...(live?.outputModalities ?? catalog?.outputModalities ?? ["text" as OutputModality]),
  ]);

  const supportsVision = live?.supportsVision ?? inputModalities.includes("image");
  if (supportsVision && !inputModalities.includes("image")) inputModalities.push("image");
  const supportsAudio = inputModalities.includes("audio");
  const supportsVideo = inputModalities.includes("video");
  const contextWindow = live?.contextWindow ?? catalog?.contextWindow ?? contextFromModelId(modelId);
  const maxOutputTokens = live?.maxOutputTokens ?? catalog?.maxOutputTokens;

  const pricing: ModelPricing = {
    inputPrice: live?.pricing?.inputPrice ?? catalog?.pricing?.inputPrice ?? 0,
    outputPrice: live?.pricing?.outputPrice ?? catalog?.pricing?.outputPrice ?? 0,
    ...((live?.pricing?.cachedInputPrice ?? catalog?.pricing?.cachedInputPrice) === undefined
      ? {}
      : { cachedInputPrice: live?.pricing?.cachedInputPrice ?? catalog?.pricing?.cachedInputPrice }),
    ...((live?.pricing?.reasoningPrice ?? catalog?.pricing?.reasoningPrice) === undefined
      ? {}
      : { reasoningPrice: live?.pricing?.reasoningPrice ?? catalog?.pricing?.reasoningPrice }),
    currency: "USD",
    unit: "per_million_tokens",
  };

  const recognized = catalogMatched || liveHasMetadata(live);
  const displayName = live?.displayName ?? catalog?.displayName;
  return {
    ...(displayName === undefined ? {} : { displayName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    inputModalities,
    outputModalities,
    supportsStream: recognized && (outputModalities.length === 0 || outputModalities.includes("text")),
    supportsTools: live?.supportsTools ?? catalog?.supportsTools ?? false,
    supportsParallelTools: false,
    supportsJsonSchema: live?.supportsJsonSchema ?? catalog?.supportsJsonSchema ?? false,
    supportsReasoning: live?.supportsReasoning ?? catalog?.supportsReasoning ?? false,
    supportsVision,
    supportsAudio,
    supportsVideo,
    supportsPromptCache:
      catalog?.supportsPromptCache ?? (live?.pricing?.cachedInputPrice !== undefined),
    pricing,
    source: catalogMatched ? "models.dev" : liveHasMetadata(live) ? "upstream" : "unknown",
    recognized,
  };
}

/** 识别到元数据的文本模型才自动启用；纯图像/音频/embedding 输出保持禁用。 */
export function shouldAutoEnable(
  metadata: BuiltModelMetadata,
  provider?: ProviderRecord,
): boolean {
  if (!metadata.recognized) return false;
  if (provider?.extraConfig["syncAutoEnable"] === false) return false;
  return metadata.outputModalities.length === 0 || metadata.outputModalities.includes("text");
}

/** 将合并结果转换为 createModel 的 capabilities。 */
export function metadataCapabilities(metadata: BuiltModelMetadata): ModelCapabilities {
  return {
    inputModalities: metadata.inputModalities,
    outputModalities: metadata.outputModalities,
    ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    supportsStream: metadata.supportsStream,
    supportsTools: metadata.supportsTools,
    supportsParallelTools: metadata.supportsParallelTools,
    supportsJsonSchema: metadata.supportsJsonSchema,
    supportsReasoning: metadata.supportsReasoning,
    supportsVision: metadata.supportsVision,
    supportsAudio: metadata.supportsAudio,
    supportsVideo: metadata.supportsVideo,
    supportsPromptCache: metadata.supportsPromptCache,
  };
}

function isDefaultModalities<T extends string>(values: T[]): boolean {
  return values.length === 1 && values[0] === "text";
}

type BooleanCapabilityKey =
  | "supportsStream"
  | "supportsTools"
  | "supportsParallelTools"
  | "supportsJsonSchema"
  | "supportsReasoning"
  | "supportsVision"
  | "supportsAudio"
  | "supportsVideo"
  | "supportsPromptCache";

function upgradeSource(
  current: ModelMetadataSource | undefined,
  incoming: Exclude<ModelMetadataSource, "manual">,
): ModelMetadataSource | undefined {
  if (incoming === "unknown") return current;
  if (current === undefined || current === "unknown") return incoming;
  if (current === "upstream" && incoming === "models.dev") return "models.dev";
  return current;
}

export interface ApplyMetadataResult {
  model: ModelRecord;
  changed: boolean;
}

/**
 * 存量模型刷新：只补空缺，不覆盖已有非空值，不改变 enabled。
 * metadataSource 为 manual 的模型由调用方跳过。
 */
export function applyMetadataToModel(
  model: ModelRecord,
  metadata: BuiltModelMetadata,
  now = Date.now(),
): ApplyMetadataResult {
  if (model.metadataSource === "manual") return { model, changed: false };

  const next: ModelRecord = {
    ...model,
    inputModalities: [...model.inputModalities],
    outputModalities: [...model.outputModalities],
    capabilities: { ...model.capabilities },
    pricing: { ...model.pricing },
  };
  let changed = false;

  if (next.contextWindow === undefined && metadata.contextWindow !== undefined) {
    next.contextWindow = metadata.contextWindow;
    next.capabilities.contextWindow = metadata.contextWindow;
    changed = true;
  }
  if (next.maxOutputTokens === undefined && metadata.maxOutputTokens !== undefined) {
    next.maxOutputTokens = metadata.maxOutputTokens;
    next.capabilities.maxOutputTokens = metadata.maxOutputTokens;
    changed = true;
  }

  if (isDefaultModalities(next.inputModalities) && !sameList(next.inputModalities, metadata.inputModalities)) {
    next.inputModalities = [...metadata.inputModalities];
    next.capabilities.inputModalities = [...metadata.inputModalities];
    changed = true;
  }
  if (isDefaultModalities(next.outputModalities) && !sameList(next.outputModalities, metadata.outputModalities)) {
    next.outputModalities = [...metadata.outputModalities];
    next.capabilities.outputModalities = [...metadata.outputModalities];
    changed = true;
  }

  const promote = (key: BooleanCapabilityKey): void => {
    if (next.capabilities[key] === false && metadata[key] === true) {
      next.capabilities[key] = true;
      changed = true;
    }
  };
  promote("supportsStream");
  promote("supportsTools");
  promote("supportsParallelTools");
  promote("supportsJsonSchema");
  promote("supportsReasoning");
  promote("supportsVision");
  promote("supportsAudio");
  promote("supportsVideo");
  promote("supportsPromptCache");

  const pricingUntouched = next.pricing.inputPrice === 0 && next.pricing.outputPrice === 0;
  if (pricingUntouched) {
    if (metadata.pricing.inputPrice !== 0) {
      next.pricing.inputPrice = metadata.pricing.inputPrice;
      changed = true;
    }
    if (metadata.pricing.outputPrice !== 0) {
      next.pricing.outputPrice = metadata.pricing.outputPrice;
      changed = true;
    }
    if (next.pricing.cachedInputPrice === undefined && metadata.pricing.cachedInputPrice !== undefined) {
      next.pricing.cachedInputPrice = metadata.pricing.cachedInputPrice;
      changed = true;
    }
    if (next.pricing.reasoningPrice === undefined && metadata.pricing.reasoningPrice !== undefined) {
      next.pricing.reasoningPrice = metadata.pricing.reasoningPrice;
      changed = true;
    }
  }

  if ((next.displayName === undefined || next.displayName === "") && metadata.displayName !== undefined) {
    next.displayName = metadata.displayName;
    changed = true;
  }

  const source = upgradeSource(next.metadataSource, metadata.source);
  if (source !== next.metadataSource) {
    next.metadataSource = source;
    changed = true;
  }

  if (!changed) return { model, changed: false };
  next.metadataUpdatedAt = now;
  next.updatedAt = now;
  return { model: next, changed: true };
}
