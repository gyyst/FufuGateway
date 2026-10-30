import type { GatewayEnv } from "../env";
import type { ProviderRecord } from "../config/types";
import { createModel, listModels } from "../config/repository";
import { fetchProviderModels } from "../providers/engine";
import type { FetchLike } from "../providers/types";

export interface ModelSyncResult {
  total: number;
  created: number;
  skipped: number;
  createdModels: string[];
}

/**
 * 同步 Provider 模型列表。新模型默认禁用、能力全部为 false，
 * 必须由管理员确认能力后启用，避免根据名称猜测能力。
 */
export async function syncProviderModels(
  env: GatewayEnv,
  provider: ProviderRecord,
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<ModelSyncResult> {
  const remote = await fetchProviderModels({
    provider,
    apiKey,
    fetchImpl,
    timeoutMs: 30_000,
  });
  const existing = (await listModels(env.DB)).filter((model) => model.providerId === provider.id);
  const existingIds = new Set(
    existing.flatMap((model) => [model.modelId.toLowerCase(), model.upstreamModelId.toLowerCase()]),
  );
  const created: string[] = [];
  const skipped: string[] = [];

  for (const model of remote) {
    if (existingIds.has(model.id.toLowerCase())) {
      skipped.push(model.id);
      continue;
    }
    await createModel(env.DB, {
      providerId: provider.id,
      modelId: model.id,
      upstreamModelId: model.id,
      ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      capabilities: {
        supportsStream: false,
        supportsTools: false,
        supportsParallelTools: false,
        supportsJsonSchema: false,
        supportsReasoning: false,
        supportsVision: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsPromptCache: false,
      },
      enabled: false,
      source: "sync",
    });
    created.push(model.id);
  }

  return {
    total: remote.length,
    created: created.length,
    skipped: skipped.length,
    createdModels: created,
  };
}
