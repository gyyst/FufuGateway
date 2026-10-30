import { GatewayError, toGatewayError } from "../core/errors";
import { isRecord } from "../core/json";
import type { CompatibilityIssue, CompatibilityPolicy, UnifiedRequest, UnifiedResponse } from "../ir";
import { fromUnifiedError, parseRetryAfter } from "../ir/errors";
import type { GatewayEnv } from "../env";
import type { ProviderAccountRecord, ProviderRecord, RuntimeConfig } from "../config/types";
import type { ResolvedTarget } from "../combo/types";
import { protocolRegistry } from "../protocol/registry";
import { buildProviderRequest } from "../providers/engine";
import type { FetchLike } from "../providers/types";
import { readResponseText, tryParseJson } from "./http";
import { fetchWithTimeout } from "./http";
import { selectProviderAccount } from "./accounts";
import {
  BreakerClient,
  accountBreakerKey,
  breakerOptionsFor,
  modelBreakerKey,
} from "./breaker";
import {
  isAccountRotationError,
  resolveRetryPolicy,
  retryDelayMs,
  shouldRetryError,
  upstreamStatusOf,
  type RetryPolicy,
} from "./retry";
import { sleep } from "../core/time";

export interface ExecutionDependencies {
  env: GatewayEnv;
  config: RuntimeConfig;
  fetchImpl: FetchLike;
  requestId: string;
  policy: CompatibilityPolicy;
  signal?: AbortSignal;
  /** 请求级总预算（绝对时间戳）。 */
  deadline?: number;
  /** Combo 节点级重试覆盖。 */
  retryPolicy?: RetryPolicy;
}

export interface ModelExecutionResult {
  response: UnifiedResponse;
  target: ResolvedTarget;
  provider: ProviderRecord;
  account: ProviderAccountRecord;
  httpStatus: number;
  issues: CompatibilityIssue[];
  latencyMs: number;
  retryCount: number;
}

const MAX_ERROR_BODY_BYTES = 64 * 1024;

function breakerWorthy(error: GatewayError): boolean {
  if (
    error.code === "UPSTREAM_ERROR" ||
    error.code === "UPSTREAM_TIMEOUT" ||
    error.code === "UPSTREAM_RATE_LIMITED" ||
    error.code === "PROVIDER_UNAVAILABLE"
  ) {
    return true;
  }
  const status = upstreamStatusOf(error);
  return status !== undefined && (status >= 500 || status === 401 || status === 403 || status === 429);
}

/**
 * 执行一次上游模型调用（非流式）。
 * 包含重试、账户轮换、Retry-After、熔断记录与请求级总预算。
 */
