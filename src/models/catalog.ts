import { isRecord } from "../core/json";
import type { ProviderRecord } from "../config/types";
import type { Modality } from "../ir/common";
import type { OutputModality } from "../ir/request";
import type { FetchLike } from "../providers/types";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODEL_CATALOG_KV_KEY = "model_catalog:models.dev:v1";
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;
const KV_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALE_MEMORY_TTL_MS = 5 * 60 * 1000;
const INPUT_MODALITIES = new Set<Modality>(["text", "image", "audio", "video", "file"]);
const OUTPUT_MODALITIES = new Set<OutputModality>(["text", "image", "audio", "embedding"]);

export interface CatalogPricing {
  inputPrice?: number;
  outputPrice?: number;
  cachedInputPrice?: number;
  reasoningPrice?: number;
}

/** models.dev 中与 FufuGateway 模型能力对应的字段。 */
export interface CatalogModel {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: Modality[];
  outputModalities?: OutputModality[];
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsReasoning?: boolean;
  supportsPromptCache?: boolean;
  pricing?: CatalogPricing;
}

export interface CatalogProvider {
  id: string;
  name?: string;
  models: Record<string, CatalogModel>;
}

export interface CatalogData {
  fetchedAt: number;
  providers: Record<string, CatalogProvider>;
}

export type CatalogStatus = "ok" | "stale" | "unavailable";

export interface CatalogLoadResult {
  catalog: CatalogData;
  status: CatalogStatus;
}

export interface CatalogMatch {
  model: CatalogModel;
  providerId?: string;
  method: "provider-exact" | "provider-normalized" | "global-exact" | "global-normalized";
}

interface CatalogIndex {
  exactByProvider: Map<string, Map<string, CatalogModel>>;
  normalizedByProvider: Map<string, Map<string, CatalogModel>>;
  exactGlobal: Map<string, Array<{ providerId: string; model: CatalogModel }>>;
  normalizedGlobal: Map<string, Array<{ providerId: string; model: CatalogModel }>>;
  providerIdByNormalizedName: Map<string, string>;
}

interface MemoryEntry {
  catalog: CatalogData;
  status: CatalogStatus;
  cachedAt: number;
}

let memory: MemoryEntry | null = null;
let inFlight: Promise<CatalogLoadResult> | null = null;
const indexes = new WeakMap<CatalogData, CatalogIndex>();

export function emptyCatalog(fetchedAt = 0): CatalogData {
  return { fetchedAt, providers: {} };
}

export function clearModelCatalogCache(): void {
  memory = null;
  inFlight = null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return result.length === 0 ? undefined : result;
}

function mapInputModalities(value: unknown): Modality[] | undefined {
  const values = stringArray(value);
  if (values === undefined) return undefined;
  const result: Modality[] = [];
  for (const value of values) {
    const normalized: Modality | undefined =
      value === "pdf" || value === "document"
        ? "file"
        : INPUT_MODALITIES.has(value as Modality)
          ? (value as Modality)
          : undefined;
    if (normalized !== undefined && !result.includes(normalized)) result.push(normalized);
  }
  return result.length === 0 ? undefined : result;
}

