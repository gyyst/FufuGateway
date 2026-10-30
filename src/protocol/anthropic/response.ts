import { GatewayError } from "../../core/errors";
import { asNumber, asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type { GatewayError as GatewayErrorType } from "../../core/errors";
import type { UnifiedContentPart, UnifiedResponse, UnifiedUsage } from "../../ir";
import type { PublicModel } from "../../ir/models";
import { createCompatibilityContext, reportEmulated, reportUnsupported } from "../../ir/compat";
import { emptyUsage, normalizeUsage } from "../../ir/usage";
import { jsonHttpResponse } from "../shared/http";
import { errorFromUpstreamStatus } from "../../ir/errors";
import { parseToolArguments, requireArray, requireObject, requireString } from "../shared/validate";
import type { ParseResponseContext, RenderContext } from "../types";

function parseAnthropicUsage(raw: unknown): UnifiedUsage {
  if (!isRecord(raw)) return emptyUsage("none");
  const input = asNumber(raw["input_tokens"]) ?? 0;
  const cached = asNumber(raw["cache_read_input_tokens"]) ?? 0;
  const cacheWrite = asNumber(raw["cache_creation_input_tokens"]) ?? 0;
  return normalizeUsage({
    inputTokens: input + cached + cacheWrite,
    outputTokens: asNumber(raw["output_tokens"]) ?? 0,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    source: "upstream",
  });
}

function parseStopReason(value: unknown, hasTools: boolean): UnifiedResponse["stopReason"] {
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
    case "pause_turn":
      return "unknown";
    default:
      return hasTools ? "tool_use" : "unknown";
  }
}

export function parseAnthropicResponse(body: JsonObject, ctx?: ParseResponseContext): UnifiedResponse {
  const blocks = requireArray(body["content"], "content");
  const content: UnifiedContentPart[] = [];

  blocks.forEach((entry, index) => {
    const block = requireObject(entry, `content[${index}]`);
    const type = requireString(block["type"], `content[${index}].type`);
    switch (type) {
      case "text":
        content.push({ type: "text", text: asString(block["text"]) ?? "" });
        break;
      case "tool_use": {
        const parsed = parseToolArguments(block["input"]);
        const part: UnifiedContentPart = {
          type: "tool_call",
          id: requireString(block["id"], `content[${index}].id`),
          name: requireString(block["name"], `content[${index}].name`),
          arguments: parsed.arguments,
        };
        if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
        content.push(part);
        break;
      }
      case "thinking": {
        const part: UnifiedContentPart = {
          type: "thinking",
          text: asString(block["thinking"]) ?? "",
        };
        const signature = asString(block["signature"]);
        if (signature !== undefined) part.signature = signature;
        content.push(part);
        break;
      }
      case "redacted_thinking":
        content.push({
          type: "thinking",
          text: "",
          redacted: true,
          redactedData: asString(block["data"]) ?? "",
        });
        break;
      case "image": {
        const source = getRecord(block, "source");
        const sourceType = source ? asString(source["type"]) : undefined;
        if (source && sourceType === "base64") {
          content.push({
            type: "image",
            source: {
              kind: "base64",
              mediaType: asString(source["media_type"]) ?? "application/octet-stream",
              data: asString(source["data"]) ?? "",
            },
          });
        } else if (source && sourceType === "url") {
          content.push({ type: "image", source: { kind: "url", url: asString(source["url"]) ?? "" } });
        } else {
          throw new GatewayError({
            code: "PROTOCOL_CONVERSION_ERROR",
            message: `Unsupported Anthropic image source in response`,
          });
        }
        break;
      }
      default:
        throw new GatewayError({
          code: "PROTOCOL_CONVERSION_ERROR",
          message: `Unsupported Anthropic response block type "${type}"`,
        });
    }
  });

  const hasTools = content.some((part) => part.type === "tool_call");
  const stopSequence = asString(body["stop_sequence"]);

  return {
    id: asString(body["id"]) ?? ctx?.requestId ?? `msg_${Date.now().toString(36)}`,
    model: asString(body["model"]) ?? ctx?.model ?? "",
    createdAt: Date.now(),
    content,
    stopReason: parseStopReason(body["stop_reason"], hasTools),
    ...(stopSequence === undefined ? {} : { stopSequence }),
    usage: parseAnthropicUsage(body["usage"]),
  };
}

