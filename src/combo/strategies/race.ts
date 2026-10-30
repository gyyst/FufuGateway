import { GatewayError } from "../../core/errors";
import type { ComboStrategy, NodeEvaluation } from "./types";
import { failureTrace } from "./types";

/**
 * Race / First Success：并行请求多个节点，首个成功者胜出并取消其余请求。
 * 适用于非流式与流式（首个产生有效内容的流获胜）。
 */
async function discardSuccess(success: import("./types").NodeSuccess): Promise<void> {
  if (success.stream === undefined) return;
  try {
    const iterator = success.stream.events[Symbol.asyncIterator]();
    await iterator.return?.();
  } catch {
    // 忽略清理异常。
  }
}

export const raceStrategy: ComboStrategy = {
  id: "race",
  supportsStreaming: true,
  async run(ctx) {
    if (ctx.nodes.length === 0) {
      return {
        error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Race combo has no nodes" }),
        trace: failureTrace(ctx.combo.name),
      };
    }

    let winner: NodeEvaluation | undefined;
    let winnerIndex = -1;
    let lastError: NodeEvaluation | undefined;
    let cursor = 0;
    const controllers = new Map<number, AbortController>();
    const limit = Math.max(1, Math.min(ctx.maxConcurrency, ctx.nodes.length));

    const worker = async (): Promise<void> => {
      for (;;) {
        if (winner !== undefined || ctx.signal.aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= ctx.nodes.length) return;
        const node = ctx.nodes[index];
        if (node === undefined) return;

        const controller = new AbortController();
        const onParentAbort = (): void => controller.abort(ctx.signal.reason);
        ctx.signal.addEventListener("abort", onParentAbort, { once: true });
        controllers.set(index, controller);

        let evaluation: NodeEvaluation;
        try {
          evaluation = await ctx.evaluate(node, { signal: controller.signal, deadline: ctx.deadline });
        } finally {
          ctx.signal.removeEventListener("abort", onParentAbort);
          controllers.delete(index);
        }
        ctx.traceChildren.push(evaluation.trace);

        if (evaluation.success !== undefined) {
          if (winner !== undefined) {
            // 另一个候选已经胜出：丢弃本次成功结果，释放可能的流资源。
            await discardSuccess(evaluation.success);
            return;
          }
          winner = evaluation;
          winnerIndex = index;
          for (const [otherIndex, other] of controllers) {
            if (otherIndex !== winnerIndex) other.abort();
          }
          return;
        }
        lastError = evaluation;
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));

    if (winner !== undefined) return winner;
    return (
      lastError ?? {
        error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "All race candidates failed" }),
        trace: failureTrace(ctx.combo.name),
      }
    );
  },
};
