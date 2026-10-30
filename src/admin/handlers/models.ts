import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import type { ModelRecord } from "../../config/types";
import type { ModelCapabilities } from "../../ir/request";
import {
  createModel,
  createPricing,
  deleteModel,
  deletePricing,
  getModel,
  getProvider,
  listModels,
  listPricing,
  replaceModel,
  requireProviderExists,
} from "../../config/repository";
import { modelCreateSchema, modelUpdateSchema, pricingCreateSchema } from "../schemas";
import {
  parseAdminBody,
  recordAudit,
  requireParam,
  validateModelId,
} from "../shared";

export async function listModelsHandler(c: Context<AppEnv>): Promise<Response> {
  const providerId = c.req.query("providerId");
  let models = await listModels(c.env.DB);
  if (providerId !== undefined) models = models.filter((model) => model.providerId === providerId);
  return c.json({ data: models });
}

export async function getModelHandler(c: Context<AppEnv>): Promise<Response> {
  const model = await getModel(c.env.DB, requireParam(c, "id"));
  if (model === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Model not found" });
  return c.json({ data: model });
}

async function assertModelUnique(
  c: Context<AppEnv>,
  providerId: string,
  modelId: string,
  excludeId?: string,
): Promise<void> {
  const models = await listModels(c.env.DB);
  const duplicate = models.find(
    (model) => model.providerId === providerId && model.modelId === modelId && model.id !== excludeId,
  );
  if (duplicate !== undefined) {
    throw new GatewayError({
      code: "INVALID_REQUEST",
      message: `Model "${modelId}" already exists for this provider`,
    });
  }
}

export async function createModelHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, modelCreateSchema);
  validateModelId(input.modelId);
  if (input.upstreamModelId !== undefined) validateModelId(input.upstreamModelId);
  const provider = await getProvider(c.env.DB, input.providerId);
  if (provider === undefined) {
    throw new GatewayError({ code: "PROVIDER_NOT_FOUND", message: "Provider not found" });
  }
  await assertModelUnique(c, input.providerId, input.modelId);

  const capabilities: Partial<ModelCapabilities> = {
    ...(input.inputModalities === undefined ? {} : { inputModalities: input.inputModalities }),
    ...(input.outputModalities === undefined ? {} : { outputModalities: input.outputModalities }),
    ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.supportsStream === undefined ? {} : { supportsStream: input.supportsStream }),
    ...(input.supportsTools === undefined ? {} : { supportsTools: input.supportsTools }),
    ...(input.supportsParallelTools === undefined ? {} : { supportsParallelTools: input.supportsParallelTools }),
    ...(input.supportsJsonSchema === undefined ? {} : { supportsJsonSchema: input.supportsJsonSchema }),
    ...(input.supportsReasoning === undefined ? {} : { supportsReasoning: input.supportsReasoning }),
    ...(input.supportsVision === undefined ? {} : { supportsVision: input.supportsVision }),
    ...(input.supportsAudio === undefined ? {} : { supportsAudio: input.supportsAudio }),
    ...(input.supportsVideo === undefined ? {} : { supportsVideo: input.supportsVideo }),
    ...(input.supportsPromptCache === undefined ? {} : { supportsPromptCache: input.supportsPromptCache }),
  };

  const model = await createModel(c.env.DB, {
    providerId: input.providerId,
    modelId: input.modelId,
    upstreamModelId: input.upstreamModelId,
    displayName: input.displayName,
    capabilities,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
    cachedInputPrice: input.cachedInputPrice,
    reasoningPrice: input.reasoningPrice,
    enabled: input.enabled,
    source: "manual",
  });
  await recordAudit(c, "model.create", "model", model.id, { modelId: model.modelId, providerId: model.providerId });
  return c.json({ data: model }, 201);
}

function mergeCapabilities(model: ModelRecord, input: Record<string, unknown>): ModelCapabilities {
  const current = model.capabilities;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof input[key] === "boolean" ? (input[key] as boolean) : fallback;
  const list = <T>(key: string, fallback: T[]): T[] =>
    Array.isArray(input[key]) ? (input[key] as T[]) : fallback;
  const num = (key: string, fallback: number | undefined): number | undefined =>
    typeof input[key] === "number" ? (input[key] as number) : fallback;
  return {
    inputModalities: list("inputModalities", current.inputModalities),
    outputModalities: list("outputModalities", current.outputModalities),
    contextWindow: num("contextWindow", current.contextWindow),
    maxOutputTokens: num("maxOutputTokens", current.maxOutputTokens),
    supportsStream: bool("supportsStream", current.supportsStream),
    supportsTools: bool("supportsTools", current.supportsTools),
    supportsParallelTools: bool("supportsParallelTools", current.supportsParallelTools),
    supportsJsonSchema: bool("supportsJsonSchema", current.supportsJsonSchema),
    supportsReasoning: bool("supportsReasoning", current.supportsReasoning),
    supportsVision: bool("supportsVision", current.supportsVision),
    supportsAudio: bool("supportsAudio", current.supportsAudio),
    supportsVideo: bool("supportsVideo", current.supportsVideo),
    supportsPromptCache: bool("supportsPromptCache", current.supportsPromptCache),
  };
}

