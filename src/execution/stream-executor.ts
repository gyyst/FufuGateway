import { GatewayError, isAbortError, toGatewayError } from "../core/errors";
import type {
  CompatibilityIssue,
  CompatibilityPolicy,
  StopReason,
  UnifiedRequest,
  UnifiedStreamEvent,
  UnifiedUsage,
} from "../ir";
import { fromUnifiedError, parseRetryAfter, toUnifiedError } from "../ir/errors";
import { emptyUsage } from "../ir/usage";
import type { GatewayEnv } from "../env";
import type { ProviderAccountRecord, ProviderRecord, RuntimeConfig } from "../config/types";
import type { ResolvedTarget } from "../combo/types";
import { protocolRegistry } from "../protocol/registry";
import { buildProviderRequest } from "../providers/engine";
import type { FetchLike } from "../providers/types";
import { createSseSource } from "../stream/sse";
import { selectProviderAccount } from "./accounts";
import { readResponseText, tryParseJson } from "./http";
import {
  BreakerClient,
  accountBreakerKey,
  breakerOptionsFor,
  modelBreakerKey,
} from "./breaker";
import { resolveRetryPolicy, retryDelayMs, shouldRetryError, type RetryPolicy } from "./retry";
import { sleep } from "../core/time";

const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface StreamExecutionDependencies {
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

export type StreamStatus = "running" | "success" | "error" | "cancelled";

export interface StreamExecutionStats {
  startedAt: number;
  firstTokenAt: number | null;
  finishedAt: number | null;
  usage: UnifiedUsage;
  stopReason: StopReason | "unknown";
  status: StreamStatus;
  errorCode: string | null;
  retryCount: number;
}

export interface StreamExecutionHandle {
  events: AsyncIterable<UnifiedStreamEvent>;
  target: ResolvedTarget;
  provider: ProviderRecord;
  account: ProviderAccountRecord;
  issues: CompatibilityIssue[];
  stats: StreamExecutionStats;
}

function timeoutError(message: string): GatewayError {
  return new GatewayError({
    code: "UPSTREAM_TIMEOUT",
    message,
    retriable: true,
  });
}

/** 等待迭代器下一项，同时应用空闲超时与父级取消。 */
async function nextWithTimeout<T>(
  next: Promise<IteratorResult<T>>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
  onParentAbort: () => void,
): Promise<IteratorResult<T>> {
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      return true;
    };
    const timer = setTimeout(() => {
      if (!finish()) return;
      onTimeout();
      reject(timeoutError("Upstream stream idle timeout"));
    }, Math.max(1, timeoutMs));
    const abortHandler = (): void => {
      if (!finish()) return;
      onParentAbort();
      reject(new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled" }));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    next.then(
      (result) => {
        if (!finish()) return;
        resolve(result);
      },
      (error: unknown) => {
        if (!finish()) return;
        reject(error);
      },
    );
  });
}

/**
 * 打开一个上游流式请求。
 *
 * 只有在收到首个有效事件后才返回；此前的错误都可以安全地触发故障转移。
 */
