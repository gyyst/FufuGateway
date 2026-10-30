import { GatewayError } from "../core/errors";
import { asString, isRecord, type JsonObject } from "../core/json";
import { newId } from "../core/ids";
import type { ModelCapabilities, OutputModality } from "../ir/request";
import type { Modality } from "../ir/common";
import type { ProtocolId } from "../ir/common";
import type { ComboNodeSpec, ComboRecord, RouteTargetSpec, StickyConfig, StrategyId } from "../combo/types";
import type {
  AccountHealth,
  AliasRecord,
  EncryptedCredential,
  ModelPricing,
  ModelRecord,
  PricingRecord,
  ProviderAccountRecord,
  ProviderRecord,
  ProviderType,
  RetryPolicyRecord,
  RuntimeSettings,
  WildcardRuleRecord,
} from "./types";
import { DEFAULT_RUNTIME_SETTINGS, providerModelKey } from "./types";

// ---------------------------------------------------------------------------
// JSON 解析
// ---------------------------------------------------------------------------

function parseJson(text: string | null, field: string): unknown {
  if (text === null || text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Stored configuration field "${field}" contains invalid JSON`,
    });
  }
}

function parseJsonObject(text: string | null, field: string): JsonObject {
  const value = parseJson(text, field);
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Stored configuration field "${field}" must be a JSON object`,
    });
  }
  return value;
}

