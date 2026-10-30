import { GatewayError } from "../core/errors";
import type {
  ModelRecord,
  ModelPricing,
  ProviderRecord,
  RuntimeConfig,
  WildcardRuleRecord,
} from "../config/types";
import { providerModelKey } from "../config/types";
import type {
  RoutePlan,
  RoutePlanNode,
  RouteResolution,
  RouteTargetSpec,
  ResolvedTarget,
} from "../combo/types";
import { MAX_ROUTE_DEPTH } from "../core/limits";
import { globMatches } from "./glob";

export interface RouteConstraints {
  /** 允许的模型 ID（含别名/虚拟模型名）。为空表示不限制。 */
  allowedModelIds?: string[];
  /** 允许的 Provider ID 或名称。为空表示不限制。 */
  allowedProviderIds?: string[];
}

function notFound(model: string): GatewayError {
  return new GatewayError({
    code: "MODEL_NOT_FOUND",
    message: `Model "${model}" is not configured`,
    details: { model },
  });
}

function ambiguous(model: string, providers: string[]): GatewayError {
  return new GatewayError({
    code: "MODEL_AMBIGUOUS",
    message: `Model "${model}" exists on multiple providers; use "provider/${model}" or configure an alias`,
    details: { model, providers },
  });
}

/** 模型路由解析器。所有匹配顺序与优先级在此集中实现。 */
export class ModelRouter {
  constructor(private readonly config: RuntimeConfig) {}

  resolve(requestedModel: string, constraints?: RouteConstraints): RouteResolution {
    const trace: string[] = [];
    const resolution = this.resolveExactOrWildcard(requestedModel, trace);
    this.enforceConstraints(resolution, constraints);
    return resolution;
  }

  /** 供组合节点与配置校验复用。 */
  resolveTargetSpec(
    spec: RouteTargetSpec,
    trace: string[] = [],
    depth = 0,
    seen = new Set<string>(),
  ): RoutePlan {
    if (depth > MAX_ROUTE_DEPTH) {
      throw new GatewayError({
        code: "CONFIG_INVALID",
        message: "Route target nesting exceeds the maximum depth",
      });
    }
    const normalized: Exclude<RouteTargetSpec, string> =
      typeof spec === "string" ? { model: spec } : spec;

    if ("model" in normalized) {
      return { kind: "models", strategy: "fallback", targets: [this.resolveModelRef(normalized.model, trace)] };
    }
    if ("alias" in normalized) {
      const key = `alias:${normalized.alias.toLowerCase()}`;
      if (seen.has(key)) {
        throw new GatewayError({
          code: "CONFIG_INVALID",
          message: `Alias cycle detected at "${normalized.alias}"`,
        });
      }
      const alias = this.config.aliasesByName.get(normalized.alias.toLowerCase());
      if (!alias || !alias.enabled) throw notFound(normalized.alias);
      trace.push(`alias:${alias.name}`);
      const nextSeen = new Set(seen).add(key);
      return this.resolveTargetSpec(alias.target, trace, depth + 1, nextSeen);
    }
    if ("combo" in normalized) {
      const combo = this.config.combosByName.get(normalized.combo.toLowerCase());
      if (!combo || !combo.enabled) throw notFound(normalized.combo);
      trace.push(`combo:${combo.name}`);
      return { kind: "combo", combo };
    }
    const rule = this.config.wildcards.find((entry) => entry.rule.pattern === normalized.wildcard);
    if (!rule || !rule.rule.enabled) throw notFound(normalized.wildcard);
    const key = `wildcard:${rule.rule.pattern}`;
    if (seen.has(key)) {
      throw new GatewayError({
        code: "CONFIG_INVALID",
        message: `Wildcard cycle detected at "${rule.rule.pattern}"`,
      });
    }
    trace.push(`wildcard:${rule.rule.pattern}`);
    return this.resolveWildcardRule(rule.rule, trace, depth + 1, new Set(seen).add(key));
  }

  /** 解析单个模型引用：支持 provider/model 前缀与唯一原生模型。 */
  resolveModelRef(ref: string, trace: string[] = []): ResolvedTarget {
    const slash = ref.indexOf("/");
    if (slash > 0) {
      const prefix = ref.slice(0, slash);
      const provider = this.config.providersByName.get(prefix.toLowerCase());
      if (provider) {
        trace.push(`provider-prefix:${provider.name}`);
        if (!provider.enabled) {
          throw new GatewayError({
            code: "PROVIDER_UNAVAILABLE",
            message: `Provider "${provider.name}" is disabled`,
            details: { provider: provider.name },
          });
        }
        const modelId = ref.slice(slash + 1);
        const record = this.config.modelByProviderModel.get(providerModelKey(provider.id, modelId));
        if (!record || !record.enabled) throw notFound(ref);
        return this.toTarget(record, provider);
      }
    }

    const records = (this.config.modelsByModelId.get(ref) ?? []).filter((record) => {
      const provider = this.config.providersById.get(record.providerId);
      return record.enabled && provider?.enabled === true;
    });
    if (records.length === 0) throw notFound(ref);
    if (records.length > 1) {
      throw ambiguous(
        ref,
        records.map((record) => this.config.providersById.get(record.providerId)?.name ?? record.providerId),
      );
    }
    const record = records[0];
    if (record === undefined) throw notFound(ref);
    const provider = this.config.providersById.get(record.providerId);
    if (provider === undefined) throw notFound(ref);
    trace.push(`native:${provider.name}/${record.modelId}`);
    return this.toTarget(record, provider);
  }

