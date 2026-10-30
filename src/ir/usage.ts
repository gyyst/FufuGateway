export type UsageSource = "upstream" | "estimated" | "none";

/** 统一 Usage。令牌数均为非负整数。 */
export interface UnifiedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  source: UsageSource;
}

export function emptyUsage(source: UsageSource = "none"): UnifiedUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source,
  };
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export interface UsageInput {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  source?: UsageSource;
}

/** 归一化 Usage，补齐 total 并过滤非法数值。 */
export function normalizeUsage(input: UsageInput): UnifiedUsage {
  const inputTokens = nonNegative(input.inputTokens);
  const outputTokens = nonNegative(input.outputTokens);
  const total = input.totalTokens === undefined
    ? inputTokens + outputTokens
    : nonNegative(input.totalTokens);
  const usage: UnifiedUsage = {
    inputTokens,
    outputTokens,
    totalTokens: total,
    source: input.source ?? "upstream",
  };
  if (input.cachedInputTokens !== undefined) usage.cachedInputTokens = nonNegative(input.cachedInputTokens);
  if (input.cacheWriteInputTokens !== undefined) {
    usage.cacheWriteInputTokens = nonNegative(input.cacheWriteInputTokens);
  }
  if (input.reasoningTokens !== undefined) usage.reasoningTokens = nonNegative(input.reasoningTokens);
  return usage;
}

/** 合并流式过程中分段到达的 Usage（后者覆盖非零字段）。 */
export function mergeUsage(base: UnifiedUsage, update: Partial<UnifiedUsage>): UnifiedUsage {
  const merged: UnifiedUsage = {
    ...base,
    ...update,
    inputTokens: update.inputTokens ?? base.inputTokens,
    outputTokens: update.outputTokens ?? base.outputTokens,
    totalTokens: update.totalTokens ?? base.totalTokens,
    source: update.source ?? base.source,
  };
  if (update.cachedInputTokens !== undefined) merged.cachedInputTokens = update.cachedInputTokens;
  if (update.cacheWriteInputTokens !== undefined) {
    merged.cacheWriteInputTokens = update.cacheWriteInputTokens;
  }
  if (update.reasoningTokens !== undefined) merged.reasoningTokens = update.reasoningTokens;
  if (merged.totalTokens === 0) {
    merged.totalTokens = merged.inputTokens + merged.outputTokens;
  }
  return merged;
}
