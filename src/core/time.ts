/** 时间、超时与时间分桶工具。 */

export function nowMs(): number {
  return Date.now();
}

/** 基于 performance.now() 的单调时钟，用于耗时统计。 */
export function monotonicMs(): number {
  return performance.now();
}

export function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

export interface SleepOptions {
  signal?: AbortSignal;
}

export function sleep(ms: number, options: SleepOptions = {}): Promise<void> {
  const { signal } = options;
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));

    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };

    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 为 Promise 增加超时控制。超时不会取消底层任务，调用方应同时把
 * AbortSignal 传给真正需要取消的操作。
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 计算指数退避延迟（含可选抖动）。 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: "full" | "none",
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  if (jitter === "none") return exponential;
  return Math.floor(Math.random() * exponential);
}