  private resolveExactOrWildcard(requestedModel: string, trace: string[]): RouteResolution {
    // 1. 显式 Provider 前缀
    const slash = requestedModel.indexOf("/");
    if (slash > 0) {
      const prefix = requestedModel.slice(0, slash);
      const provider = this.config.providersByName.get(prefix.toLowerCase());
      if (provider) {
        const target = this.resolveModelRef(requestedModel, trace);
        return {
          requestedModel,
          match: { type: "provider_prefix", provider: provider.name, model: requestedModel.slice(slash + 1) },
          plan: { kind: "models", strategy: "fallback", targets: [target] },
          trace,
        };
      }
    }

    // 2. 原生模型精确匹配
    const native = (this.config.modelsByModelId.get(requestedModel) ?? []).filter((record) => {
      const provider = this.config.providersById.get(record.providerId);
      return record.enabled && provider?.enabled === true;
    });
    if (native.length === 1) {
      const record = native[0];
      if (record !== undefined) {
        const provider = this.config.providersById.get(record.providerId);
        if (provider !== undefined) {
          trace.push(`native:${provider.name}/${record.modelId}`);
          return {
            requestedModel,
            match: { type: "native", modelId: requestedModel },
            plan: { kind: "models", strategy: "fallback", targets: [this.toTarget(record, provider)] },
            trace,
          };
        }
      }
    }
    if (native.length > 1) {
      throw ambiguous(
        requestedModel,
        native.map((record) => this.config.providersById.get(record.providerId)?.name ?? record.providerId),
      );
    }

    // 3. Alias 精确匹配
    const alias = this.config.aliasesByName.get(requestedModel.toLowerCase());
    if (alias !== undefined && alias.enabled) {
      trace.push(`alias:${alias.name}`);
      const plan = this.resolveTargetSpec(alias.target, trace, 1, new Set([`alias:${alias.name.toLowerCase()}`]));
      return {
        requestedModel,
        match: { type: "alias", alias: alias.name, priority: alias.priority },
        plan,
        trace,
      };
    }

    // 4. Combo 名称精确匹配
    const combo = this.config.combosByName.get(requestedModel.toLowerCase());
    if (combo !== undefined && combo.enabled) {
      trace.push(`combo:${combo.name}`);
      return {
        requestedModel,
        match: { type: "combo", comboId: combo.id, comboName: combo.name },
        plan: { kind: "combo", combo },
        trace,
      };
    }

    // 5. 通配符（已按 priority + 具体度 + ID 排序）
    for (const entry of this.config.wildcards) {
      if (!entry.rule.enabled) continue;
      if (!globMatches(entry.compiled, requestedModel)) continue;
      trace.push(`wildcard:${entry.rule.pattern}`);
      const plan = this.resolveWildcardRule(entry.rule, trace, 1, new Set([`wildcard:${entry.rule.pattern}`]));
      return {
        requestedModel,
        match: {
          type: "wildcard",
          ruleId: entry.rule.id,
          pattern: entry.rule.pattern,
          priority: entry.rule.priority,
        },
        plan,
        trace,
      };
    }

    throw notFound(requestedModel);
  }

