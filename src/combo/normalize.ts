import { GatewayError } from "../core/errors";
import type { RuntimeConfig } from "../config/types";
import type { ModelRouter } from "../router/resolver";
import type {
  ComboNodeSpec,
  ComboRecord,
  ResolvedCombo,
  ResolvedComboNode,
  ResolvedTarget,
  RoutePlan,
  RoutePlanNode,
  StrategyId,
} from "./types";
import { normalizeComboNodeTarget } from "./validator";

export interface NormalizeLimits {
  maxDepth: number;
  maxNodes: number;
}

interface NormalizeState {
  config: RuntimeConfig;
  router: ModelRouter;
  limits: NormalizeLimits;
  nodeCount: number;
}

interface NodeMeta {
  weight: number;
  priority?: number;
  timeoutMs?: number;
  maxRetries?: number;
  strategy?: StrategyId;
}

function specMeta(spec: ComboNodeSpec): NodeMeta {
  if (typeof spec === "string") return { weight: 1 };
  return {
    weight: spec.weight ?? 1,
    ...(spec.priority === undefined ? {} : { priority: spec.priority }),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(typeof spec.maxRetries === "number" ? { maxRetries: Math.max(0, Math.trunc(spec.maxRetries)) } : {}),
    ...(spec.strategy === undefined ? {} : { strategy: spec.strategy }),
  };
}

function bump(state: NormalizeState): void {
  state.nodeCount += 1;
  if (state.nodeCount > state.limits.maxNodes) {
    throw new GatewayError({
      code: "COMBO_EXECUTION_FAILED",
      message: `Combo expands beyond the maximum of ${state.limits.maxNodes} nodes`,
    });
  }
}

function modelNode(
  state: NormalizeState,
  target: ResolvedTarget,
  meta: NodeMeta,
  defaultPriority: number,
): ResolvedComboNode {
  bump(state);
  return {
    kind: "model",
    target,
    weight: meta.weight,
    priority: meta.priority ?? defaultPriority,
    ...(meta.timeoutMs === undefined ? {} : { timeoutMs: meta.timeoutMs }),
    ...(meta.maxRetries === undefined ? {} : { maxRetries: meta.maxRetries }),
  };
}

function inlineNode(
  state: NormalizeState,
  name: string,
  strategy: StrategyId,
  nodes: ResolvedComboNode[],
  meta: NodeMeta,
  defaultPriority = 100,
): ResolvedComboNode {
  bump(state);
  return {
    kind: "inline",
    name,
    strategy,
    nodes,
    weight: meta.weight,
    priority: meta.priority ?? defaultPriority,
    ...(meta.timeoutMs === undefined ? {} : { timeoutMs: meta.timeoutMs }),
    ...(meta.maxRetries === undefined ? {} : { maxRetries: meta.maxRetries }),
  };
}

function comboNode(
  state: NormalizeState,
  combo: ResolvedCombo,
  meta: NodeMeta,
): ResolvedComboNode {
  bump(state);
  return {
    kind: "combo",
    combo,
    weight: meta.weight,
    priority: meta.priority ?? 100,
    ...(meta.timeoutMs === undefined ? {} : { timeoutMs: meta.timeoutMs }),
  };
}

function convertPlan(
  plan: RoutePlan,
  state: NormalizeState,
  stack: string[],
  depth: number,
  meta: NodeMeta,
): ResolvedComboNode {
  if (plan.kind === "models") {
    if (plan.targets.length === 0) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: "Route plan resolved to no targets" });
    }
    if (plan.targets.length === 1 && plan.strategy === "fallback") {
      const target = plan.targets[0];
      if (target === undefined) {
        throw new GatewayError({ code: "CONFIG_INVALID", message: "Route plan resolved to no targets" });
      }
      return modelNode(state, target, meta, target.priority);
    }
    const nodes = plan.targets.map((target) =>
      modelNode(state, target, { weight: target.weight }, target.priority),
    );
    return inlineNode(state, `route:${plan.strategy}`, plan.strategy, nodes, meta);
  }
  if (plan.kind === "combo") {
    const nested = normalizeComboRecord(plan.combo, state, stack, depth + 1);
    if (meta.strategy !== undefined && meta.strategy !== nested.strategy) {
      return inlineNode(
        state,
        `override:${meta.strategy}:${nested.name}`,
        meta.strategy,
        nested.nodes,
        meta,
      );
    }
    return comboNode(state, nested, meta);
  }

  const nodes = plan.nodes.map((node) => convertPlanNode(node, state, stack, depth));
  return inlineNode(state, plan.name, plan.strategy, nodes, meta);
}

