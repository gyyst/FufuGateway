import type { StopReason } from "./response";
import type { UnifiedUsage } from "./usage";
import type { UnifiedError } from "./errors";

/** 流式内容块类型。 */
export type UnifiedStreamBlock =
  | { kind: "text" }
  | {
      kind: "thinking";
      signature?: string;
      redacted?: boolean;
      redactedData?: string;
    }
  | { kind: "tool_use"; id: string; name: string };

/**
 * 统一流式事件。
 *
 * 采用 block 语义，可无损表达 thinking、文本与工具调用交错的厂商协议；
 * 下游适配器负责转换成各自的事件格式。
 */
export type UnifiedStreamEvent =
  | { type: "start"; id: string; model: string; role: "assistant"; usage?: UnifiedUsage }
  | { type: "block_start"; index: number; block: UnifiedStreamBlock }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "signature_delta"; index: number; signature: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "block_stop"; index: number }
  | { type: "finish"; stopReason: StopReason; stopSequence?: string; usage: UnifiedUsage }
  | { type: "error"; error: UnifiedError }
  | { type: "ping" };

export function isTerminalStreamEvent(event: UnifiedStreamEvent): boolean {
  return event.type === "finish" || event.type === "error";
}
