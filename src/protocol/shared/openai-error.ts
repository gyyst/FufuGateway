import { isRecord, asString } from "../../core/json";
import type { UnifiedError } from "../../ir/errors";
import { errorFromUpstreamStatus } from "../../ir/errors";
import type { GatewayErrorCode } from "../../core/errors";

/** 解析 OpenAI 风格错误体（Chat Completions / Responses 共用）。 */
export function parseOpenAIErrorBody(
  status: number,
  body: unknown,
  retryAfterMs?: number,
): UnifiedError {
  const errorObject = isRecord(body) && isRecord(body["error"]) ? body["error"] : undefined;
  return errorFromUpstreamStatus(status, {
    upstreamType: errorObject ? asString(errorObject["type"]) : undefined,
    upstreamCode: errorObject ? asString(errorObject["code"]) : undefined,
    retryAfterMs,
  });
}

export function openAIErrorType(code: GatewayErrorCode, status: number): string {
  switch (code) {
    case "AUTHENTICATION_ERROR":
      return "authentication_error";
    case "PERMISSION_DENIED":
      return "permission_error";
    case "INVALID_REQUEST":
    case "UNSUPPORTED_FEATURE":
    case "PROTOCOL_CONVERSION_ERROR":
      return "invalid_request_error";
    case "MODEL_NOT_FOUND":
    case "PROVIDER_NOT_FOUND":
    case "NOT_FOUND":
      return "not_found_error";
    case "MODEL_AMBIGUOUS":
      return "invalid_request_error";
    case "UPSTREAM_RATE_LIMITED":
    case "REQUEST_LIMIT_EXCEEDED":
    case "TOKEN_LIMIT_EXCEEDED":
      return "rate_limit_error";
    case "BUDGET_EXCEEDED":
      return "insufficient_quota";
    default:
      return status >= 500 ? "api_error" : "invalid_request_error";
  }
}
