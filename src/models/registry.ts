import { defaultCapabilities } from "../ir/request";
import type { PublicModel } from "../ir/models";
import type { RuntimeConfig } from "../config/types";
import type { RouteConstraints } from "../router/resolver";

function providerAllowed(
  providerId: string,
  providerName: string,
  constraints: RouteConstraints | undefined,
): boolean {
  const allowed = constraints?.allowedProviderIds;
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.includes(providerId) || allowed.includes(providerName);
}

function modelAllowed(modelId: string, constraints: RouteConstraints | undefined): boolean {
  const allowed = constraints?.allowedModelIds;
  if (allowed === undefined || allowed.length === 0) return true;
  return allowed.includes(modelId);
}

/**
 * 向下游暴露的模型目录：原生模型（去重）、别名与 Combo。
 * 权限过滤与推理路由保持一致。
 */
export function listPublicModels(
  config: RuntimeConfig,
  constraints?: RouteConstraints,
): PublicModel[] {
  const result: PublicModel[] = [];
  const seen = new Set<string>();
  const providerRestricted =
    constraints?.allowedProviderIds !== undefined && constraints.allowedProviderIds.length > 0;

  for (const provider of config.data.providers) {
    if (!provider.enabled) continue;
    if (!providerAllowed(provider.id, provider.name, constraints)) continue;
    for (const model of config.modelsByProvider.get(provider.id) ?? []) {
      if (!model.enabled || seen.has(model.modelId)) continue;
      if (!modelAllowed(model.modelId, constraints)) continue;
      seen.add(model.modelId);
      result.push({
        id: model.modelId,
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        providerId: provider.id,
        providerName: provider.name,
        createdAt: model.createdAt,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        capabilities: model.capabilities,
      });
    }
  }

  for (const alias of config.data.aliases) {
    if (!alias.enabled || seen.has(alias.name)) continue;
    if (!modelAllowed(alias.name, constraints)) continue;
    if (providerRestricted) {
      // 无法静态确定别名指向的 Provider 时，仅在明确按名称授权时展示。
      if (!(constraints?.allowedModelIds ?? []).includes(alias.name)) continue;
    }
    seen.add(alias.name);
    result.push({
      id: alias.name,
      providerId: "",
      providerName: "FufuGateway",
      createdAt: alias.createdAt,
      capabilities: defaultCapabilities({ supportsStream: true, supportsTools: true }),
    });
  }

  for (const combo of config.data.combos) {
    if (!combo.enabled || seen.has(combo.name)) continue;
    if (!modelAllowed(combo.name, constraints)) continue;
    if (providerRestricted && !(constraints?.allowedModelIds ?? []).includes(combo.name)) continue;
    seen.add(combo.name);
    result.push({
      id: combo.name,
      providerId: "",
      providerName: "FufuGateway",
      createdAt: combo.createdAt,
      capabilities: defaultCapabilities({ supportsStream: true, supportsTools: true }),
    });
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

export function findPublicModel(
  config: RuntimeConfig,
  id: string,
  constraints?: RouteConstraints,
): PublicModel | undefined {
  return listPublicModels(config, constraints).find((model) => model.id === id);
}
