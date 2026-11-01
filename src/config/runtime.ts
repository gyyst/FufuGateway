import { compareGlobSpecificity, compileGlob } from "../router/glob";
import type { ComboRecord } from "../combo/types";
import type {
  CompiledGlobCombo,
  ConfigSnapshotData,
  LegacyAliasRecord,
  LegacyWildcardRule,
  ModelRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RuntimeConfig,
} from "./types";
import { providerModelKey } from "./types";

function hasGlobChars(name: string): boolean {
  return name.includes("*") || name.includes("?");
}

/** 旧快照中的别名在运行时等价为一个单节点 Combo。 */
function legacyAliasToCombo(alias: LegacyAliasRecord): ComboRecord {
  return {
    id: alias.id,
    name: alias.name,
    ...(alias.description === undefined ? {} : { description: alias.description }),
    strategy: "fallback",
    nodes: [alias.target],
    priority: alias.priority,
    enabled: alias.enabled,
    createdAt: alias.createdAt,
    updatedAt: alias.updatedAt,
  };
}

/** 旧快照中的通配符规则在运行时等价为一个 glob Combo。 */
function legacyWildcardToCombo(rule: LegacyWildcardRule): ComboRecord {
  return {
    id: rule.id,
    name: rule.pattern,
    ...(rule.description === undefined ? {} : { description: rule.description }),
    strategy: rule.strategy,
    nodes: rule.targets,
    priority: rule.priority,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

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

  const comboList: ComboRecord[] = [...data.combos];
  for (const alias of data.aliases ?? []) {
    comboList.push(legacyAliasToCombo(alias));
  }
  for (const rule of data.wildcards ?? []) {
    comboList.push(legacyWildcardToCombo(rule));
  }
  const combosByName = new Map(comboList.map((combo) => [combo.name.toLowerCase(), combo]));
  const globCombos: CompiledGlobCombo[] = comboList
    .filter((combo) => hasGlobChars(combo.name))
    .map((combo) => ({ combo, compiled: compileGlob(combo.name) }));
  globCombos.sort((a, b) => {
    const priorityA = a.combo.priority ?? 100;
    const priorityB = b.combo.priority ?? 100;
    if (priorityA !== priorityB) return priorityB - priorityA;
    const specificity = compareGlobSpecificity(a.compiled, b.compiled);
    if (specificity !== 0) return specificity;
    return a.combo.id.localeCompare(b.combo.id);
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
    combosByName,
    globCombos,
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
