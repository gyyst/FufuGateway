import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import { GatewayError } from "../core/errors";
import { timingSafeEqual } from "../core/ids";
import { extractInferenceCredential, protocolForPath } from "./api-key";
import { findApiKeyAuthentication, touchApiKey } from "./repository";
import type { ApiKeyRecord, AuthPrincipal, UserRecord } from "./types";
import { hashApiKey } from "./api-key";

function unauthorized(message = "Invalid or inactive API key"): GatewayError {
  return new GatewayError({ code: "AUTHENTICATION_ERROR", message });
}

export async function authenticateCredential(
  env: AppEnv["Bindings"],
  credential: string,
): Promise<{ apiKey: ApiKeyRecord; user: UserRecord }> {
  const hash = await hashApiKey(credential);
  const found = await findApiKeyAuthentication(env.DB, hash);
  if (!found) throw unauthorized();
  const { apiKey, user } = found;
  const now = Date.now();
  if (apiKey.status !== "active" || user.status !== "active") throw unauthorized();
  if (apiKey.expiresAt !== undefined && apiKey.expiresAt <= now) throw unauthorized();
  return found;
}

function hasScope(apiKey: ApiKeyRecord, scope: string): boolean {
  return apiKey.scopes.includes(scope) || apiKey.scopes.includes("admin");
}

/** 推理接口认证：每个请求直接读取 D1，确保吊销立即生效。 */
export const authenticateInference: MiddlewareHandler<AppEnv> = async (c, next) => {
  const protocol = protocolForPath(c.req.path);
  const credential = extractInferenceCredential(c.req.raw.headers, new URL(c.req.url), protocol);
  if (credential === undefined) {
    throw new GatewayError({ code: "AUTHENTICATION_ERROR", message: "Missing API key" });
  }
  const { apiKey, user } = await authenticateCredential(c.env, credential);
  if (!hasScope(apiKey, "inference")) {
    throw new GatewayError({
      code: "PERMISSION_DENIED",
      message: "This API key cannot access inference endpoints",
    });
  }
  const principal: AuthPrincipal = {
    type: "api_key",
    isAdmin: user.role === "admin" && apiKey.scopes.includes("admin"),
    apiKey,
    user,
  };
  c.set("principal", principal);

  const now = Date.now();
  if (apiKey.lastUsedAt === undefined || now - apiKey.lastUsedAt > 60_000) {
    c.executionCtx.waitUntil(touchApiKey(c.env.DB, apiKey.id, now));
  }
  await next();
};

/**
 * 管理接口认证：支持 ADMIN_TOKEN，或具备 admin scope 的管理员 API Key。
 * 默认拒绝，避免管理面暴露给推理 Key。
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const configured = c.env.ADMIN_TOKEN;
  if (!configured) {
    throw new GatewayError({
      code: "CONFIG_INVALID",
      message: "Admin token is not configured",
      status: 503,
    });
  }
  const bearer = c.req.header("authorization");
  const token =
    (/^Bearer\s+(.+)$/i.exec(bearer?.trim() ?? "")?.[1]?.trim()) ||
    c.req.header("x-admin-token")?.trim();

  if (token !== undefined && token !== "" && timingSafeEqual(token, configured)) {
    c.set("principal", { type: "admin_token", isAdmin: true });
    await next();
    return;
  }

  if (token !== undefined && token.startsWith("fufu_sk_")) {
    try {
      const { apiKey, user } = await authenticateCredential(c.env, token);
      if (user.role === "admin" && apiKey.scopes.includes("admin")) {
        c.set("principal", { type: "api_key", isAdmin: true, apiKey, user });
        await next();
        return;
      }
    } catch {
      // 统一在下方返回管理面鉴权失败，避免泄露 Key 状态。
    }
  }

  throw new GatewayError({ code: "AUTHENTICATION_ERROR", message: "Invalid admin credentials" });
};