export async function updateModelHandler(c: Context<AppEnv>): Promise<Response> {
  const model = await getModel(c.env.DB, requireParam(c, "id"));
  if (model === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Model not found" });
  const input = await parseAdminBody(c, modelUpdateSchema);
  const modelId = input.modelId ?? model.modelId;
  validateModelId(modelId);
  if (input.upstreamModelId !== undefined) validateModelId(input.upstreamModelId);
  if (modelId !== model.modelId) {
    await assertModelUnique(c, model.providerId, modelId, model.id);
  }

  const capabilities = mergeCapabilities(model, input as unknown as Record<string, unknown>);
  const updated: ModelRecord = {
    ...model,
    modelId,
    upstreamModelId: input.upstreamModelId ?? model.upstreamModelId,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    inputModalities: capabilities.inputModalities,
    outputModalities: capabilities.outputModalities,
    ...(capabilities.contextWindow === undefined ? {} : { contextWindow: capabilities.contextWindow }),
    ...(capabilities.maxOutputTokens === undefined ? {} : { maxOutputTokens: capabilities.maxOutputTokens }),
    capabilities,
    pricing: {
      ...model.pricing,
      ...(input.inputPrice === undefined ? {} : { inputPrice: input.inputPrice }),
      ...(input.outputPrice === undefined ? {} : { outputPrice: input.outputPrice }),
      ...(input.cachedInputPrice === undefined ? { cachedInputPrice: model.pricing.cachedInputPrice } : { cachedInputPrice: input.cachedInputPrice }),
      ...(input.reasoningPrice === undefined ? { reasoningPrice: model.pricing.reasoningPrice } : { reasoningPrice: input.reasoningPrice }),
    },
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    updatedAt: Date.now(),
  };
  if (updated.contextWindow === undefined) delete updated.contextWindow;
  if (updated.maxOutputTokens === undefined) delete updated.maxOutputTokens;
  if (updated.pricing.cachedInputPrice === undefined) delete updated.pricing.cachedInputPrice;
  if (updated.pricing.reasoningPrice === undefined) delete updated.pricing.reasoningPrice;

  await replaceModel(c.env.DB, updated);
  await recordAudit(c, "model.update", "model", model.id, { modelId: updated.modelId });
  return c.json({ data: updated });
}

export async function deleteModelHandler(c: Context<AppEnv>): Promise<Response> {
  const model = await getModel(c.env.DB, requireParam(c, "id"));
  if (model === undefined) throw new GatewayError({ code: "NOT_FOUND", message: "Model not found" });
  await deleteModel(c.env.DB, model.id);
  await recordAudit(c, "model.delete", "model", model.id, { modelId: model.modelId });
  return c.json({ deleted: true, id: model.id });
}

export async function listPricingHandler(c: Context<AppEnv>): Promise<Response> {
  return c.json({ data: await listPricing(c.env.DB) });
}

export async function createPricingHandler(c: Context<AppEnv>): Promise<Response> {
  const input = await parseAdminBody(c, pricingCreateSchema);
  await requireProviderExists(c.env.DB, input.providerId);
  const record = await createPricing(c.env.DB, {
    providerId: input.providerId,
    modelId: input.modelId,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
    cachedInputPrice: input.cachedInputPrice,
    reasoningPrice: input.reasoningPrice,
    currency: input.currency,
    effectiveFrom: input.effectiveFrom,
  });
  await recordAudit(c, "pricing.create", "pricing", record.id, {
    providerId: record.providerId,
    modelId: record.modelId,
  });
  return c.json({ data: record }, 201);
}

export async function deletePricingHandler(c: Context<AppEnv>): Promise<Response> {
  const id = requireParam(c, "id");
  await deletePricing(c.env.DB, id);
  await recordAudit(c, "pricing.delete", "pricing", id);
  return c.json({ deleted: true, id });
}
