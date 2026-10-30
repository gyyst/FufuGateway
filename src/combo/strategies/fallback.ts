import type { ComboStrategy } from "./types";
import { runSequential, withPreferredOrder } from "./sequential";

export const fallbackStrategy: ComboStrategy = {
  id: "fallback",
  supportsStreaming: true,
  run(ctx) {
    return runSequential(ctx, withPreferredOrder(ctx));
  },
};
