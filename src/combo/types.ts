/** Combo 调度策略与配置表达式。 */

export type StrategyId =
  | "fallback"
  | "round_robin"
  | "weighted_round_robin"
  | "random"
  | "priority"
  | "lowest_latency"
  | "lowest_cost"
  | "race"
  | "fusion";

export const STRATEGY_IDS: readonly StrategyId[] = [
  "fallback",
  "round_robin",
  "weighted_round_robin",
  "random",
  "priority",
  "lowest_latency",
  "lowest_cost",
  "race",
  "fusion",
];

export function isStrategyId(value: string): value is StrategyId {
  return (STRATEGY_IDS as readonly string[]).includes(value);
}

export interface StickyConfig {
  enabled: boolean;
  ttlSeconds: number;
  mode: "round_robin" | "first_available";
  /** 是否允许用首条 user 消息哈希作为会话标识（默认关闭）。 */
  hashFirstUserMessage?: boolean;
}

/** 配置态 Combo 节点：支持字符串简写与对象形式。 */
export type ComboNodeSpec =
  | string
  | {
      model?: string;
      alias?: string;
      wildcard?: string;
      combo?: string;
      weight?: number;
      priority?: number;
      timeoutMs?: number;
      maxRetries?: number;
      strategy?: StrategyId;
    };

export interface ComboRecord {
  id: string;
  name: string;
  description?: string;
  strategy: StrategyId;
  nodes: ComboNodeSpec[];
  /** Fusion 策略使用的 Judge Model 引用（provider/model 或唯一模型 ID）。 */
  judgeModel?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  sticky?: StickyConfig;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 路由目标表达式。字符串形式等价于 `{ model }`。 */
export type RouteTargetSpec =
  | string
  | { model: string }
  | { alias: string }
  | { combo: string }
  | { wildcard: string };

export interface ResolvedTarget {
  kind: "model";
  providerId: string;
  providerName: string;
  modelRecordId: string;
  modelId: string;
  upstreamModelId: string;
  capabilities: import("../ir/request").ModelCapabilities;
  pricing: import("../config/types").ModelPricing;
  weight: number;
  priority: number;
}

export type RouteMatch =
  | { type: "provider_prefix"; provider: string; model: string }
  | { type: "native"; modelId: string }
  | { type: "alias"; alias: string; priority: number }
  | { type: "wildcard"; ruleId: string; pattern: string; priority: number }
  | { type: "combo"; comboId: string; comboName: string };

export interface RoutePlanNode {
  kind: "model" | "combo";
  modelTarget?: ResolvedTarget;
  comboName?: string;
  weight: number;
  priority: number;
}

export type RoutePlan =
  | { kind: "models"; strategy: StrategyId; targets: ResolvedTarget[] }
  | { kind: "combo"; combo: ComboRecord }
  | { kind: "inline_combo"; name: string; strategy: StrategyId; nodes: RoutePlanNode[] };

export interface RouteResolution {
  requestedModel: string;
  match: RouteMatch;
  plan: RoutePlan;
  trace: string[];
}

/** 归一化后的 Combo 节点（发布期/请求期解析完成，无名称歧义）。 */
export type ResolvedComboNode =
  | {
      kind: "model";
      target: ResolvedTarget;
      weight: number;
      priority: number;
      timeoutMs?: number;
      maxRetries?: number;
    }
  | {
      kind: "combo";
      combo: ResolvedCombo;
      weight: number;
      priority: number;
      timeoutMs?: number;
    }
  | {
      kind: "inline";
      name: string;
      strategy: StrategyId;
      nodes: ResolvedComboNode[];
      weight: number;
      priority: number;
      timeoutMs?: number;
    };

export interface ResolvedCombo {
  id: string;
  name: string;
  strategy: StrategyId;
  nodes: ResolvedComboNode[];
  timeoutMs?: number;
  maxConcurrency?: number;
  sticky?: StickyConfig;
  judgeTarget?: ResolvedTarget;
}
