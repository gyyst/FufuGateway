import type { Hono } from "hono";
import type { AppEnv } from "../app";
import { GatewayError } from "../core/errors";
import { HEALTH_CHECK_TIMEOUT_MS } from "../core/limits";
import { withTimeout } from "../core/time";
import { GATEWAY_NAME, GATEWAY_VERSION } from "../core/version";

interface CheckResult {
  ok: boolean;
  error?: string;
}

async function runCheck(operation: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await withTimeout(
      operation(),
      HEALTH_CHECK_TIMEOUT_MS,
      () => new GatewayError({ code: "UPSTREAM_TIMEOUT", message: "Health check timed out" }),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "UnknownError" };
  }
}

export function registerHealthRoutes(app: Hono<AppEnv>): void {
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      environment: c.env.ENVIRONMENT ?? "unknown",
      now: Date.now(),
      requestId: c.get("requestId"),
    }),
  );

  app.get("/health/ready", async (c) => {
    const [d1, kv, coordination] = await Promise.all([
      runCheck(() => c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>()),
      runCheck(() => c.env.CONFIG_KV.get("health:probe")),
      runCheck(() => c.env.COORDINATION.get(c.env.COORDINATION.idFromName("health")).ping()),
    ]);

    const ready = d1.ok && kv.ok && coordination.ok;
    return c.json(
      {
        status: ready ? "ready" : "degraded",
        service: GATEWAY_NAME,
        version: GATEWAY_VERSION,
        environment: c.env.ENVIRONMENT ?? "unknown",
        checks: { d1, kv, coordination },
        now: Date.now(),
        requestId: c.get("requestId"),
      },
      ready ? 200 : 503,
    );
  });
}
