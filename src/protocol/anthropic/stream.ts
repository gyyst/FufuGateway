import { GatewayError } from "../../core/errors";
import { asNumber, asString, getRecord, isRecord } from "../../core/json";
import type { StopReason, UnifiedStreamEvent, UnifiedUsage } from "../../ir";
import { emptyUsage, mergeUsage, normalizeUsage } from "../../ir/usage";
import { createEventStream, encodeSse, sseResponse } from "../../stream/sse-encoder";
import type { SseMessage } from "../../stream/sse";
import type { ParseResponseContext, ProtocolHttpResponse, RenderContext } from "../types";

interface AnthropicStreamUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

function parseUsage(raw: unknown): AnthropicStreamUsage | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    inputTokens: asNumber(raw["input_tokens"]) ?? 0,
    cachedInputTokens: asNumber(raw["cache_read_input_tokens"]) ?? 0,
    cacheWriteInputTokens: asNumber(raw["cache_creation_input_tokens"]) ?? 0,
    outputTokens: asNumber(raw["output_tokens"]) ?? 0,
  };
}

function toUnifiedUsage(usage: AnthropicStreamUsage): UnifiedUsage {
  return normalizeUsage({
    inputTokens: usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    source: "upstream",
  });
}

function mapStopReason(value: unknown, hasTools: boolean): StopReason {
  switch (asString(value)) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "content_filter";
    default:
      return hasTools ? "tool_use" : "unknown";
  }
}

