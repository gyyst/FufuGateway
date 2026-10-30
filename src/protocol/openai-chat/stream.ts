import { GatewayError } from "../../core/errors";
import { asNumber, asString, isRecord, type JsonObject } from "../../core/json";
import type { StopReason, UnifiedStreamEvent, UnifiedUsage } from "../../ir";
import { emptyUsage } from "../../ir/usage";
import { encodeSse, encodeSseComment, createEventStream, sseResponse } from "../../stream/sse-encoder";
import type { SseMessage } from "../../stream/sse";
import type { ParseResponseContext, ProtocolHttpResponse, RenderContext } from "../types";
import {
  mapOpenAIChatFinishReason,
  openAIFinishReasonFromStopReason,
  openAIUsageBody,
  parseOpenAIChatUsage,
} from "./response";

interface ToolBlockState {
  irIndex: number;
  id: string;
  name: string;
  argsEmitted: boolean;
}

/** 解析 OpenAI Chat Completions 流式响应。 */
export async function* parseOpenAIChatStream(
  events: AsyncIterable<SseMessage>,
  ctx?: ParseResponseContext,
): AsyncIterable<UnifiedStreamEvent> {
  let id = ctx?.requestId ?? "chatcmpl-stream";
  let model = ctx?.model ?? "";
  let started = false;
  let nextIndex = 0;
  let textIndex: number | undefined;
  let thinkingIndex: number | undefined;
  const toolBlocks = new Map<number, ToolBlockState>();
  const openBlocks = new Set<number>();
  let finishReasonRaw: unknown;
  let usage: UnifiedUsage = emptyUsage("none");

  const startEvent = (): UnifiedStreamEvent => {
    started = true;
    return { type: "start", id, model, role: "assistant" };
  };

  for await (const message of events) {
    if (message.comment === true) {
      yield { type: "ping" };
      continue;
    }
    if (message.data.trim() === "[DONE]") break;

    let payload: unknown;
    try {
      payload = JSON.parse(message.data) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(payload)) continue;

    const errorObject = payload["error"];
    if (isRecord(errorObject)) {
      yield {
        type: "error",
        error: {
          code: "UPSTREAM_ERROR",
          message: "Upstream stream returned an error",
          retriable: false,
          ...(asString(errorObject["code"]) === undefined ? {} : { upstreamCode: asString(errorObject["code"]) }),
          ...(asString(errorObject["type"]) === undefined ? {} : { upstreamType: asString(errorObject["type"]) }),
        },
      };
      return;
    }

    id = asString(payload["id"]) ?? id;
    model = asString(payload["model"]) ?? model;
    if (!started) yield startEvent();

    if (payload["usage"] !== undefined) {
      const parsed = parseOpenAIChatUsage(payload["usage"]);
      if (parsed.source !== "none") usage = parsed;
    }

    const choices = payload["choices"];
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = choices.find(
      (entry): entry is JsonObject => isRecord(entry) && (entry["index"] === 0 || entry["index"] === undefined),
    ) ?? choices.find(isRecord);
    if (!isRecord(choice)) continue;

    const delta = choice["delta"];
    if (isRecord(delta)) {
      const reasoning = asString(delta["reasoning_content"]) ?? asString(delta["reasoning"]);
      if (reasoning !== undefined && reasoning !== "") {
        if (thinkingIndex === undefined) {
          thinkingIndex = nextIndex;
          nextIndex += 1;
          openBlocks.add(thinkingIndex);
          yield { type: "block_start", index: thinkingIndex, block: { kind: "thinking" } };
        }
        yield { type: "thinking_delta", index: thinkingIndex, text: reasoning };
      }

      const content = delta["content"];
      let textChunk: string | undefined;
      if (typeof content === "string") {
        textChunk = content;
      } else if (Array.isArray(content)) {
        const pieces: string[] = [];
        for (const part of content) {
          if (!isRecord(part)) continue;
          const text = asString(part["text"]);
          if (text !== undefined) pieces.push(text);
        }
        if (pieces.length > 0) textChunk = pieces.join("");
      }
      if (textChunk !== undefined && textChunk !== "") {
        if (textIndex === undefined) {
          textIndex = nextIndex;
          nextIndex += 1;
          openBlocks.add(textIndex);
          yield { type: "block_start", index: textIndex, block: { kind: "text" } };
        }
        yield { type: "text_delta", index: textIndex, text: textChunk };
      }

      const toolCalls = delta["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const rawCall of toolCalls) {
          if (!isRecord(rawCall)) continue;
          const openAiIndex = asNumber(rawCall["index"]) ?? 0;
          const fn = isRecord(rawCall["function"]) ? rawCall["function"] : undefined;
          const idValue = asString(rawCall["id"]);
          const name = fn === undefined ? undefined : asString(fn["name"]);
          const args = fn === undefined ? undefined : asString(fn["arguments"]);

          let block = toolBlocks.get(openAiIndex);
          if (block === undefined) {
            const irIndex = nextIndex;
            nextIndex += 1;
            block = {
              irIndex,
              id: idValue ?? `call_stream_${openAiIndex}`,
              name: name ?? "",
              argsEmitted: false,
            };
            toolBlocks.set(openAiIndex, block);
            openBlocks.add(irIndex);
            yield {
              type: "block_start",
              index: irIndex,
              block: { kind: "tool_use", id: block.id, name: block.name },
            };
          } else {
            if (idValue !== undefined) block.id = idValue;
            if (name !== undefined && name !== "") block.name = name;
          }
          if (args !== undefined && args !== "") {
            block.argsEmitted = true;
            yield { type: "tool_input_delta", index: block.irIndex, partialJson: args };
          }
        }
      }
    }

    if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== null) {
      finishReasonRaw = choice["finish_reason"];
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
  openBlocks.clear();

  const hasTools = toolBlocks.size > 0;
  const stopReason: StopReason =
    finishReasonRaw === undefined
      ? hasTools
        ? "tool_use"
        : "unknown"
      : mapOpenAIChatFinishReason(finishReasonRaw, hasTools);
  yield { type: "finish", stopReason, usage };
}

