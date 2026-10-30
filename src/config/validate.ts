import { GatewayError } from "../core/errors";
import { HARD_MAX_COMBO_CONCURRENCY } from "../core/limits";
import { isProtocolId, PROTOCOL_IDS, type ProtocolId } from "../ir/common";
import { compileGlob } from "../router/glob";
import { ModelRouter } from "../router/resolver";
import { isStrategyId } from "../combo/types";
import { normalizeComboNodeTarget, validateCombos } from "../combo/validator";
import type { RouteTargetSpec } from "../combo/types";
import { sanitizeCustomHeaders, validateUpstreamBaseUrl } from "../security/ssrf";
import { buildRuntimeConfig } from "./runtime";
import type {
  ConfigSnapshotData,
  ConfigValidationIssue,
  ProviderType,
  RuntimeSettings,
} from "./types";

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const VIRTUAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;

const ALLOWED_PROTOCOLS: Record<ProviderType, readonly ProtocolId[]> = {
  OPENAI_COMPATIBLE: ["openai-chat", "openai-responses"],
  ANTHROPIC: ["anthropic"],
  GOOGLE_GEMINI: ["gemini"],
  CUSTOM: PROTOCOL_IDS,
};

export interface ValidateSnapshotOptions {
  allowPrivateUpstreams: boolean;
}

function issue(
  list: ConfigValidationIssue[],
  severity: "error" | "warning",
  code: string,
  message: string,
  entityType?: string,
  entityId?: string,
): void {
  list.push({ severity, code, message, ...(entityType === undefined ? {} : { entityType }), ...(entityId === undefined ? {} : { entityId }) });
}

function targetLabel(target: RouteTargetSpec): string {
  if (typeof target === "string") return target;
  if ("model" in target) return target.model;
  if ("alias" in target) return `alias:${target.alias}`;
  if ("combo" in target) return `combo:${target.combo}`;
  return `wildcard:${target.wildcard}`;
}

function validateSettings(settings: RuntimeSettings, issues: ConfigValidationIssue[]): void {
  if (settings.maxComboConcurrency > HARD_MAX_COMBO_CONCURRENCY) {
    issue(
      issues,
      "error",
      "CONFIG_INVALID",
      `limits.max_combo_concurrency must not exceed ${HARD_MAX_COMBO_CONCURRENCY}`,
      "settings",
      "limits.max_combo_concurrency",
    );
  }
  if (settings.maxComboDepth < 1 || settings.maxComboNodes < 1) {
    issue(issues, "error", "CONFIG_INVALID", "Combo depth and node limits must be positive", "settings");
  }
  if (settings.configCacheTtlMs < 0) {
    issue(issues, "error", "CONFIG_INVALID", "config.cache_ttl_ms must not be negative", "settings");
  }
  if (settings.compatPolicy !== "strict" && settings.compatPolicy !== "warn" && settings.compatPolicy !== "drop" && settings.compatPolicy !== "passthrough") {
    issue(issues, "error", "CONFIG_INVALID", "compat.default_policy is invalid", "settings");
  }
}

