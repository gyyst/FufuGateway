import type { Context } from "hono";
import type { AppEnv } from "../../app";
import { GatewayError } from "../../core/errors";
import { isRecord } from "../../core/json";
import { setSetting } from "../../config/repository";
import { parseAdminBody, recordAudit } from "../shared";
import { z } from "zod";

const ALLOWED_KEYS = new Set([
  "gateway.name",
  "compat.default_policy",
  "limits.max_body_bytes",
  "limits.max_response_bytes",
  "limits.max_stream_event_bytes",
  "limits.max_combo_depth",
  "limits.max_combo_nodes",
  "limits.max_combo_concurrency",
  "timeouts.request_ms",
  "logging.retention_days",
  "cors.allowed_origins",
  "config.cache_ttl_ms",
]);

const settingsUpdateSchema = z.record(z.string(), z.unknown());

export async function getSettingsHandler(c: Context<AppEnv>): Promise<Response> {
  const rows = await c.env.DB.prepare("SELECT key, value FROM system_settings").all<{
    key: string;
    value: string;
  }>();
  const data: Record<string, unknown> = {};
  for (const row of rows.results) {
    try {
      data[row.key] = JSON.parse(row.value) as unknown;
    } catch {
      data[row.key] = row.value;
    }
  }
  return c.json({ data, note: "Settings changes take effect after publishing a new configuration version." });
}

function validateValue(key: string, value: unknown): void {
  if (key === "gateway.name") {
    if (typeof value !== "string" || value.trim() === "") {
      throw new GatewayError({ code: "INVALID_REQUEST", message: "gateway.name must be a non-empty string" });
    }
    return;
  }
  if (key === "compat.default_policy") {
    if (
      value !== "strict" &&
      value !== "warn" &&
      value !== "drop" &&
      value !== "passthrough"
    ) {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "compat.default_policy must be strict, warn, drop or passthrough",
      });
    }
    return;
  }
  if (key === "cors.allowed_origins") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new GatewayError({
        code: "INVALID_REQUEST",
        message: "cors.allowed_origins must be a string array",
      });
    }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: `${key} must be a non-negative number` });
  }
}

export async function updateSettingsHandler(c: Context<AppEnv>): Promise<Response> {
  const body = await parseAdminBody(c, settingsUpdateSchema);
  const entries = Object.entries(body);
  if (entries.length === 0) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "No settings provided" });
  }
  if (!isRecord(body)) {
    throw new GatewayError({ code: "INVALID_REQUEST", message: "Settings must be an object" });
  }
  for (const [key, value] of entries) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new GatewayError({ code: "INVALID_REQUEST", message: `Unknown setting "${key}"` });
    }
    validateValue(key, value);
  }
  for (const [key, value] of entries) {
    await setSetting(c.env.DB, key, value);
  }
  await recordAudit(c, "settings.update", "settings", null, { keys: entries.map(([key]) => key) });
  return c.json({
    data: body,
    note: "Settings saved. Publish a configuration version to apply them to inference traffic.",
  });
}
