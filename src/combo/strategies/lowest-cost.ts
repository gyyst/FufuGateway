import type { ResolvedComboNode } from "../types";
import type { ComboStrategy } from "./types";
import { runSequential } from "./sequential";

export function estimatedCost(node: ResolvedComboNode): number {
  if (node.kind !== "model") return Number.POSITIVE_INFINITY;
  const pricing = node.target.pricing;
  return pricing.inputPrice + pricing.outputPrice;
}

export const lowestCostStrategy: ComboStrategy = {
  id: "lowest_cost",
  supportsStreaming: true,
  run(ctx) {
    const ordered = [...ctx.nodes].sort((a, b) => {
      const diff = estimatedCost(a) - estimatedCost(b);
      if (diff !== 0 && Number.isFinite(diff)) return diff;
      return b.priority - a.priority;
    });
    return runSequential(ctx, ordered);
  },
};
