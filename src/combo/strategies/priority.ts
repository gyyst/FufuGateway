import type { ComboStrategy } from "./types";
import { nodeKey } from "./types";
import { runSequential } from "./sequential";

export const priorityStrategy: ComboStrategy = {
  id: "priority",
  supportsStreaming: true,
  run(ctx) {
    const preferred =
      ctx.preferredKey === undefined
        ? undefined
        : ctx.nodes.find((node) => nodeKey(node) === ctx.preferredKey);
    const rest = ctx.nodes
      .filter((node) => node !== preferred)
      .sort((a, b) => b.priority - a.priority);
    return runSequential(ctx, preferred === undefined ? rest : [preferred, ...rest]);
  },
};
