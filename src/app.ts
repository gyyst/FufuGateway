import { Hono } from "hono";
import type { AuthPrincipal } from "./auth/types";
import { GatewayError, toGatewayError } from "./core/errors";
import { newRequestId, newTraceId, parseTraceparent, sanitizeRequestId } from "./core/ids";
import { DEFAULT_MAX_BODY_BYTES } from "./core/limits";
import { createLogger, errorFields, type Logger } from "./core/logger";
import { GATEWAY_NAME, GATEWAY_VERSION } from "./core/version";
import type { GatewayEnv } from "./env";
import type { FetchLike } from "./providers/types";
import { registerAdminRoutes } from "./admin/routes";
import { uiHandler } from "./ui";
import { registerHealthRoutes } from "./gateway/health";
import { registerInferenceRoutes } from "./gateway/inference";
import { renderGatewayError } from "./gateway/http-errors";

export interface AppVariables {
  requestId: string;
  traceId: string;
  startedAt: number;
  logger: Logger;
  principal?: AuthPrincipal;
  fetchImpl: FetchLike;
}

export type AppEnv = {
  Bindings: GatewayEnv;
  Variables: AppVariables;
};

export interface AppOptions {
  maxBodyBytes?: number;
  /** 测试注入的出站 fetch；生产环境使用全局 fetch。 */
  fetchImpl?: FetchLike;
}

/** 组装 Hono 应用。所有路由注册最终都收敛到此处。 */
export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  app.use("*", async (c, next) => {
    const requestId = sanitizeRequestId(c.req.header("x-request-id")) ?? newRequestId();
    const traceId = parseTraceparent(c.req.header("traceparent")) ?? newTraceId();
    const startedAt = Date.now();
    const logger = createLogger({
      level: c.env.LOG_LEVEL,
      base: {
        requestId,
        traceId,
        method: c.req.method,
        path: c.req.path,
      },
    });

    c.set("requestId", requestId);
    c.set("traceId", traceId);
    c.set("startedAt", startedAt);
    c.set("logger", logger);
    c.set("fetchImpl", fetchImpl);
    c.header("x-request-id", requestId);
    c.header("x-trace-id", traceId);

    const start = performance.now();
    try {
      await next();
      const durationMs = Math.round(performance.now() - start);
      c.header("x-response-time-ms", String(durationMs));
      logger.info("request.completed", { status: c.res.status, durationMs });
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      logger.error("request.failed", { durationMs, error: errorFields(error) });
      throw error;
    }
  });

  // 请求体大小预检；实际读取时还会再次校验。
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      await next();
      return;
    }
    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > maxBodyBytes) {
        throw new GatewayError({
          code: "REQUEST_LIMIT_EXCEEDED",
          message: `Request body exceeds ${maxBodyBytes} bytes`,
          status: 413,
        });
      }
    }
    await next();
  });

  app.get("/", (c) =>
    c.json({
      service: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      status: "ok",
      endpoints: {
        health: "/health",
        ready: "/health/ready",
        chat: "/v1/chat/completions",
        responses: "/v1/responses",
        anthropic: "/v1/messages",
        gemini: "/v1beta/models/{model}:generateContent",
      },
    }),
  );

  registerHealthRoutes(app);
  app.get("/ui", uiHandler);
  app.get("/ui/", uiHandler);
  registerInferenceRoutes(app);
  registerAdminRoutes(app);

  app.notFound((c) =>
    renderGatewayError(
      c,
      toGatewayError(undefined, { code: "NOT_FOUND", message: "Route not found" }),
    ),
  );

  app.onError((error, c) => renderGatewayError(c, toGatewayError(error)));

  return app;
}
