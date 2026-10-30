/**
 * 统一错误体系。
 *
 * 所有业务错误都必须转换为 GatewayError，避免把内部异常、上游密钥、
 * 数据库信息或堆栈直接暴露给客户端。
 */

export const GATEWAY_ERROR_CODES = [
  "AUTHENTICATION_ERROR",
  "PERMISSION_DENIED",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "MODEL_NOT_FOUND",
  "MODEL_AMBIGUOUS",
  "PROVIDER_NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_RATE_LIMITED",
  "UPSTREAM_ERROR",
  "PROTOCOL_CONVERSION_ERROR",
  "UNSUPPORTED_FEATURE",
  "COMBO_CYCLE_DETECTED",
  "COMBO_EXECUTION_FAILED",
  "REQUEST_LIMIT_EXCEEDED",
  "TOKEN_LIMIT_EXCEEDED",
  "BUDGET_EXCEEDED",
  "REQUEST_CANCELLED",
  "CONFIG_INVALID",
  "INTERNAL_ERROR",
] as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export const DEFAULT_HTTP_STATUS: Record<GatewayErrorCode, number> = {
  AUTHENTICATION_ERROR: 401,
  PERMISSION_DENIED: 403,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  MODEL_NOT_FOUND: 404,
  MODEL_AMBIGUOUS: 409,
  PROVIDER_NOT_FOUND: 404,
  PROVIDER_UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  PROTOCOL_CONVERSION_ERROR: 502,
  UNSUPPORTED_FEATURE: 400,
  COMBO_CYCLE_DETECTED: 500,
  COMBO_EXECUTION_FAILED: 502,
  REQUEST_LIMIT_EXCEEDED: 429,
  TOKEN_LIMIT_EXCEEDED: 429,
  BUDGET_EXCEEDED: 402,
  REQUEST_CANCELLED: 499,
  CONFIG_INVALID: 400,
  INTERNAL_ERROR: 500,
};

/** 默认是否允许在路由/Combo 层切换上游重试。 */
export const DEFAULT_RETRIABLE: Record<GatewayErrorCode, boolean> = {
  AUTHENTICATION_ERROR: false,
  PERMISSION_DENIED: false,
  INVALID_REQUEST: false,
  NOT_FOUND: false,
  MODEL_NOT_FOUND: false,
  MODEL_AMBIGUOUS: false,
  PROVIDER_NOT_FOUND: false,
  PROVIDER_UNAVAILABLE: true,
  UPSTREAM_TIMEOUT: true,
  UPSTREAM_RATE_LIMITED: true,
  UPSTREAM_ERROR: true,
  PROTOCOL_CONVERSION_ERROR: false,
  UNSUPPORTED_FEATURE: false,
  COMBO_CYCLE_DETECTED: false,
  COMBO_EXECUTION_FAILED: true,
  REQUEST_LIMIT_EXCEEDED: false,
  TOKEN_LIMIT_EXCEEDED: false,
  BUDGET_EXCEEDED: false,
  REQUEST_CANCELLED: false,
  CONFIG_INVALID: false,
  INTERNAL_ERROR: false,
};

export interface GatewayErrorOptions {
  code: GatewayErrorCode;
  message: string;
  /** 覆盖默认 HTTP 状态码（例如请求体过大使用 413）。 */
  status?: number;
  retriable?: boolean;
  /** 可安全返回给客户端的结构化细节，禁止放入密钥或内部堆栈。 */
  details?: Record<string, unknown>;
  cause?: unknown;
  /** 是否允许把 message 返回给客户端，默认 true。 */
  expose?: boolean;
}

const GENERIC_INTERNAL_MESSAGE = "Internal gateway error";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly retriable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly expose: boolean;

  constructor(options: GatewayErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    this.code = options.code;
    this.status = options.status ?? DEFAULT_HTTP_STATUS[options.code];
    this.retriable = options.retriable ?? DEFAULT_RETRIABLE[options.code];
    this.details = options.details;
    this.expose = options.expose ?? true;
  }

  /** 返回给客户端的安全消息。 */
  get publicMessage(): string {
    return this.expose ? this.message : GENERIC_INTERNAL_MESSAGE;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.publicMessage,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  withDetails(details: Record<string, unknown>): GatewayError {
    return new GatewayError({
      code: this.code,
      message: this.message,
      status: this.status,
      retriable: this.retriable,
      details: { ...this.details, ...details },
      cause: this.cause,
      expose: this.expose,
    });
  }
}

export function isGatewayError(value: unknown): value is GatewayError {
  return value instanceof GatewayError;
}

export function isAbortError(value: unknown): boolean {
  return (
    (value instanceof DOMException && value.name === "AbortError") ||
    (value instanceof Error && value.name === "AbortError")
  );
}

/**
 * 把任意异常转换为 GatewayError。
 * 未知异常一律收敛为 INTERNAL_ERROR，仅保留原因用于服务端日志。
 */
export function toGatewayError(
  value: unknown,
  fallback: { message?: string; code?: GatewayErrorCode } = {},
): GatewayError {
  if (isGatewayError(value)) return value;
  if (isAbortError(value)) {
    return new GatewayError({
      code: "REQUEST_CANCELLED",
      message: "Request cancelled",
      cause: value,
    });
  }
  return new GatewayError({
    code: fallback.code ?? "INTERNAL_ERROR",
    message: fallback.message ?? GENERIC_INTERNAL_MESSAGE,
    expose: false,
    cause: value,
  });
}
