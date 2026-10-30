import type { ComboStrategy } from "./types";
import { circularOrder, orderWithPreferred } from "./types";
import { nodeWeights, runSequential, weightedRandomIndex } from "./sequential";

export const randomStrategy: ComboStrategy = {
  id: "random",
  supportsStreaming: true,
  async run(ctx) {
    if (ctx.preferredKey !== undefined) {
      return runSequential(ctx, orderWithPreferred(ctx.nodes, ctx.preferredKey));
    }
    const index = weightedRandomIndex(nodeWeights(ctx.nodes));
    return runSequential(ctx, circularOrder(ctx.nodes, index));
  },
};