  private resolveWildcardRule(
    rule: WildcardRuleRecord,
    trace: string[],
    depth: number,
    seen: Set<string>,
  ): RoutePlan {
    if (rule.targets.length === 0) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: `Wildcard "${rule.pattern}" has no targets` });
    }
    const plans = rule.targets.map((target) => this.resolveTargetSpec(target, trace, depth, seen));
    const hasCombo = plans.some((plan) => plan.kind !== "models");
    if (!hasCombo) {
      const targets: ResolvedTarget[] = [];
      const seenTargets = new Set<string>();
      for (const plan of plans) {
        if (plan.kind !== "models") continue;
        for (const target of plan.targets) {
          if (seenTargets.has(target.modelRecordId)) continue;
          seenTargets.add(target.modelRecordId);
          targets.push(target);
        }
      }
      if (targets.length === 0) {
        throw new GatewayError({ code: "CONFIG_INVALID", message: `Wildcard "${rule.pattern}" resolved to no models` });
      }
      return { kind: "models", strategy: rule.strategy, targets };
    }

    const nodes: RoutePlanNode[] = [];
    for (const plan of plans) {
      if (plan.kind === "models") {
        for (const target of plan.targets) {
          nodes.push({ kind: "model", modelTarget: target, weight: target.weight, priority: rule.priority });
        }
      } else if (plan.kind === "combo") {
        nodes.push({ kind: "combo", comboName: plan.combo.name, weight: 1, priority: rule.priority });
      } else {
        nodes.push(...plan.nodes);
      }
    }
    if (nodes.length === 0) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: `Wildcard "${rule.pattern}" resolved to no nodes` });
    }
    return { kind: "inline_combo", name: `wildcard:${rule.pattern}`, strategy: rule.strategy, nodes };
  }

  private toTarget(record: ModelRecord, provider: ProviderRecord): ResolvedTarget {
    return {
      kind: "model",
      providerId: provider.id,
      providerName: provider.name,
      modelRecordId: record.id,
      modelId: record.modelId,
      upstreamModelId: record.upstreamModelId,
      capabilities: record.capabilities,
      pricing: this.pricingFor(record, provider),
      weight: 1,
      priority: provider.priority,
    };
  }

  private pricingFor(record: ModelRecord, provider: ProviderRecord): ModelPricing {
    const override =
      this.config.pricingByProviderModel.get(providerModelKey(provider.id, record.upstreamModelId)) ??
      this.config.pricingByProviderModel.get(providerModelKey(provider.id, record.modelId));
    if (override === undefined) return record.pricing;
    return {
      inputPrice: override.inputPrice,
      outputPrice: override.outputPrice,
      ...(override.cachedInputPrice === undefined ? {} : { cachedInputPrice: override.cachedInputPrice }),
      ...(override.reasoningPrice === undefined ? {} : { reasoningPrice: override.reasoningPrice }),
      currency: override.currency,
      unit: "per_million_tokens",
    };
  }

  private enforceConstraints(resolution: RouteResolution, constraints?: RouteConstraints): void {
    if (!constraints) return;
    const allowedModels = constraints.allowedModelIds;
    const allowedProviders = constraints.allowedProviderIds;
    const modelAllowed = (target: ResolvedTarget): boolean => {
      if (allowedModels !== undefined && allowedModels.length > 0) {
        if (allowedModels.includes(resolution.requestedModel)) return true;
        if (!allowedModels.includes(target.modelId)) return false;
      }
      if (allowedProviders !== undefined && allowedProviders.length > 0) {
        return (
          allowedProviders.includes(target.providerId) || allowedProviders.includes(target.providerName)
        );
      }
      return true;
    };

    if (resolution.plan.kind === "models") {
      const filtered = resolution.plan.targets.filter(modelAllowed);
      if (filtered.length === 0) {
        throw new GatewayError({
          code: "PERMISSION_DENIED",
          message: "This API key cannot access the requested model or provider",
        });
      }
      resolution.plan = { ...resolution.plan, targets: filtered };
      return;
    }

    if (resolution.plan.kind === "inline_combo") {
      const filtered = resolution.plan.nodes.filter((node) => {
        if (node.kind === "model" && node.modelTarget) return modelAllowed(node.modelTarget);
        return true;
      });
      if (filtered.length === 0) {
        throw new GatewayError({
          code: "PERMISSION_DENIED",
          message: "This API key cannot access any model in this combo",
        });
      }
      resolution.plan = { ...resolution.plan, nodes: filtered };
      return;
    }

    // 具名 Combo 的叶子在执行时逐项校验（见 assertTargetAllowed）。
    if (allowedModels !== undefined && allowedModels.length > 0 && !allowedModels.includes(resolution.requestedModel)) {
      // 允许组合内部的模型白名单校验在叶子层进行。
      return;
    }
  }

  /** 组合执行叶子节点的权限校验。 */
  static assertTargetAllowed(
    target: ResolvedTarget,
    constraints: RouteConstraints | undefined,
    requestedModel: string,
  ): void {
    if (!constraints) return;
    const allowedModels = constraints.allowedModelIds;
    const allowedProviders = constraints.allowedProviderIds;
    if (allowedModels !== undefined && allowedModels.length > 0) {
      if (!allowedModels.includes(requestedModel) && !allowedModels.includes(target.modelId)) {
        throw new GatewayError({
          code: "PERMISSION_DENIED",
          message: "This API key cannot access the requested model",
        });
      }
    }
    if (
      allowedProviders !== undefined &&
      allowedProviders.length > 0 &&
      !allowedProviders.includes(target.providerId) &&
      !allowedProviders.includes(target.providerName)
    ) {
      throw new GatewayError({
        code: "PERMISSION_DENIED",
        message: "This API key cannot access the requested provider",
      });
    }
  }
}
