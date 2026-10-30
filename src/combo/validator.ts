import type { ConfigValidationIssue } from "../config/types";
import type { AliasRecord, WildcardRuleRecord } from "../config/types";
import type { ComboNodeSpec, ComboRecord, RouteTargetSpec, StrategyId } from "./types";
import { isStrategyId } from "./types";

export interface ComboValidationOptions {
  maxDepth: number;
  maxNodes: number;
}

interface SpecRefs {
  combos: string[];
  nodeCount: number;
}

function normalizeTarget(spec: ComboNodeSpec): RouteTargetSpec | undefined {
  if (typeof spec === "string") return spec === "" ? undefined : { model: spec };
  if (spec === null || typeof spec !== "object") return undefined;
  if (spec.model !== undefined) return { model: spec.model };
  if (spec.alias !== undefined) return { alias: spec.alias };
  if (spec.wildcard !== undefined) return { wildcard: spec.wildcard };
  if (spec.combo !== undefined) return { combo: spec.combo };
  return undefined;
}

export { normalizeTarget as normalizeComboNodeTarget };

function specWeight(spec: ComboNodeSpec): number {
  return typeof spec === "string" ? 1 : spec.weight ?? 1;
}

/**
 * 校验 Combo 配置：循环引用、最大深度、最大节点数。
 * 只针对 Combo 之间的引用图；模型/别名/通配符的可达性由路由校验负责。
 */
