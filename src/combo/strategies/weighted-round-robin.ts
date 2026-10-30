import type { ComboStrategy } from "./types";
import { circularOrder, orderWithPreferred } from "./types";
import { nodeWeights, runSequential } from "./sequential";

export const weightedRoundRobinStrategy: ComboStrategy = {
  id: "weighted_round_robin",
  supportsStreaming: true,
  async run(ctx) {
    if (ctx.preferredKey !== undefined) {
      return runSequential(ctx, orderWithPreferred(ctx.nodes, ctx.preferredKey));
    }
    const index = await ctx.coordination.nextWeighted(ctx.combo.id, nodeWeights(ctx.nodes));
    return runSequential(ctx, circularOrder(ctx.nodes, index));
  },
};