function mapOutputModalities(value: unknown): OutputModality[] | undefined {
  const values = stringArray(value);
  if (values === undefined) return undefined;
  const result: OutputModality[] = [];
  for (const value of values) {
    if (OUTPUT_MODALITIES.has(value as OutputModality) && !result.includes(value as OutputModality)) {
      result.push(value as OutputModality);
    }
  }
  return result.length === 0 ? undefined : result;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCatalogModel(id: string, record: Record<string, unknown>): CatalogModel {
  const limits = isRecord(record["limit"]) ? record["limit"] : undefined;
  const modalities = isRecord(record["modalities"]) ? record["modalities"] : undefined;
  const cost = isRecord(record["cost"]) ? record["cost"] : undefined;
  const reasoningOptions = record["reasoning_options"];
  const displayName = typeof record["name"] === "string" ? record["name"].trim() : "";
  const inputPrice = positiveNumber(cost?.["input"]);
  const outputPrice = positiveNumber(cost?.["output"]);
  const cachedInputPrice = positiveNumber(cost?.["cache_read"]);
  const reasoningPrice = positiveNumber(cost?.["reasoning"]);
  const contextWindow = positiveInteger(limits?.["context"]);
  const maxOutputTokens = positiveInteger(limits?.["output"]);
  const inputModalities = mapInputModalities(modalities?.["input"]);
  const outputModalities = mapOutputModalities(modalities?.["output"]);
  const pricing: CatalogPricing = {
    ...(inputPrice === undefined ? {} : { inputPrice }),
    ...(outputPrice === undefined ? {} : { outputPrice }),
    ...(cachedInputPrice === undefined ? {} : { cachedInputPrice }),
    ...(reasoningPrice === undefined ? {} : { reasoningPrice }),
  };

  return {
    id,
    ...(displayName === "" ? {} : { displayName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(record["tool_call"] === true ? { supportsTools: true } : {}),
    ...(record["tool_call"] === false ? { supportsTools: false } : {}),
    ...(record["structured_output"] === true ? { supportsJsonSchema: true } : {}),
    ...(record["structured_output"] === false ? { supportsJsonSchema: false } : {}),
    ...(record["reasoning"] === true || (Array.isArray(reasoningOptions) && reasoningOptions.length > 0)
      ? { supportsReasoning: true }
      : {}),
    ...(cost?.["cache_read"] === undefined ? {} : { supportsPromptCache: true }),
    ...(Object.keys(pricing).length === 0 ? {} : { pricing }),
  };
}

export function parseCatalogPayload(payload: unknown, fetchedAt: number): CatalogData | undefined {
  if (!isRecord(payload)) return undefined;
  const providers: Record<string, CatalogProvider> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!isRecord(value)) continue;
    const modelsValue = value["models"];
    if (!isRecord(modelsValue)) continue;
    const id = typeof value["id"] === "string" && value["id"].trim() !== "" ? value["id"] : key;
    const name = typeof value["name"] === "string" ? value["name"] : undefined;
    const models: Record<string, CatalogModel> = {};
    for (const [modelId, modelValue] of Object.entries(modelsValue)) {
      if (!isRecord(modelValue)) continue;
      models[modelId] = parseCatalogModel(modelId, modelValue);
    }
    if (Object.keys(models).length === 0) continue;
    providers[id] = { id, ...(name === undefined ? {} : { name }), models };
  }
  if (Object.keys(providers).length === 0) return undefined;
  return { fetchedAt, providers };
}

function parseStoredCatalog(raw: string): CatalogData | undefined {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!isRecord(payload)) return undefined;
    const fetchedAt = payload["fetchedAt"];
    const providersValue = payload["providers"];
    if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || !isRecord(providersValue)) {
      return undefined;
    }
    const providers: Record<string, CatalogProvider> = {};
    for (const [key, providerValue] of Object.entries(providersValue)) {
      if (!isRecord(providerValue) || !isRecord(providerValue["models"])) continue;
      const models: Record<string, CatalogModel> = {};
      for (const [modelId, modelValue] of Object.entries(providerValue["models"])) {
        if (isRecord(modelValue) && typeof modelValue["id"] === "string") {
          models[modelId] = modelValue as unknown as CatalogModel;
        }
      }
      if (Object.keys(models).length === 0) continue;
      const id = typeof providerValue["id"] === "string" ? providerValue["id"] : key;
      const name = typeof providerValue["name"] === "string" ? providerValue["name"] : undefined;
      providers[id] = { id, ...(name === undefined ? {} : { name }), models };
    }
    if (Object.keys(providers).length === 0) return undefined;
    return { fetchedAt, providers };
  } catch {
    return undefined;
  }
}

function warn(message: string, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: message,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function fetchCatalog(fetchImpl: FetchLike, now: number): Promise<CatalogData> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(MODELS_DEV_URL, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "fufu-gateway/model-catalog" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const catalog = parseCatalogPayload(payload, now);
    if (catalog === undefined) throw new Error("unexpected models.dev payload");
    return catalog;
  } finally {
    clearTimeout(timer);
  }
}

function remember(catalog: CatalogData, status: CatalogStatus, now: number): CatalogLoadResult {
  memory = { catalog, status, cachedAt: now };
  return { catalog, status };
}

function memoryFresh(entry: MemoryEntry, now: number): boolean {
  const ttl = entry.status === "ok" ? MODEL_CATALOG_TTL_MS : STALE_MEMORY_TTL_MS;
  return now - entry.cachedAt < ttl;
}

