import { compareGlobSpecificity, compileGlob } from "../router/glob";
import type {
  CompiledWildcardRule,
  ConfigSnapshotData,
  ModelRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RuntimeConfig,
} from "./types";
import { providerModelKey } from "./types";

export interface RuntimeMeta {
  version: number;
  checksum: string;
  createdAt: number;
  source: "kv" | "d1-fallback";
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const list = map.get(value);
    if (list === undefined) map.set(value, [item]);
    else list.push(item);
  }
  return map;
}

/** 将配置快照构建为带索引的运行期配置。调用前必须完成校验。 */
export function buildRuntimeConfig(data: ConfigSnapshotData, meta: RuntimeMeta): RuntimeConfig {  const providersById = new Map<string, ProviderRecord>();
  const providersByName = new Map<string, ProviderRecord>();
  for (const provider of data.providers) {
    providersById.set(provider.id, provider);
    providersByName.set(provider.name.toLowerCase(), provider);
  }

  const modelsById = new Map<string, ModelRecord>();
  const modelsByProvider = groupBy(data.models, (model) => model.providerId);
  const modelByProviderModel = new Map<string, ModelRecord>();
  for (const model of data.models) {
    modelsById.set(model.id, model);
    modelByProviderModel.set(providerModelKey(model.providerId, model.modelId), model);
  }
  const modelsByModelId = groupBy(data.models, (model) => model.modelId);

  const aliasesByName = new Map(data.aliases.map((alias) => [alias.name.toLowerCase(), alias]));
  const combosByName = new Map(data.combos.map((combo) => [combo.name.toLowerCase(), combo]));

  const wildcards: CompiledWildcardRule[] = data.wildcards.map((rule) => ({
    rule,
    compiled: compileGlob(rule.pattern),
  }));
  wildcards.sort((a, b) => {
    if (a.rule.priority !== b.rule.priority) return b.rule.priority - a.rule.priority;
    const specificity = compareGlobSpecificity(a.compiled, b.compiled);
    if (specificity !== 0) return specificity;
    return a.rule.id.localeCompare(b.rule.id);
  });

  const accountsByProvider = new Map<string, ProviderAccountRecord[]>();
  for (const account of data.accounts) {
    const list = accountsByProvider.get(account.providerId);
    if (list === undefined) accountsByProvider.set(account.providerId, [account]);
    else list.push(account);
  }
  for (const list of accountsByProvider.values()) {
    list.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return a.id.localeCompare(b.id);
    });
  }

  const pricingByProviderModel = new Map(data.pricing.map((price) => [providerModelKey(price.providerId, price.modelId), price]));

  return {
    version: meta.version,
    checksum: meta.checksum,
    createdAt: meta.createdAt,
    source: meta.source,
    data,
    providersById,
    providersByName,
    modelsById,
    modelsByModelId,
    modelsByProvider,
    modelByProviderModel,
    aliasesByName,
    combosByName,
    wildcards,
    accountsByProvider,
    pricingByProviderModel,
    settings: data.settings,
  };
}

/** 计算配置快照的 SHA-256 校验和。 */
export async function computeChecksum(data: ConfigSnapshotData): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(data)),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
