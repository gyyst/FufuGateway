import { describe, expect, it } from "vitest";
import { GatewayError } from "../../src/core/errors";
import {
  isAccountRotationError,
  resolveRetryPolicy,
  retryDelayMs,
  shouldRetryError,
} from "../../src/execution/retry";
import type { ProviderRecord } from "../../src/config/types";

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "p",
    name: "p",
    type: "OPENAI_COMPATIBLE",
    protocol: "openai-chat",
    baseUrl: "https://x.test",
    enabled: true,
    priority: 100,
    weight: 1,
    customHeaders: {},
    timeoutMs: 60_000,
    firstTokenTimeoutMs: 20_000,
    idleTimeoutMs: 60_000,
    maxRetries: 2,
    retry: null,
    proxyConfig: null,
    extraConfig: {},
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function error(options: {
  retriable: boolean;
  status?: number;
  code?: GatewayError["code"];
  retryAfterMs?: number;
}): GatewayError {
  return new GatewayError({
    code: options.code ?? "UPSTREAM_ERROR",
    message: "x",
    retriable: options.retriable,
    details: {
      ...(options.status === undefined ? {} : { upstream_status: options.status }),
      ...(options.retryAfterMs === undefined ? {} : { retry_after_ms: options.retryAfterMs }),
    },
  });
}

describe("重试策略", () => {
  it("默认根据 Provider maxRetries 生成尝试次数", () => {
    const policy = resolveRetryPolicy(provider({ maxRetries: 3 }));
    expect(policy.maxAttempts).toBe(4);
    expect(policy.retryStatuses).toContain(429);
    expect(policy.retryOnNetworkError).toBe(true);
  });

  it("仅重试配置的状态码或可重试错误", () => {
    const policy = resolveRetryPolicy(provider());
    expect(shouldRetryError(error({ retriable: true, status: 500 }), policy)).toBe(true);
    expect(shouldRetryError(error({ retriable: true, status: 429 }), policy)).toBe(true);
    expect(shouldRetryError(error({ retriable: false, status: 400 }), policy)).toBe(false);
    expect(
      shouldRetryError(error({ retriable: true, status: 418 }), {
        ...policy,
        retryStatuses: [500],
      }),
    ).toBe(false);
  });

  it("超时是否重试由 retryOnTimeout 决定", () => {
    const policy = resolveRetryPolicy(provider());
    expect(
      shouldRetryError(error({ retriable: true, code: "UPSTREAM_TIMEOUT" }), policy),
    ).toBe(true);
    expect(
      shouldRetryError(error({ retriable: true, code: "UPSTREAM_TIMEOUT" }), {
        ...policy,
        retryOnTimeout: "never",
      }),
    ).toBe(false);
  });

  it("优先使用 Retry-After 且不超过最大延迟", () => {
    const policy = resolveRetryPolicy(provider());
    expect(retryDelayMs(error({ retriable: true, status: 429, retryAfterMs: 120 }), 1, policy)).toBe(120);
    expect(
      retryDelayMs(
        error({ retriable: true, status: 429, retryAfterMs: 900_000 }),
        1,
        { ...policy, maxDelayMs: 5_000 },
      ),
    ).toBe(5_000);
  });

  it("识别认证错误以轮换账户", () => {
    expect(isAccountRotationError(error({ retriable: false, status: 401 }))).toBe(true);
    expect(isAccountRotationError(error({ retriable: false, status: 403 }))).toBe(true);
    expect(isAccountRotationError(error({ retriable: true, status: 500 }))).toBe(false);
  });
});
