import { isRecord, type JsonObject } from "../core/json";

function collect(value: unknown, state: { chars: number; images: number }, depth: number): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    state.chars += value.length;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, state, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  if (value["type"] === "image" || value["inlineData"] !== undefined || value["image_url"] !== undefined) {
    state.images += 1;
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === "type" || key === "role") continue;
    collect(item, state, depth + 1);
  }
}

/**
 * Anthropic count_tokens 的本地估算。
 * 结果仅用于预算/限流参考，不代表上游真实分词结果。
 */
export function estimateAnthropicInputTokens(body: JsonObject): number {
  const state = { chars: 0, images: 0 };
  collect(body["system"], state, 0);
  collect(body["messages"], state, 0);
  collect(body["tools"], state, 0);
  const estimate = Math.ceil(state.chars / 4) + state.images * 256;
  return Math.max(1, estimate);
}
