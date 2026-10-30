import { GatewayError } from "../../core/errors";
import { asNumber, asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type { StopReason, UnifiedStreamEvent, UnifiedUsage } from "../../ir";
import { emptyUsage, normalizeUsage } from "../../ir/usage";
import { createEventStream, encodeSse, encodeSseComment, sseResponse } from "../../stream/sse-encoder";
import type { SseMessage } from "../../stream/sse";
import type { ParseResponseContext, ProtocolHttpResponse, RenderContext } from "../types";

type ItemKind = "message" | "reasoning" | "function_call";

interface ItemState {
  kind: ItemKind;
  itemId: string;
  outputIndex: number;
  item: JsonObject;
  text: string;
  args: string;
}

function parseResponsesStreamUsage(raw: unknown): UnifiedUsage {
  if (!isRecord(raw)) return emptyUsage("none");
  const inputDetails = getRecord(raw, "input_tokens_details");
  const outputDetails = getRecord(raw, "output_tokens_details");
  return normalizeUsage({
    inputTokens: asNumber(raw["input_tokens"]) ?? 0,
    outputTokens: asNumber(raw["output_tokens"]) ?? 0,
    totalTokens: asNumber(raw["total_tokens"]),
    cachedInputTokens: inputDetails ? asNumber(inputDetails["cached_tokens"]) : undefined,
    reasoningTokens: outputDetails ? asNumber(outputDetails["reasoning_tokens"]) : undefined,
    source: "upstream",
  });
}

/** 解析 OpenAI Responses 流式响应。 */
export async function* parseResponsesStream(
  events: AsyncIterable<SseMessage>,
  ctx?: ParseResponseContext,
): AsyncIterable<UnifiedStreamEvent> {
  let id = ctx?.requestId ?? "resp_stream";
  let model = ctx?.model ?? "";
  let started = false;
  let usage: UnifiedUsage = emptyUsage("none");
  let stopReason: StopReason | undefined;
  let nextIndex = 0;
  let sawTool = false;
  const blockByItemId = new Map<string, number>();
  const itemByBlock = new Map<number, ItemState>();
  const openBlocks = new Set<number>();

  const start = (): UnifiedStreamEvent => {
    started = true;
    return { type: "start", id, model, role: "assistant", ...(usage.source === "none" ? {} : { usage }) };
  };

  const ensureBlock = (
    itemId: string,
    kind: ItemKind,
    item: JsonObject,
    outputIndex: number,
  ): { index: number; created: boolean } => {
    const existing = blockByItemId.get(itemId);
    if (existing !== undefined) return { index: existing, created: false };
    const index = nextIndex;
    nextIndex += 1;
    blockByItemId.set(itemId, index);
    itemByBlock.set(index, {
      kind,
      itemId,
      outputIndex,
      item,
      text: "",
      args: "",
    });
    openBlocks.add(index);
    return { index, created: true };
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
    const responseObject = getRecord(payload, "response");

    if (type === "response.created" || type === "response.in_progress") {
      if (responseObject) {
        id = asString(responseObject["id"]) ?? id;
        model = asString(responseObject["model"]) ?? model;
        const parsed = parseResponsesStreamUsage(responseObject["usage"]);
        if (parsed.source !== "none") usage = parsed;
      }
      if (!started) yield start();
      continue;
    }

    if (type === "response.output_item.added") {
      const item = getRecord(payload, "item");
      if (!item) continue;
      if (!started) yield start();
      const itemId = asString(item["id"]) ?? asString(payload["item_id"]) ?? `item_${nextIndex}`;
      const outputIndex = asNumber(payload["output_index"]) ?? 0;
      const itemType = asString(item["type"]);
      if (itemType === "function_call") {
        sawTool = true;
        const block = ensureBlock(itemId, "function_call", item, outputIndex);
        if (block.created) {
          yield {
            type: "block_start",
            index: block.index,
            block: {
              kind: "tool_use",
              id: asString(item["call_id"]) ?? asString(item["id"]) ?? itemId,
              name: asString(item["name"]) ?? "",
            },
          };
        }
      } else if (itemType === "reasoning") {
        const block = ensureBlock(itemId, "reasoning", item, outputIndex);
        if (block.created) yield { type: "block_start", index: block.index, block: { kind: "thinking" } };
      } else {
        const block = ensureBlock(itemId, "message", item, outputIndex);
        if (block.created) yield { type: "block_start", index: block.index, block: { kind: "text" } };
      }
      continue;
    }

    if (type === "response.output_text.delta" || type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      const delta = asString(payload["delta"]) ?? "";
      if (delta === "") continue;
      const itemId = asString(payload["item_id"]) ?? "";
      const kind: ItemKind = type === "response.output_text.delta" ? "message" : "reasoning";
      const block = ensureBlock(itemId, kind, {}, asNumber(payload["output_index"]) ?? 0);
      if (block.created) {
        yield {
          type: "block_start",
          index: block.index,
          block: { kind: kind === "message" ? "text" : "thinking" },
        };
      }
      if (kind === "message") yield { type: "text_delta", index: block.index, text: delta };
      else yield { type: "thinking_delta", index: block.index, text: delta };
      const state = itemByBlock.get(block.index);
      if (state) state.text += delta;
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = asString(payload["delta"]) ?? "";
      if (delta === "") continue;
      const itemId = asString(payload["item_id"]) ?? "";
      const block = ensureBlock(itemId, "function_call", {}, asNumber(payload["output_index"]) ?? 0);
      if (block.created) {
        sawTool = true;
        yield {
          type: "block_start",
          index: block.index,
          block: { kind: "tool_use", id: itemId, name: "" },
        };
      }
      const state = itemByBlock.get(block.index);
      if (state) state.args += delta;
      yield { type: "tool_input_delta", index: block.index, partialJson: delta };
      continue;
    }

    if (type === "response.output_item.done") {
      const item = getRecord(payload, "item");
      const itemId = asString(item?.["id"]) ?? asString(payload["item_id"]) ?? "";
      const index = blockByItemId.get(itemId);
      if (index === undefined) continue;
      const state = itemByBlock.get(index);
      if (state && state.kind === "function_call") {
        const args = item ? asString(item["arguments"]) : undefined;
        if (args !== undefined && args !== "" && state.args === "") {
          state.args = args;
          yield { type: "tool_input_delta", index, partialJson: args };
        }
      }
      openBlocks.delete(index);
      yield { type: "block_stop", index };
      continue;
    }

    if (type === "response.completed" || type === "response.incomplete") {
      if (responseObject) {
        const parsed = parseResponsesStreamUsage(responseObject["usage"]);
        if (parsed.source !== "none") usage = parsed;
        const incomplete = getRecord(responseObject, "incomplete_details");
        const reason = incomplete ? asString(incomplete["reason"]) : undefined;
        if (reason === "max_output_tokens") stopReason = "max_tokens";
        else if (reason === "content_filter") stopReason = "content_filter";
      }
      if (stopReason === undefined) stopReason = sawTool ? "tool_use" : "end_turn";
      if (!started) yield start();
      for (const index of [...openBlocks].sort((a, b) => a - b)) {
        yield { type: "block_stop", index };
      }
      openBlocks.clear();
      yield { type: "finish", stopReason, usage };
      return;
    }

    if (type === "response.failed") {
      yield {
        type: "error",
        error: {
          code: "UPSTREAM_ERROR",
          message: "Upstream Responses stream failed",
          retriable: false,
          ...(responseObject && getRecord(responseObject, "error") && asString(getRecord(responseObject, "error")?.["code"]) !== undefined
            ? { upstreamCode: asString(getRecord(responseObject, "error")?.["code"]) }
            : {}),
        },
      };
      return;
    }

    if (type === "error") {
      yield {
        type: "error",
        error: {
          code: "UPSTREAM_ERROR",
          message: "Upstream stream returned an error",
          retriable: false,
          ...(asString(payload["code"]) === undefined ? {} : { upstreamCode: asString(payload["code"]) }),
        },
      };
      return;
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
  yield { type: "finish", stopReason: stopReason ?? (sawTool ? "tool_use" : "unknown"), usage };
}

// ---------------------------------------------------------------------------
// IR → OpenAI Responses 客户端 SSE
// ---------------------------------------------------------------------------

function responsesUsageBody(usage: UnifiedUsage): JsonObject {
  const body: JsonObject = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
  if (usage.cachedInputTokens !== undefined) {
    body["input_tokens_details"] = { cached_tokens: usage.cachedInputTokens };
  }
  if (usage.reasoningTokens !== undefined) {
    body["output_tokens_details"] = { reasoning_tokens: usage.reasoningTokens };
  }
  return body;
}

export function renderResponsesStream(
  events: AsyncIterable<UnifiedStreamEvent>,
  ctx: RenderContext,
): ProtocolHttpResponse {
  let id = `resp_${ctx.requestId}`;
  let model = ctx.model;
  let createdAt = Math.floor(ctx.created / 1000);
  let started = false;
  let outputCounter = 0;
  const items = new Map<number, ItemState>();
  const outputItems: JsonObject[] = [];
  const frames: Uint8Array[] = [];

  const frame = (eventName: string, payload: JsonObject): void => {
    frames.push(encodeSse({ event: eventName, data: JSON.stringify({ type: eventName, ...payload }) }));
  };

  const ensureStart = (): void => {
    if (started) return;
    started = true;
    frame("response.created", {
      response: {
        id,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model,
        output: [],
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
          ensureStart();
          break;
        case "block_start": {
          ensureStart();
          const outputIndex = outputCounter;
          outputCounter += 1;
          if (event.block.kind === "tool_use") {
            const itemId = `${id}_fc_${outputIndex}`;
            const item: JsonObject = {
              id: itemId,
              type: "function_call",
              call_id: event.block.id,
              name: event.block.name,
              arguments: "",
              status: "in_progress",
            };
            items.set(event.index, {
              kind: "function_call",
              itemId,
              outputIndex,
              item,
              text: "",
              args: "",
            });
            frame("response.output_item.added", { output_index: outputIndex, item });
          } else if (event.block.kind === "thinking") {
            const itemId = `${id}_rs_${outputIndex}`;
            const item: JsonObject = { id: itemId, type: "reasoning", summary: [] };
            items.set(event.index, {
              kind: "reasoning",
              itemId,
              outputIndex,
              item,
              text: "",
              args: "",
            });
            frame("response.output_item.added", { output_index: outputIndex, item });
            frame("response.reasoning_summary_part.added", {
              item_id: itemId,
              output_index: outputIndex,
              summary_index: 0,
              part: { type: "summary_text", text: "" },
            });
          } else {
            const itemId = `${id}_msg_${outputIndex}`;
            const item: JsonObject = {
              id: itemId,
              type: "message",
              role: "assistant",
              status: "in_progress",
              content: [],
            };
            items.set(event.index, {
              kind: "message",
              itemId,
              outputIndex,
              item,
              text: "",
              args: "",
            });
            frame("response.output_item.added", { output_index: outputIndex, item });
            frame("response.content_part.added", {
              item_id: itemId,
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
          }
          break;
        }
        case "text_delta": {
          const state = items.get(event.index);
          if (!state) break;
          state.text += event.text;
          frame("response.output_text.delta", {
            item_id: state.itemId,
            output_index: state.outputIndex,
            content_index: 0,
            delta: event.text,
          });
          break;
        }
        case "thinking_delta": {
          const state = items.get(event.index);
          if (!state) break;
          state.text += event.text;
          frame("response.reasoning_summary_text.delta", {
            item_id: state.itemId,
            output_index: state.outputIndex,
            summary_index: 0,
            delta: event.text,
          });
          break;
        }
        case "tool_input_delta": {
          const state = items.get(event.index);
          if (!state) break;
          state.args += event.partialJson;
          frame("response.function_call_arguments.delta", {
            item_id: state.itemId,
            output_index: state.outputIndex,
            delta: event.partialJson,
          });
          break;
        }
        case "block_stop": {
          const state = items.get(event.index);
          if (!state) break;
          let doneItem: JsonObject;
          if (state.kind === "function_call") {
            doneItem = { ...state.item, arguments: state.args, status: "completed" };
            frame("response.function_call_arguments.done", {
              item_id: state.itemId,
              output_index: state.outputIndex,
              arguments: state.args,
            });
          } else if (state.kind === "reasoning") {
            doneItem = {
              ...state.item,
              summary: state.text === "" ? [] : [{ type: "summary_text", text: state.text }],
            };
            frame("response.reasoning_summary_text.done", {
              item_id: state.itemId,
              output_index: state.outputIndex,
              summary_index: 0,
              text: state.text,
            });
          } else {
            doneItem = {
              ...state.item,
              status: "completed",
              content: [{ type: "output_text", text: state.text, annotations: [] }],
            };
            frame("response.output_text.done", {
              item_id: state.itemId,
              output_index: state.outputIndex,
              content_index: 0,
              text: state.text,
            });
          }
          frame("response.output_item.done", { output_index: state.outputIndex, item: doneItem });
          outputItems.push(doneItem);
          items.delete(event.index);
          break;
        }
        case "finish": {
          ensureStart();
          const status =
            event.stopReason === "max_tokens" || event.stopReason === "content_filter"
              ? "incomplete"
              : "completed";
          const incomplete =
            event.stopReason === "max_tokens"
              ? { reason: "max_output_tokens" }
              : event.stopReason === "content_filter"
                ? { reason: "content_filter" }
                : null;
          frame(status === "completed" ? "response.completed" : "response.incomplete", {
            response: {
              id,
              object: "response",
              created_at: createdAt,
              status,
              model,
              output: outputItems,
              usage: responsesUsageBody(event.usage),
              incomplete_details: incomplete,
              error: null,
            },
          });
          break;
        }
        case "error":
          frame("error", {
            code: event.error.code,
            message: event.error.message,
            param: null,
          });
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
