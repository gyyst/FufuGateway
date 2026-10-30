import { GatewayError } from "../../core/errors";
import { asString, getArray, getRecord, isRecord, type JsonObject } from "../../core/json";
import type { StopReason, UnifiedStreamEvent, UnifiedUsage } from "../../ir";
import { emptyUsage } from "../../ir/usage";
import { createEventStream, encodeSse, encodeSseComment, sseResponse } from "../../stream/sse-encoder";
import type { SseMessage } from "../../stream/sse";
import type { ParseResponseContext, ProtocolHttpResponse, RenderContext } from "../types";
import { mapGeminiFinishReason, parseGeminiUsage } from "./response";

/** 解析 Gemini streamGenerateContent 流式响应。 */
export async function* parseGeminiStream(
  events: AsyncIterable<SseMessage>,
  ctx?: ParseResponseContext,
): AsyncIterable<UnifiedStreamEvent> {
  let id = ctx?.requestId ?? "gemini_stream";
  let model = ctx?.model ?? "";
  let started = false;
  let usage: UnifiedUsage = emptyUsage("none");
  let nextIndex = 0;
  let textIndex: number | undefined;
  let thinkingIndex: number | undefined;
  let callCounter = 0;
  let finishReasonRaw: unknown;
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

    const errorObject = getRecord(payload, "error");
    if (errorObject) {
      yield {
        type: "error",
        error: {
          code: "UPSTREAM_ERROR",
          message: "Upstream stream returned an error",
          retriable: false,
          ...(asString(errorObject["status"]) === undefined ? {} : { upstreamType: asString(errorObject["status"]) }),
        },
      };
      return;
    }

    id = asString(payload["responseId"]) ?? id;
    model = asString(payload["modelVersion"]) ?? model;
    if (payload["usageMetadata"] !== undefined) {
      const parsed = parseGeminiUsage(payload["usageMetadata"]);
      if (parsed.source !== "none") usage = parsed;
    }
    if (!started) yield start();

    const candidates = payload["candidates"];
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const candidate = candidates.find(
      (entry): entry is JsonObject => isRecord(entry) && (entry["index"] === 0 || entry["index"] === undefined),
    ) ?? candidates.find(isRecord);
    if (!isRecord(candidate)) continue;

    if (candidate["finishReason"] !== undefined) finishReasonRaw = candidate["finishReason"];

    const parts = getArray(getRecord(candidate, "content") ?? {}, "parts");
    if (!parts) continue;

    for (const part of parts) {
      if (!isRecord(part)) continue;

      const functionCall = getRecord(part, "functionCall");
      if (functionCall) {
        sawTool = true;
        const index = nextIndex;
        nextIndex += 1;
        const callId = `call_gemini_${callCounter}`;
        callCounter += 1;
        yield {
          type: "block_start",
          index,
          block: {
            kind: "tool_use",
            id: callId,
            name: asString(functionCall["name"]) ?? "",
          },
        };
        yield {
          type: "tool_input_delta",
          index,
          partialJson: JSON.stringify(functionCall["args"] ?? {}),
        };
        yield { type: "block_stop", index };
        continue;
      }

      const text = asString(part["text"]);
      if (text === undefined) continue;
      const isThought = part["thought"] === true;
      if (isThought) {
        if (thinkingIndex === undefined) {
          thinkingIndex = nextIndex;
          nextIndex += 1;
          openBlocks.add(thinkingIndex);
          yield { type: "block_start", index: thinkingIndex, block: { kind: "thinking" } };
        }
        if (text !== "") yield { type: "thinking_delta", index: thinkingIndex, text };
        const signature = asString(part["thoughtSignature"]);
        if (signature !== undefined) {
          yield { type: "signature_delta", index: thinkingIndex, signature };
        }
      } else {
        if (text === "") continue;
        if (textIndex === undefined) {
          textIndex = nextIndex;
          nextIndex += 1;
          openBlocks.add(textIndex);
          yield { type: "block_start", index: textIndex, block: { kind: "text" } };
        }
        yield { type: "text_delta", index: textIndex, text };
      }
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
  const stopReason: StopReason =
    finishReasonRaw === undefined
      ? sawTool
        ? "tool_use"
        : "unknown"
      : mapGeminiFinishReason(finishReasonRaw, sawTool);
  yield { type: "finish", stopReason, usage };
}

// ---------------------------------------------------------------------------
// IR → Gemini 客户端 SSE
// ---------------------------------------------------------------------------

function geminiUsageBody(usage: UnifiedUsage): JsonObject {
  const body: JsonObject = {
    promptTokenCount: usage.inputTokens,
    candidatesTokenCount: usage.outputTokens,
    totalTokenCount: usage.totalTokens,
  };
  if (usage.cachedInputTokens !== undefined) {
    body["cachedContentTokenCount"] = usage.cachedInputTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    body["thoughtsTokenCount"] = usage.reasoningTokens;
  }
  return body;
}

function geminiFinishReason(stop: StopReason): string {
  if (stop === "max_tokens") return "MAX_TOKENS";
  if (stop === "content_filter") return "SAFETY";
  if (stop === "error") return "OTHER";
  return "STOP";
}

export function renderGeminiStream(
  events: AsyncIterable<UnifiedStreamEvent>,
  ctx: RenderContext,
): ProtocolHttpResponse {
  let id = `gemini_${ctx.requestId}`;
  let model = ctx.model;
  const frames: Uint8Array[] = [];
  const toolBlocks = new Map<number, { name: string; args: string }>();

  const emit = (
    parts: JsonObject[],
    finishReason?: string,
  ): void => {
    const content: JsonObject = {
      role: "model",
      parts: parts.length === 0 ? [{ text: "" }] : parts,
    };
    frames.push(
      encodeSse({
        data: JSON.stringify({
          candidates: [
            {
              content,
              ...(finishReason === undefined ? {} : { finishReason }),
              index: 0,
            },
          ],
          modelVersion: model,
          responseId: id,
        }),
      }),
    );
  };

  const stream = createEventStream<UnifiedStreamEvent>(events, {
    encode: (event) => {
      frames.length = 0;
      switch (event.type) {
        case "start":
          id = event.id;
          model = event.model;
          break;
        case "text_delta":
          emit([{ text: event.text }]);
          break;
        case "thinking_delta":
          emit([{ text: event.text, thought: true }]);
          break;
        case "signature_delta":
          emit([{ text: "", thought: true, thoughtSignature: event.signature }]);
          break;
        case "block_start":
          if (event.block.kind === "tool_use") {
            toolBlocks.set(event.index, { name: event.block.name, args: "" });
          }
          break;
        case "tool_input_delta": {
          const state = toolBlocks.get(event.index);
          if (state) state.args += event.partialJson;
          break;
        }
        case "block_stop": {
          const state = toolBlocks.get(event.index);
          if (state === undefined) break;
          toolBlocks.delete(event.index);
          let args: unknown = {};
          try {
            const parsed = JSON.parse(state.args === "" ? "{}" : state.args) as unknown;
            if (isRecord(parsed)) args = parsed;
          } catch {
            args = {};
          }
          emit([{ functionCall: { name: state.name, args } }]);
          break;
        }
        case "finish":
          frames.push(
            encodeSse({
              data: JSON.stringify({
                candidates: [
                  {
                    content: { role: "model", parts: [] },
                    finishReason: geminiFinishReason(event.stopReason),
                    index: 0,
                  },
                ],
                usageMetadata: geminiUsageBody(event.usage),
                modelVersion: model,
                responseId: id,
              }),
            }),
          );
          break;
        case "error":
          frames.push(
            encodeSse({
              data: JSON.stringify({
                error: {
                  code: 500,
                  message: event.error.message,
                  status: event.error.code === "UPSTREAM_RATE_LIMITED" ? "RESOURCE_EXHAUSTED" : "INTERNAL",
                },
              }),
            }),
          );
          break;
        case "ping":
          frames.push(encodeSseComment("ping"));
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