export function validateSnapshot(
  data: ConfigSnapshotData,
  options: ValidateSnapshotOptions,
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  const providerIds = new Set(data.providers.map((provider) => provider.id));
  const providerNames = new Set<string>();

  // Providers
  for (const provider of data.providers) {
    if (!PROVIDER_NAME.test(provider.name)) {
      issue(issues, "error", "CONFIG_INVALID", `Provider name "${provider.name}" is invalid`, "provider", provider.id);
    }
    const lower = provider.name.toLowerCase();
    if (providerNames.has(lower)) {
      issue(issues, "error", "CONFIG_INVALID", `Provider name "${provider.name}" is duplicated`, "provider", provider.id);
    }
    providerNames.add(lower);

    if (!isProtocolId(provider.protocol)) {
      issue(issues, "error", "CONFIG_INVALID", `Provider "${provider.name}" has an invalid protocol`, "provider", provider.id);
    } else {
      const allowed = ALLOWED_PROTOCOLS[provider.type];
      if (!allowed.includes(provider.protocol)) {
        issue(
          issues,
          "error",
          "CONFIG_INVALID",
          `Provider "${provider.name}" type ${provider.type} cannot use protocol ${provider.protocol}`,
          "provider",
          provider.id,
        );
      }
    }

    try {
      validateUpstreamBaseUrl(provider.baseUrl, { allowPrivate: options.allowPrivateUpstreams });
    } catch (error) {
      issue(
        issues,
        "error",
        "CONFIG_INVALID",
        `Provider "${provider.name}" baseUrl is not allowed: ${error instanceof Error ? error.message : "invalid URL"}`,
        "provider",
        provider.id,
      );
    }

    try {
      sanitizeCustomHeaders(provider.customHeaders);
    } catch (error) {
      issue(
        issues,
        "error",
        "CONFIG_INVALID",
        `Provider "${provider.name}" custom headers are invalid: ${error instanceof Error ? error.message : "invalid"}`,
        "provider",
        provider.id,
      );
    }

    if (provider.timeoutMs <= 0 || provider.firstTokenTimeoutMs <= 0 || provider.idleTimeoutMs <= 0) {
      issue(issues, "error", "CONFIG_INVALID", `Provider "${provider.name}" timeouts must be positive`, "provider", provider.id);
    }
    if (provider.priority < 0 || provider.weight < 1) {
      issue(issues, "error", "CONFIG_INVALID", `Provider "${provider.name}" priority/weight is invalid`, "provider", provider.id);
    }
    if (provider.retry) {
      if (
        provider.retry.maxAttempts < 1 ||
        provider.retry.baseDelayMs < 0 ||
        provider.retry.maxDelayMs < provider.retry.baseDelayMs ||
        !Array.isArray(provider.retry.retryStatuses)
      ) {
        issue(issues, "error", "CONFIG_INVALID", `Provider "${provider.name}" retry policy is invalid`, "provider", provider.id);
      }
    }

    const accounts = data.accounts.filter((account) => account.providerId === provider.id);
    if (accounts.length === 0) {
      issue(issues, "warning", "PROVIDER_NO_ACCOUNT", `Provider "${provider.name}" has no accounts`, "provider", provider.id);
    } else if (!accounts.some((account) => account.enabled)) {
      issue(issues, "warning", "PROVIDER_NO_ACCOUNT", `Provider "${provider.name}" has no enabled accounts`, "provider", provider.id);
    }
  }

  // Accounts
  for (const account of data.accounts) {
    if (!providerIds.has(account.providerId)) {
      issue(issues, "error", "CONFIG_INVALID", `Account "${account.name}" references an unknown provider`, "account", account.id);
    }
    if (account.encryptedKey === undefined && account.secretRef === undefined) {
      issue(issues, "error", "CONFIG_INVALID", `Account "${account.name}" has no credential configured`, "account", account.id);
    }
    if (account.encryptedKey !== undefined) {
      const key = account.encryptedKey;
      if (!key.ciphertext || !key.iv || !key.tag) {
        issue(issues, "error", "CONFIG_INVALID", `Account "${account.name}" has an incomplete credential`, "account", account.id);
      }
    }
    if (account.secretRef !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(account.secretRef)) {
      issue(issues, "error", "CONFIG_INVALID", `Account "${account.name}" secretRef is invalid`, "account", account.id);
    }
  }

  // Models
  const modelKeys = new Set<string>();
  for (const model of data.models) {
    if (!MODEL_ID.test(model.modelId)) {
      issue(issues, "error", "CONFIG_INVALID", `Model ID "${model.modelId}" is invalid`, "model", model.id);
    }
    if (model.upstreamModelId.trim() === "") {
      issue(issues, "error", "CONFIG_INVALID", `Model "${model.modelId}" has an empty upstream model ID`, "model", model.id);
    }
    if (!providerIds.has(model.providerId)) {
      issue(issues, "error", "CONFIG_INVALID", `Model "${model.modelId}" references an unknown provider`, "model", model.id);
    }
    const key = `${model.providerId}::${model.modelId}`;
    if (modelKeys.has(key)) {
      issue(issues, "error", "CONFIG_INVALID", `Model "${model.modelId}" is duplicated for its provider`, "model", model.id);
    }
    modelKeys.add(key);
    const pricing = model.pricing;
    if (
      pricing.inputPrice < 0 ||
      pricing.outputPrice < 0 ||
      (pricing.cachedInputPrice !== undefined && pricing.cachedInputPrice < 0) ||
      (pricing.reasoningPrice !== undefined && pricing.reasoningPrice < 0)
    ) {
      issue(issues, "error", "CONFIG_INVALID", `Model "${model.modelId}" has negative pricing`, "model", model.id);
    }
    if (model.capabilities.inputModalities.length === 0 || model.capabilities.outputModalities.length === 0) {
      issue(issues, "error", "CONFIG_INVALID", `Model "${model.modelId}" must declare modalities`, "model", model.id);
    }
    if (model.capabilities.supportsVision && !model.capabilities.inputModalities.includes("image")) {
      issue(issues, "warning", "CONFIG_INCONSISTENT", `Model "${model.modelId}" supports vision but has no image input modality`, "model", model.id);
    }
  }

  // 命名空间冲突
  const nativeModelIds = new Set(data.models.map((model) => model.modelId.toLowerCase()));
  const aliasNames = new Set<string>();
  const comboNames = new Set<string>();

  for (const alias of data.aliases) {
    const lower = alias.name.toLowerCase();
    if (!VIRTUAL_NAME.test(alias.name)) {
      issue(issues, "error", "CONFIG_INVALID", `Alias name "${alias.name}" is invalid (slashes are not allowed)`, "alias", alias.id);
    }
    if (aliasNames.has(lower)) {
      issue(issues, "error", "CONFIG_INVALID", `Alias "${alias.name}" is duplicated`, "alias", alias.id);
    }
    aliasNames.add(lower);
    if (nativeModelIds.has(lower)) {
      issue(issues, "error", "CONFIG_MODEL_CONFLICT", `Alias "${alias.name}" conflicts with a native model ID`, "alias", alias.id);
    }
    if (providerNames.has(lower)) {
      issue(issues, "error", "CONFIG_MODEL_CONFLICT", `Alias "${alias.name}" conflicts with a provider name`, "alias", alias.id);
    }
  }

  for (const combo of data.combos) {
    const lower = combo.name.toLowerCase();
    if (!VIRTUAL_NAME.test(combo.name)) {
      issue(issues, "error", "CONFIG_INVALID", `Combo name "${combo.name}" is invalid (slashes are not allowed)`, "combo", combo.id);
    }
    if (comboNames.has(lower)) {
      issue(issues, "error", "CONFIG_INVALID", `Combo "${combo.name}" is duplicated`, "combo", combo.id);
    }
    comboNames.add(lower);
    if (!isStrategyId(combo.strategy)) {
      issue(issues, "error", "CONFIG_INVALID", `Combo "${combo.name}" has an invalid strategy`, "combo", combo.id);
    }
    if (nativeModelIds.has(lower)) {
      issue(issues, "error", "CONFIG_MODEL_CONFLICT", `Combo "${combo.name}" conflicts with a native model ID`, "combo", combo.id);
    }
    if (providerNames.has(lower)) {
      issue(issues, "error", "CONFIG_MODEL_CONFLICT", `Combo "${combo.name}" conflicts with a provider name`, "combo", combo.id);
    }
    if (combo.sticky && (combo.sticky.ttlSeconds <= 0 || (combo.sticky.mode !== "round_robin" && combo.sticky.mode !== "first_available"))) {
      issue(issues, "error", "CONFIG_INVALID", `Combo "${combo.name}" has invalid sticky settings`, "combo", combo.id);
    }
  }

  for (const alias of data.aliases) {
    if (comboNames.has(alias.name.toLowerCase())) {
      issue(issues, "error", "CONFIG_MODEL_CONFLICT", `Alias "${alias.name}" conflicts with a combo name`, "alias", alias.id);
    }
  }

  // 编译通配符（无效规则不参与目标解析，避免干扰其余校验）
  for (const rule of data.wildcards) {
    try {
      compileGlob(rule.pattern);
    } catch (error) {
      issue(
        issues,
        "error",
        "CONFIG_INVALID",
        `Wildcard "${rule.pattern}" is invalid: ${error instanceof Error ? error.message : "invalid pattern"}`,
        "wildcard",
        rule.id,
      );
    }
    if (!isStrategyId(rule.strategy)) {
      issue(issues, "error", "CONFIG_INVALID", `Wildcard "${rule.pattern}" has an invalid strategy`, "wildcard", rule.id);
    }
    if (rule.targets.length === 0) {
      issue(issues, "error", "CONFIG_INVALID", `Wildcard "${rule.pattern}" has no targets`, "wildcard", rule.id);
    }
    if (rule.priority < 0) {
      issue(issues, "error", "CONFIG_INVALID", `Wildcard "${rule.pattern}" priority must be non-negative`, "wildcard", rule.id);
    }
  }

  // 目标解析（使用仅含合法通配符的运行期索引）
  const validWildcards = data.wildcards.filter((rule) => {
    try {
      compileGlob(rule.pattern);
      return true;
    } catch {
      return false;
    }
  });
  const runtime = buildRuntimeConfig(
    { ...data, wildcards: validWildcards },
    { version: 0, checksum: "", createdAt: 0, source: "d1-fallback" },
  );
  const router = new ModelRouter(runtime);

  const checkTarget = (
    target: RouteTargetSpec,
    enabled: boolean,
    entityType: string,
    entityId: string,
    label: string,
  ): void => {
    try {
      router.resolveTargetSpec(target);
    } catch (error) {
      issue(
        issues,
        enabled ? "error" : "warning",
        error instanceof GatewayError ? error.code : "CONFIG_INVALID",
        `${label} target "${targetLabel(target)}" cannot be resolved: ${error instanceof Error ? error.message : "unknown"}`,
        entityType,
        entityId,
      );
    }
  };

  for (const alias of data.aliases) {
    checkTarget(alias.target, alias.enabled, "alias", alias.id, `Alias "${alias.name}"`);
  }
  for (const rule of data.wildcards) {
    for (const target of rule.targets) {
      checkTarget(target, rule.enabled, "wildcard", rule.id, `Wildcard "${rule.pattern}"`);
    }
  }
  for (const combo of data.combos) {
    if (combo.strategy === "fusion" && combo.judgeModel === undefined) {
      issue(
        issues,
        "error",
        "CONFIG_INVALID",
        `Combo "${combo.name}" uses fusion but has no judgeModel`,
        "combo",
        combo.id,
      );
    }
    if (combo.judgeModel !== undefined) {
      try {
        router.resolveModelRef(combo.judgeModel);
      } catch (error) {
        issue(
          issues,
          "error",
          error instanceof GatewayError ? error.code : "CONFIG_INVALID",
          `Combo "${combo.name}" judgeModel "${combo.judgeModel}" cannot be resolved: ${error instanceof Error ? error.message : "unknown"}`,
          "combo",
          combo.id,
        );
      }
    }
    combo.nodes.forEach((node, index) => {
      const target = normalizeComboNodeTarget(node);
      if (target === undefined) {
        issue(
          issues,
          "error",
          "CONFIG_INVALID",
          `Combo "${combo.name}" node ${index} must specify exactly one of model/alias/wildcard/combo`,
          "combo",
          combo.id,
        );
        return;
      }
      checkTarget(target, combo.enabled, "combo", combo.id, `Combo "${combo.name}" node ${index}`);
    });
  }

  issues.push(
    ...validateCombos(data.combos, data.aliases, data.wildcards, {
      maxDepth: data.settings.maxComboDepth,
      maxNodes: data.settings.maxComboNodes,
    }),
  );

  validateSettings(data.settings, issues);
  return issues;
}

export function configErrorFromIssues(issues: ConfigValidationIssue[]): GatewayError {
  const errors = issues.filter((entry) => entry.severity === "error");
  return new GatewayError({
    code: "CONFIG_INVALID",
    message: `Configuration validation failed with ${errors.length} error(s)`,
    details: { issues: errors.slice(0, 20) },
  });
}
