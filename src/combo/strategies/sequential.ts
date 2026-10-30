import { GatewayError } from "../../core/errors";
import type { ResolvedComboNode } from "../types";
import type { NodeEvaluation, StrategyContext } from "./types";
import { failureTrace, orderWithPreferred } from "./types";

/**
 * 顺序执行策略的公共实现：按给定顺序尝试节点，
 * 仅在错误可重试时继续尝试下一个节点。
 */
export async function runSequential(
  ctx: StrategyContext,
  ordered: ResolvedComboNode[],
): Promise<NodeEvaluation> {
  if (ordered.length === 0) {
    return {
      error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Combo has no executable nodes" }),
      trace: failureTrace(ctx.combo.name),
    };
  }

  let last: NodeEvaluation | undefined;
  for (const node of ordered) {
    if (ctx.signal.aborted) {
      return {
        error: new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled" }),
        trace: failureTrace(ctx.combo.name, "cancelled"),
      };
    }
    const evaluation = await ctx.evaluate(node, { signal: ctx.signal, deadline: ctx.deadline });
    ctx.traceChildren.push(evaluation.trace);
    if (evaluation.success !== undefined) return evaluation;
    last = evaluation;
    if (evaluation.error?.retriable !== true) return evaluation;
  }

  return (
    last ?? {
      error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "All combo nodes failed" }),
      trace: failureTrace(ctx.combo.name),
    }
  );
}

export function withPreferredOrder(ctx: StrategyContext): ResolvedComboNode[] {
  return orderWithPreferred(ctx.nodes, ctx.preferredKey);
}

/** 加权随机选择索引。 */
export function weightedRandomIndex(weights: number[]): number {
  if (weights.length === 0) return 0;
  const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (total <= 0) return Math.floor(Math.random() * weights.length);
  let threshold = Math.random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    threshold -= Math.max(0, weights[index] ?? 0);
    if (threshold <= 0) return index;
  }
  return weights.length - 1;
}

export function nodeWeights(nodes: ResolvedComboNode[]): number[] {
  return nodes.map((node) => (node.weight > 0 ? node.weight : 1));
}