/** 解析 Anthropic Messages 流式响应。 */
export async function* parseAnthropicStream(
  events: AsyncIterable<SseMessage>,
  ctx?: ParseResponseContext,
): AsyncIterable<UnifiedStreamEvent> {
  let id = ctx?.requestId ?? "msg_stream";
  let model = ctx?.model ?? "";
  let started = false;
  let usage = emptyUsage("none");
  let stopReason: StopReason | undefined;
  let stopSequence: string | undefined;
  let sawTool = false;
  const openBlocks = new Set<number>();

  const start = (): UnifiedStreamEvent => {
    started = true;
    return { type: "start", id, model, role: "assistant", ...(usage.source === "none" ? {} : { usage }) };
  };

  for await (const message of events) {
    if (message.comment === true) {
      yield { type: "ping" };
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(message.data) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;
    const type = asString(payload["type"]) ?? message.event;

    switch (type) {
      case "message_start": {
        const messageObject = getRecord(payload, "message");
        if (messageObject) {
          id = asString(messageObject["id"]) ?? id;
          model = asString(messageObject["model"]) ?? model;
          const parsed = parseUsage(messageObject["usage"]);
          if (parsed) usage = toUnifiedUsage(parsed);
        }
        if (!started) yield start();
        break;
      }
      case "content_block_start": {
        const index = asNumber(payload["index"]);
        const block = getRecord(payload, "content_block");
        if (index === undefined || block === undefined) break;
        const blockType = asString(block["type"]);
        openBlocks.add(index);
        if (blockType === "thinking") {
          yield {
            type: "block_start",
            index,
            block: {
              kind: "thinking",
              ...(asString(block["signature"]) === undefined ? {} : { signature: asString(block["signature"]) }),
            },
          };
        } else if (blockType === "redacted_thinking") {
          yield {
            type: "block_start",
            index,
            block: { kind: "thinking", redacted: true, redactedData: asString(block["data"]) ?? "" },
          };
        } else if (blockType === "tool_use") {
          sawTool = true;
          yield {
            type: "block_start",
            index,
            block: {
              kind: "tool_use",
              id: asString(block["id"]) ?? `call_${index}`,
              name: asString(block["name"]) ?? "",
            },
          };
        } else {
          yield { type: "block_start", index, block: { kind: "text" } };
        }
        break;
      }
      case "content_block_delta": {
        const index = asNumber(payload["index"]);
        const delta = getRecord(payload, "delta");
        if (index === undefined || delta === undefined) break;
        const deltaType = asString(delta["type"]);
        if (deltaType === "text_delta") {
          const text = asString(delta["text"]);
          if (text !== undefined) yield { type: "text_delta", index, text };
        } else if (deltaType === "thinking_delta") {
          const thinking = asString(delta["thinking"]);
          if (thinking !== undefined) yield { type: "thinking_delta", index, text: thinking };
        } else if (deltaType === "signature_delta") {
          const signature = asString(delta["signature"]);
          if (signature !== undefined) yield { type: "signature_delta", index, signature };
        } else if (deltaType === "input_json_delta") {
          const partial = asString(delta["partial_json"]);
          if (partial !== undefined) yield { type: "tool_input_delta", index, partialJson: partial };
        }
        break;
      }
      case "content_block_stop": {
        const index = asNumber(payload["index"]);
        if (index === undefined) break;
        openBlocks.delete(index);
        yield { type: "block_stop", index };
        break;
      }
      case "message_delta": {
        const delta = getRecord(payload, "delta");
        if (delta) {
          if (delta["stop_reason"] !== undefined) stopReason = mapStopReason(delta["stop_reason"], sawTool);
          const sequence = asString(delta["stop_sequence"]);
          if (sequence !== undefined) stopSequence = sequence;
        }
        const parsed = parseUsage(payload["usage"]);
        if (parsed) {
          usage = mergeUsage(usage, {
            inputTokens: Math.max(usage.inputTokens, parsed.inputTokens + parsed.cachedInputTokens + parsed.cacheWriteInputTokens),
            outputTokens: Math.max(usage.outputTokens, parsed.outputTokens),
            cachedInputTokens:
              parsed.cachedInputTokens > 0 ? parsed.cachedInputTokens : usage.cachedInputTokens,
            cacheWriteInputTokens:
              parsed.cacheWriteInputTokens > 0 ? parsed.cacheWriteInputTokens : usage.cacheWriteInputTokens,
            source: "upstream",
          });
        }
        break;
      }
      case "message_stop": {
        if (!started) yield start();
        for (const index of [...openBlocks].sort((a, b) => a - b)) {
          yield { type: "block_stop", index };
        }
        openBlocks.clear();
        yield {
          type: "finish",
          stopReason: stopReason ?? (sawTool ? "tool_use" : "end_turn"),
          ...(stopSequence === undefined ? {} : { stopSequence }),
          usage,
        };
        return;
      }
      case "error": {
        const errorObject = getRecord(payload, "error");
        const errorType = errorObject ? asString(errorObject["type"]) : undefined;
        yield {
          type: "error",
          error: {
            code: errorType === "rate_limit_error" ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_ERROR",
            message: "Upstream stream returned an error",
            retriable: false,
            ...(errorType === undefined ? {} : { upstreamType: errorType }),
          },
        };
        return;
      }
      case "ping":
        yield { type: "ping" };
        break;
      default:
        break;
    }
  }

  if (!started) {
    throw new GatewayError({
      code: "PROTOCOL_CONVERSION_ERROR",
      message: "Upstream stream ended before emitting any data",
    });
  }
  for (const index of [...openBlocks].sort((a, b) => a - b)) {
    yield { type: "block_stop", index };
  }
  yield {
    type: "finish",
    stopReason: stopReason ?? (sawTool ? "tool_use" : "unknown"),
    ...(stopSequence === undefined ? {} : { stopSequence }),
    usage,
  };
}

// ---------------------------------------------------------------------------
// IR → Anthropic Messages 客户端 SSE
// ---------------------------------------------------------------------------

function anthropicStopReason(stop: StopReason): string {
  if (stop === "max_tokens") return "max_tokens";
  if (stop === "tool_use") return "tool_use";
  if (stop === "stop_sequence") return "stop_sequence";
  if (stop === "content_filter") return "refusal";
  return "end_turn";
}

export function renderAnthropicStream(
  events: AsyncIterable<UnifiedStreamEvent>,
  ctx: RenderContext,
): ProtocolHttpResponse {
  let id = `msg_${ctx.requestId}`;
  let model = ctx.model;
  let started = false;
  const frames: Uint8Array[] = [];

  const frame = (eventName: string, payload: Record<string, unknown>): void => {
    frames.push(encodeSse({ event: eventName, data: JSON.stringify(payload) }));
  };

  const ensureStart = (usage?: UnifiedUsage): void => {
    if (started) return;
    started = true;
    const cached = usage?.cachedInputTokens ?? 0;
    const cacheWrite = usage?.cacheWriteInputTokens ?? 0;
    frame("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(0, (usage?.inputTokens ?? 0) - cached - cacheWrite),
          output_tokens: 0,
          ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
          ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
        },
      },
    });
  };

  const stream = createEventStream<UnifiedStreamEvent>(events, {
    encode: (event) => {
      frames.length = 0;
      switch (event.type) {
        case "start":
          id = event.id;
          model = event.model;
          ensureStart(event.usage);
          break;
        case "block_start":
          ensureStart();
          if (event.block.kind === "thinking") {
            if (event.block.redacted === true) {
              frame("content_block_start", {
                type: "content_block_start",
                index: event.index,
                content_block: { type: "redacted_thinking", data: event.block.redactedData ?? "" },
              });
            } else {
              frame("content_block_start", {
                type: "content_block_start",
                index: event.index,
                content_block: { type: "thinking", thinking: "", signature: event.block.signature ?? "" },
              });
            }
          } else if (event.block.kind === "tool_use") {
            frame("content_block_start", {
              type: "content_block_start",
              index: event.index,
              content_block: {
                type: "tool_use",
                id: event.block.id,
                name: event.block.name,
                input: {},
              },
            });
          } else {
            frame("content_block_start", {
              type: "content_block_start",
              index: event.index,
              content_block: { type: "text", text: "" },
            });
          }
          break;
        case "text_delta":
          frame("content_block_delta", {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "text_delta", text: event.text },
          });
          break;
        case "thinking_delta":
          frame("content_block_delta", {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "thinking_delta", thinking: event.text },
          });
          break;
        case "signature_delta":
          frame("content_block_delta", {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "signature_delta", signature: event.signature },
          });
          break;
        case "tool_input_delta":
          frame("content_block_delta", {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "input_json_delta", partial_json: event.partialJson },
          });
          break;
        case "block_stop":
          frame("content_block_stop", { type: "content_block_stop", index: event.index });
          break;
        case "finish": {
          ensureStart(event.usage);
          const cached = event.usage.cachedInputTokens ?? 0;
          const cacheWrite = event.usage.cacheWriteInputTokens ?? 0;
          frame("message_delta", {
            type: "message_delta",
            delta: {
              stop_reason: anthropicStopReason(event.stopReason),
              stop_sequence: event.stopSequence ?? null,
            },
            usage: {
              input_tokens: Math.max(0, event.usage.inputTokens - cached - cacheWrite),
              output_tokens: event.usage.outputTokens,
              ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
              ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
            },
          });
          frame("message_stop", { type: "message_stop" });
          break;
        }
        case "error":
          frame("error", {
            type: "error",
            error: {
              type: event.error.code === "UPSTREAM_RATE_LIMITED" ? "rate_limit_error" : "api_error",
              message: event.error.message,
            },
          });
          break;
        case "ping":
          frame("ping", { type: "ping" });
          break;
        default:
          break;
      }
      return frames;
    },
    isTerminal: (event) => event.type === "finish" || event.type === "error",
  });

  return sseResponse(stream, { "x-request-id": ctx.requestId });
}
