import { GatewayError } from "../../core/errors";
import type { ComboStrategy, NodeEvaluation, NodeSuccess } from "./types";
import { failureTrace } from "./types";

/**
 * Fusion：并行获取多个候选结果，再交给 Judge Model 生成最终答案。
 * 流式请求无法在提交后重新生成，因此明确返回 UNSUPPORTED_FEATURE。
 */
export const fusionStrategy: ComboStrategy = {
  id: "fusion",
  supportsStreaming: false,
  async run(ctx) {
    if (ctx.isStream) {
      throw new GatewayError({
        code: "UNSUPPORTED_FEATURE",
        message: "Fusion strategy does not support streaming responses",
      });
    }
    if (ctx.nodes.length === 0) {
      return {
        error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "Fusion combo has no nodes" }),
        trace: failureTrace(ctx.combo.name),
      };
    }

    const successes: NodeSuccess[] = [];
    let lastError: NodeEvaluation | undefined;
    let cursor = 0;
    const limit = Math.max(1, Math.min(ctx.maxConcurrency, ctx.nodes.length));

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= ctx.nodes.length) return;
        if (ctx.signal.aborted) return;
        const node = ctx.nodes[index];
        if (node === undefined) return;
        const evaluation = await ctx.evaluate(node, { signal: ctx.signal, deadline: ctx.deadline });
        ctx.traceChildren.push(evaluation.trace);
        if (evaluation.success !== undefined) successes.push(evaluation.success);
        else lastError = evaluation;
      }
    };

    await Promise.all(Array.from({ length: limit }, () => worker()));

    if (successes.length === 0) {
      return (
        lastError ?? {
          error: new GatewayError({ code: "COMBO_EXECUTION_FAILED", message: "All fusion candidates failed" }),
          trace: failureTrace(ctx.combo.name),
        }
      );
    }

    const judged = await ctx.judge(successes);
    ctx.traceChildren.push(judged.trace);
    return judged;
  },
};