async function loadCatalog(args: {
  kv?: KVNamespace;
  fetchImpl: FetchLike;
  forceRefresh?: boolean;
  now: number;
}): Promise<CatalogLoadResult> {
  const { kv, fetchImpl, forceRefresh, now } = args;
  let stored: CatalogData | undefined;
  if (kv !== undefined) {
    try {
      const raw = await kv.get(MODEL_CATALOG_KV_KEY);
      if (raw !== null) stored = parseStoredCatalog(raw);
    } catch (error) {
      warn("model_catalog.kv_read_failed", error);
    }
  }

  if (stored !== undefined && forceRefresh !== true && now - stored.fetchedAt < MODEL_CATALOG_TTL_MS) {
    return remember(stored, "ok", now);
  }

  try {
    const fresh = await fetchCatalog(fetchImpl, now);
    if (kv !== undefined) {
      try {
        await kv.put(MODEL_CATALOG_KV_KEY, JSON.stringify(fresh), { expirationTtl: KV_TTL_SECONDS });
      } catch (error) {
        warn("model_catalog.kv_write_failed", error);
      }
    }
    return remember(fresh, "ok", now);
  } catch (error) {
    warn("model_catalog.load_failed", error);
  }

  if (stored !== undefined) return remember(stored, "stale", now);
  return remember(emptyCatalog(now), "unavailable", now);
}

/**
 * 读取 models.dev 目录。优先内存缓存，其次 KV，最后下载。
 * 外部目录不可用时返回 stale 或 unavailable，不抛出异常。
 */
