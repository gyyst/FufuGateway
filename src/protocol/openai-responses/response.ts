import { GatewayError, type GatewayError as GatewayErrorType } from "../../core/errors";
import { asNumber, asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type { UnifiedContentPart, UnifiedResponse, UnifiedUsage } from "../../ir";
import { createCompatibilityContext, reportUnsupported } from "../../ir/compat";
import { emptyUsage, normalizeUsage } from "../../ir/usage";
import type { PublicModel } from "../../ir/models";
import { jsonHttpResponse } from "../shared/http";
import { openAIErrorType, parseOpenAIErrorBody } from "../shared/openai-error";
import { renderOpenAIModelList } from "../shared/openai-models";
import { parseToolArguments, requireArray, requireObject, requireString, stringifyToolArguments } from "../shared/validate";
import type { ParseResponseContext, RenderContext } from "../types";

function parseResponsesUsage(raw: unknown): UnifiedUsage {
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

function parseOutputMessageContent(content: unknown): UnifiedContentPart[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (content === undefined || content === null) return [];
  const blocks = requireArray(content, "output[].content");
  const result: UnifiedContentPart[] = [];
  blocks.forEach((entry, index) => {
    const block = requireObject(entry, `output[].content[${index}]`);
    const type = asString(block["type"]);
    if (type === "output_text" || type === "text") {
      result.push({ type: "text", text: asString(block["text"]) ?? "" });
    } else if (type === "refusal") {
      result.push({ type: "refusal", text: asString(block["refusal"]) ?? "" });
    } else {
      throw new GatewayError({
        code: "PROTOCOL_CONVERSION_ERROR",
        message: `Unsupported Responses output content type "${type ?? "unknown"}"`,
      });
    }
  });
  return result;
}

function parseReasoningOutput(item: JsonObject): UnifiedContentPart | undefined {
  let text = "";
  if (Array.isArray(item["summary"])) {
    for (const entry of item["summary"]) {
      if (isRecord(entry)) text += asString(entry["text"]) ?? "";
    }
  }
  if (text === "" && Array.isArray(item["content"])) {
    for (const entry of item["content"]) {
      if (isRecord(entry)) text += asString(entry["text"]) ?? "";
    }
  }
  const signature = asString(item["encrypted_content"]);
  if (text === "" && signature === undefined) return undefined;
  const part: UnifiedContentPart = { type: "thinking", text };
  if (signature !== undefined) part.signature = signature;
  return part;
}

export function parseResponsesResponse(body: JsonObject, ctx?: ParseResponseContext): UnifiedResponse {
  const status = asString(body["status"]);
  if (status === "failed") {
    throw new GatewayError({
      code: "UPSTREAM_ERROR",
      message: "Upstream Responses API reported a failed response",
      retriable: true,
      details: { upstream_status: status },
    });
  }

  const content: UnifiedContentPart[] = [];
  const output = body["output"];
  if (Array.isArray(output)) {
    output.forEach((entry, index) => {
      const item = requireObject(entry, `output[${index}]`);
      const type = asString(item["type"]);
      switch (type) {
        case "reasoning": {
          const part = parseReasoningOutput(item);
          if (part) content.push(part);
          break;
        }
        case "message":
          content.push(...parseOutputMessageContent(item["content"]));
          break;
        case "function_call": {
          const parsed = parseToolArguments(item["arguments"]);
          const part: UnifiedContentPart = {
            type: "tool_call",
            id: asString(item["call_id"]) ?? asString(item["id"]) ?? `call_${index}`,
            name: requireString(item["name"], `output[${index}].name`),
            arguments: parsed.arguments,
          };
          if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
          content.push(part);
          break;
        }
        case "output_text": {
          content.push({ type: "text", text: asString(item["text"]) ?? "" });
          break;
        }
        default:
          throw new GatewayError({
            code: "PROTOCOL_CONVERSION_ERROR",
            message: `Unsupported Responses output item type "${type ?? "unknown"}"`,
          });
      }
    });
  }

  if (content.length === 0 && typeof body["output_text"] === "string") {
    const text = body["output_text"];
    if (text !== "") content.push({ type: "text", text });
  }

  const hasTools = content.some((part) => part.type === "tool_call");
  const incomplete = getRecord(body, "incomplete_details");
  const incompleteReason = incomplete ? asString(incomplete["reason"]) : undefined;

  const stopReason: UnifiedResponse["stopReason"] =
    incompleteReason === "max_output_tokens"
      ? "max_tokens"
      : incompleteReason === "content_filter"
        ? "content_filter"
        : hasTools
          ? "tool_use"
          : "end_turn";

  return {
    id: asString(body["id"]) ?? ctx?.requestId ?? `resp_${Date.now().toString(36)}`,
    model: asString(body["model"]) ?? ctx?.model ?? "",
    createdAt: (asNumber(body["created_at"]) ?? Math.floor(Date.now() / 1000)) * 1000,
    content,
    stopReason,
    usage: parseResponsesUsage(body["usage"]),
  };
}

export function renderResponsesResponse(response: UnifiedResponse, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  const compat = createCompatibilityContext(ctx.policy, "gateway", "openai-responses");
  const output: JsonObject[] = [];
  let messageItem: JsonObject | undefined;

  const ensureMessageItem = (): JsonObject => {
    if (messageItem !== undefined) return messageItem;
    messageItem = {
      type: "message",
      id: `${response.id}_msg`,
      role: "assistant",
      status: "completed",
      content: [],
    };
    output.push(messageItem);
    return messageItem;
  };

  for (const part of response.content) {
    if (part.type === "text") {
      const item = ensureMessageItem();
      (item["content"] as JsonObject[]).push({ type: "output_text", text: part.text, annotations: [] });
    } else if (part.type === "refusal") {
      const item = ensureMessageItem();
      (item["content"] as JsonObject[]).push({ type: "refusal", refusal: part.text });
    } else if (part.type === "thinking") {
      messageItem = undefined;
      if (part.redacted === true) {
        reportUnsupported(compat, "thinking.redacted", "redacted thinking cannot be represented in Responses");
        continue;
      }
      output.push({
        type: "reasoning",
        id: `${response.id}_rs_${output.length}`,
        summary: part.text === "" ? [] : [{ type: "summary_text", text: part.text }],
        ...(part.signature === undefined ? {} : { encrypted_content: part.signature }),
      });
    } else if (part.type === "tool_call") {
      messageItem = undefined;
      output.push({
        type: "function_call",
        id: `${response.id}_fc_${output.length}`,
        call_id: part.id,
        name: part.name,
        arguments: stringifyToolArguments(part.arguments, part.rawArguments),
        status: "completed",
      });
    } else if (part.type === "image") {
      reportUnsupported(compat, "output.image", "Responses output cannot carry gateway images");
    }
  }

  const incomplete =
    response.stopReason === "max_tokens"
      ? { reason: "max_output_tokens" }
      : response.stopReason === "content_filter"
        ? { reason: "content_filter" }
        : null;

  const usage: JsonObject = {
    input_tokens: response.usage.inputTokens,
    output_tokens: response.usage.outputTokens,
    total_tokens: response.usage.totalTokens,
  };
  if (response.usage.cachedInputTokens !== undefined) {
    usage["input_tokens_details"] = { cached_tokens: response.usage.cachedInputTokens };
  }
  if (response.usage.reasoningTokens !== undefined) {
    usage["output_tokens_details"] = { reasoning_tokens: response.usage.reasoningTokens };
  }

  ctx.issues.push(...compat.issues);
  return jsonHttpResponse(
    {
      id: response.id,
      object: "response",
      created_at: Math.floor(response.createdAt / 1000),
      status: incomplete === null ? "completed" : "incomplete",
      model: response.model || ctx.model,
      output,
      output_text: response.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
      usage,
      error: null,
      incomplete_details: incomplete,
    },
    200,
    { "x-request-id": ctx.requestId },
  );
}

export function parseResponsesError(status: number, body: unknown, retryAfterMs?: number) {
  return parseOpenAIErrorBody(status, body, retryAfterMs);
}

export function renderResponsesError(error: GatewayErrorType, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return jsonHttpResponse(
    {
      error: {
        message: error.publicMessage,
        type: openAIErrorType(error.code, error.status),
        param: null,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    error.status,
    { "x-request-id": ctx.requestId },
  );
}

export function renderResponsesModels(models: PublicModel[], ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return renderOpenAIModelList(models, ctx);
}
