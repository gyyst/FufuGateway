import type { GatewayError } from "../core/errors";
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_RETRY_STATUSES,
} from "../core/limits";
import { computeBackoffMs } from "../core/time";
import type { ProviderRecord, RetryPolicyRecord } from "../config/types";

export type RetryPolicy = RetryPolicyRecord;

export function resolveRetryPolicy(provider: ProviderRecord): RetryPolicy {
  const configured = provider.retry;
  const maxAttempts = Math.min(
    Math.max(1, configured?.maxAttempts ?? provider.maxRetries + 1),
    DEFAULT_MAX_RETRY_ATTEMPTS,
  );
  return {
    maxAttempts,
    baseDelayMs: configured?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: configured?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    jitter: configured?.jitter ?? "full",
    retryStatuses: configured?.retryStatuses ?? [...DEFAULT_RETRY_STATUSES],
    retryOnNetworkError: configured?.retryOnNetworkError ?? true,
    retryOnTimeout: configured?.retryOnTimeout ?? "before_first_byte",
    respectRetryAfter: configured?.respectRetryAfter ?? true,
  };
}

export function upstreamStatusOf(error: GatewayError): number | undefined {
  const value = error.details?.["upstream_status"];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isNetworkError(error: GatewayError): boolean {
  return error.details?.["network"] === true;
}

/** 判断错误是否满足配置的重试条件。 */
export function shouldRetryError(error: GatewayError, policy: RetryPolicy): boolean {
  if (!error.retriable) return false;
  if (error.code === "UPSTREAM_TIMEOUT") return policy.retryOnTimeout !== "never";
  if (isNetworkError(error)) return policy.retryOnNetworkError;
  const status = upstreamStatusOf(error);
  if (status !== undefined) return policy.retryStatuses.includes(status);
  return true;
}

/** 计算下一次重试前的等待时间，优先遵循 Retry-After。 */
export function retryDelayMs(error: GatewayError, retryNumber: number, policy: RetryPolicy): number {
  if (policy.respectRetryAfter) {
    const retryAfter = error.details?.["retry_after_ms"];
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0) {
      return Math.min(retryAfter, policy.maxDelayMs);
    }
  }
  return computeBackoffMs(retryNumber, policy.baseDelayMs, policy.maxDelayMs, policy.jitter);
}

/** 认证类错误可在同一 Provider 内轮换账户。 */
export function isAccountRotationError(error: GatewayError): boolean {
  const status = upstreamStatusOf(error);
  return status === 401 || status === 403;
}
