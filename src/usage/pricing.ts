import type { UnifiedUsage } from "../ir";
import type { ModelPricing } from "../config/types";

/**
 * 按每百万 token 价格计算费用。
 * 缓存输入从输入 token 中拆出；推理 token 从输出 token 中拆出，避免重复计费。
 */
export function computeCost(pricing: ModelPricing, usage: UnifiedUsage): number {
  const input = Math.max(0, usage.inputTokens);
  const output = Math.max(0, usage.outputTokens);
  const cached = Math.min(input, Math.max(0, usage.cachedInputTokens ?? 0));
  const reasoning = Math.min(output, Math.max(0, usage.reasoningTokens ?? 0));

  const inputPrice = Math.max(0, pricing.inputPrice);
  const cachedPrice = Math.max(0, pricing.cachedInputPrice ?? pricing.inputPrice);
  const outputPrice = Math.max(0, pricing.outputPrice);
  const reasoningPrice = Math.max(0, pricing.reasoningPrice ?? pricing.outputPrice);

  const cost =
    ((input - cached) / 1_000_000) * inputPrice +
    (cached / 1_000_000) * cachedPrice +
    ((output - reasoning) / 1_000_000) * outputPrice +
    (reasoning / 1_000_000) * reasoningPrice;

  return Number.isFinite(cost) && cost > 0 ? Math.round(cost * 1e8) / 1e8 : 0;
}
