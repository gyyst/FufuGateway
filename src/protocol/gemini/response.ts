import { GatewayError, type GatewayError as GatewayErrorType } from "../../core/errors";
import { asNumber, asString, getRecord, isRecord, type JsonObject } from "../../core/json";
import type { UnifiedContentPart, UnifiedResponse, UnifiedUsage } from "../../ir";
import type { PublicModel } from "../../ir/models";
import { createCompatibilityContext, reportEmulated } from "../../ir/compat";
import { emptyUsage, normalizeUsage } from "../../ir/usage";
import { errorFromUpstreamStatus } from "../../ir/errors";
import { jsonHttpResponse } from "../shared/http";
import { parseToolArguments, requireArray, requireObject, requireString } from "../shared/validate";
import type { ParseResponseContext, RenderContext } from "../types";

export function parseGeminiUsage(raw: unknown): UnifiedUsage {
  if (!isRecord(raw)) return emptyUsage("none");
  return normalizeUsage({
    inputTokens: asNumber(raw["promptTokenCount"]) ?? 0,
    outputTokens: asNumber(raw["candidatesTokenCount"]) ?? 0,
    totalTokens: asNumber(raw["totalTokenCount"]),
    cachedInputTokens: asNumber(raw["cachedContentTokenCount"]),
    reasoningTokens: asNumber(raw["thoughtsTokenCount"]),
    source: "upstream",
  });
}

export function mapGeminiFinishReason(value: unknown, hasTools: boolean): UnifiedResponse["stopReason"] {
  switch (asString(value)) {
    case "STOP":
      return hasTools ? "tool_use" : "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
      return "error";
    default:
      return hasTools ? "tool_use" : "unknown";
  }
}

function parseGeminiResponseParts(partsRaw: unknown, path: string): UnifiedContentPart[] {
  const parts = requireArray(partsRaw, path);
  const result: UnifiedContentPart[] = [];
  parts.forEach((entry, index) => {
    const part = requireObject(entry, `${path}[${index}]`);
    const call = getRecord(part, "functionCall");
    if (call) {
      const parsed = parseToolArguments(call["args"]);
      const toolCall: UnifiedContentPart = {
        type: "tool_call",
        id: `call_gemini_${index}`,
        name: requireString(call["name"], `${path}[${index}].functionCall.name`),
        arguments: parsed.arguments,
      };
      const signature = asString(part["thoughtSignature"]);
      if (signature !== undefined) toolCall.signature = signature;
      result.push(toolCall);
      return;
    }
    if (part["inlineData"] !== undefined) {
      const inline = requireObject(part["inlineData"], `${path}[${index}].inlineData`);
      result.push({
        type: "image",
        source: {
          kind: "base64",
          mediaType: asString(inline["mimeType"]) ?? "application/octet-stream",
          data: asString(inline["data"]) ?? "",
        },
      });
      return;
    }
    if (part["fileData"] !== undefined) {
      const file = requireObject(part["fileData"], `${path}[${index}].fileData`);
      const uri = asString(file["fileUri"]) ?? "";
      result.push({
        type: "image",
        source: uri.startsWith("http")
          ? { kind: "url", url: uri }
          : { kind: "file", fileId: uri, ...(asString(file["mimeType"]) === undefined ? {} : { mediaType: asString(file["mimeType"]) }) },
      });
      return;
    }
    const text = asString(part["text"]);
    if (text !== undefined) {
      if (part["thought"] === true) {
        const thinking: UnifiedContentPart = { type: "thinking", text };
        const signature = asString(part["thoughtSignature"]);
        if (signature !== undefined) thinking.signature = signature;
        result.push(thinking);
      } else {
        result.push({ type: "text", text });
      }
      return;
    }
    throw new GatewayError({
      code: "PROTOCOL_CONVERSION_ERROR",
      message: `Unsupported Gemini response part at ${path}[${index}]`,
    });
  });
  return result;
}

export function parseGeminiResponse(body: JsonObject, ctx?: ParseResponseContext): UnifiedResponse {
  const candidates = body["candidates"];
  const id = asString(body["responseId"]) ?? ctx?.requestId ?? `gemini_${Date.now().toString(36)}`;
  const model = asString(body["modelVersion"]) ?? ctx?.model ?? "";
  const createdAt = Date.now();

  if (!Array.isArray(candidates) || candidates.length === 0) {
    const feedback = getRecord(body, "promptFeedback");
    const blockReason = feedback ? asString(feedback["blockReason"]) : undefined;
    if (blockReason !== undefined) {
      return {
        id,
        model,
        createdAt,
        content: [],
        stopReason: "content_filter",
        usage: parseGeminiUsage(body["usageMetadata"]),
      };
    }
    throw new GatewayError({
      code: "PROTOCOL_CONVERSION_ERROR",
      message: "Gemini returned no candidates",
    });
  }

  const candidate = requireObject(candidates[0], "candidates[0]");
  const content = requireObject(candidate["content"], "candidates[0].content");
  const parts = parseGeminiResponseParts(content["parts"], "candidates[0].content.parts");
  const hasTools = parts.some((part) => part.type === "tool_call");

  return {
    id,
    model,
    createdAt,
    content: parts,
    stopReason: mapGeminiFinishReason(candidate["finishReason"], hasTools),
    usage: parseGeminiUsage(body["usageMetadata"]),
  };
}