export async function openModelStream(
  request: UnifiedRequest,
  target: ResolvedTarget,
  deps: StreamExecutionDependencies,
  excludedAccounts?: ReadonlySet<string>,
): Promise<StreamExecutionHandle> {
  const provider = deps.config.providersById.get(target.providerId);
  if (provider === undefined || !provider.enabled) {
    throw new GatewayError({
      code: "PROVIDER_UNAVAILABLE",
      message: `Provider "${target.providerName}" is unavailable`,
    });
  }
  if (deps.signal?.aborted === true) {
    throw new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled" });
  }

  const { account, apiKey } = await selectProviderAccount(
    deps.env,
    deps.config,
    provider.id,
    excludedAccounts,
  );
  const breaker = new BreakerClient(deps.env);
  const breakerOptions = breakerOptionsFor(provider);
  const modelKey = modelBreakerKey(target.modelRecordId);
  const providerKey = `provider:${provider.id}`;
  const accountKey = accountBreakerKey(account.id);
  const recordBreaker = (success: boolean): void => {
    void breaker.record(provider.id, providerKey, success, breakerOptions);
    void breaker.record(provider.id, modelKey, success, breakerOptions);
    void breaker.record(provider.id, accountKey, success, breakerOptions);
  };
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
  const streamRequest: UnifiedRequest = request.stream ? request : { ...request, stream: true };
  const built = buildProviderRequest({
    provider,
    target,
    apiKey,
    request: streamRequest,
    policy: deps.policy,
  });

  const startedAt = Date.now();
  const deadline = deps.deadline ?? startedAt + deps.config.settings.requestTimeoutMs;
  const controller = new AbortController();
  let parentAborted = false;
  const onParentAbort = (): void => {
    parentAborted = true;
    controller.abort(deps.signal?.reason);
  };
  deps.signal?.addEventListener("abort", onParentAbort, { once: true });

  let headerTimedOut = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, Math.max(1, provider.timeoutMs));

  let response: Response;
  try {
    response = await deps.fetchImpl(built.url, {
      method: built.method,
      headers: built.headers,
      body: built.body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(headerTimer);
    deps.signal?.removeEventListener("abort", onParentAbort);
    recordBreaker(false);
    if (parentAborted) {
      throw new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled", cause: error });
    }
    if (headerTimedOut) throw timeoutError("Upstream response header timeout");
    if (isAbortError(error)) throw timeoutError("Upstream request aborted");
    throw new GatewayError({
      code: "UPSTREAM_ERROR",
      message: "Failed to reach upstream",
      retriable: true,
      cause: error,
    });
  } finally {
    clearTimeout(headerTimer);
  }

  const cleanupAbort = (): void => {
    deps.signal?.removeEventListener("abort", onParentAbort);
    controller.abort();
  };

  if (response.status >= 300 && response.status < 400) {
    cleanupAbort();
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
    cleanupAbort();
    recordBreaker(false);
    const parsed = tryParseJson(text);
    throw fromUnifiedError(
      adapter.parseUpstreamError(
        response.status,
        parsed ?? text,
        parseRetryAfter(response.headers.get("retry-after")),
      ),
    );
  }

  if (response.body === null) {
    cleanupAbort();
    recordBreaker(false);
    throw new GatewayError({ code: "PROTOCOL_CONVERSION_ERROR", message: "Upstream returned an empty stream" });
  }

  const sseSource = createSseSource(response.body, {
    maxEventBytes: deps.config.settings.maxStreamEventBytes,
  });
  const parsedEvents = adapter.parseStream(sseSource.events, {
    model: target.modelId,
    requestId: deps.requestId,
  });
  const iterator = parsedEvents[Symbol.asyncIterator]();

  // 首个有效事件探针：只缓冲心跳，不向下游提交任何内容。
  const bufferedPings: UnifiedStreamEvent[] = [];
  let firstEvent: UnifiedStreamEvent | undefined;
  const firstTokenDeadline = startedAt + provider.firstTokenTimeoutMs;
  try {
    for (;;) {
      const remaining = firstTokenDeadline - Date.now();
      if (remaining <= 0) throw timeoutError("Upstream first token timeout");
      const next = await nextWithTimeout(
        iterator.next(),
        remaining,
        deps.signal,
        () => controller.abort(),
        () => controller.abort(),
      );
      if (next.done === true) {
        throw new GatewayError({
          code: "PROTOCOL_CONVERSION_ERROR",
          message: "Upstream stream ended before emitting any content",
        });
      }
      const event = next.value;
      if (event.type === "ping") {
        bufferedPings.push(event);
        continue;
      }
      if (event.type === "error") {
        throw fromUnifiedError(event.error);
      }
      firstEvent = event as UnifiedStreamEvent;
      break;
    }
  } catch (error) {
    cleanupAbort();
    recordBreaker(false);
    await sseSource.cancel();
    try {
      await iterator.return?.();
    } catch {
      // 忽略清理异常。
    }
    throw toGatewayError(error, { code: "UPSTREAM_ERROR", message: "Failed to open upstream stream" });
  }

  const stats: StreamExecutionStats = {
    startedAt,
    firstTokenAt: null,
    finishedAt: null,
    usage: emptyUsage("none"),
    stopReason: "unknown",
    status: "running",
    errorCode: null,
    retryCount: 0,
  };

  const observe = (event: UnifiedStreamEvent): void => {
    if (event.type === "ping") return;
    if (stats.firstTokenAt === null) stats.firstTokenAt = Date.now();
    if (event.type === "finish") {
      stats.usage = event.usage;
      stats.stopReason = event.stopReason;
      stats.status = "success";
      stats.finishedAt = Date.now();
    } else if (event.type === "error") {
      stats.status = "error";
      stats.errorCode = event.error.code;
      stats.finishedAt = Date.now();
    }
  };

  const events = (async function* (): AsyncGenerator<UnifiedStreamEvent> {
    let yielded = false;
    try {
      for (const ping of bufferedPings) {
        yield ping;
      }
      if (firstEvent === undefined) return;
      observe(firstEvent);
      yielded = true;
      yield firstEvent;
      if (firstEvent.type === "finish" || firstEvent.type === "error") return;

      for (;;) {
        const remaining = deadline - Date.now();
          if (remaining <= 0) {
          throw new GatewayError({
            code: "UPSTREAM_TIMEOUT",
            message: "Stream exceeded the total time budget",
            retriable: false,
          });
        }
        const next = await nextWithTimeout(
          iterator.next(),
          Math.min(provider.idleTimeoutMs, remaining),
          deps.signal,
          () => controller.abort(),
          () => controller.abort(),
        );
        if (next.done === true) {
          if (stats.status === "running") {
            stats.status = "error";
            stats.errorCode = "PROTOCOL_CONVERSION_ERROR";
            stats.finishedAt = Date.now();
          }
          return;
        }
        observe(next.value);
        yielded = true;
        yield next.value;
        if (next.value.type === "finish" || next.value.type === "error") return;
      }
    } catch (error) {
      const gatewayError = toGatewayError(error, {
        code: "UPSTREAM_ERROR",
        message: "Streaming request failed",
      });
      if (gatewayError.code === "REQUEST_CANCELLED") {
        if (stats.status === "running") {
          stats.status = "cancelled";
          stats.finishedAt = Date.now();
        }
        throw gatewayError;
      }
      stats.status = "error";
      stats.errorCode = gatewayError.code;
      stats.finishedAt = Date.now();
      if (yielded) {
        yield {
          type: "error",
          error: { ...toUnifiedError(gatewayError), retriable: false },
        };
        return;
      }
      throw gatewayError;
    } finally {
      deps.signal?.removeEventListener("abort", onParentAbort);
      controller.abort();
      if (stats.finishedAt === null) {
        stats.finishedAt = Date.now();
        if (stats.status === "running") stats.status = "cancelled";
      }
      await sseSource.cancel();
      try {
        await iterator.return?.();
      } catch {
        // 忽略上游清理异常。
      }
    }
  })();

  recordBreaker(true);
  return {
    events,
    target,
    provider,
    account,
    issues: built.issues,
    stats,
  };
}

/**
 * 打开流式请求，并在首个内容到达前按 Provider 重试策略重试。
 * 提交后（返回 handle）不再重试，错误会以流内事件结束。
 */
export async function openModelStreamWithRetry(
  request: UnifiedRequest,
  target: ResolvedTarget,
  deps: StreamExecutionDependencies,
  excludedAccounts?: ReadonlySet<string>,
): Promise<StreamExecutionHandle> {
  const provider = deps.config.providersById.get(target.providerId);
  if (provider === undefined) {
    return openModelStream(request, target, deps, excludedAccounts);
  }
  const policy = deps.retryPolicy ?? resolveRetryPolicy(provider);
  const deadline = deps.deadline ?? Date.now() + deps.config.settings.requestTimeoutMs;
  let lastError: GatewayError | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (Date.now() >= deadline) break;
    try {
      const handle = await openModelStream(request, target, { ...deps, deadline }, excludedAccounts);
      handle.stats.retryCount = attempt - 1;
      return handle;
    } catch (error) {
      const gatewayError = toGatewayError(error, {
        code: "UPSTREAM_ERROR",
        message: "Failed to open upstream stream",
      });
      lastError = gatewayError;
      if (attempt >= policy.maxAttempts || !shouldRetryError(gatewayError, policy)) break;
      const delay = retryDelayMs(gatewayError, attempt, policy);
      if (Date.now() + delay >= deadline) break;
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
      message: "Streaming deadline exceeded before upstream produced content",
      retriable: true,
    })
  );
}
