import { GatewayError, type GatewayErrorCode } from "../core/errors";
import { truncate } from "../core/json";
import type { StopReason } from "./response";

/** 上游错误的统一表示。 */
export interface UnifiedError {
  code: GatewayErrorCode;
  message: string;
  retriable: boolean;
  upstreamStatus?: number;
  upstreamCode?: string;
  upstreamType?: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

export function toUnifiedError(error: GatewayError): UnifiedError {
  return {
    code: error.code,
    message: error.publicMessage,
    retriable: error.retriable,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

export function fromUnifiedError(error: UnifiedError): GatewayError {
  return new GatewayError({
    code: error.code,
    message: error.message,
    retriable: error.retriable,
    details: {
      ...(error.details ?? {}),
      ...(error.upstreamStatus === undefined ? {} : { upstream_status: error.upstreamStatus }),
      ...(error.upstreamCode === undefined ? {} : { upstream_code: error.upstreamCode }),
      ...(error.upstreamType === undefined ? {} : { upstream_type: error.upstreamType }),
      ...(error.retryAfterMs === undefined ? {} : { retry_after_ms: error.retryAfterMs }),
    },
    expose: true,
  });
}

/** HTTP 状态 → 统一错误的默认映射。 */
export function errorFromUpstreamStatus(
  status: number,
  options: {
    message?: string;
    upstreamCode?: string;
    upstreamType?: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  } = {},
): UnifiedError {
  const baseMessage = options.message ?? `Upstream returned HTTP ${status}`;
  const common = {
    upstreamStatus: status,
    ...(options.upstreamCode === undefined ? {} : { upstreamCode: options.upstreamCode }),
    ...(options.upstreamType === undefined ? {} : { upstreamType: options.upstreamType }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.details === undefined ? {} : { details: options.details }),
  };

  if (status === 401 || status === 403) {
    return {
      code: "UPSTREAM_ERROR",
      message: "Upstream rejected gateway credentials",
      retriable: false,
      ...common,
    };
  }
  if (status === 404) {
    return { code: "MODEL_NOT_FOUND", message: "Upstream model not found", retriable: false, ...common };
  }
  if (status === 408 || status === 504) {
    return { code: "UPSTREAM_TIMEOUT", message: "Upstream request timed out", retriable: true, ...common };
  }
  if (status === 429) {
    return {
      code: "UPSTREAM_RATE_LIMITED",
      message: "Upstream rate limit exceeded",
      retriable: true,
      ...common,
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: "INVALID_REQUEST",
      message: truncate(baseMessage, 500),
      retriable: false,
      ...common,
    };
  }
  if (status >= 500) {
    return { code: "UPSTREAM_ERROR", message: "Upstream service error", retriable: true, ...common };
  }
  return {
    code: "UPSTREAM_ERROR",
    message: `Upstream returned HTTP ${status}`,
    retriable: false,
    ...common,
  };
}

/** 解析 Retry-After（秒数或 HTTP 日期），返回毫秒。 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, 300_000);
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(Math.max(0, timestamp - Date.now()), 300_000);
}

export type { StopReason };
