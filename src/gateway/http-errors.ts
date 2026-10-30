import type { Context } from "hono";
import type { AppEnv } from "../app";
import type { GatewayError } from "../core/errors";
import { stringifyJson } from "../core/json";
import type { ProtocolAdapter } from "../protocol/types";
import { protocolRegistry } from "../protocol/registry";

function adapterForPath(path: string): ProtocolAdapter | undefined {
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) {
    return protocolRegistry.get("anthropic");
  }
  if (path === "/v1/responses" || path.startsWith("/v1/responses/")) {
    return protocolRegistry.get("openai-responses");
  }
  if (path.startsWith("/v1beta/")) {
    return protocolRegistry.get("gemini");
  }
  if (path.startsWith("/v1/")) {
    return protocolRegistry.get("openai-chat");
  }
  return undefined;
}

function withRequestHeaders(
  c: Context<AppEnv>,
  headers: Record<string, string>,
  status: number,
  body: string,
): Response {
  const result = new Headers(headers);
  const requestId = c.get("requestId");
  const traceId = c.get("traceId");
  if (requestId) result.set("x-request-id", requestId);
  if (traceId) result.set("x-trace-id", traceId);
  return new Response(body, { status, headers: result });
}

function retryAfterSeconds(error: GatewayError): string | undefined {
  const value = error.details?.["retry_after_ms"];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return String(Math.max(1, Math.ceil(value / 1000)));
}

/** 错误响应渲染：推理入口使用对应下游协议的错误格式，管理接口使用中性格式。 */
export function renderGatewayError(c: Context<AppEnv>, error: GatewayError): Response {
  const retryAfter = retryAfterSeconds(error);
  const adapter = adapterForPath(c.req.path);
  if (adapter !== undefined) {
    try {
      const rendered = adapter.renderError(error, {
        requestId: c.get("requestId") ?? "",
        model: "",
        created: Date.now(),
        policy: "warn",
        issues: [],
      });
      if (typeof rendered.body === "string") {
        const response = withRequestHeaders(c, rendered.headers, rendered.status, rendered.body);
        if (retryAfter !== undefined) response.headers.set("retry-after", retryAfter);
        return response;
      }
      const headers = new Headers(rendered.headers);
      const requestId = c.get("requestId");
      const traceId = c.get("traceId");
      if (requestId) headers.set("x-request-id", requestId);
      if (traceId) headers.set("x-trace-id", traceId);
      if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
      return new Response(rendered.body, { status: rendered.status, headers });
    } catch {
      // 协议渲染失败时回退到中性格式，避免错误处理本身抛错。
    }
  }

  const requestId = c.get("requestId");
  const body = {
    error: {
      code: error.code,
      message: error.publicMessage,
      type: "gateway_error",
      ...(error.details === undefined ? {} : { details: error.details }),
      request_id: requestId,
    },
  };
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
  return withRequestHeaders(c, headers, error.status, stringifyJson(body));
}