// ---------------------------------------------------------------------------
// IR → OpenAI Chat 客户端 SSE
// ---------------------------------------------------------------------------

export function renderOpenAIChatStream(
  events: AsyncIterable<UnifiedStreamEvent>,
  ctx: RenderContext,
): ProtocolHttpResponse {
  let id = `chatcmpl-${ctx.requestId}`;
  let model = ctx.model;
  let created = Math.floor(ctx.created / 1000);
  let started = false;
  let toolCounter = 0;
  const toolIndexByBlock = new Map<number, number>();

  const frames: Uint8Array[] = [];
  const chunk = (delta: JsonObject, finishReason: string | null = null): void => {
    frames.push(
      encodeSse({
        data: JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }),
      }),
    );
  };
  const ensureStart = (): void => {
    if (started) return;
    started = true;
    chunk({ role: "assistant", content: "" });
  };

  const stream = createEventStream<UnifiedStreamEvent>(events, {
    encode: (event) => {
      frames.length = 0;
      switch (event.type) {
        case "start":
          id = event.id;
          model = event.model;
          ensureStart();
          break;
        case "block_start":
          if (event.block.kind === "tool_use") {
            const index = toolCounter;
            toolCounter += 1;
            toolIndexByBlock.set(event.index, index);
            chunk({
              tool_calls: [
                {
                  index,
                  id: event.block.id,
                  type: "function",
                  function: { name: event.block.name, arguments: "" },
                },
              ],
            });
          }
          break;
        case "text_delta":
          ensureStart();
          chunk({ content: event.text });
          break;
        case "thinking_delta":
          ensureStart();
          chunk({ reasoning_content: event.text });
          break;
        case "tool_input_delta": {
          const index = toolIndexByBlock.get(event.index) ?? 0;
          chunk({ tool_calls: [{ index, function: { arguments: event.partialJson } }] });
          break;
        }
        case "finish": {
          ensureStart();
          chunk({}, openAIFinishReasonFromStopReason(event.stopReason));
          if (event.usage.source !== "none" || event.usage.totalTokens > 0) {
            frames.push(
              encodeSse({
                data: JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [],
                  usage: openAIUsageBody(event.usage),
                }),
              }),
            );
          }
          frames.push(encodeSse({ data: "[DONE]" }));
          break;
        }
        case "error":
          frames.push(
            encodeSse({
              data: JSON.stringify({
                error: {
                  message: event.error.message,
                  type: event.error.code === "UPSTREAM_RATE_LIMITED" ? "rate_limit_error" : "api_error",
                  code: event.error.code,
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