export async function loadModelsDevCatalog(args: {
  kv?: KVNamespace;
  fetchImpl: FetchLike;
  forceRefresh?: boolean;
  now?: number;
}): Promise<CatalogLoadResult> {
  const now = args.now ?? Date.now();
  if (memory !== null && args.forceRefresh !== true && memoryFresh(memory, now)) {
    return { catalog: memory.catalog, status: memory.status };
  }
  if (inFlight !== null) return inFlight;

  inFlight = loadCatalog({ ...args, now }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const HOST_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  ["api.openai.com", "openai"],
  ["api.anthropic.com", "anthropic"],
  ["generativelanguage.googleapis.com", "google"],
  ["aiplatform.googleapis.com", "google-vertex"],
  ["openrouter.ai", "openrouter"],
  ["api.deepseek.com", "deepseek"],
  ["api.moonshot.ai", "moonshotai"],
  ["api.moonshot.cn", "moonshotai-cn"],
  ["api.z.ai", "zai"],
  ["open.bigmodel.cn", "zhipuai"],
  ["dashscope.aliyuncs.com", "alibaba-cn"],
  ["dashscope-intl.aliyuncs.com", "alibaba"],
  ["api.mistral.ai", "mistral"],
  ["api.groq.com", "groq"],
  ["api.x.ai", "xai"],
  ["api.together.xyz", "togetherai"],
  ["api.together.ai", "togetherai"],
  ["api.fireworks.ai", "fireworks-ai"],
  ["api.siliconflow.com", "siliconflow"],
  ["api.siliconflow.cn", "siliconflow-cn"],
  ["ark.cn-beijing.volces.com", "volcengine"],
  ["api.cloudflare.com", "cloudflare-workers-ai"],
  ["api.githubcopilot.com", "github-copilot"],
  ["api.perplexity.ai", "perplexity"],
  ["integrate.api.nvidia.com", "nvidia"],
  ["api.cohere.com", "cohere"],
];

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function configuredProviderIds(provider: ProviderRecord): string[] {
  const configured = provider.extraConfig["modelsDevProvider"];
  if (typeof configured === "string") {
    const value = configured.trim();
    return value === "" ? [] : [value];
  }
  if (!Array.isArray(configured)) return [];
  return configured
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function buildIndex(catalog: CatalogData): CatalogIndex {
  const exactByProvider = new Map<string, Map<string, CatalogModel>>();
  const normalizedByProvider = new Map<string, Map<string, CatalogModel>>();
  const exactGlobal = new Map<string, Array<{ providerId: string; model: CatalogModel }>>();
  const normalizedGlobal = new Map<string, Array<{ providerId: string; model: CatalogModel }>>();
  const providerIdByNormalizedName = new Map<string, string>();

  for (const [providerId, provider] of Object.entries(catalog.providers)) {
    providerIdByNormalizedName.set(normalizedName(providerId), providerId);
    if (provider.name !== undefined) {
      const key = normalizedName(provider.name);
      if (!providerIdByNormalizedName.has(key)) providerIdByNormalizedName.set(key, providerId);
    }

    const exact = new Map<string, CatalogModel>();
    const normalized = new Map<string, CatalogModel>();
    for (const [modelId, model] of Object.entries(provider.models)) {
      const lowerId = modelId.toLowerCase();
      exact.set(lowerId, model);
      const normalizedId = normalizeModelId(modelId);
      if (!normalized.has(normalizedId)) normalized.set(normalizedId, model);

      const exactEntry = { providerId, model };
      const exactList = exactGlobal.get(lowerId);
      if (exactList === undefined) exactGlobal.set(lowerId, [exactEntry]);
      else exactList.push(exactEntry);

      const normalizedEntry = { providerId, model };
      const normalizedList = normalizedGlobal.get(normalizedId);
      if (normalizedList === undefined) normalizedGlobal.set(normalizedId, [normalizedEntry]);
      else normalizedList.push(normalizedEntry);
    }
    exactByProvider.set(providerId, exact);
    normalizedByProvider.set(providerId, normalized);
  }

  return {
    exactByProvider,
    normalizedByProvider,
    exactGlobal,
    normalizedGlobal,
    providerIdByNormalizedName,
  };
}

function indexOf(catalog: CatalogData): CatalogIndex {
  const cached = indexes.get(catalog);
  if (cached !== undefined) return cached;
  const built = buildIndex(catalog);
  indexes.set(catalog, built);
  return built;
}

/** Provider 在 models.dev 中的候选 ID，按显式配置、主机、名称排序。 */
export function providerCatalogIds(provider: ProviderRecord, catalog: CatalogData): string[] {
  const index = indexOf(catalog);
  const result: string[] = [];
  const push = (id: string): void => {
    if (id !== "" && catalog.providers[id] !== undefined && !result.includes(id)) result.push(id);
  };

  for (const id of configuredProviderIds(provider)) push(id);

  const host = hostnameOf(provider.baseUrl);
  if (host !== "") {
    for (const [domain, id] of HOST_PROVIDERS) {
      if (host === domain || host.endsWith(`.${domain}`)) push(id);
    }
    if (host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com")) {
      push("azure");
    }
    if (host.startsWith("bedrock-runtime.") && host.endsWith(".amazonaws.com")) {
      push("amazon-bedrock");
    }
  }

  const byName = index.providerIdByNormalizedName.get(normalizedName(provider.name));
  if (byName !== undefined) push(byName);

  return result;
}

/** 去掉中转常见的 `vendor/` 前缀。 */
function stripVendorPrefix(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash < 0 ? modelId : modelId.slice(slash + 1);
}

/**
 * 归一化模型 ID，用于跨厂商匹配：
 * - 去厂商前缀、大小写、下划线/空格
 * - 去快照日期后缀（-20260801 / -260813）
 * - 统一版本点号与横线（glm-5.3 == glm-5-3）
 * - 去末尾窗口标记（[1m] / [200k]）
 */
export function normalizeModelId(raw: string): string {
  let id = raw.trim().toLowerCase();
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replace(/\[[^\]]*\]\s*$/, "");
  id = id.replace(/[_\s]+/g, "-");
  id = id.replace(/-(?:20\d{6}|\d{6})$/, "");
  id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  return id.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

/** 解析模型 ID 末尾的窗口标记，例如 claude-opus-5[1m]。 */
export function contextFromModelId(raw: string): number | undefined {
  const match = /\[(\d+(?:\.\d+)?)([km])\]\s*$/i.exec(raw.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : 1_000;
  const window = Math.round(amount * multiplier);
  return window > 0 ? window : undefined;
}

function signature(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify([...value].sort()) : JSON.stringify(value);
}

function mostCommon<T>(values: Array<T | undefined>): T | undefined {
  const counts = new Map<string, { value: T; count: number; first: number }>();
  let position = 0;
  for (const value of values) {
    if (value !== undefined) {
      const key = signature(value);
      const current = counts.get(key);
      if (current === undefined) counts.set(key, { value, count: 1, first: position });
      else current.count += 1;
    }
    position += 1;
  }
  let best: { value: T; count: number; first: number } | undefined;
  for (const entry of counts.values()) {
    if (best === undefined || entry.count > best.count) best = entry;
  }
  return best?.value;
}

function majorityBoolean(values: Array<boolean | undefined>): boolean | undefined {
  let yes = 0;
  let no = 0;
  for (const value of values) {
    if (value === true) yes += 1;
    else if (value === false) no += 1;
  }
  if (yes === 0 && no === 0) return undefined;
  return yes > no;
}

/** 多个 Provider 命中同名模型时按多数值合并；价格不跨 Provider 合并。 */
function aggregateCatalogModels(entries: Array<{ model: CatalogModel }>): CatalogModel {
  const models = entries.map((entry) => entry.model);
  const first = models[0];
  if (first === undefined) throw new Error("aggregateCatalogModels requires at least one entry");
  const displayName = mostCommon(models.map((model) => model.displayName));
  const contextWindow = mostCommon(models.map((model) => model.contextWindow));
  const maxOutputTokens = mostCommon(models.map((model) => model.maxOutputTokens));
  const inputModalities = mostCommon(models.map((model) => model.inputModalities));
  const outputModalities = mostCommon(models.map((model) => model.outputModalities));
  const supportsTools = majorityBoolean(models.map((model) => model.supportsTools));
  const supportsJsonSchema = majorityBoolean(models.map((model) => model.supportsJsonSchema));
  const supportsReasoning = majorityBoolean(models.map((model) => model.supportsReasoning));
  const supportsPromptCache = majorityBoolean(models.map((model) => model.supportsPromptCache));

  return {
    id: first.id,
    ...(displayName === undefined ? {} : { displayName }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
    ...(supportsJsonSchema === undefined ? {} : { supportsJsonSchema }),
    ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
    ...(supportsPromptCache === undefined ? {} : { supportsPromptCache }),
  };
}

/**
 * 在目录中查找模型：
 * 1. Provider 内精确 / 去前缀 / 归一化
 * 2. 全局精确 / 归一化（多 Provider 时取多数值）
 */
export function findCatalogModel(
  catalog: CatalogData,
  provider: ProviderRecord,
  modelId: string,
): CatalogMatch | undefined {
  const index = indexOf(catalog);
  const candidates = providerCatalogIds(provider, catalog);
  const stripped = stripVendorPrefix(modelId);
  const normalized = normalizeModelId(modelId);

  for (const providerId of candidates) {
    const exact = index.exactByProvider.get(providerId)?.get(modelId.toLowerCase());
    if (exact !== undefined) return { model: exact, providerId, method: "provider-exact" };
    if (stripped !== modelId) {
      const strippedExact = index.exactByProvider.get(providerId)?.get(stripped.toLowerCase());
      if (strippedExact !== undefined) {
        return { model: strippedExact, providerId, method: "provider-exact" };
      }
    }
    const normalizedMatch = index.normalizedByProvider.get(providerId)?.get(normalized);
    if (normalizedMatch !== undefined) {
      return { model: normalizedMatch, providerId, method: "provider-normalized" };
    }
  }

  const exactGlobal = index.exactGlobal.get(modelId.toLowerCase()) ?? index.exactGlobal.get(stripped.toLowerCase());
  if (exactGlobal !== undefined && exactGlobal.length > 0) {
    if (exactGlobal.length === 1 && exactGlobal[0] !== undefined) {
      return { model: exactGlobal[0].model, providerId: exactGlobal[0].providerId, method: "global-exact" };
    }
    return { model: aggregateCatalogModels(exactGlobal), method: "global-exact" };
  }

  const normalizedGlobal = index.normalizedGlobal.get(normalized);
  if (normalizedGlobal !== undefined && normalizedGlobal.length > 0) {
    if (normalizedGlobal.length === 1 && normalizedGlobal[0] !== undefined) {
      return {
        model: normalizedGlobal[0].model,
        providerId: normalizedGlobal[0].providerId,
        method: "global-normalized",
      };
    }
    return { model: aggregateCatalogModels(normalizedGlobal), method: "global-normalized" };
  }

  return undefined;
}