export async function executeModelOnce(
  request: UnifiedRequest,
  target: ResolvedTarget,
  deps: ExecutionDependencies,
  excludedAccounts?: ReadonlySet<string>,
): Promise<ModelExecutionResult> {
  if (request.stream) {
    throw new GatewayError({
      code: "INTERNAL_ERROR",
      message: "Streaming requests must use the streaming execution path",
      expose: false,
    });
  }

  const provider = deps.config.providersById.get(target.providerId);
  if (provider === undefined || !provider.enabled) {
    throw new GatewayError({
      code: "PROVIDER_UNAVAILABLE",
      message: `Provider "${target.providerName}" is unavailable`,
    });
  }

  const policy = deps.retryPolicy ?? resolveRetryPolicy(provider);
  const breakerOptions = breakerOptionsFor(provider);
  const breaker = new BreakerClient(deps.env);
  const modelKey = modelBreakerKey(target.modelRecordId);
  const providerKey = `provider:${provider.id}`;
  const deadline = deps.deadline ?? Date.now() + deps.config.settings.requestTimeoutMs;
  const failedAccounts = new Set(excludedAccounts ?? []);
  const accountPool = (deps.config.accountsByProvider.get(provider.id) ?? []).filter(
    (account) => account.enabled,
  );
  const maxIterations = Math.max(policy.maxAttempts, accountPool.length + 1);
  let lastError: GatewayError | undefined;
  let normalAttempts = 0;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (Date.now() >= deadline) break;
    if (!(await breaker.isAllowed(provider.id, providerKey, breakerOptions))) {
      throw new GatewayError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Provider "${provider.name}" is temporarily circuit-open`,
        retriable: true,
        details: { breaker: "provider" },
      });
    }
    if (!(await breaker.isAllowed(provider.id, modelKey, breakerOptions))) {
      throw new GatewayError({
        code: "PROVIDER_UNAVAILABLE",
        message: `Model "${target.modelId}" is temporarily circuit-open`,
        retriable: true,
        details: { breaker: "model" },
      });
    }

    let account: ProviderAccountRecord | undefined;
    const startedAt = Date.now();
    try {
      const selected = await selectProviderAccount(
        deps.env,
        deps.config,
        provider.id,
        failedAccounts,
      );
      account = selected.account;
      const built = buildProviderRequest({
        provider,
        target,
        apiKey: selected.apiKey,
        request,
        policy: deps.policy,
      });

      const remaining = Math.max(1, Math.min(provider.timeoutMs, deadline - Date.now()));
      const response = await fetchWithTimeout(built.url, {
        fetchImpl: deps.fetchImpl,
        timeoutMs: remaining,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        init: {
          method: built.method,
          headers: built.headers,
          body: built.body,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        throw new GatewayError({
          code: "UPSTREAM_ERROR",
          message: "Upstream redirects are not allowed",
          details: { upstream_status: response.status },
        });
      }

      const adapter = protocolRegistry.get(provider.protocol);
      if (!response.ok) {
        let text = "";
        try {
          text = await readResponseText(response, MAX_ERROR_BODY_BYTES);
        } catch {
          text = "";
        }
        const parsed = tryParseJson(text);
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw fromUnifiedError(
          adapter.parseUpstreamError(response.status, parsed ?? text, retryAfterMs),
        );
      }

      const text = await readResponseText(response, deps.config.settings.maxResponseBytes);
      const payload = tryParseJson(text);
      if (!isRecord(payload)) {
        throw new GatewayError({
          code: "PROTOCOL_CONVERSION_ERROR",
          message: "Upstream returned invalid JSON",
        });
      }
      const unifiedResponse = adapter.parseResponse(payload, {
        requestId: deps.requestId,
        model: target.modelId,
      });

      void breaker.record(provider.id, providerKey, true, breakerOptions);
      void breaker.record(provider.id, modelKey, true, breakerOptions);
      void breaker.record(provider.id, accountBreakerKey(selected.account.id), true, breakerOptions);

      return {
        response: unifiedResponse,
        target,
        provider,
        account: selected.account,
        httpStatus: response.status,
        issues: built.issues,
        latencyMs: Date.now() - startedAt,
        retryCount: normalAttempts,
      };
    } catch (error) {
      const gatewayError = toGatewayError(error, {
        code: "UPSTREAM_ERROR",
        message: "Upstream request failed",
      });
      lastError = gatewayError;
      normalAttempts += 1;

      if (account !== undefined) {
        if (isAccountRotationError(gatewayError)) {
          failedAccounts.add(account.id);
        }
        if (breakerWorthy(gatewayError)) {
          await breaker.record(provider.id, accountBreakerKey(account.id), false, breakerOptions);
        }
      }
      if (breakerWorthy(gatewayError)) {
        await breaker.record(provider.id, providerKey, false, breakerOptions);
        await breaker.record(provider.id, modelKey, false, breakerOptions);
      }

      const remainingAccounts = accountPool.length - failedAccounts.size;
      const canRotateAccount =
        account !== undefined && isAccountRotationError(gatewayError) && remainingAccounts > 0;
      const canRetry =
        normalAttempts < policy.maxAttempts && shouldRetryError(gatewayError, policy);
      if (!canRotateAccount && !canRetry) break;

      const delay = retryDelayMs(gatewayError, normalAttempts, policy);
      if (Date.now() + delay >= deadline) break;
      if (deps.signal?.aborted === true) {
        throw new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled" });
      }
      try {
        await sleep(delay, { ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
      } catch (sleepError) {
        throw new GatewayError({
          code: "REQUEST_CANCELLED",
          message: "Request cancelled",
          cause: sleepError,
        });
      }
    }
  }

  throw (
    lastError ??
    new GatewayError({
      code: "UPSTREAM_TIMEOUT",
      message: "Request deadline exceeded before upstream accepted the request",
      retriable: true,
    })
  );
}
