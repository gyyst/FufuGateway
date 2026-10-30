import type { ResolvedComboNode } from "../types";
import type { ComboStrategy } from "./types";
import { runSequential } from "./sequential";

function latencyKey(node: ResolvedComboNode): string | undefined {
  return node.kind === "model" ? `${node.target.providerId}:${node.target.modelRecordId}` : undefined;
}

export const lowestLatencyStrategy: ComboStrategy = {
  id: "lowest_latency",
  supportsStreaming: true,
  async run(ctx) {
    const keys = ctx.nodes
      .map(latencyKey)
      .filter((key): key is string => key !== undefined);
    const latencies = await ctx.coordination.getLatencies(ctx.combo.id, keys);
    const score = (node: ResolvedComboNode): number => {
      const key = latencyKey(node);
      if (key === undefined) return Number.POSITIVE_INFINITY;
      return latencies[key] ?? Number.POSITIVE_INFINITY;
    };
    const ordered = [...ctx.nodes].sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0 && Number.isFinite(diff)) return diff;
      return b.priority - a.priority;
    });
    return runSequential(ctx, ordered);
  },
};
