import { GatewayError } from "../../core/errors";
import { asNumber, asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type { UnifiedContentPart, UnifiedResponse, UnifiedUsage } from "../../ir";
import { emptyUsage, normalizeUsage } from "../../ir/usage";
import { createCompatibilityContext, reportUnsupported } from "../../ir/compat";
import type { GatewayError as GatewayErrorType } from "../../core/errors";
import { jsonHttpResponse } from "../shared/http";
import { openAIErrorType, parseOpenAIErrorBody } from "../shared/openai-error";
import { renderOpenAIModelList } from "../shared/openai-models";
import { parseToolArguments, requireArray, requireObject, requireString, stringifyToolArguments } from "../shared/validate";
import type { ParseResponseContext, RenderContext } from "../types";
import type { PublicModel } from "../../ir/models";

export function parseOpenAIChatUsage(raw: unknown): UnifiedUsage {
  if (!isRecord(raw)) return emptyUsage("none");
  const promptDetails = getRecord(raw, "prompt_tokens_details");
  const completionDetails = getRecord(raw, "completion_tokens_details");
  return normalizeUsage({
    inputTokens: asNumber(raw["prompt_tokens"]) ?? 0,
    outputTokens: asNumber(raw["completion_tokens"]) ?? 0,
    totalTokens: asNumber(raw["total_tokens"]),
    cachedInputTokens: promptDetails ? asNumber(promptDetails["cached_tokens"]) : undefined,
    reasoningTokens: completionDetails ? asNumber(completionDetails["reasoning_tokens"]) : undefined,
    source: "upstream",
  });
}

export function stripPrefixReasoning(message: JsonObject): string | undefined {
  return asString(message["reasoning_content"]) ?? asString(message["reasoning"]);
}

function parseAssistantContent(raw: unknown): UnifiedContentPart[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return raw === "" ? [] : [{ type: "text", text: raw }];
  const parts = requireArray(raw, "choices[0].message.content");
  const result: UnifiedContentPart[] = [];
  parts.forEach((entry, index) => {
    const part = requireObject(entry, `choices[0].message.content[${index}]`);
    const type = asString(part["type"]);
    if (type === "text") {
      const text = asString(part["text"]);
      if (text !== undefined) result.push({ type: "text", text });
      return;
    }
    if (type === "refusal") {
      result.push({ type: "refusal", text: asString(part["refusal"]) ?? "" });
      return;
    }
    throw new GatewayError({
      code: "PROTOCOL_CONVERSION_ERROR",
      message: `Unsupported OpenAI Chat response content type "${type ?? "unknown"}"`,
    });
  });
  return result;
}

export function mapOpenAIChatFinishReason(value: unknown, hasTools: boolean): UnifiedResponse["stopReason"] {
  switch (asString(value)) {
    case "stop":
      return hasTools ? "tool_use" : "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return hasTools ? "tool_use" : "unknown";
  }
}

export function parseOpenAIChatResponse(body: JsonObject, ctx?: ParseResponseContext): UnifiedResponse {
  const choices = requireArray(body["choices"], "choices");
  if (choices.length === 0) {
    throw new GatewayError({ code: "PROTOCOL_CONVERSION_ERROR", message: "Upstream returned no choices" });
  }

  let choice: JsonObject | undefined;
  for (const entry of choices) {
    const candidate = requireObject(entry, "choices[]");
    if (candidate["index"] === 0 || candidate["index"] === undefined) {
      choice = candidate;
      break;
    }
  }
  if (choice === undefined) choice = requireObject(choices[0], "choices[0]");

  const message = requireObject(choice["message"], "choices[0].message");
  const content: UnifiedContentPart[] = [];

  const reasoning = stripPrefixReasoning(message);
  if (reasoning !== undefined && reasoning !== "") {
    content.push({ type: "thinking", text: reasoning });
  }
  content.push(...parseAssistantContent(message["content"]));

  const toolCalls = message["tool_calls"];
  if (toolCalls !== undefined && toolCalls !== null) {
    const calls = requireArray(toolCalls, "choices[0].message.tool_calls");
    calls.forEach((entry, index) => {
      const call = requireObject(entry, `choices[0].message.tool_calls[${index}]`);
      const fn = requireObject(call["function"], `choices[0].message.tool_calls[${index}].function`);
      const name = requireString(fn["name"], `choices[0].message.tool_calls[${index}].function.name`);
      const parsed = parseToolArguments(fn["arguments"]);
      const part: UnifiedContentPart = {
        type: "tool_call",
        id: asString(call["id"]) ?? `call_${index}`,
        name,
        arguments: parsed.arguments,
      };
      if (parsed.rawArguments !== undefined) part.rawArguments = parsed.rawArguments;
      content.push(part);
    });
  }

  const hasTools = content.some((part) => part.type === "tool_call");
  const refusal = asString(message["refusal"]);
  if (refusal !== undefined && refusal !== "") content.push({ type: "refusal", text: refusal });

  return {
    id: asString(body["id"]) ?? ctx?.requestId ?? "chatcmpl-unknown",
    model: asString(body["model"]) ?? ctx?.model ?? "",
    createdAt: (asNumber(body["created"]) ?? Math.floor(Date.now() / 1000)) * 1000,
    content,
    stopReason: mapOpenAIChatFinishReason(choice["finish_reason"], hasTools),
    usage: parseOpenAIChatUsage(body["usage"]),
  };
}

export function openAIFinishReasonFromStopReason(stop: UnifiedResponse["stopReason"]): string {
  if (stop === "max_tokens") return "length";
  if (stop === "tool_use") return "tool_calls";
  if (stop === "content_filter") return "content_filter";
  return "stop";
}

export function openAIUsageBody(usage: UnifiedUsage): JsonObject {
  const body: JsonObject = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  };
  if (usage.cachedInputTokens !== undefined) {
    body["prompt_tokens_details"] = { cached_tokens: usage.cachedInputTokens };
  }
  if (usage.reasoningTokens !== undefined) {
    body["completion_tokens_details"] = { reasoning_tokens: usage.reasoningTokens };
  }
  return body;
}

