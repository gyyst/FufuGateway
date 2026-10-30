import type { UnifiedContentPart } from "./content";
import type { UnifiedUsage } from "./usage";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "content_filter"
  | "error"
  | "unknown";

export interface UnifiedResponse {
  id: string;
  model: string;
  createdAt: number;
  content: UnifiedContentPart[];
  stopReason: StopReason;
  stopSequence?: string;
  usage: UnifiedUsage;
}

/** 是否包含工具调用（决定 OpenAI 风格的 finish_reason）。 */
export function hasToolCall(content: readonly UnifiedContentPart[]): boolean {
  return content.some((part) => part.type === "tool_call");
}
