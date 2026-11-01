import type { ModelCapabilities, OutputModality } from "../ir/request";
import type { Modality, ProtocolId } from "../ir/common";
import type { CompiledGlob } from "../router/glob";
import type { ComboRecord, RouteTargetSpec, StickyConfig, StrategyId } from "../combo/types";

export type ProviderType = "OPENAI_COMPATIBLE" | "ANTHROPIC" | "GOOGLE_GEMINI" | "CUSTOM";

export const PROVIDER_TYPES: readonly ProviderType[] = [
  "OPENAI_COMPATIBLE",
  "ANTHROPIC",
  "GOOGLE_GEMINI",
  "CUSTOM",
];

export interface RetryPolicyRecord {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: "full" | "none";
  retryStatuses: number[];
  retryOnNetworkError: boolean;
  retryOnTimeout: "never" | "before_first_byte" | "always";
  respectRetryAfter: boolean;
}

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  protocol: ProtocolId;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  weight: number;
  customHeaders: Record<string, string>;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  maxRetries: number;
  retry: RetryPolicyRecord | null;
  proxyConfig: Record<string, unknown> | null;
  extraConfig: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type AccountHealth = "unknown" | "healthy" | "degraded" | "unhealthy";

export interface ProviderAccountRecord {
  id: string;
  providerId: string;
  name: string;
  encryptedKey?: EncryptedCredential;
  secretRef?: string;
  weight: number;
  priority: number;
  enabled: boolean;
  healthStatus: AccountHealth;
  cooldownUntil?: number;
  consecutiveFailures: number;
  lastCheckedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ModelPricing {
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice?: number;
  reasoningPrice?: number;
  currency: string;
  unit: "per_million_tokens";
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelId: string;
  upstreamModelId: string;
  displayName?: string;
  inputModalities: Modality[];
  outputModalities: OutputModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  enabled: boolean;
  source: "manual" | "sync";
  createdAt: number;
  updatedAt: number;
}

/** @deprecated 仅用于读取旧配置快照中的别名；新配置统一为单节点 Combo。 */
export interface LegacyAliasRecord {
  id: string;
  name: string;
  target: RouteTargetSpec;
  description?: string;
  enabled: boolean;
  priority: number;
  createdAt: number;
  updatedAt: number;
}

/** @deprecated 仅用于读取旧配置快照中的通配符规则；新配置统一为 glob Combo。 */
export interface LegacyWildcardRule {
  id: string;
  pattern: string;
  strategy: StrategyId;
  targets: RouteTargetSpec[];
  priority: number;
  enabled: boolean;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PricingRecord {
  id: string;
  providerId: string;
  modelId: string;
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice?: number;
  reasoningPrice?: number;
  currency: string;
  effectiveFrom?: number;
  createdAt: number;
}

export interface RuntimeSettings {
  gatewayName: string;
  compatPolicy: "strict" | "warn" | "drop" | "passthrough";
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxStreamEventBytes: number;
  maxComboDepth: number;
  maxComboNodes: number;
  maxComboConcurrency: number;
  requestTimeoutMs: number;
  retentionDays: number;
  corsAllowedOrigins: string[];
  configCacheTtlMs: number;
}

export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  gatewayName: "FufuGateway",
  compatPolicy: "warn",
  maxBodyBytes: 4 * 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxStreamEventBytes: 1024 * 1024,
  maxComboDepth: 16,
  maxComboNodes: 256,
  maxComboConcurrency: 8,
  requestTimeoutMs: 300_000,
  retentionDays: 30,
  corsAllowedOrigins: [],
  configCacheTtlMs: 60_000,
};

export interface ConfigValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  entityType?: string;
  entityId?: string;
}

/** 可序列化的配置快照（存入 KV 与 config_versions）。 */
export interface ConfigSnapshotData {
  providers: ProviderRecord[];
  accounts: ProviderAccountRecord[];
  models: ModelRecord[];
  /** 旧快照可能仍包含别名，运行时合成为单节点 Combo。 */
  aliases?: LegacyAliasRecord[];
  /** 旧快照可能仍包含通配符规则，运行时合成为 glob Combo。 */
  wildcards?: LegacyWildcardRule[];
  combos: ComboRecord[];
  pricing: PricingRecord[];
  settings: RuntimeSettings;
}

export interface ConfigSnapshot {
  version: number;
  checksum: string;
  createdAt: number;
  createdBy?: string;
  data: ConfigSnapshotData;
}

export interface CompiledGlobCombo {
  combo: ComboRecord;
  compiled: CompiledGlob;
}

/** 运行期配置：快照 + 预构建索引 + 编译后的通配符。 */
export interface RuntimeConfig {
  version: number;
  checksum: string;
  createdAt: number;
  source: "kv" | "d1-fallback";
  data: ConfigSnapshotData;
  providersById: Map<string, ProviderRecord>;
  providersByName: Map<string, ProviderRecord>;
  modelsById: Map<string, ModelRecord>;
  modelsByModelId: Map<string, ModelRecord[]>;
  modelsByProvider: Map<string, ModelRecord[]>;
  modelByProviderModel: Map<string, ModelRecord>;
  combosByName: Map<string, ComboRecord>;
  globCombos: CompiledGlobCombo[];
  accountsByProvider: Map<string, ProviderAccountRecord[]>;
  pricingByProviderModel: Map<string, PricingRecord>;
  settings: RuntimeSettings;
}

export type { ComboRecord, RouteTargetSpec, StickyConfig, StrategyId };

export function providerModelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}
