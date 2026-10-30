import type { ComboStrategy } from "./types";
import { circularOrder, orderWithPreferred } from "./types";
import { runSequential } from "./sequential";

export const roundRobinStrategy: ComboStrategy = {
  id: "round_robin",
  supportsStreaming: true,
  async run(ctx) {
    if (ctx.preferredKey !== undefined) {
      return runSequential(ctx, orderWithPreferred(ctx.nodes, ctx.preferredKey));
    }
    const index = await ctx.coordination.nextRoundRobin(ctx.combo.id, ctx.nodes.length);
    return runSequential(ctx, circularOrder(ctx.nodes, index));
  },
};