export function renderOpenAIChatResponse(response: UnifiedResponse, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  const compat = createCompatibilityContext(ctx.policy, "gateway", "openai-chat");
  let text = "";
  let thinking = "";
  let refusal: string | undefined;
  const toolCalls: JsonObject[] = [];

  for (const part of response.content) {
    if (part.type === "text") text += part.text;
    else if (part.type === "thinking") thinking += part.text;
    else if (part.type === "refusal") refusal = (refusal ?? "") + part.text;
    else if (part.type === "tool_call") {
      toolCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: stringifyToolArguments(part.arguments, part.rawArguments),
        },
      });
    } else if (part.type === "image") {
      reportUnsupported(compat, "output.image", "OpenAI Chat Completions cannot return image content");
    }
  }

  const message: JsonObject = {
    role: "assistant",
    content: text === "" && toolCalls.length > 0 ? null : text,
  };
  if (thinking !== "") message["reasoning_content"] = thinking;
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  if (refusal !== undefined) message["refusal"] = refusal;

  const finishReason = openAIFinishReasonFromStopReason(response.stopReason);
  const usage = openAIUsageBody(response.usage);

  ctx.issues.push(...compat.issues);
  return jsonHttpResponse(
    {
      id: response.id,
      object: "chat.completion",
      created: Math.floor(response.createdAt / 1000),
      model: response.model || ctx.model,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      usage,
    },
    200,
    { "x-request-id": ctx.requestId },
  );
}

export function parseOpenAIChatError(status: number, body: unknown, retryAfterMs?: number) {
  return parseOpenAIErrorBody(status, body, retryAfterMs);
}

export function renderOpenAIChatError(error: GatewayErrorType, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
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

export function renderOpenAIChatModels(models: PublicModel[], ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return renderOpenAIModelList(models, ctx);
}
