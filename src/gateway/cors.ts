import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { loadRuntimeConfig } from "../config/cache";

const EXPOSE_HEADERS =
  "x-request-id,x-trace-id,x-fufu-model,x-fufu-provider,x-fufu-warnings,x-fufu-usage-source,x-fufu-stream,retry-after";

/**
 * 推理入口 CORS。默认不开放；只有系统设置 cors.allowed_origins 中的来源
 * 才会收到 CORS 响应头。预检请求在认证之前处理。
 */
export const inferenceCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin === undefined || origin === "") {
    await next();
    return;
  }
  const config = await loadRuntimeConfig(c.env);
  const allowed = config.settings.corsAllowedOrigins;
  const permitted = allowed.includes("*") || allowed.includes(origin);
  if (c.req.method === "OPTIONS") {
    if (!permitted) {
      return c.body(null, 403);
    }
    c.header("access-control-allow-origin", allowed.includes("*") ? "*" : origin);
    c.header("vary", "Origin");
    c.header("access-control-allow-methods", "GET, POST, OPTIONS");
    c.header(
      "access-control-allow-headers",
      "authorization, content-type, x-api-key, x-goog-api-key, x-fufu-session-id, x-session-id, anthropic-version, anthropic-beta",
    );
    c.header("access-control-max-age", "600");
    c.header("access-control-expose-headers", EXPOSE_HEADERS);
    return c.body(null, 204);
  }
  await next();
  c.res.headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  if (permitted) {
    c.res.headers.set("access-control-allow-origin", allowed.includes("*") ? "*" : origin);
    c.res.headers.set("vary", "Origin");
  }
};