function convertPlanNode(
  node: RoutePlanNode,
  state: NormalizeState,
  stack: string[],
  depth: number,
): ResolvedComboNode {
  if (node.kind === "model") {
    if (node.modelTarget === undefined) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: "Inline combo node has no model target" });
    }
    return modelNode(
      state,
      node.modelTarget,
      { weight: node.weight, priority: node.priority },
      node.priority,
    );
  }
  const name = node.comboName;
  if (name === undefined) {
    throw new GatewayError({ code: "CONFIG_INVALID", message: "Inline combo node has no combo name" });
  }
  const combo = state.config.combosByName.get(name.toLowerCase());
  if (combo === undefined || !combo.enabled) {
    throw new GatewayError({ code: "MODEL_NOT_FOUND", message: `Combo "${name}" is not available` });
  }
  const nested = normalizeComboRecord(combo, state, stack, depth + 1);
  return comboNode(state, nested, { weight: node.weight, priority: node.priority });
}

export function normalizeComboRecord(
  combo: ComboRecord,
  state: NormalizeState,
  stack: string[],
  depth: number,
): ResolvedCombo {
  if (depth > state.limits.maxDepth) {
    throw new GatewayError({
      code: "COMBO_EXECUTION_FAILED",
      message: `Combo nesting exceeds the maximum depth of ${state.limits.maxDepth}`,
    });
  }
  const key = combo.name.toLowerCase();
  if (stack.includes(key)) {
    throw new GatewayError({
      code: "COMBO_CYCLE_DETECTED",
      message: `Combo cycle detected at "${combo.name}"`,
    });
  }
  const nextStack = [...stack, key];
  const nodes: ResolvedComboNode[] = [];

  for (let index = 0; index < combo.nodes.length; index += 1) {
    const spec = combo.nodes[index];
    if (spec === undefined) continue;
    const target = normalizeComboNodeTarget(spec);
    if (target === undefined) {
      throw new GatewayError({
        code: "CONFIG_INVALID",
        message: `Combo "${combo.name}" node ${index} must specify exactly one target type`,
      });
    }
    const meta = specMeta(spec);
    const plan = state.router.resolveTargetSpec(target);
    nodes.push(convertPlan(plan, state, nextStack, depth, meta));
  }
  if (nodes.length === 0) {
    throw new GatewayError({ code: "CONFIG_INVALID", message: `Combo "${combo.name}" has no executable nodes` });
  }

  const judgeTarget =
    combo.judgeModel === undefined ? undefined : state.router.resolveModelRef(combo.judgeModel);
  if (combo.strategy === "fusion" && judgeTarget === undefined) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: `Combo "${combo.name}" uses fusion but has no judgeModel`,
    });
  }

  return {
    id: combo.id,
    name: combo.name,
    strategy: combo.strategy,
    nodes,
    ...(combo.timeoutMs === undefined ? {} : { timeoutMs: combo.timeoutMs }),
    ...(combo.maxConcurrency === undefined ? {} : { maxConcurrency: combo.maxConcurrency }),
    ...(combo.sticky === undefined ? {} : { sticky: combo.sticky }),
    ...(judgeTarget === undefined ? {} : { judgeTarget }),
  };
}

/** 将路由结果转换为可执行的 Combo 树。 */
export function buildResolvedRoute(
  plan: RoutePlan,
  config: RuntimeConfig,
  router: ModelRouter,
  limits: NormalizeLimits,
): ResolvedCombo {
  const state: NormalizeState = { config, router, limits, nodeCount: 0 };

  if (plan.kind === "models") {
    const nodes = plan.targets.map((target) =>
      modelNode(state, target, { weight: target.weight }, target.priority),
    );
    if (nodes.length === 0) {
      throw new GatewayError({ code: "CONFIG_INVALID", message: "Route plan resolved to no targets" });
    }
    return {
      id: `route:${plan.strategy}`,
      name: `route:${plan.strategy}`,
      strategy: plan.strategy,
      nodes,
    };
  }

  if (plan.kind === "combo") {
    return normalizeComboRecord(plan.combo, state, [], 0);
  }

  const nodes = plan.nodes.map((node) => convertPlanNode(node, state, [], 0));
  return {
    id: `inline:${plan.name}`,
    name: plan.name,
    strategy: plan.strategy,
    nodes,
  };
}