function parseJsonArray(text: string | null, field: string): unknown[] {
  const value = parseJson(text, field);
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Stored configuration field "${field}" must be a JSON array`,
    });
  }
  return value;
}

function parseStringArray(text: string | null, field: string): string[] {
  return parseJsonArray(text, field).map((item) => {
    if (typeof item !== "string") {
      throw new GatewayError({
        code: "CONFIG_INVALID",
        message: `Stored configuration field "${field}" must contain only strings`,
      });
    }
    return item;
  });
}

function parseRouteTarget(value: unknown, field: string): RouteTargetSpec {
  if (typeof value === "string") return value;
  if (isRecord(value)) {
    const model = asString(value["model"]);
    if (model !== undefined) return { model };
    const alias = asString(value["alias"]);
    if (alias !== undefined) return { alias };
    const combo = asString(value["combo"]);
    if (combo !== undefined) return { combo };
    const wildcard = asString(value["wildcard"]);
    if (wildcard !== undefined) return { wildcard };
  }
  throw new GatewayError({ code: "CONFIG_INVALID", message: `${field} is not a valid route target` });
}

// ---------------------------------------------------------------------------
// 行类型
// ---------------------------------------------------------------------------

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  protocol: string;
  base_url: string;
  enabled: number;
  priority: number;
  weight: number;
  custom_headers: string | null;
  timeout_ms: number;
  first_token_timeout_ms: number;
  idle_timeout_ms: number;
  max_retries: number;
  retry_config: string | null;
  proxy_config: string | null;
  extra_config: string | null;
  created_at: number;
  updated_at: number;
}

interface AccountRow {
  id: string;
  provider_id: string;
  name: string;
  api_key_enc: string | null;
  api_key_iv: string | null;
  api_key_tag: string | null;
  secret_ref: string | null;
  weight: number;
  priority: number;
  enabled: number;
  health_status: string;
  cooldown_until: number | null;
  consecutive_failures: number;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  upstream_model_id: string;
  display_name: string | null;
  input_modalities: string;
  output_modalities: string;
  context_window: number | null;
  max_output_tokens: number | null;
  supports_stream: number;
  supports_tools: number;
  supports_parallel_tools: number;
  supports_json_schema: number;
  supports_reasoning: number;
  supports_vision: number;
  supports_audio: number;
  supports_video: number;
  supports_prompt_cache: number;
  input_price: number | null;
  output_price: number | null;
  cached_input_price: number | null;
  reasoning_price: number | null;
  price_unit: string;
  enabled: number;
  source: string;
  created_at: number;
  updated_at: number;
}

interface AliasRow {
  id: string;
  name: string;
  target: string;
  description: string | null;
  enabled: number;
  priority: number;
  created_at: number;
  updated_at: number;
}

interface WildcardRow {
  id: string;
  pattern: string;
  strategy: string;
  targets: string;
  priority: number;
  enabled: number;
  description: string | null;
  created_at: number;
  updated_at: number;
}

interface ComboRow {
  id: string;
  name: string;
  description: string | null;
  strategy: string;
  nodes: string;
  judge_model: string | null;
  timeout_ms: number | null;
  max_concurrency: number | null;
  sticky: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface PricingRow {
  id: string;
  provider_id: string;
  model_id: string;
  input_price: number;
  output_price: number;
  cached_input_price: number | null;
  reasoning_price: number | null;
  currency: string;
  effective_from: number | null;
  created_at: number;
}

interface SettingRow {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// 映射
// ---------------------------------------------------------------------------

export function mapProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ProviderType,
    protocol: row.protocol as ProtocolId,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    priority: row.priority,
    weight: row.weight,
    customHeaders: parseJsonObject(row.custom_headers, "providers.custom_headers") as Record<string, string>,
    timeoutMs: row.timeout_ms,
    firstTokenTimeoutMs: row.first_token_timeout_ms,
    idleTimeoutMs: row.idle_timeout_ms,
    maxRetries: row.max_retries,
    retry: (parseJson(row.retry_config, "providers.retry_config") as RetryPolicyRecord | undefined) ?? null,
    proxyConfig: (parseJson(row.proxy_config, "providers.proxy_config") as Record<string, unknown> | undefined) ?? null,
    extraConfig: parseJsonObject(row.extra_config, "providers.extra_config"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAccount(row: AccountRow): ProviderAccountRecord {
  const encryptedKey =
    row.api_key_enc !== null && row.api_key_iv !== null && row.api_key_tag !== null
      ? { ciphertext: row.api_key_enc, iv: row.api_key_iv, tag: row.api_key_tag }
      : undefined;
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    ...(encryptedKey === undefined ? {} : { encryptedKey }),
    ...(row.secret_ref === null ? {} : { secretRef: row.secret_ref }),
    weight: row.weight,
    priority: row.priority,
    enabled: row.enabled === 1,
    healthStatus: row.health_status as AccountHealth,
    ...(row.cooldown_until === null ? {} : { cooldownUntil: row.cooldown_until }),
    consecutiveFailures: row.consecutive_failures,
    ...(row.last_checked_at === null ? {} : { lastCheckedAt: row.last_checked_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildCapabilities(row: ModelRow): ModelCapabilities {
  const inputModalities = parseStringArray(row.input_modalities, "models.input_modalities") as Modality[];
  const outputModalities = parseStringArray(row.output_modalities, "models.output_modalities") as OutputModality[];
  return {
    inputModalities,
    outputModalities,
    ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
    ...(row.max_output_tokens === null ? {} : { maxOutputTokens: row.max_output_tokens }),
    supportsStream: row.supports_stream === 1,
    supportsTools: row.supports_tools === 1,
    supportsParallelTools: row.supports_parallel_tools === 1,
    supportsJsonSchema: row.supports_json_schema === 1,
    supportsReasoning: row.supports_reasoning === 1,
    supportsVision: row.supports_vision === 1,
    supportsAudio: row.supports_audio === 1,
    supportsVideo: row.supports_video === 1,
    supportsPromptCache: row.supports_prompt_cache === 1,
  };
}

function buildPricing(row: ModelRow): ModelPricing {
  return {
    inputPrice: row.input_price ?? 0,
    outputPrice: row.output_price ?? 0,
    ...(row.cached_input_price === null ? {} : { cachedInputPrice: row.cached_input_price }),
    ...(row.reasoning_price === null ? {} : { reasoningPrice: row.reasoning_price }),
    currency: "USD",
    unit: "per_million_tokens",
  };
}

export function mapModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    upstreamModelId: row.upstream_model_id,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    inputModalities: parseStringArray(row.input_modalities, "models.input_modalities") as Modality[],
    outputModalities: parseStringArray(row.output_modalities, "models.output_modalities") as OutputModality[],
    ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
    ...(row.max_output_tokens === null ? {} : { maxOutputTokens: row.max_output_tokens }),
    capabilities: buildCapabilities(row),
    pricing: buildPricing(row),
    enabled: row.enabled === 1,
    source: row.source === "sync" ? "sync" : "manual",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAlias(row: AliasRow): AliasRecord {
  return {
    id: row.id,
    name: row.name,
    target: parseRouteTarget(parseJson(row.target, "model_aliases.target"), "model_aliases.target"),
    ...(row.description === null ? {} : { description: row.description }),
    enabled: row.enabled === 1,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapWildcard(row: WildcardRow): WildcardRuleRecord {
  const targets = parseJsonArray(row.targets, "wildcard_rules.targets").map((target, index) =>
    parseRouteTarget(target, `wildcard_rules.targets[${index}]`),
  );
  return {
    id: row.id,
    pattern: row.pattern,
    strategy: row.strategy as StrategyId,
    targets,
    priority: row.priority,
    enabled: row.enabled === 1,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCombo(row: ComboRow): ComboRecord {
  const nodes = parseJsonArray(row.nodes, "combos.nodes") as ComboNodeSpec[];
  const sticky = parseJson(row.sticky, "combos.sticky") as StickyConfig | undefined;
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    strategy: row.strategy as StrategyId,
    nodes,
    ...(row.judge_model === null ? {} : { judgeModel: row.judge_model }),
    ...(row.timeout_ms === null ? {} : { timeoutMs: row.timeout_ms }),
    ...(row.max_concurrency === null ? {} : { maxConcurrency: row.max_concurrency }),
    ...(sticky === undefined ? {} : { sticky }),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapPricing(row: PricingRow): PricingRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    inputPrice: row.input_price,
    outputPrice: row.output_price,
    ...(row.cached_input_price === null ? {} : { cachedInputPrice: row.cached_input_price }),
    ...(row.reasoning_price === null ? {} : { reasoningPrice: row.reasoning_price }),
    currency: row.currency,
    ...(row.effective_from === null ? {} : { effectiveFrom: row.effective_from }),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

export async function listProviders(db: D1Database): Promise<ProviderRecord[]> {
  const rows = await db.prepare("SELECT * FROM providers ORDER BY name ASC").all<ProviderRow>();
  return rows.results.map(mapProvider);
}

export async function getProvider(db: D1Database, id: string): Promise<ProviderRecord | undefined> {
  const row = await db.prepare("SELECT * FROM providers WHERE id = ?").bind(id).first<ProviderRow>();
  return row === null ? undefined : mapProvider(row);
}

export async function requireProviderExists(db: D1Database, id: string): Promise<ProviderRecord> {
  const provider = await getProvider(db, id);
  if (provider === undefined) {
    throw new GatewayError({ code: "PROVIDER_NOT_FOUND", message: `Provider "${id}" not found` });
  }
  return provider;
}

export async function listAccounts(db: D1Database, providerId?: string): Promise<ProviderAccountRecord[]> {
  const query = providerId
    ? db.prepare("SELECT * FROM provider_accounts WHERE provider_id = ? ORDER BY priority DESC, weight DESC, id ASC").bind(providerId)
    : db.prepare("SELECT * FROM provider_accounts ORDER BY provider_id ASC, priority DESC, weight DESC, id ASC");
  const rows = await query.all<AccountRow>();
  return rows.results.map(mapAccount);
}

export async function getAccount(db: D1Database, id: string): Promise<ProviderAccountRecord | undefined> {
  const row = await db.prepare("SELECT * FROM provider_accounts WHERE id = ?").bind(id).first<AccountRow>();
  return row === null ? undefined : mapAccount(row);
}

export async function listModels(db: D1Database): Promise<ModelRecord[]> {
  const rows = await db.prepare("SELECT * FROM models ORDER BY model_id ASC, provider_id ASC").all<ModelRow>();
  return rows.results.map(mapModel);
}

export async function getModel(db: D1Database, id: string): Promise<ModelRecord | undefined> {
  const row = await db.prepare("SELECT * FROM models WHERE id = ?").bind(id).first<ModelRow>();
  return row === null ? undefined : mapModel(row);
}

export async function listAliases(db: D1Database): Promise<AliasRecord[]> {
  const rows = await db.prepare("SELECT * FROM model_aliases ORDER BY name ASC").all<AliasRow>();
  return rows.results.map(mapAlias);
}

export async function getAlias(db: D1Database, id: string): Promise<AliasRecord | undefined> {
  const row = await db.prepare("SELECT * FROM model_aliases WHERE id = ?").bind(id).first<AliasRow>();
  return row === null ? undefined : mapAlias(row);
}

export async function listWildcards(db: D1Database): Promise<WildcardRuleRecord[]> {
  const rows = await db.prepare("SELECT * FROM wildcard_rules ORDER BY priority DESC, pattern ASC").all<WildcardRow>();
  return rows.results.map(mapWildcard);
}

export async function getWildcard(db: D1Database, id: string): Promise<WildcardRuleRecord | undefined> {
  const row = await db.prepare("SELECT * FROM wildcard_rules WHERE id = ?").bind(id).first<WildcardRow>();
  return row === null ? undefined : mapWildcard(row);
}

export async function listCombos(db: D1Database): Promise<ComboRecord[]> {
  const rows = await db.prepare("SELECT * FROM combos ORDER BY name ASC").all<ComboRow>();
  return rows.results.map(mapCombo);
}

export async function getCombo(db: D1Database, id: string): Promise<ComboRecord | undefined> {
  const row = await db.prepare("SELECT * FROM combos WHERE id = ?").bind(id).first<ComboRow>();
  return row === null ? undefined : mapCombo(row);
}

export async function listPricing(db: D1Database): Promise<PricingRecord[]> {
  const rows = await db.prepare("SELECT * FROM pricing ORDER BY provider_id ASC, model_id ASC").all<PricingRow>();
  return rows.results.map(mapPricing);
}

/** 一次性加载构建配置快照所需的全部数据。 */
export async function loadConfigData(db: D1Database): Promise<import("./types").ConfigSnapshotData> {
  const [providers, accounts, models, aliases, wildcards, combos, pricing, settings] = await Promise.all([
    listProviders(db),
    listAccounts(db),
    listModels(db),
    listAliases(db),
    listWildcards(db),
    listCombos(db),
    listPricing(db),
    loadSettings(db),
  ]);
  return { providers, accounts, models, aliases, wildcards, combos, pricing, settings };
}

export async function loadSettings(db: D1Database): Promise<RuntimeSettings> {
  const rows = await db.prepare("SELECT key, value FROM system_settings").all<SettingRow>();
  const map = new Map(rows.results.map((row) => [row.key, row.value]));
  const read = (key: string): unknown => {
    const raw = map.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new GatewayError({ code: "CONFIG_INVALID", message: `System setting "${key}" has invalid JSON` });
    }
  };
  const readNumber = (key: string, fallback: number): number => {
    const value = read(key);
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const readString = (key: string, fallback: string): string => {
    const value = read(key);
    return typeof value === "string" ? value : fallback;
  };
  const readStringArray = (key: string): string[] => {
    const value = read(key);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  };
  const policy = readString("compat.default_policy", DEFAULT_RUNTIME_SETTINGS.compatPolicy);
  const compatPolicy =
    policy === "strict" || policy === "warn" || policy === "drop" || policy === "passthrough"
      ? policy
      : DEFAULT_RUNTIME_SETTINGS.compatPolicy;
  return {
    gatewayName: readString("gateway.name", DEFAULT_RUNTIME_SETTINGS.gatewayName),
    compatPolicy,
    maxBodyBytes: readNumber("limits.max_body_bytes", DEFAULT_RUNTIME_SETTINGS.maxBodyBytes),
    maxResponseBytes: readNumber("limits.max_response_bytes", DEFAULT_RUNTIME_SETTINGS.maxResponseBytes),
    maxStreamEventBytes: readNumber("limits.max_stream_event_bytes", DEFAULT_RUNTIME_SETTINGS.maxStreamEventBytes),
    maxComboDepth: readNumber("limits.max_combo_depth", DEFAULT_RUNTIME_SETTINGS.maxComboDepth),
    maxComboNodes: readNumber("limits.max_combo_nodes", DEFAULT_RUNTIME_SETTINGS.maxComboNodes),
    maxComboConcurrency: readNumber("limits.max_combo_concurrency", DEFAULT_RUNTIME_SETTINGS.maxComboConcurrency),
    requestTimeoutMs: readNumber("timeouts.request_ms", DEFAULT_RUNTIME_SETTINGS.requestTimeoutMs),
    retentionDays: readNumber("logging.retention_days", DEFAULT_RUNTIME_SETTINGS.retentionDays),
    corsAllowedOrigins: readStringArray("cors.allowed_origins"),
    configCacheTtlMs: readNumber("config.cache_ttl_ms", DEFAULT_RUNTIME_SETTINGS.configCacheTtlMs),
  };
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now();
}

export interface CreateProviderInput {
  name: string;
  type: ProviderType;
  protocol: ProtocolId;
  baseUrl: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRetries?: number;
  retry?: RetryPolicyRecord | null;
  proxyConfig?: Record<string, unknown> | null;
  extraConfig?: Record<string, unknown>;
}

export async function createProvider(db: D1Database, input: CreateProviderInput): Promise<ProviderRecord> {
  const timestamp = now();
  const record: ProviderRecord = {
    id: newId("prv"),
    name: input.name,
    type: input.type,
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    weight: input.weight ?? 1,
    customHeaders: input.customHeaders ?? {},
    timeoutMs: input.timeoutMs ?? 60_000,
    firstTokenTimeoutMs: input.firstTokenTimeoutMs ?? 20_000,
    idleTimeoutMs: input.idleTimeoutMs ?? 60_000,
    maxRetries: input.maxRetries ?? 2,
    retry: input.retry ?? null,
    proxyConfig: input.proxyConfig ?? null,
    extraConfig: input.extraConfig ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await replaceProvider(db, record);
  return record;
}

export async function replaceProvider(db: D1Database, record: ProviderRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO providers
        (id, name, type, protocol, base_url, enabled, priority, weight, custom_headers,
         timeout_ms, first_token_timeout_ms, idle_timeout_ms, max_retries, retry_config,
         proxy_config, extra_config, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.name,
      record.type,
      record.protocol,
      record.baseUrl,
      record.enabled ? 1 : 0,
      record.priority,
      record.weight,
      JSON.stringify(record.customHeaders),
      record.timeoutMs,
      record.firstTokenTimeoutMs,
      record.idleTimeoutMs,
      record.maxRetries,
      record.retry === null ? null : JSON.stringify(record.retry),
      record.proxyConfig === null ? null : JSON.stringify(record.proxyConfig),
      JSON.stringify(record.extraConfig),
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

export async function deleteProvider(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM provider_accounts WHERE provider_id = ?").bind(id),
    db.prepare("DELETE FROM models WHERE provider_id = ?").bind(id),
    db.prepare("DELETE FROM pricing WHERE provider_id = ?").bind(id),
    db.prepare("DELETE FROM providers WHERE id = ?").bind(id),
  ]);
}

export interface CreateAccountInput {
  providerId: string;
  name: string;
  encryptedKey?: EncryptedCredential;
  secretRef?: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
}

export async function createAccount(db: D1Database, input: CreateAccountInput): Promise<ProviderAccountRecord> {
  const timestamp = now();
  const record: ProviderAccountRecord = {
    id: newId("acc"),
    providerId: input.providerId,
    name: input.name,
    ...(input.encryptedKey === undefined ? {} : { encryptedKey: input.encryptedKey }),
    ...(input.secretRef === undefined ? {} : { secretRef: input.secretRef }),
    weight: input.weight ?? 1,
    priority: input.priority ?? 100,
    enabled: input.enabled ?? true,
    healthStatus: "unknown",
    consecutiveFailures: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await replaceAccount(db, record);
  return record;
}

export async function replaceAccount(db: D1Database, record: ProviderAccountRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO provider_accounts
        (id, provider_id, name, api_key_enc, api_key_iv, api_key_tag, secret_ref, weight, priority,
         enabled, health_status, cooldown_until, consecutive_failures, last_checked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.providerId,
      record.name,
      record.encryptedKey?.ciphertext ?? null,
      record.encryptedKey?.iv ?? null,
      record.encryptedKey?.tag ?? null,
      record.secretRef ?? null,
      record.weight,
      record.priority,
      record.enabled ? 1 : 0,
      record.healthStatus,
      record.cooldownUntil ?? null,
      record.consecutiveFailures,
      record.lastCheckedAt ?? null,
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

export async function deleteAccount(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM provider_accounts WHERE id = ?").bind(id).run();
}

export interface CreateModelInput {
  providerId: string;
  modelId: string;
  upstreamModelId?: string;
  displayName?: string;
  inputModalities?: Modality[];
  outputModalities?: OutputModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  inputPrice?: number;
  outputPrice?: number;
  cachedInputPrice?: number;
  reasoningPrice?: number;
  enabled?: boolean;
  source?: "manual" | "sync";
}

export async function createModel(db: D1Database, input: CreateModelInput): Promise<ModelRecord> {
  const timestamp = now();
  const capabilities = input.capabilities ?? {};
  const inputModalities = input.inputModalities ?? capabilities.inputModalities ?? ["text"];
  const outputModalities = input.outputModalities ?? capabilities.outputModalities ?? ["text"];
  const contextWindow = input.contextWindow ?? capabilities.contextWindow;
  const maxOutputTokens = input.maxOutputTokens ?? capabilities.maxOutputTokens;
  const record: ModelRecord = {
    id: newId("mdl"),
    providerId: input.providerId,
    modelId: input.modelId,
    upstreamModelId: input.upstreamModelId ?? input.modelId,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    inputModalities,
    outputModalities,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    capabilities: {
      inputModalities,
      outputModalities,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      supportsStream: capabilities.supportsStream ?? true,
      supportsTools: capabilities.supportsTools ?? false,
      supportsParallelTools: capabilities.supportsParallelTools ?? false,
      supportsJsonSchema: capabilities.supportsJsonSchema ?? false,
      supportsReasoning: capabilities.supportsReasoning ?? false,
      supportsVision: capabilities.supportsVision ?? false,
      supportsAudio: capabilities.supportsAudio ?? false,
      supportsVideo: capabilities.supportsVideo ?? false,
      supportsPromptCache: capabilities.supportsPromptCache ?? false,
    },
    pricing: {
      inputPrice: input.inputPrice ?? 0,
      outputPrice: input.outputPrice ?? 0,
      ...(input.cachedInputPrice === undefined ? {} : { cachedInputPrice: input.cachedInputPrice }),
      ...(input.reasoningPrice === undefined ? {} : { reasoningPrice: input.reasoningPrice }),
      currency: "USD",
      unit: "per_million_tokens",
    },
    enabled: input.enabled ?? true,
    source: input.source ?? "manual",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await replaceModel(db, record);
  return record;
}

export async function replaceModel(db: D1Database, record: ModelRecord): Promise<void> {
  const capabilities = record.capabilities;
  await db
    .prepare(
      `INSERT OR REPLACE INTO models
        (id, provider_id, model_id, upstream_model_id, display_name, input_modalities, output_modalities,
         context_window, max_output_tokens, supports_stream, supports_tools, supports_parallel_tools,
         supports_json_schema, supports_reasoning, supports_vision, supports_audio, supports_video,
         supports_prompt_cache, input_price, output_price, cached_input_price, reasoning_price,
         price_unit, enabled, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.providerId,
      record.modelId,
      record.upstreamModelId,
      record.displayName ?? null,
      JSON.stringify(record.inputModalities),
      JSON.stringify(record.outputModalities),
      record.contextWindow ?? null,
      record.maxOutputTokens ?? null,
      capabilities.supportsStream ? 1 : 0,
      capabilities.supportsTools ? 1 : 0,
      capabilities.supportsParallelTools ? 1 : 0,
      capabilities.supportsJsonSchema ? 1 : 0,
      capabilities.supportsReasoning ? 1 : 0,
      capabilities.supportsVision ? 1 : 0,
      capabilities.supportsAudio ? 1 : 0,
      capabilities.supportsVideo ? 1 : 0,
      capabilities.supportsPromptCache ? 1 : 0,
      record.pricing.inputPrice,
      record.pricing.outputPrice,
      record.pricing.cachedInputPrice ?? null,
      record.pricing.reasoningPrice ?? null,
      record.pricing.unit,
      record.enabled ? 1 : 0,
      record.source,
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

export async function deleteModel(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM models WHERE id = ?").bind(id).run();
}

export interface CreateAliasInput {
  name: string;
  target: RouteTargetSpec;
  description?: string;
  enabled?: boolean;
  priority?: number;
}

export async function createAlias(db: D1Database, input: CreateAliasInput): Promise<AliasRecord> {
  const timestamp = now();
  const record: AliasRecord = {
    id: newId("als"),
    name: input.name,
    target: input.target,
    ...(input.description === undefined ? {} : { description: input.description }),
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await replaceAlias(db, record);
  return record;
}

export async function replaceAlias(db: D1Database, record: AliasRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO model_aliases
        (id, name, target, description, enabled, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.name,
      JSON.stringify(record.target),
      record.description ?? null,
      record.enabled ? 1 : 0,
      record.priority,
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

export async function deleteAlias(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM model_aliases WHERE id = ?").bind(id).run();
}

export interface CreateWildcardInput {
  pattern: string;
  strategy: StrategyId;
  targets: RouteTargetSpec[];
  priority?: number;
  enabled?: boolean;
  description?: string;
}

export async function createWildcard(db: D1Database, input: CreateWildcardInput): Promise<WildcardRuleRecord> {
  const timestamp = now();
  const record: WildcardRuleRecord = {
    id: newId("wld"),
    pattern: input.pattern,
    strategy: input.strategy,
    targets: input.targets,
    priority: input.priority ?? 100,
    enabled: input.enabled ?? true,
    ...(input.description === undefined ? {} : { description: input.description }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await replaceWildcard(db, record);
  return record;
}

export async function replaceWildcard(db: D1Database, record: WildcardRuleRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO wildcard_rules
        (id, pattern, strategy, targets, priority, enabled, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.pattern,
      record.strategy,
      JSON.stringify(record.targets),
      record.priority,
      record.enabled ? 1 : 0,
      record.description ?? null,
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

export async function deleteWildcard(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM wildcard_rules WHERE id = ?").bind(id).run();
}

export interface CreateComboInput {
  name: string;
  strategy: StrategyId;
  nodes: ComboNodeSpec[];
  judgeModel?: string;
  description?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  sticky?: StickyConfig;
  enabled?: boolean;
}

export async function createCombo(db: D1Database, input: CreateComboInput): Promise<ComboRecord> {
  const timestamp = now();
  const record: ComboRecord = {
    id: newId("cmb"),
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    strategy: input.strategy,
    nodes: input.nodes,
    ...(input.judgeModel === undefined ? {} : { judgeModel: input.judgeModel }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.sticky === undefined ? {} : { sticky: input.sticky }),
    enabled: input.enabled ?? true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await replaceCombo(db, record);
  return record;
}

export async function replaceCombo(db: D1Database, record: ComboRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO combos
        (id, name, description, strategy, nodes, judge_model, timeout_ms, max_concurrency, sticky, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.name,
      record.description ?? null,
      record.strategy,
      JSON.stringify(record.nodes),
      record.judgeModel ?? null,
      record.timeoutMs ?? null,
      record.maxConcurrency ?? null,
      record.sticky === undefined ? null : JSON.stringify(record.sticky),
      record.enabled ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    )
    .run();
}

export async function deleteCombo(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM combos WHERE id = ?").bind(id).run();
}

export interface CreatePricingInput {
  providerId: string;
  modelId: string;
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice?: number;
  reasoningPrice?: number;
  currency?: string;
  effectiveFrom?: number;
}

export async function createPricing(db: D1Database, input: CreatePricingInput): Promise<PricingRecord> {
  const record: PricingRecord = {
    id: newId("prc"),
    providerId: input.providerId,
    modelId: input.modelId,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
    ...(input.cachedInputPrice === undefined ? {} : { cachedInputPrice: input.cachedInputPrice }),
    ...(input.reasoningPrice === undefined ? {} : { reasoningPrice: input.reasoningPrice }),
    currency: input.currency ?? "USD",
    ...(input.effectiveFrom === undefined ? {} : { effectiveFrom: input.effectiveFrom }),
    createdAt: now(),
  };
  await db
    .prepare(
      `INSERT OR REPLACE INTO pricing
        (id, provider_id, model_id, input_price, output_price, cached_input_price, reasoning_price,
         currency, effective_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.providerId,
      record.modelId,
      record.inputPrice,
      record.outputPrice,
      record.cachedInputPrice ?? null,
      record.reasoningPrice ?? null,
      record.currency,
      record.effectiveFrom ?? null,
      record.createdAt,
    )
    .run();
  return record;
}

export async function deletePricing(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM pricing WHERE id = ?").bind(id).run();
}

export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(key, JSON.stringify(value), now())
    .run();
}

export { providerModelKey };
