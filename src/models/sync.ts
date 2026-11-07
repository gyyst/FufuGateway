import type { GatewayEnv } from "../env";
import type { ProviderRecord } from "../config/types";
import {
  createModel,
  listModels,
  replaceModel,
  type CreateModelInput,
} from "../config/repository";
import { fetchProviderModels } from "../providers/engine";
import type { RemoteModel } from "../providers/transport";
import type { FetchLike } from "../providers/types";
import { findCatalogModel, loadModelsDevCatalog, type CatalogStatus } from "./catalog";
import {
  applyMetadataToModel,
  buildModelMetadata,
  metadataCapabilities,
  shouldAutoEnable,
  type BuiltModelMetadata,
} from "./metadata";

export interface ModelSyncMetadataStats {
  catalog: CatalogStatus;
  modelsDevMatched: number;
  upstreamMatched: number;
  unknown: number;
}

export interface ModelSyncResult {
  total: number;
  created: number;
  skipped: number;
  createdModels: string[];
  autoEnabled: number;
  metadata: ModelSyncMetadataStats;
}

/** 同步创建模型时使用的合并结果。 */
function createInputFromMetadata(
  provider: ProviderRecord,
  remote: RemoteModel,
  metadata: BuiltModelMetadata,
  enabled: boolean,
  now: number,
): CreateModelInput {
  return {
    providerId: provider.id,
    modelId: remote.id,
    upstreamModelId: remote.id,
    ...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName }),
    inputModalities: metadata.inputModalities,
    outputModalities: metadata.outputModalities,
    ...(metadata.contextWindow === undefined ? {} : { contextWindow: metadata.contextWindow }),
    ...(metadata.maxOutputTokens === undefined ? {} : { maxOutputTokens: metadata.maxOutputTokens }),
    capabilities: metadataCapabilities(metadata),
    inputPrice: metadata.pricing.inputPrice,
    outputPrice: metadata.pricing.outputPrice,
    ...(metadata.pricing.cachedInputPrice === undefined
      ? {}
      : { cachedInputPrice: metadata.pricing.cachedInputPrice }),
    ...(metadata.pricing.reasoningPrice === undefined
      ? {}
      : { reasoningPrice: metadata.pricing.reasoningPrice }),
    enabled,
    source: "sync",
    metadataSource: metadata.source,
    metadataUpdatedAt: now,
  };
}

/**
 * 同步 Provider 模型列表：
 * - 上游 /models 实时元数据优先，models.dev 目录兜底。
 * - 识别到元数据的文本模型自动启用；未识别或非文本输出保持禁用。
 * - 已存在模型跳过，存量回填使用 refreshProviderModelMetadata。
 */
export async function syncProviderModels(
  env: GatewayEnv,
  provider: ProviderRecord,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<ModelSyncResult> {
  const [remote, catalogResult] = await Promise.all([
    fetchProviderModels({
      provider,
      apiKey,
      fetchImpl,
      timeoutMs: 30_000,
    }),
    loadModelsDevCatalog({ kv: env.CONFIG_KV, fetchImpl }),
  ]);
  const existing = (await listModels(env.DB)).filter((model) => model.providerId === provider.id);
  const existingIds = new Set(
    existing.flatMap((model) => [model.modelId.toLowerCase(), model.upstreamModelId.toLowerCase()]),
  );
  const created: string[] = [];
  const skipped: string[] = [];
  const metadata: ModelSyncMetadataStats = {
    catalog: catalogResult.status,
    modelsDevMatched: 0,
    upstreamMatched: 0,
    unknown: 0,
  };
  let autoEnabled = 0;
  const now = Date.now();

  for (const model of remote) {
    if (existingIds.has(model.id.toLowerCase())) {
      skipped.push(model.id);
      continue;
    }
    const match = findCatalogModel(catalogResult.catalog, provider, model.id);
    const built = buildModelMetadata({
      live: model,
      ...(match === undefined ? {} : { catalog: match.model }),
      catalogMatched: match !== undefined,
      modelId: model.id,
    });
    const enabled = shouldAutoEnable(built, provider);
    if (built.source === "models.dev") metadata.modelsDevMatched += 1;
    else if (built.source === "upstream") metadata.upstreamMatched += 1;
    else metadata.unknown += 1;
    if (enabled) autoEnabled += 1;

    await createModel(env.DB, createInputFromMetadata(provider, model, built, enabled, now));
    created.push(model.id);
  }

  return {
    total: remote.length,
    created: created.length,
    skipped: skipped.length,
    createdModels: created,
    autoEnabled,
    metadata,
  };
}

export interface RefreshMetadataResult {
  updated: number;
  unchanged: number;
  skippedManual: number;
  unmatched: number;
  metadata: {
    catalog: CatalogStatus;
    modelsDevMatched: number;
    upstreamMatched: number;
  };
}

/**
 * 刷新 Provider 下已有模型的元数据：只补空缺，不覆盖已填字段，
 * 不改变 enabled；metadataSource 为 manual 的模型跳过。
 */
export async function refreshProviderModelMetadata(args: {
  env: GatewayEnv;
  provider: ProviderRecord;
  live: RemoteModel[];
  fetchImpl: FetchLike;
}): Promise<RefreshMetadataResult> {
  const { env, provider, live, fetchImpl } = args;
  const catalogResult = await loadModelsDevCatalog({ kv: env.CONFIG_KV, fetchImpl });
  const models = (await listModels(env.DB)).filter((model) => model.providerId === provider.id);
  const liveById = new Map<string, RemoteModel>();
  for (const model of live) liveById.set(model.id.toLowerCase(), model);

  let updated = 0;
  let unchanged = 0;
  let skippedManual = 0;
  let unmatched = 0;
  let modelsDevMatched = 0;
  let upstreamMatched = 0;
  const now = Date.now();

  for (const model of models) {
    if (model.metadataSource === "manual") {
      skippedManual += 1;
      continue;
    }
    const liveEntry =
      liveById.get(model.upstreamModelId.toLowerCase()) ?? liveById.get(model.modelId.toLowerCase());
    const lookupId = liveEntry?.id ?? model.upstreamModelId;
    const match =
      findCatalogModel(catalogResult.catalog, provider, lookupId) ??
      (model.modelId.toLowerCase() === lookupId.toLowerCase()
        ? undefined
        : findCatalogModel(catalogResult.catalog, provider, model.modelId));

    if (liveEntry === undefined && match === undefined) {
      unmatched += 1;
      continue;
    }

    const metadata = buildModelMetadata({
      ...(liveEntry === undefined ? {} : { live: liveEntry }),
      ...(match === undefined ? {} : { catalog: match.model }),
      catalogMatched: match !== undefined,
      modelId: lookupId,
    });
    if (metadata.source === "models.dev") modelsDevMatched += 1;
    else if (metadata.source === "upstream") upstreamMatched += 1;

    const result = applyMetadataToModel(model, metadata, now);
    if (result.changed) {
      await replaceModel(env.DB, result.model);
      updated += 1;
    } else {
      unchanged += 1;
    }
  }

  return {
    updated,
    unchanged,
    skippedManual,
    unmatched,
    metadata: {
      catalog: catalogResult.status,
      modelsDevMatched,
      upstreamMatched,
    },
  };
}
