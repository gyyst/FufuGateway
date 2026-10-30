import { GatewayError, isAbortError } from "../core/errors";
import type { FetchLike } from "../providers/types";

export interface FetchWithTimeoutOptions {
  fetchImpl: FetchLike;
  timeoutMs: number;
  signal?: AbortSignal;
  init?: RequestInit;
}

/**
 * 带超时的上游请求。超时与父级取消会被区分处理。
 * redirect 固定为 manual，防止通过重定向绕过上游地址校验。
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, options.timeoutMs));

  try {
    return await options.fetchImpl(url, {
      ...options.init,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new GatewayError({ code: "REQUEST_CANCELLED", message: "Request cancelled", cause: error });
    }
    if (timedOut) {
      throw new GatewayError({
        code: "UPSTREAM_TIMEOUT",
        message: "Upstream request timed out",
        retriable: true,
        cause: error,
      });
    }
    if (isAbortError(error)) {
      throw new GatewayError({ code: "UPSTREAM_TIMEOUT", message: "Upstream request aborted", retriable: true, cause: error });
    }
    throw new GatewayError({
      code: "UPSTREAM_ERROR",
      message: "Failed to reach upstream",
      retriable: true,
      details: { network: true },
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** 读取响应体并强制大小限制，避免上游返回超大内容耗尽内存。 */
export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new GatewayError({
        code: "PROTOCOL_CONVERSION_ERROR",
        message: "Upstream response exceeds the configured size limit",
        details: { max_bytes: maxBytes },
      });
    }
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new GatewayError({
      code: "PROTOCOL_CONVERSION_ERROR",
      message: "Upstream response exceeds the configured size limit",
      details: { max_bytes: maxBytes },
    });
  }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(buffer);
}

export function tryParseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