export function renderGeminiResponse(response: UnifiedResponse, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  const compat = createCompatibilityContext(ctx.policy, "gateway", "gemini");
  const parts: JsonObject[] = [];

  for (const part of response.content) {
    if (part.type === "text") {
      parts.push({ text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        text: part.text,
        thought: true,
        ...(part.signature === undefined ? {} : { thoughtSignature: part.signature }),
      });
    } else if (part.type === "tool_call") {
      parts.push({ functionCall: { name: part.name, args: part.arguments } });
    } else if (part.type === "refusal") {
      parts.push({ text: part.text });
      reportEmulated(compat, "refusal", "refusal was converted to a text part");
    } else if (part.type === "image") {
      if (part.source.kind === "base64") {
        parts.push({ inlineData: { mimeType: part.source.mediaType, data: part.source.data } });
      } else if (part.source.kind === "url") {
        parts.push({ fileData: { fileUri: part.source.url } });
      } else {
        parts.push({
          fileData: {
            fileUri: part.source.fileId,
            ...(part.source.mediaType === undefined ? {} : { mimeType: part.source.mediaType }),
          },
        });
      }
    }
  }

  if (parts.length === 0) parts.push({ text: "" });

  const finishReason =
    response.stopReason === "max_tokens"
      ? "MAX_TOKENS"
      : response.stopReason === "content_filter"
        ? "SAFETY"
        : response.stopReason === "error"
          ? "OTHER"
          : "STOP";

  const usageMetadata: JsonObject = {
    promptTokenCount: response.usage.inputTokens,
    candidatesTokenCount: response.usage.outputTokens,
    totalTokenCount: response.usage.totalTokens,
  };
  if (response.usage.cachedInputTokens !== undefined) {
    usageMetadata["cachedContentTokenCount"] = response.usage.cachedInputTokens;
  }
  if (response.usage.reasoningTokens !== undefined) {
    usageMetadata["thoughtsTokenCount"] = response.usage.reasoningTokens;
  }

  ctx.issues.push(...compat.issues);
  return jsonHttpResponse(
    {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason,
          index: 0,
          safetyRatings: [],
        },
      ],
      usageMetadata,
      modelVersion: response.model || ctx.model,
      responseId: response.id,
    },
    200,
    { "x-request-id": ctx.requestId },
  );
}

export function parseGeminiError(status: number, body: unknown, retryAfterMs?: number) {
  const errorObject = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  return errorFromUpstreamStatus(status, {
    upstreamType: errorObject ? asString(errorObject["status"]) : undefined,
    upstreamCode: errorObject ? String(errorObject["code"] ?? "") : undefined,
    retryAfterMs,
  });
}

function googleStatus(status: number, code: GatewayErrorType["code"]): string {
  switch (code) {
    case "AUTHENTICATION_ERROR":
      return "UNAUTHENTICATED";
    case "PERMISSION_DENIED":
      return "PERMISSION_DENIED";
    case "NOT_FOUND":
    case "MODEL_NOT_FOUND":
    case "PROVIDER_NOT_FOUND":
      return "NOT_FOUND";
    case "REQUEST_LIMIT_EXCEEDED":
    case "TOKEN_LIMIT_EXCEEDED":
    case "UPSTREAM_RATE_LIMITED":
    case "BUDGET_EXCEEDED":
      return "RESOURCE_EXHAUSTED";
    case "UPSTREAM_TIMEOUT":
      return "DEADLINE_EXCEEDED";
    case "PROVIDER_UNAVAILABLE":
      return "UNAVAILABLE";
    case "INVALID_REQUEST":
    case "UNSUPPORTED_FEATURE":
    case "MODEL_AMBIGUOUS":
    case "PROTOCOL_CONVERSION_ERROR":
      return "INVALID_ARGUMENT";
    default:
      return status >= 500 ? "INTERNAL" : "INVALID_ARGUMENT";
  }
}

export function renderGeminiError(error: GatewayErrorType, ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return jsonHttpResponse(
    {
      error: {
        code: error.status,
        message: error.publicMessage,
        status: googleStatus(error.status, error.code),
        ...(error.details === undefined ? {} : { details: [{ "@type": "type.googleapis.com/gateway.ErrorDetail", ...error.details }] }),
      },
    },
    error.status,
    { "x-request-id": ctx.requestId },
  );
}

export function renderGeminiModels(models: PublicModel[], ctx: RenderContext): ReturnType<typeof jsonHttpResponse> {
  return jsonHttpResponse(
    {
      models: models.map((model) => ({
        name: `models/${model.id}`,
        displayName: model.displayName ?? model.id,
        description: `Model ${model.id} provided by ${model.providerName}`,
        ...(model.contextWindow === undefined ? {} : { inputTokenLimit: model.contextWindow }),
        ...(model.maxOutputTokens === undefined ? {} : { outputTokenLimit: model.maxOutputTokens }),
        supportedGenerationMethods: model.capabilities.supportsStream
          ? ["generateContent", "streamGenerateContent"]
          : ["generateContent"],
      })),
    },
    200,
    { "x-request-id": ctx.requestId },
  );
}