export function validateCombos(
  combos: ComboRecord[],
  aliases: AliasRecord[],
  wildcards: WildcardRuleRecord[],
  options: ComboValidationOptions,
): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  if (combos.length === 0) return issues;

  const aliasMap = new Map(aliases.map((alias) => [alias.name.toLowerCase(), alias]));
  const wildcardMap = new Map(wildcards.map((rule) => [rule.pattern, rule]));
  const comboMap = new Map(combos.map((combo) => [combo.name.toLowerCase(), combo]));

  const collectTarget = (
    target: RouteTargetSpec,
    seen: Set<string>,
    depth: number,
  ): SpecRefs => {
    if (depth > options.maxDepth + 4) {
      return { combos: [], nodeCount: 0 };
    }
    const normalized = typeof target === "string" ? { model: target } : target;
    if ("model" in normalized) return { combos: [], nodeCount: 1 };
    if ("combo" in normalized) {
      return { combos: [normalized.combo.toLowerCase()], nodeCount: 1 };
    }
    if ("alias" in normalized) {
      const key = `alias:${normalized.alias.toLowerCase()}`;
      if (seen.has(key)) return { combos: [], nodeCount: 0 };
      const alias = aliasMap.get(normalized.alias.toLowerCase());
      if (!alias) return { combos: [], nodeCount: 1 };
      return collectTarget(alias.target, new Set(seen).add(key), depth + 1);
    }
    const key = `wildcard:${normalized.wildcard}`;
    if (seen.has(key)) return { combos: [], nodeCount: 0 };
    const rule = wildcardMap.get(normalized.wildcard);
    if (!rule) return { combos: [], nodeCount: 1 };
    const nextSeen = new Set(seen).add(key);
    let combosList: string[] = [];
    let nodes = 0;
    for (const child of rule.targets) {
      const result = collectTarget(child, nextSeen, depth + 1);
      combosList = combosList.concat(result.combos);
      nodes += result.nodeCount;
    }
    return { combos: combosList, nodeCount: nodes };
  };

  const refGraph = new Map<string, Set<string>>();
  const directNodes = new Map<string, number>();

  for (const combo of combos) {
    const key = combo.name.toLowerCase();
    const refs = new Set<string>();
    let nodes = 0;
    if (!Array.isArray(combo.nodes) || combo.nodes.length === 0) {
      issues.push({
        severity: "error",
        code: "CONFIG_INVALID",
        message: `Combo "${combo.name}" must contain at least one node`,
        entityType: "combo",
        entityId: combo.id,
      });
      continue;
    }
    for (let index = 0; index < combo.nodes.length; index += 1) {
      const spec = combo.nodes[index];
      if (spec === undefined) continue;
      const target = normalizeTarget(spec);
      if (target === undefined) {
        issues.push({
          severity: "error",
          code: "CONFIG_INVALID",
          message: `Combo "${combo.name}" node ${index} must specify exactly one of model/alias/wildcard/combo`,
          entityType: "combo",
          entityId: combo.id,
        });
        continue;
      }
      if (specWeight(spec) <= 0) {
        issues.push({
          severity: "error",
          code: "CONFIG_INVALID",
          message: `Combo "${combo.name}" node ${index} weight must be positive`,
          entityType: "combo",
          entityId: combo.id,
        });
      }
      if (typeof spec === "object" && spec.strategy !== undefined && !isStrategyId(spec.strategy)) {
        issues.push({
          severity: "error",
          code: "CONFIG_INVALID",
          message: `Combo "${combo.name}" node ${index} has an invalid strategy`,
          entityType: "combo",
          entityId: combo.id,
        });
      }
      const result = collectTarget(target, new Set(), 0);
      for (const ref of result.combos) refs.add(ref);
      nodes += 1 + Math.max(0, result.nodeCount - 1);
    }
    refGraph.set(key, refs);
    directNodes.set(key, nodes);
  }

  // 循环检测（三色 DFS）
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (name: string): void => {
    color.set(name, GRAY);
    stack.push(name);
    for (const ref of refGraph.get(name) ?? []) {
      if (!comboMap.has(ref)) continue;
      const state = color.get(ref) ?? WHITE;
      if (state === GRAY) {
        const start = stack.indexOf(ref);
        const cycle = [...stack.slice(start), ref];
        const signature = [...cycle].sort().join(">");
        if (!reported.has(signature)) {
          reported.add(signature);
          issues.push({
            severity: "error",
            code: "COMBO_CYCLE_DETECTED",
            message: `Combo cycle detected: ${cycle.join(" -> ")}`,
            entityType: "combo",
            entityId: comboMap.get(ref)?.id,
          });
        }
      } else if (state === WHITE) {
        visit(ref);
      }
    }
    stack.pop();
    color.set(name, BLACK);
  };

  for (const key of refGraph.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE) visit(key);
  }

  // 深度限制
  const depthMemo = new Map<string, number>();
  const computeDepth = (name: string, visiting: Set<string>): number => {
    const memo = depthMemo.get(name);
    if (memo !== undefined) return memo;
    if (visiting.has(name)) return 0;
    const next = new Set(visiting).add(name);
    let max = 0;
    for (const ref of refGraph.get(name) ?? []) {
      if (!comboMap.has(ref)) continue;
      max = Math.max(max, 1 + computeDepth(ref, next));
    }
    depthMemo.set(name, max);
    return max;
  };

  for (const combo of combos) {
    const depth = computeDepth(combo.name.toLowerCase(), new Set());
    if (depth > options.maxDepth) {
      issues.push({
        severity: "error",
        code: "COMBO_LIMIT_EXCEEDED",
        message: `Combo "${combo.name}" nesting depth ${depth} exceeds the limit ${options.maxDepth}`,
        entityType: "combo",
        entityId: combo.id,
      });
    }
  }

  // 节点数限制（含嵌套展开）
  const countMemo = new Map<string, number>();
  const countNodes = (name: string, visiting: Set<string>): number => {
    const memo = countMemo.get(name);
    if (memo !== undefined) return memo;
    if (visiting.has(name)) return 0;
    const combo = comboMap.get(name);
    if (!combo) return 0;
    const next = new Set(visiting).add(name);
    let total = 0;
    for (const spec of combo.nodes) {
      total += 1;
      const target = normalizeTarget(spec);
      if (!target) continue;
      const directCombos = collectTarget(target, new Set(), 0).combos;
      for (const ref of directCombos) {
        total += countNodes(ref, next);
      }
    }
    countMemo.set(name, total);
    return total;
  };

  for (const combo of combos) {
    const total = countNodes(combo.name.toLowerCase(), new Set());
    if (total > options.maxNodes) {
      issues.push({
        severity: "error",
        code: "COMBO_LIMIT_EXCEEDED",
        message: `Combo "${combo.name}" expands to ${total} nodes, exceeding the limit ${options.maxNodes}`,
        entityType: "combo",
        entityId: combo.id,
      });
    }
  }

  return issues;
}

export function isValidStrategy(value: string): value is StrategyId {
  return isStrategyId(value);
}