export function renderAnthropicResponse(response: UnifiedResponse, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  const compat = createCompatibilityContext(ctx.policy, "gateway", "anthropic");
  const content: JsonObject[] = [];

  for (const part of response.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      if (part.redacted === true) {
        content.push({ type: "redacted_thinking", data: part.redactedData ?? part.signature ?? "" });
      } else if (part.signature !== undefined) {
        content.push({ type: "thinking", thinking: part.text, signature: part.signature });
      } else if (part.text !== "") {
        content.push({ type: "text", text: part.text });
        reportEmulated(
          compat,
          "thinking.signature",
          "thinking content without an Anthropic signature was rendered as text",
        );
      }
    } else if (part.type === "tool_call") {
      content.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.arguments,
      });
    } else if (part.type === "refusal") {
      content.push({ type: "text", text: part.text });
      reportEmulated(compat, "refusal", "refusal was converted to a text block");
    } else if (part.type === "image") {
      reportUnsupported(compat, "output.image", "Anthropic Messages responses cannot include gateway images");
    }
  }

  const cached = response.usage.cachedInputTokens ?? 0;
  const cacheWrite = response.usage.cacheWriteInputTokens ?? 0;
  const usage: JsonObject = {
    input_tokens: Math.max(0, response.usage.inputTokens - cached - cacheWrite),
    output_tokens: response.usage.outputTokens,
  };
  if (cached > 0) usage["cache_read_input_tokens"] = cached;
  if (cacheWrite > 0) usage["cache_creation_input_tokens"] = cacheWrite;

  const stopReason =
    response.stopReason === "max_tokens"
      ? "max_tokens"
      : response.stopReason === "tool_use"
        ? "tool_use"
        : response.stopReason === "stop_sequence"
          ? "stop_sequence"
          : response.stopReason === "content_filter"
            ? "refusal"
            : "end_turn";

  ctx.issues.push(...compat.issues);
  return jsonHttpResponse(
    {
      id: response.id,
      type: "message",
      role: "assistant",
      model: response.model || ctx.model,
      content,
      stop_reason: stopReason,
      stop_sequence: response.stopSequence ?? null,
      usage,
    },
    200,
    { "x-request-id": ctx.requestId },
  );
}

export function parseAnthropicError(status: number, body: unknown, retryAfterMs?: number) {
  const errorObject = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  return errorFromUpstreamStatus(status, {
    upstreamType: errorObject ? asString(errorObject["type"]) : undefined,
    retryAfterMs,
  });
}

function anthropicErrorType(error: GatewayErrorType): string {
  if (error.status === 413) return "request_too_large";
  switch (error.code) {
    case "AUTHENTICATION_ERROR":
      return "authentication_error";
    case "PERMISSION_DENIED":
      return "permission_error";
    case "NOT_FOUND":
    case "MODEL_NOT_FOUND":
    case "PROVIDER_NOT_FOUND":
      return "not_found_error";
    case "UPSTREAM_RATE_LIMITED":
    case "REQUEST_LIMIT_EXCEEDED":
    case "TOKEN_LIMIT_EXCEEDED":
      return "rate_limit_error";
    case "INVALID_REQUEST":
    case "UNSUPPORTED_FEATURE":
    case "MODEL_AMBIGUOUS":
      return "invalid_request_error";
    default:
      return error.status === 503 ? "overloaded_error" : "api_error";
  }
}

export function renderAnthropicError(error: GatewayErrorType, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return jsonHttpResponse(
    {
      type: "error",
      error: {
        type: anthropicErrorType(error),
        message: error.publicMessage,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    error.status,
    { "x-request-id": ctx.requestId },
  );
}

export function renderAnthropicModels(_models: PublicModel[], ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return jsonHttpResponse(
    {
      type: "error",
      error: { type: "not_found_error", message: "Anthropic Messages has no models endpoint" },
    },
    404,
    { "x-request-id": ctx.requestId },
  );
}
